import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { FINANCE_QUERY_KEYS, invalidateFinanceData } from "./appQueries";

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
});
