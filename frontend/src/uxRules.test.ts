import { describe, expect, it } from "vitest";
import { makeRecommendations } from "./pages/AnalysisPage";
import { investmentTradeValidation } from "./pages/InvestmentsPage";
import { friendlyExchangeMessage } from "./pages/SettingsPage";
import { categoriesForTransactionKind } from "./pages/TransactionsPage";
import type { Category, HealthScore } from "./types";

const categories: Category[] = [
  { id: 1, name: "薪資", kind: "income", essential: false, color: "#0a0", icon: "briefcase" },
  { id: 2, name: "獎金與其他收入", kind: "income", essential: false, color: "#0b0", icon: "sparkles" },
  { id: 3, name: "餐飲", kind: "expense", essential: true, color: "#f80", icon: "utensils" },
];

describe("scenario-aware transaction categories", () => {
  it("keeps income and expense categories separate", () => {
    expect(categoriesForTransactionKind(categories, "income").map((item) => item.name)).toEqual(["薪資", "獎金與其他收入"]);
    expect(categoriesForTransactionKind(categories, "expense").map((item) => item.name)).toEqual(["餐飲"]);
  });
});

describe("investment trade guardrails", () => {
  it("requires quantity and proceeds and prevents overselling", () => {
    expect(investmentTradeValidation({ side: "sell", quantity: 0, totalAmount: 100, availableQuantity: 2 }).valid).toBe(false);
    expect(investmentTradeValidation({ side: "sell", quantity: 3, totalAmount: 100, availableQuantity: 2 }).valid).toBe(false);
    expect(investmentTradeValidation({ side: "sell", quantity: 2, totalAmount: 100, availableQuantity: 2 }).valid).toBe(true);
  });
});

describe("analysis recommendations", () => {
  it("does not ask for income when income-based indicators are already valid", () => {
    const health: HealthScore = {
      score: null,
      completeness: 1,
      components: [
        { key: "savings", label: "儲蓄率", value: 82.5, score: null, detail: "" },
        { key: "debt", label: "負債支出比", value: 0, score: null, detail: "" },
        { key: "emergency", label: "緊急預備金", value: 12, score: null, detail: "" },
      ],
    };
    expect(makeRecommendations(health)).not.toContain("補上最近三個月的收入交易，才能計算儲蓄率、必要支出比與債務支出比。");
  });
});

describe("exchange error messages", () => {
  it("turns Binance request-weight errors into actionable Chinese", () => {
    const result = friendlyExchangeMessage("Way too much request weight used; IP banned until 1787137798293.");
    expect(result).toContain("幣安請求過於頻繁");
    expect(result).toContain("系統會自動重試");
    expect(result).not.toContain("request weight");
  });
});
