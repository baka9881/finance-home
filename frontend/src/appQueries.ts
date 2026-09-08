import type { QueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { taipeiMonthInputValue } from "./date";
import type { Account, Category, Dashboard, HealthScore, Position, TransactionPage } from "./types";

export const APP_QUERY_STALE_TIME = 5 * 60_000;
export const APP_QUERY_GC_TIME = 30 * 60_000;

// Every accounting change can affect more than the currently visible page.
// Keep this dependency list shared by manual changes and background imports.
export const FINANCE_QUERY_KEYS = [
  "accounts", "positions", "transactions", "dashboard", "health", "spending-analysis",
  "pending-csv-balances", "transfer-suggestions", "credit-card-bills", "credit-card-cycles",
  "recurring-expenses", "ignored-recurring-expenses", "account-balances", "attention",
] as const;

export function invalidateFinanceData(client: QueryClient, additionalKeys: string[] = []) {
  const keys = new Set<string>([...FINANCE_QUERY_KEYS, ...additionalKeys]);
  return client.invalidateQueries({ predicate: (query) => keys.has(String(query.queryKey[0])) });
}

export function preloadPageModules() {
  return Promise.allSettled([
    import("./pages/AccountsPage"),
    import("./pages/TransactionsPage"),
    import("./pages/InvestmentsPage"),
    import("./pages/AnalysisPage"),
    import("./pages/SettingsPage"),
  ]);
}

export function prefetchPrimaryData(client: QueryClient, owner: string) {
  const month = taipeiMonthInputValue();
  return Promise.allSettled([
    client.prefetchQuery({
      queryKey: ["dashboard", owner],
      queryFn: () => api<Dashboard>(`/dashboard?owner=${owner}`),
    }),
    client.prefetchQuery({
      queryKey: ["accounts", owner],
      queryFn: () => api<Account[]>(`/accounts?owner=${owner}`),
    }),
    client.prefetchQuery({
      queryKey: ["positions", owner],
      queryFn: () => api<Position[]>(`/positions?owner=${owner}`),
    }),
    client.prefetchQuery({
      queryKey: ["transactions", "page", month, "", owner, "", false, false, 1, false],
      queryFn: () => api<TransactionPage>(`/transactions/page?month=${month}&owner=${owner}`),
    }),
    client.prefetchQuery({
      queryKey: ["categories"],
      queryFn: () => api<Category[]>("/categories"),
    }),
  ]);
}

export function prefetchSecondaryData(client: QueryClient, owner: string) {
  return Promise.allSettled([
    client.prefetchQuery({
      queryKey: ["health", owner],
      queryFn: () => api<HealthScore>(`/analysis/health?owner=${owner}`),
    }),
    client.prefetchQuery({
      queryKey: ["dashboard", owner],
      queryFn: () => api<Dashboard>(`/dashboard?owner=${owner}`),
    }),
    client.prefetchQuery({
      queryKey: ["settings"],
      queryFn: () => api("/settings"),
    }),
    client.prefetchQuery({
      queryKey: ["fx"],
      queryFn: () => api("/fx"),
    }),
    client.prefetchQuery({
      queryKey: ["rules"],
      queryFn: () => api("/rules"),
    }),
  ]);
}
