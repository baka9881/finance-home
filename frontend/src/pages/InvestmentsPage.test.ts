import { describe, expect, it } from "vitest";
import type { Position } from "../types";
import { exchangeSyncWarnings, investmentTotals } from "./InvestmentsPage";

function position(overrides: Partial<Position>): Position {
  return {
    id: 1,
    account_id: 1,
    account_name: "測試帳戶",
    owner: "me",
    owner_label: "我",
    market: "US",
    symbol: "MSTR",
    quantity: 1,
    display_quantity: 1,
    average_cost: 100,
    currency: "USD",
    price: 120,
    price_source: "test",
    stale: false,
    fx_estimated: false,
    market_value: 120,
    market_value_twd: 3_840,
    asset_value_twd: 3_840,
    included_in_totals: true,
    instrument_type: "asset",
    cost_twd: 3_200,
    cost_status: "automatic",
    cost_note: "",
    profit_twd: 640,
    ...overrides,
  };
}

describe("investmentTotals", () => {
  it("顯示合約損益，但不把名目價值當成資產", () => {
    const totals = investmentTotals([
      position({}),
      position({
        id: 2,
        market: "BINANCE_FUTURES",
        symbol: "BTCUSDT",
        quantity: 0.02,
        display_quantity: 0.02,
        market_value_twd: 38_400,
        asset_value_twd: 0,
        included_in_totals: false,
        instrument_type: "futures",
        direction: "long",
        cost_twd: 0,
        profit_twd: 3_200,
      }),
    ]);

    expect(totals).toEqual({ value: 3_840, cost: 3_200, profit: 3_840, futures: 1 });
  });
});

describe("exchangeSyncWarnings", () => {
  it("surfaces nested Binance warnings on the investments refresh", () => {
    expect(exchangeSyncWarnings({
      connected: 1,
      updated: 1,
      skipped: 0,
      errors: [],
      results: [
        { warnings: ["暫時無法讀取合約錢包持倉"] },
        { warnings: ["合約 API 權限不足"] },
      ],
    })).toEqual(["暫時無法讀取合約錢包持倉", "合約 API 權限不足"]);
  });
});
