import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { FINANCE_QUERY_KEYS, invalidateFinanceData, invalidateFinanceDataSubset } from "./appQueries";

describe("cross-page accounting updates", () => {
  it("invalidates every dependent view, all months and owners, but not unrelated preferences", async () => {
    const client = new QueryClient();
    for (const key of FINANCE_QUERY_KEYS) {
      for (const owner of ["me", "partner"]) client.setQueryData([key, owner, "2026-08"], []);
    }
    client.setQueryData(["settings"], { theme: "light" });
    client.setQueryData(["gmail-status"], {});
    await invalidateFinanceData(client, ["gmail-status"]);
    for (const key of FINANCE_QUERY_KEYS) for (const owner of ["me", "partner"]) {
      expect(client.getQueryState([key, owner, "2026-08"])?.isInvalidated).toBe(true);
    }
    expect(client.getQueryState(["gmail-status"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["settings"])?.isInvalidated).toBe(false);
    client.clear();
  });

  it("can refresh only the queries affected by a fast account edit", async () => {
    const client = new QueryClient();
    client.setQueryData(["accounts", "me"], []);
    client.setQueryData(["dashboard", "me"], {});
    client.setQueryData(["health", "me"], {});
    client.setQueryData(["attention", "me"], []);
    client.setQueryData(["transactions", "page"], []);

    await invalidateFinanceDataSubset(client, ["accounts", "dashboard", "health", "attention"]);

    expect(client.getQueryState(["accounts", "me"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["dashboard", "me"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["health", "me"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["attention", "me"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["transactions", "page"])?.isInvalidated).toBe(false);
    client.clear();
  });
});
