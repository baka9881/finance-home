from __future__ import annotations

import io
from datetime import date, timedelta

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
    monkeypatch.setattr(
        services_module,
        "_fetch_binance_spot_snapshot",
        lambda _key, _secret: (
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
        ),
    )
    connected = client.post(
        "/api/exchanges/binance/connect",
        json={"account_id": account_id, "api_key": "read-only-key", "api_secret": "read-only-secret"},
    )
    assert connected.status_code == 200, connected.text

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
        lambda _key, _secret: (
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
        lambda _key, _secret: (
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
        lambda _key, _secret: (
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


def test_binance_signature_error_has_actionable_message():
    request = services_module.httpx.Request("GET", "https://api.binance.com/api/v3/account")
    response = services_module.httpx.Response(
        400,
        request=request,
        json={"code": -1022, "msg": "Signature for this request is not valid."},
    )

    with pytest.raises(ValueError, match="API Key 與 Secret Key 是同一次建立"):
        services_module._binance_response_payload(response)


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
