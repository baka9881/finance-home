from __future__ import annotations

import io
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app import main as main_module
from app import services as services_module
from app.database import Base, get_db
from app.main import app
from app.services import seed_defaults


@pytest.fixture()
def client():
    test_engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSession = sessionmaker(bind=test_engine, expire_on_commit=False)
    Base.metadata.create_all(test_engine)
    with TestingSession() as db:
        seed_defaults(db)

    def override_db():
        db = TestingSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
    Base.metadata.drop_all(test_engine)


def create_account(client: TestClient, name: str, nature: str = "asset") -> int:
    response = client.post(
        "/api/accounts",
        json={
            "name": name,
            "account_type": "bank" if nature == "asset" else "credit_card",
            "nature": nature,
            "currency": "TWD",
            "is_liquid": nature == "asset",
            "opening_balance": 100000 if nature == "asset" else 12000,
            "opening_date": date.today().isoformat(),
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def test_cloud_password_protects_financial_api(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(main_module, "FINANCE_APP_PASSWORD", "test-password")
    monkeypatch.setattr(main_module, "FINANCE_AUTH_SECRET", "test-secret")

    assert client.get("/api/health").status_code == 200
    assert client.get("/api/dashboard").status_code == 401
    assert client.post("/api/auth/login", json={"password": "wrong"}).status_code == 401

    login = client.post("/api/auth/login", json={"password": "test-password"})
    assert login.status_code == 200
    token = login.json()["token"]
    authorized = client.get("/api/dashboard", headers={"Authorization": f"Bearer {token}"})
    assert authorized.status_code == 200


def test_automation_sync_uses_separate_token(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    calls: list[str] = []
    monkeypatch.setenv("FINANCE_AUTOMATION_TOKEN", "test-automation-token")
    monkeypatch.setattr(
        main_module,
        "run_automatic_updates",
        lambda: calls.append("started"),
    )

    assert client.post("/api/automation/sync").status_code == 401
    assert (
        client.post(
            "/api/automation/sync",
            headers={"X-Automation-Token": "wrong-token"},
        ).status_code
        == 401
    )

    accepted = client.post(
        "/api/automation/sync",
        headers={"X-Automation-Token": "test-automation-token"},
    )
    assert accepted.status_code == 202
    assert accepted.json() == {"accepted": True, "status": "scheduled"}
    assert calls == ["started"]

    status = client.get("/api/automation/status")
    assert status.status_code == 200
    assert status.json()["enabled"] is True
    assert status.json()["schedule"] == "hourly"


def test_account_balance_and_dashboard(client: TestClient):
    create_account(client, "薪轉帳戶")
    create_account(client, "信用卡", "liability")

    dashboard = client.get("/api/dashboard")
    assert dashboard.status_code == 200
    payload = dashboard.json()
    assert payload["assets"] == 100000
    assert payload["liabilities"] == 12000
    assert payload["net_worth"] == 88000


def test_binance_spot_sync_updates_holdings_without_double_counting(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("FINANCE_CREDENTIAL_SECRET", "test-credential-secret")
    fx = client.post(
        "/api/fx/manual",
        json={
            "currency": "USD",
            "rate_date": date.today().isoformat(),
            "rate_to_twd": 32,
        },
    )
    assert fx.status_code == 200, fx.text
    account_response = client.post(
        "/api/accounts",
        json={
            "name": "幣安現貨",
            "institution": "Binance",
            "account_type": "crypto",
            "nature": "asset",
            "currency": "TWD",
            "is_liquid": True,
            "opening_balance": 999999,
            "opening_date": date.today().isoformat(),
        },
    )
    assert account_response.status_code == 201, account_response.text
    account_id = account_response.json()["id"]

    manual_position = client.post(
        "/api/positions",
        json={
            "account_id": account_id,
            "market": "US",
            "symbol": "MSTR",
            "name": "MicroStrategy",
            "quantity": 1,
            "average_cost": 100,
            "currency": "USD",
            "manual_price": 100,
        },
    )
    assert manual_position.status_code == 201, manual_position.text

    balances = [
        {"asset": "BTC", "free": "0.5", "locked": "0"},
        {"asset": "USDT", "free": "100", "locked": "0"},
        {"asset": "DUST", "free": "1", "locked": "0"},
    ]
    wallet = {"total_usdt": services_module.Decimal("30500")}
    cost_detail_requests: list[bool] = []

    def fake_binance_snapshot(_key, _secret, *, include_cost_details=True):
        cost_detail_requests.append(include_cost_details)
        return (
            balances,
            {
                "BTCUSDT": services_module.Decimal("60000"),
                "DUSTUSDT": services_module.Decimal("0.01"),
            },
            wallet["total_usdt"],
            [],
            {},
            [],
            [],
            [],
        )

    monkeypatch.setattr(
        services_module,
        "_fetch_binance_spot_snapshot",
        fake_binance_snapshot,
    )
    connected = client.post(
        "/api/exchanges/binance/connect",
        json={"account_id": account_id, "api_key": "read-only-key", "api_secret": "read-only-secret"},
    )
    assert connected.status_code == 200, connected.text
    assert cost_detail_requests == [True]

    account = next(item for item in client.get("/api/accounts").json() if item["id"] == account_id)
    assert account["balance_twd"] == 976000
    assert account["investments_twd"] == 963200
    assert account["total_twd"] == 976000
    assert account["auto_balance_base_twd"] is None
    assert account["balance_includes_positions"] is True
    assert account["valuation_mode"] == "manual_total"
    positions = client.get("/api/positions").json()
    assert len(positions) == 2
    bitcoin = next(item for item in positions if item["symbol"] == "bitcoin")
    assert bitcoin["quantity"] == 0.5
    assert bitcoin["price"] == 60000
    assert bitcoin["cost_status"] == "estimated"

    status = client.get("/api/exchanges/binance").json()
    assert status[0]["connected"] is True
    skipped = client.post("/api/exchanges/sync")
    assert skipped.status_code == 200
    assert skipped.json()["skipped"] == 1

    balances.clear()
    balances.append({"asset": "USDT", "free": "125", "locked": "0"})
    wallet["total_usdt"] = services_module.Decimal("125")
    refreshed = client.post(f"/api/exchanges/sync?account_id={account_id}&force=true")
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["updated"] == 1
    assert cost_detail_requests == [True, False]
    positions = client.get("/api/positions").json()
    assert len(positions) == 1
    assert positions[0]["symbol"] == "MSTR"
    account = next(item for item in client.get("/api/accounts").json() if item["id"] == account_id)
    assert account["total_twd"] == 4000
    assert account["investments_twd"] == 3200
    assert account["auto_balance_base_twd"] is None
    assert account["valuation_mode"] == "manual_total"


def test_binance_portfolio_margin_updates_tradfi_position(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("FINANCE_CREDENTIAL_SECRET", "test-credential-secret")
    client.post(
        "/api/fx/manual",
        json={
            "currency": "USD",
            "rate_date": date.today().isoformat(),
            "rate_to_twd": 32,
        },
    )
    account_response = client.post(
        "/api/accounts",
        json={
            "name": "幣安交易所",
            "institution": "Binance",
            "account_type": "crypto",
            "nature": "asset",
            "currency": "TWD",
            "is_liquid": True,
            "opening_balance": 0,
            "opening_date": date.today().isoformat(),
        },
    )
    account_id = account_response.json()["id"]
    client.post(
        "/api/positions",
        json={
            "account_id": account_id,
            "market": "US",
            "symbol": "MSTR",
            "name": "微策略",
            "quantity": 3.2758,
            "average_cost": 92.39,
            "currency": "USD",
        },
    )

    monkeypatch.setattr(
        services_module,
        "_fetch_binance_spot_snapshot",
        lambda _key, _secret, **_kwargs: (
            [{"asset": "USDT", "free": "100", "locked": "0"}],
            {},
            services_module.Decimal("500"),
            [],
            {},
            [],
            [
                {
                    "symbol": "MSTRUSDT",
                    "baseAsset": "MSTR",
                    "contractType": "TRADIFI_PERPETUAL",
                    "underlyingType": "EQUITY",
                    "positionAmt": "4.3",
                    "entryPrice": "91.25",
                    "markPrice": "94.86",
                    "positionSide": "BOTH",
                }
            ],
            [],
        ),
    )

    connected = client.post(
        "/api/exchanges/binance/connect",
        json={
            "account_id": account_id,
            "api_key": "read-only-key",
            "api_secret": "read-only-secret",
        },
    )
    assert connected.status_code == 200, connected.text

    positions = client.get("/api/positions").json()
    assert len(positions) == 1
    assert positions[0]["symbol"] == "MSTR"
    assert positions[0]["quantity"] == 4.3
    assert positions[0]["average_cost"] == 91.25
    assert positions[0]["price"] == 94.86
    assert positions[0]["price_source"] == "Binance Futures"
    assert positions[0]["cost_status"] == "automatic"


def test_position_cost_can_be_confirmed_with_average_cost_patch(client: TestClient):
    account_id = create_account(client, "投資帳戶")
    created = client.post(
        "/api/positions",
        json={
            "account_id": account_id,
            "market": "US",
            "symbol": "MSTR",
            "name": "Strategy",
            "quantity": 2,
            "average_cost": 90,
            "currency": "USD",
            "manual_price": 100,
        },
    )
    assert created.status_code == 201, created.text
    assert created.json()["cost_status"] == "confirmed"

    updated = client.patch(
        f"/api/positions/{created.json()['id']}",
        json={"quantity": 2.5, "average_cost": 80},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["quantity"] == 2.5
    assert updated.json()["average_cost"] == 80
    assert updated.json()["cost_status"] == "confirmed"


def test_binance_funding_wallet_updates_existing_stock_position(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("FINANCE_CREDENTIAL_SECRET", "test-credential-secret")
    client.post(
        "/api/fx/manual",
        json={
            "currency": "USD",
            "rate_date": date.today().isoformat(),
            "rate_to_twd": 32,
        },
    )
    account_response = client.post(
        "/api/accounts",
        json={
            "name": "幣安交易所",
            "institution": "Binance",
            "account_type": "crypto",
            "nature": "asset",
            "currency": "TWD",
            "is_liquid": True,
            "opening_balance": 0,
            "opening_date": date.today().isoformat(),
        },
    )
    account_id = account_response.json()["id"]
    client.post(
        "/api/positions",
        json={
            "account_id": account_id,
            "market": "US",
            "symbol": "MSTR",
            "name": "微策略",
            "quantity": 3.2758,
            "average_cost": 92.39,
            "currency": "USD",
            "manual_price": 94.64,
        },
    )

    monkeypatch.setattr(
        services_module,
        "_fetch_binance_spot_snapshot",
        lambda _key, _secret, **_kwargs: (
            [{"asset": "USDT", "free": "100", "locked": "0"}],
            {},
            services_module.Decimal("1661.16"),
            [
                {
                    "asset": "MSTR",
                    "free": "4.3",
                    "locked": "0",
                    "freeze": "0",
                    "withdrawing": "0",
                }
            ],
            {"MSTR": "MSTR"},
            [],
            [],
            [],
        ),
    )

    connected = client.post(
        "/api/exchanges/binance/connect",
        json={
            "account_id": account_id,
            "api_key": "read-only-key",
            "api_secret": "read-only-secret",
        },
    )
    assert connected.status_code == 200, connected.text

    positions = client.get("/api/positions").json()
    assert len(positions) == 1
    assert positions[0]["symbol"] == "MSTR"
    assert positions[0]["quantity"] == 4.3
    assert positions[0]["average_cost"] == 92.39
    assert positions[0]["price"] == 94.64


def test_binance_stock_trades_apply_only_new_fills_after_baseline(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(services_module, "BINANCE_COST_SYNC_INTERVAL", timedelta(0))
    monkeypatch.setenv("FINANCE_CREDENTIAL_SECRET", "test-credential-secret")
    client.post(
        "/api/fx/manual",
        json={
            "currency": "USD",
            "rate_date": date.today().isoformat(),
            "rate_to_twd": 32,
        },
    )
    account_response = client.post(
        "/api/accounts",
        json={
            "name": "幣安交易所",
            "institution": "Binance",
            "account_type": "crypto",
            "nature": "asset",
            "currency": "TWD",
            "is_liquid": True,
            "opening_balance": 0,
            "opening_date": date.today().isoformat(),
        },
    )
    account_id = account_response.json()["id"]
    client.post(
        "/api/positions",
        json={
            "account_id": account_id,
            "market": "US",
            "symbol": "MSTR",
            "name": "微策略",
            "quantity": 3.2758,
            "average_cost": 92.39,
            "currency": "USD",
            "manual_price": 94.64,
        },
    )

    stock_trades = [
        {
            "executionId": "old-buy",
            "symbol": "MSTR",
            "side": "BUY",
            "qty": "3.2758",
            "price": "92.39",
            "executionAt": 1,
        }
    ]
    monkeypatch.setattr(
        services_module,
        "_fetch_binance_spot_snapshot",
        lambda _key, _secret, **_kwargs: (
            [{"asset": "USDT", "free": "100", "locked": "0"}],
            {},
            services_module.Decimal("1661.16"),
            [],
            {},
            stock_trades,
            [],
            [],
        ),
    )

    connected = client.post(
        "/api/exchanges/binance/connect",
        json={
            "account_id": account_id,
            "api_key": "read-only-key",
            "api_secret": "read-only-secret",
        },
    )
    assert connected.status_code == 200, connected.text

    positions = client.get("/api/positions").json()
    assert len(positions) == 1
    assert positions[0]["symbol"] == "MSTR"
    assert positions[0]["quantity"] == 3.2758

    stock_trades.append(
        {
            "executionId": "new-buy",
            "symbol": "MSTR",
            "side": "BUY",
            "qty": "1.0242",
            "price": "95.00",
            "executionAt": 2,
        }
    )
    refreshed = client.post(f"/api/exchanges/sync?account_id={account_id}&force=true")
    assert refreshed.status_code == 200, refreshed.text
    positions = client.get("/api/positions").json()
    assert positions[0]["quantity"] == 4.3
    assert positions[0]["average_cost"] == 93.011666

    unchanged = client.post(f"/api/exchanges/sync?account_id={account_id}&force=true")
    assert unchanged.status_code == 200, unchanged.text
    positions = client.get("/api/positions").json()
    assert len(positions) == 1
    assert positions[0]["quantity"] == 4.3
    assert positions[0]["price"] == 94.64


def test_binance_credentials_remove_pasted_whitespace_and_invisible_characters():
    assert services_module._clean_binance_credential("  abc\n123\u200b  ") == "abc123"


def test_binance_wallet_total_includes_each_active_wallet():
    payload = [
        {"walletName": "Spot", "balance": "1096.65", "activate": True},
        {"walletName": "Funding", "balance": "413.53", "activate": True},
        {"walletName": "Futures", "balance": "148.86", "activate": True},
        {"walletName": "Inactive", "balance": "999", "activate": False},
    ]

    assert services_module._binance_wallet_total(payload) == services_module.Decimal("1659.04")


def test_binance_spot_average_cost_uses_matching_trade_history():
    trades = [
        {
            "id": 1,
            "time": 1,
            "price": "50000",
            "qty": "0.01",
            "quoteQty": "500",
            "commission": "0",
            "commissionAsset": "BNB",
            "isBuyer": True,
        },
        {
            "id": 2,
            "time": 2,
            "price": "60000",
            "qty": "0.01",
            "quoteQty": "600",
            "commission": "0",
            "commissionAsset": "BNB",
            "isBuyer": True,
        },
        {
            "id": 3,
            "time": 3,
            "price": "65000",
            "qty": "0.005",
            "quoteQty": "325",
            "commission": "0",
            "commissionAsset": "BNB",
            "isBuyer": False,
        },
    ]

    average_cost = services_module._binance_spot_average_cost(
        trades,
        "BTC",
        services_module.Decimal("0.015"),
    )
    assert average_cost == services_module.Decimal("55000")


def test_binance_spot_average_cost_rejects_incomplete_history():
    trades = [
        {
            "id": 1,
            "time": 1,
            "price": "50000",
            "qty": "0.01",
            "quoteQty": "500",
            "commission": "0",
            "commissionAsset": "BNB",
            "isBuyer": True,
        }
    ]

    assert (
        services_module._binance_spot_average_cost(
            trades,
            "BTC",
            services_module.Decimal("0.02"),
        )
        is None
    )


def test_binance_signature_error_has_actionable_message():
    request = services_module.httpx.Request("GET", "https://api.binance.com/api/v3/account")
    response = services_module.httpx.Response(
        400,
        request=request,
        json={"code": -1022, "msg": "Signature for this request is not valid."},
    )

    with pytest.raises(ValueError, match="API Key 與 Secret Key 是同一次建立"):
        services_module._binance_response_payload(response)


def test_binance_rate_limit_uses_server_ban_timestamp():
    request = services_module.httpx.Request("GET", "https://api.binance.com/api/v3/account")
    retry_at = datetime.now(timezone.utc) + timedelta(hours=2)
    retry_ms = int(retry_at.timestamp() * 1000)
    response = services_module.httpx.Response(
        418,
        request=request,
        json={"code": -1003, "msg": f"IP banned until {retry_ms}."},
    )

    with pytest.raises(services_module.BinanceRateLimitError) as caught:
        services_module._binance_response_payload(response)

    assert abs((caught.value.retry_at - retry_at.replace(tzinfo=None)).total_seconds()) < 1


def test_us_market_uses_nasdaq_first_and_daily_cache(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
):
    account_id = create_account(client, "美股投資帳戶")
    position = client.post(
        "/api/positions",
        json={
            "account_id": account_id,
            "market": "US",
            "symbol": "MSTR",
            "name": "Strategy",
            "quantity": 1,
            "average_cost": 90,
            "currency": "USD",
        },
    )
    assert position.status_code == 201, position.text
    monkeypatch.setenv("ALPHA_VANTAGE_API_KEY", "test-key")

    calls: list[str] = []

    class FakeResponse:
        def __init__(self, payload: dict):
            self.payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self.payload

    class FakeMarketClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def get(self, url: str, **kwargs):
            calls.append(url)
            if "alphavantage.co" in url:
                return FakeResponse(
                    {
                        "Information": (
                            "Our standard API rate limit is 25 requests per day."
                        )
                    }
                )
            if "api.nasdaq.com" in url:
                return FakeResponse(
                    {
                        "data": {
                            "currency": "USD",
                            "primaryData": {
                                "lastSalePrice": "$97.74",
                                "lastTradeTimestamp": "Aug 7, 2026 1:28 PM ET",
                            },
                        },
                        "status": {"rCode": 200},
                    }
                )
            return FakeResponse(
                {
                    "chart": {
                        "result": [
                            {
                                "meta": {"currency": "USD"},
                                "timestamp": [
                                    int(
                                        datetime(
                                            2026, 8, 6, tzinfo=timezone.utc
                                        ).timestamp()
                                    )
                                ],
                                "indicators": {
                                    "quote": [{"close": [97.15]}]
                                },
                            }
                        ],
                        "error": None,
                    }
                }
            )

    monkeypatch.setattr(services_module.httpx, "Client", FakeMarketClient)

    refreshed = client.post("/api/market/refresh")
    assert refreshed.status_code == 200, refreshed.text
    payload = refreshed.json()
    assert payload["updated"] == 1
    assert payload["updated_items"] == ["MSTR"]
    assert payload["cached_items"] == []
    assert payload["warnings"] == []
    assert len(calls) == 1

    positions = client.get("/api/positions").json()
    assert positions[0]["price"] == 97.74
    assert positions[0]["price_source"] == "Nasdaq"
    assert positions[0]["price_date"] == "2026-08-07"

    cached = client.post("/api/market/refresh")
    assert cached.status_code == 200, cached.text
    assert cached.json()["skipped"] == 1
    assert cached.json()["cached_items"] == ["MSTR"]
    assert len(calls) == 1

    forced = client.post("/api/market/refresh?force=true")
    assert forced.status_code == 200, forced.text
    assert forced.json()["updated"] == 1
    assert forced.json()["updated_items"] == ["MSTR"]
    assert len(calls) == 2


def test_alpha_vantage_failure_reason_is_not_always_reported_as_quota():
    assert (
        services_module._alpha_vantage_failure_reason(
            {"Error Message": "Invalid API call. Please retry."}
        )
        == "Alpha Vantage 暫時未提供行情"
    )
    assert (
        services_module._alpha_vantage_failure_reason(
            {"Information": "Our standard API rate limit is 25 requests per day."}
        )
        == "Alpha Vantage 今日免費額度已用完"
    )


def test_transfer_does_not_pollute_cashflow(client: TestClient):
    source = create_account(client, "來源帳戶")
    target = create_account(client, "目標帳戶")
    today = date.today().isoformat()
    outgoing = client.post(
        "/api/transactions",
        json={
            "account_id": source,
            "transaction_date": today,
            "description": "轉至投資帳戶",
            "amount": -5000,
            "transaction_kind": "expense",
        },
    ).json()["id"]
    incoming = client.post(
        "/api/transactions",
        json={
            "account_id": target,
            "transaction_date": today,
            "description": "銀行轉入",
            "amount": 5000,
            "transaction_kind": "income",
        },
    ).json()["id"]

    response = client.post(
        "/api/transfers",
        json={"from_transaction_id": outgoing, "to_transaction_id": incoming},
    )
    assert response.status_code == 200
    dashboard = client.get("/api/dashboard").json()
    assert dashboard["month_income"] == 0
    assert dashboard["month_expense"] == 0


def test_account_transfer_is_not_treated_as_unclassified_expense(client: TestClient):
    source = create_account(client, "家中現金")
    target = create_account(client, "生活費帳戶")
    response = client.post(
        "/api/account-transfers",
        json={
            "from_account_id": source,
            "to_account_id": target,
            "transfer_date": date.today().isoformat(),
            "amount": 1000,
            "description": "帳戶轉帳",
        },
    )
    assert response.status_code == 201, response.text

    result = client.post("/api/transactions/reclassify")
    assert result.status_code == 200, result.text
    assert result.json() == {"updated": 0, "remaining": 0}

    rows = client.get("/api/transactions").json()
    assert len(rows) == 2
    assert all(row["transaction_kind"] == "transfer" for row in rows)


def test_csv_import_big5_and_duplicate_detection(client: TestClient):
    account_id = create_account(client, "CSV 帳戶")
    csv_text = "日期,摘要,支出,收入,餘額\n115/07/01,早餐,80,,99920\n115/07/02,薪資,,30000,129920\n"
    content = csv_text.encode("big5")
    mapping = {
        "date": "日期",
        "description": "摘要",
        "debit": "支出",
        "credit": "收入",
        "balance": "餘額",
    }

    files = {"file": ("transactions.csv", io.BytesIO(content), "text/csv")}
    data = {"account_id": str(account_id), "mapping_json": __import__("json").dumps(mapping), "commit": "true"}
    first = client.post("/api/transactions/import", files=files, data=data)
    assert first.status_code == 200, first.text
    assert first.json()["imported"] == 2

    files = {"file": ("transactions.csv", io.BytesIO(content), "text/csv")}
    second = client.post("/api/transactions/import", files=files, data=data)
    assert second.status_code == 200
    assert second.json()["duplicates"] == 2
    assert second.json()["imported"] == 0

    rows = client.get("/api/transactions").json()
    assert len(rows) == 2
    assert sorted(item["base_amount"] for item in rows) == [-80, 30000]


def test_csv_statement_balance_replaces_bank_balance_and_reports_source(client: TestClient):
    account_id = create_account(client, "銀行帳戶")
    statement_date = date.today().isoformat()
    content = (
        "date,description,amount,balance\n"
        f"{statement_date},早餐,-100,99900\n"
        f"{statement_date},薪資,30000,129900\n"
    ).encode("utf-8")
    response = client.post(
        "/api/transactions/import",
        files={"file": ("bank.csv", io.BytesIO(content), "text/csv")},
        data={
            "account_id": str(account_id),
            "mapping_json": __import__("json").dumps(
                {
                    "date": "date",
                    "description": "description",
                    "amount": "amount",
                    "balance": "balance",
                }
            ),
            "commit": "true",
        },
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["balance_source"] == "statement"
    assert result["balance_before"] == 100000
    assert result["balance_after"] == 129900
    assert result["balance_applied_transactions"] == 2
    account = next(item for item in client.get("/api/accounts").json() if item["id"] == account_id)
    assert account["balance"] == 129900


def test_older_csv_statement_does_not_replace_newer_balance(client: TestClient):
    account_id = create_account(client, "銀行帳戶")
    newer_date = (date.today() + timedelta(days=1)).isoformat()
    statement_date = date.today().isoformat()
    client.post(
        f"/api/accounts/{account_id}/balance",
        json={"amount": 150000, "snapshot_date": newer_date, "fx_rate": 1},
    )
    content = f"date,description,amount,balance\n{statement_date},早餐,-100,99900\n".encode("utf-8")
    response = client.post(
        "/api/transactions/import",
        files={"file": ("old-bank.csv", io.BytesIO(content), "text/csv")},
        data={
            "account_id": str(account_id),
            "mapping_json": __import__("json").dumps(
                {
                    "date": "date",
                    "description": "description",
                    "amount": "amount",
                    "balance": "balance",
                }
            ),
            "commit": "true",
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["balance_source"] == "historical_statement"
    assert response.json()["balance_after"] == 150000
    account = next(item for item in client.get("/api/accounts").json() if item["id"] == account_id)
    assert account["balance"] == 150000


def test_csv_import_adjusts_balance_once_and_can_reconcile_existing_rows(client: TestClient):
    account_id = create_account(client, "生活費帳戶")
    content = (
        "date,description,amount,currency\n"
        "2026-07-01,早餐,-100,TWD\n"
        "2026-07-02,交通,-50,TWD\n"
    ).encode("utf-8")
    mapping = {
        "date": "date",
        "description": "description",
        "amount": "amount",
        "currency": "currency",
    }
    data = {
        "account_id": str(account_id),
        "mapping_json": __import__("json").dumps(mapping),
        "commit": "true",
        "adjust_balance": "false",
    }

    first = client.post(
        "/api/transactions/import",
        files={"file": ("transactions.csv", io.BytesIO(content), "text/csv")},
        data=data,
    )
    assert first.status_code == 200, first.text
    assert first.json()["imported"] == 2
    assert first.json()["balance_applied_transactions"] == 0
    account = next(item for item in client.get("/api/accounts").json() if item["id"] == account_id)
    assert account["balance"] == 100000

    pending = client.get("/api/transactions/import-balance/pending").json()
    assert pending == [
        {
            "account_id": account_id,
            "account_name": "生活費帳戶",
            "currency": "TWD",
            "count": 2,
            "balance_change": -150,
            "current_balance": 100000,
            "balance_after": 99850,
        }
    ]

    reconciled = client.post(f"/api/transactions/import-balance/apply/{account_id}")
    assert reconciled.status_code == 200, reconciled.text
    assert reconciled.json()["balance_change"] == -150
    account = next(item for item in client.get("/api/accounts").json() if item["id"] == account_id)
    assert account["balance"] == 99850

    data["adjust_balance"] = "true"
    repeated = client.post(
        "/api/transactions/import",
        files={"file": ("transactions.csv", io.BytesIO(content), "text/csv")},
        data=data,
    )
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["balance_applied_transactions"] == 0
    account = next(item for item in client.get("/api/accounts").json() if item["id"] == account_id)
    assert account["balance"] == 99850


def test_csv_credit_card_expenses_increase_liability_balance(client: TestClient):
    account_id = create_account(client, "信用卡", "liability")
    content = "date,description,amount\n2026-07-01,餐費,-200\n".encode("utf-8")
    mapping = {"date": "date", "description": "description", "amount": "amount"}
    response = client.post(
        "/api/transactions/import",
        files={"file": ("credit-card.csv", io.BytesIO(content), "text/csv")},
        data={
            "account_id": str(account_id),
            "mapping_json": __import__("json").dumps(mapping),
            "commit": "true",
            "adjust_balance": "true",
        },
    )
    assert response.status_code == 200, response.text
    account = next(item for item in client.get("/api/accounts").json() if item["id"] == account_id)
    assert account["balance"] == 12200


def test_reclassify_existing_uncategorized_transactions(client: TestClient):
    account_id = create_account(client, "信用卡", "liability")
    categories = client.get("/api/categories").json()
    uncategorized = next(item for item in categories if item["name"] == "未分類")
    today = date.today().isoformat()

    for description in (
        "APPLE.COM/BILL",
        "統一超商－品冠",
        "國外交易手續費 -APPLE.",
        "ＷｅＭｏＳｃｏｏｔｅ",
        "陌生商家",
    ):
        response = client.post(
            "/api/transactions",
            json={
                "account_id": account_id,
                "transaction_date": today,
                "description": description,
                "amount": -100,
                "transaction_kind": "expense",
                "category_id": uncategorized["id"],
            },
        )
        assert response.status_code == 201, response.text

    result = client.post("/api/transactions/reclassify")
    assert result.status_code == 200, result.text
    assert result.json() == {"updated": 4, "remaining": 1}

    rows = {item["description"]: item["category_name"] for item in client.get("/api/transactions").json()}
    assert rows["APPLE.COM/BILL"] == "訂閱"
    assert rows["統一超商－品冠"] == "餐飲"
    assert rows["國外交易手續費 -APPLE."] == "利息與費用"
    assert rows["ＷｅＭｏＳｃｏｏｔｅ"] == "交通"
    assert rows["陌生商家"] == "未分類"


def test_budget_goal_and_health_score(client: TestClient):
    account = create_account(client, "生活帳戶")
    categories = client.get("/api/categories").json()
    salary = next(item for item in categories if item["name"] == "薪資")
    food = next(item for item in categories if item["name"] == "餐飲")
    today = date.today()
    for offset in (0, 30, 60):
        tx_date = (today - timedelta(days=offset)).isoformat()
        client.post(
            "/api/transactions",
            json={
                "account_id": account,
                "transaction_date": tx_date,
                "description": f"薪資 {offset}",
                "amount": 40000,
                "transaction_kind": "income",
                "category_id": salary["id"],
            },
        )
        client.post(
            "/api/transactions",
            json={
                "account_id": account,
                "transaction_date": tx_date,
                "description": f"餐費 {offset}",
                "amount": -10000,
                "transaction_kind": "expense",
                "category_id": food["id"],
            },
        )

    budget = client.post(
        "/api/budgets",
        json={
            "month": today.strftime("%Y-%m"),
            "category_id": food["id"],
            "amount": 15000,
        },
    )
    assert budget.status_code == 200
    goal = client.post(
        "/api/goals",
        json={"name": "旅遊", "target_amount": 50000, "current_amount": 10000},
    )
    assert goal.status_code == 201

    health = client.get("/api/analysis/health")
    assert health.status_code == 200
    payload = health.json()
    assert payload["completeness"] >= 3
    assert payload["score"] is not None

    filtered_health = client.get("/api/analysis/health?owner=me")
    assert filtered_health.status_code == 200
    assert filtered_health.json()["score"] is not None

    partner_health = client.get("/api/analysis/health?owner=partner")
    assert partner_health.status_code == 200
    assert partner_health.json()["score"] is None


def test_spending_analysis_supports_months_and_recurring_expenses(client: TestClient):
    account = create_account(client, "生活帳戶")
    categories = client.get("/api/categories").json()
    subscription = next(item for item in categories if item["name"] == "訂閱")
    food = next(item for item in categories if item["name"] == "餐飲")
    fees = next(item for item in categories if item["name"] == "利息與費用")
    today = date.today()
    previous_date = today.replace(day=1) - timedelta(days=1)

    transactions = [
        (previous_date, "健身房月費", -999, "expense", subscription["id"]),
        (today, "健身房月費", -999, "expense", subscription["id"]),
        (previous_date, "貸款還款（本金）", -5000, "debt_principal", None),
        (previous_date, "貸款還款（利息）", -500, "interest", fees["id"]),
        (today, "貸款還款（本金）", -5000, "debt_principal", None),
        (today, "貸款還款（利息）", -500, "interest", fees["id"]),
        (previous_date, "家樂福", -100, "expense", food["id"]),
        (today, "家樂福", -800, "expense", food["id"]),
    ]
    for transaction_date, description, amount, kind, category_id in transactions:
        response = client.post(
            "/api/transactions",
            json={
                "account_id": account,
                "transaction_date": transaction_date.isoformat(),
                "description": description,
                "amount": amount,
                "transaction_kind": kind,
                "category_id": category_id,
            },
        )
        assert response.status_code == 201, response.text

    month = today.strftime("%Y-%m")
    response = client.get(f"/api/analysis/spending?month={month}&owner=me")
    assert response.status_code == 200
    payload = response.json()
    assert payload["month"] == month
    assert payload["month_expense"] == 2299
    assert any(
        item["name"] == "訂閱" and item["value"] == 999
        for item in payload["category_expenses"]
    )
    recurring = {item["name"]: item for item in payload["recurring_expenses"]}
    assert recurring["健身房月費"]["average_amount"] == 999
    assert recurring["貸款還款"]["average_amount"] == 5500
    assert recurring["貸款還款"]["category_name"] == "貸款"
    assert "家樂福" not in recurring

    custom = client.post(
        "/api/recurring-expenses",
        json={
            "name": "健身房月費",
            "owner": "me",
            "amount": 1099,
            "account_id": account,
            "category_id": subscription["id"],
        },
    )
    assert custom.status_code == 201
    updated_payload = client.get(
        f"/api/analysis/spending?month={month}&owner=me"
    ).json()
    matching = [
        item
        for item in updated_payload["recurring_expenses"]
        if item["name"] == "健身房月費"
    ]
    assert len(matching) == 1
    assert matching[0]["source"] == "custom"
    assert matching[0]["average_amount"] == 1099
    assert updated_payload["estimated_recurring_total"] == 6599

    ignored = client.post(
        "/api/recurring-expenses/ignore-detected",
        json={"account_id": account, "name": "貸款還款"},
    )
    assert ignored.status_code == 201, ignored.text
    ignored_again = client.post(
        "/api/recurring-expenses/ignore-detected",
        json={"account_id": account, "name": "貸款還款"},
    )
    assert ignored_again.status_code == 201, ignored_again.text
    after_ignore = client.get(
        f"/api/analysis/spending?month={month}&owner=me"
    ).json()
    assert all(
        item["name"] != "貸款還款"
        for item in after_ignore["recurring_expenses"]
    )
    assert after_ignore["estimated_recurring_total"] == 1099

    assert client.get("/api/analysis/spending?month=not-a-month").status_code == 422


def test_custom_recurring_expense_crud_and_analysis_override(client: TestClient):
    account = create_account(client, "房貸扣款帳戶")
    categories = client.get("/api/categories").json()
    housing = next(item for item in categories if item["name"] == "居住")

    created = client.post(
        "/api/recurring-expenses",
        json={
            "name": "房貸",
            "owner": "me",
            "amount": 18000,
            "due_day": 5,
            "account_id": account,
            "category_id": housing["id"],
            "note": "每月自動扣款",
        },
    )
    assert created.status_code == 201, created.text
    expense_id = created.json()["id"]

    listed = client.get("/api/recurring-expenses?owner=me")
    assert listed.status_code == 200
    assert listed.json()[0]["name"] == "房貸"
    assert listed.json()[0]["due_day"] == 5

    month = date.today().strftime("%Y-%m")
    analysis = client.get(f"/api/analysis/spending?month={month}&owner=me")
    assert analysis.status_code == 200
    recurring = analysis.json()["recurring_expenses"]
    assert len(recurring) == 1
    assert recurring[0]["source"] == "custom"
    assert recurring[0]["average_amount"] == 18000
    assert analysis.json()["estimated_recurring_total"] == 18000

    updated = client.patch(
        f"/api/recurring-expenses/{expense_id}",
        json={"amount": 17500, "due_day": 8},
    )
    assert updated.status_code == 200
    assert updated.json()["amount"] == 17500
    assert updated.json()["due_day"] == 8

    deleted = client.delete(f"/api/recurring-expenses/{expense_id}")
    assert deleted.status_code == 200
    assert client.get("/api/recurring-expenses?owner=me").json() == []


def test_classification_rules_can_be_filtered_and_edited(client: TestClient):
    rules = client.get("/api/rules")
    assert rules.status_code == 200
    assert any(item["is_default"] for item in rules.json())

    categories = client.get("/api/categories").json()
    shopping = next(item for item in categories if item["name"] == "購物")
    created = client.post(
        "/api/rules",
        json={
            "keyword": "測試商店",
            "category_id": shopping["id"],
            "transaction_kind": "expense",
            "priority": 100,
        },
    )
    assert created.status_code == 200, created.text
    rule_id = created.json()["id"]

    updated = client.patch(
        f"/api/rules/{rule_id}",
        json={"keyword": "測試網路商店", "enabled": True},
    )
    assert updated.status_code == 200, updated.text
    row = next(item for item in client.get("/api/rules").json() if item["id"] == rule_id)
    assert row["keyword"] == "測試網路商店"
    assert row["is_default"] is False

    assert client.delete(f"/api/rules/{rule_id}").status_code == 200


def test_credit_card_email_rule_crud_is_scoped_and_hides_pdf_password(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("FINANCE_CREDENTIAL_SECRET", "email-rule-test-secret")
    payment_account = create_account(client, "生活費帳戶")
    card_account = create_account(client, "國泰信用卡", "liability")

    missing_filter = client.post(
        "/api/email/card-rules",
        json={
            "name": "國泰信用卡",
            "card_account_id": card_account,
            "payment_account_id": payment_account,
        },
    )
    assert missing_filter.status_code == 422

    created = client.post(
        "/api/email/card-rules",
        json={
            "name": "國泰信用卡",
            "owner": "partner",
            "card_account_id": card_account,
            "payment_account_id": payment_account,
            "sender_pattern": "cathaybk.com.tw",
            "subject_pattern": "信用卡",
            "card_last4": "1234",
            "auto_pay": True,
            "statement_password": "A123456789",
        },
    )
    assert created.status_code == 201, created.text
    rule = created.json()
    assert rule["owner"] == "me"
    assert rule["statement_password_configured"] is True
    assert "statement_password" not in rule

    listed = client.get("/api/email/card-rules")
    assert listed.status_code == 200
    assert listed.json()[0]["sender_pattern"] == "cathaybk.com.tw"

    deactivated = client.delete(f"/api/email/card-rules/{rule['id']}")
    assert deactivated.status_code == 200
    assert client.get("/api/email/card-rules").json()[0]["active"] is False
