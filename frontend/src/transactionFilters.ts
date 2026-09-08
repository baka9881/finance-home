import { taipeiMonthInputValue } from "./date";

export interface TransactionFilters {
  month: string; account: string; search: string; onlyUnclassified: boolean; showTransfers: boolean; page: number; excluded: boolean;
}
export const TRANSACTION_FILTER_KEY = "finance.transaction-filters.v2";
export function readTransactionFilters(params: URLSearchParams): TransactionFilters {
  let saved: Partial<TransactionFilters> = {};
  try { saved = JSON.parse(sessionStorage.getItem(TRANSACTION_FILTER_KEY) || "{}"); } catch { /* storage unavailable */ }
  const month = params.get("month") ?? saved.month ?? taipeiMonthInputValue();
  return {
    month: month === "all" || month === "" ? "" : /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : taipeiMonthInputValue(),
    account: params.get("account") ?? saved.account ?? "",
    search: params.get("search") ?? saved.search ?? "",
    onlyUnclassified: params.has("unclassified") ? params.get("unclassified") === "1" : saved.onlyUnclassified ?? false,
    showTransfers: params.has("transfers") ? params.get("transfers") === "1" : saved.showTransfers ?? false,
    page: Math.max(1, Number(params.get("page") ?? saved.page) || 1),
    excluded: params.has("excluded") ? params.get("excluded") === "1" : saved.excluded ?? false,
  };
}
export function saveTransactionFilters(filters: TransactionFilters) {
  try { sessionStorage.setItem(TRANSACTION_FILTER_KEY, JSON.stringify(filters)); } catch { /* private browsing */ }
}

export function transactionFilterParams(filters: TransactionFilters, current = new URLSearchParams()) {
  const params = new URLSearchParams(current);
  params.set("month", filters.month || "all");
  params.set("account", filters.account);
  params.set("search", filters.search);
  params.set("unclassified", filters.onlyUnclassified ? "1" : "0");
  params.set("transfers", filters.showTransfers ? "1" : "0");
  params.set("excluded", filters.excluded ? "1" : "0");
  params.set("page", String(filters.page));
  return params;
}

export function transactionSourceLabel(source: string) {
  return ({ gmail: "郵件匯入", csv: "CSV 匯入", manual: "手動記帳", gmail_payment: "繳款記帳", gmail_autopay: "繳款記帳", investment: "投資記錄" } as Record<string, string>)[source] || "系統記帳";
}
