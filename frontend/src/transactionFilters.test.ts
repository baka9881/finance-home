// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { readTransactionFilters, saveTransactionFilters, transactionFilterParams } from "./transactionFilters";

describe("transaction filters", () => {
  beforeEach(() => sessionStorage.clear());
  it("restores filters and round trips explicit URL state without stale saved values", () => {
    const filters = { month: "2026-07", account: "3", search: "咖啡", onlyUnclassified: true, showTransfers: true, excluded: false, page: 3 };
    saveTransactionFilters(filters);
    expect(readTransactionFilters(new URLSearchParams())).toEqual(filters);
    const changed = { ...filters, month: "", search: "", onlyUnclassified: false, page: 1 };
    expect(readTransactionFilters(transactionFilterParams(changed))).toEqual(changed);
  });
  it("preserves quick action parameters and validates invalid months", () => {
    const filters = readTransactionFilters(new URLSearchParams("month=2026-07"));
    expect(transactionFilterParams(filters, new URLSearchParams("quick=expense")).get("quick")).toBe("expense");
    expect(readTransactionFilters(new URLSearchParams("month=2026-99")).month).not.toBe("2026-99");
  });
});
