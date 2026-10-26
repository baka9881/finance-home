from decimal import Decimal

import pytest

from app import services


def fill(trade_id, quantity, cost, *, timestamp=1, quote="USDT", buyer=True,
         commission="0", commission_asset="USDT"):
    return {
        "id": trade_id, "time": timestamp, "qty": quantity, "quoteQty": cost,
        "commission": commission, "commissionAsset": commission_asset,
        "isBuyer": buyer, "_quote_asset": quote,
    }


def test_crypto_history_paginates_from_oldest_fill_and_keeps_pair_local_ids():
    seen = []

    def handler(request):
        symbol = request.url.params["symbol"]
        start = int(request.url.params["fromId"])
        seen.append((symbol, start))
        if symbol == "BTCUSDT" and start == 0:
            rows = [fill(index, "0.00001", "0.50") for index in range(1000)]
        elif symbol == "BTCUSDT" and start == 1000:
            rows = [fill(1000, "0.01", "600", timestamp=2)]
        else:
            rows = [fill(0, "0.01", "700", timestamp=3)]
        return services.httpx.Response(200, json=rows, request=request)

    with services.httpx.Client(transport=services.httpx.MockTransport(handler)) as client:
        trades = services._fetch_binance_spot_trades(client, "test", 0, "BTCUSDT", "USDT")
        trades += services._fetch_binance_spot_trades(client, "test", 0, "BTCUSDC", "USDC")
    assert seen == [("BTCUSDT", 0), ("BTCUSDT", 1000), ("BTCUSDC", 0)]
    assert len(trades) == 1002
    assert services._binance_spot_average_cost(trades, "BTC", Decimal("0.03")) == Decimal("60000")


def test_crypto_history_rejects_repeating_full_page():
    def handler(request):
        return services.httpx.Response(
            200, json=[fill(index, "0.001", "50") for index in range(1000)], request=request,
        )

    with services.httpx.Client(transport=services.httpx.MockTransport(handler)) as client:
        with pytest.raises(ValueError, match="分頁沒有繼續前進"):
            services._fetch_binance_spot_trades(client, "test", 0, "BTCUSDT", "USDT")


def test_crypto_cost_merges_markets_in_time_order_and_includes_base_and_quote_fees():
    trades = [
        fill(1, "0.01", "600", timestamp=2, quote="USDC", commission="0.001", commission_asset="BTC"),
        fill(1, "0.01", "500", timestamp=1, quote="USD1", commission="1", commission_asset="USD1"),
        fill(2, "0.004", "300", timestamp=3, quote="USDC", buyer=False, commission="0.001", commission_asset="BTC"),
    ]
    average = services._binance_spot_average_cost(trades, "BTC", Decimal("0.014"))
    assert average is not None
    assert abs(average - Decimal("1101") / Decimal("0.019")) < Decimal("0.00000000000000000001")
    assert "USD1" in services.BINANCE_CASH_ASSETS


def test_crypto_cost_does_not_invent_a_historical_conversion_for_bnb_fees():
    trades = [fill(1, "0.01", "500", commission="0.001", commission_asset="BNB")]
    assert services._binance_spot_average_cost(trades, "BTC", Decimal("0.01")) is None


@pytest.mark.parametrize("complete", [False, True])
def test_crypto_snapshot_validates_cost_against_unified_and_spot_total(monkeypatch, complete):
    real_client = services.httpx.Client
    requested_pairs = []

    def handler(request):
        path = request.url.path
        if path == "/api/v3/time":
            payload = {"serverTime": 1800000000000}
        elif path == "/api/v3/account":
            payload = {"balances": [{"asset": "BTC", "free": "0.00412587", "locked": "0"}]}
        elif path == "/sapi/v1/asset/wallet/balance":
            payload = [
                {"activate": True, "walletName": "Unified", "balance": "800", "assetBalances": [
                    {"asset": "BTC", "free": "0.01087834", "locked": "0"}]},
                {"activate": True, "walletName": "Spot", "balance": "300", "assetBalances": [
                    {"asset": "BTC", "free": "0.00412587", "locked": "0"}]},
            ]
        elif path in {
            "/sapi/v1/asset/get-funding-asset", "/papi/v1/um/positionRisk",
            "/fapi/v3/balance", "/dapi/v1/balance",
        }:
            payload = []
        elif path == "/sapi/v1/equity/trade/history":
            payload = {"rows": [], "total": 0}
        elif path == "/api/v3/ticker/price":
            payload = [{"symbol": "BTC" + quote, "price": "80000"} for quote in ("USDT", "USDC", "USD1")]
        elif path == "/api/v3/myTrades":
            pair = request.url.params["symbol"]
            assert request.url.params["fromId"] == "0"
            requested_pairs.append(pair)
            payload = []
            if pair == "BTCUSDT":
                payload = [fill(1, "0.00412587", "271.36")]
            elif pair == "BTCUSDC" and complete:
                payload = [fill(1, "0.01087834", "760", quote="USDC")]
        else:
            raise AssertionError(f"Unexpected path: {path}")
        return services.httpx.Response(200, json=payload, request=request)

    monkeypatch.setattr(
        services.httpx, "Client",
        lambda **kwargs: real_client(transport=services.httpx.MockTransport(handler), **kwargs),
    )
    snapshot = services._fetch_binance_spot_snapshot("test-key", "test-secret")
    wallet = snapshot[7][0]
    assert set(requested_pairs) == {"BTCUSDT", "BTCUSDC", "BTCUSD1"}
    assert wallet["free"] == Decimal("0.01500421")
    if complete:
        assert wallet["_cost_status"] == "automatic"
        assert wallet["_cost_quantity"] == "0.01500421"
        assert Decimal(wallet["_average_cost"]) == Decimal("1031.36") / Decimal("0.01500421")
    else:
        assert "_average_cost" not in wallet
        assert wallet["_cost_status"] == "estimated"
        assert any("全部錢包餘額" in warning for warning in snapshot[8])
