// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import AccountsPage from "./pages/AccountsPage";
import InvestmentsPage from "./pages/InvestmentsPage";
import AnalysisPage from "./pages/AnalysisPage";
import DashboardPage from "./pages/DashboardPage";
import TransactionsPage from "./pages/TransactionsPage";
import SettingsPage from "./pages/SettingsPage";
import { api } from "./api";
vi.mock("./api", () => ({ api: vi.fn(), apiBlob: vi.fn() }));
beforeEach(() => { localStorage.clear(); vi.mocked(api).mockRejectedValue(new Error("測試連線失敗")); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function show(page: ReactElement, cached?: { key: string[]; data: unknown }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (cached) client.setQueryData(cached.key, cached.data);
  render(<MemoryRouter><QueryClientProvider client={client}>{page}</QueryClientProvider></MemoryRouter>);
}
it("does not pretend failed accounts are an empty account list", async () => {
  show(<AccountsPage />);
  await screen.findByText("帳戶資料暫時無法更新");
  expect(screen.queryByText("新增第一個帳戶")).toBeNull();
});
it("preserves cached account information when refetch fails", async () => {
  show(<AccountsPage />, { key: ["accounts", "all", "including-archived"], data: [{ id: 1, name: "保留的生活費", account_type: "bank", nature: "asset", currency: "TWD", owner: "me", owner_label: "我", balance: 1234, balance_twd: 1234, total_value_twd: 1234, archived: false, linked_email_rules: [] }] });
  await screen.findByText("帳戶資料暫時無法更新");
  expect(screen.getByRole("heading", { name: "保留的生活費" })).toBeTruthy();
});
it("shows an explicit investments load failure", async () => {
  show(<InvestmentsPage />);
  await screen.findByText("持倉資料載入失敗");
  expect(screen.getByRole("button", { name: "重新載入" })).toBeTruthy();
});
it("shows an explicit analysis load failure", async () => {
  show(<AnalysisPage />);
  await screen.findByText("財務分析載入失敗");
  expect(screen.queryByText("NT$0")).toBeNull();
});
it("shows an explicit dashboard load failure", async () => {
  show(<DashboardPage />);
  await screen.findByText(/無法載入財務資料|財務資料載入失敗|總覽.*載入失敗/);
  expect(screen.queryByText("NT$0")).toBeNull();
});
it("does not describe failed transaction loading as an empty month", async () => {
  show(<TransactionsPage />);
  await screen.findByText("交易資料載入失敗");
  expect(screen.queryByText("這個月份沒有交易")).toBeNull();
});
it("distinguishes settings load failure from disconnected services", async () => {
  show(<SettingsPage />);
  await screen.findByText(/部分設定暫時無法更新/);
  expect(screen.queryByText("尚未連接 Gmail")).toBeNull();
  expect(screen.getByRole("button", { name: "重新載入設定" })).toBeTruthy();
});
