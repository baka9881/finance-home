// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../api";
import { rememberTransactionAccount } from "../QuickTransactionForm";
import type { Account, TransactionPage } from "../types";
import TransactionsPage from "./TransactionsPage";

vi.mock("../api", () => ({ api: vi.fn() }));

const accounts = [
  { id: 1, name: "現金", account_type: "cash", nature: "asset", currency: "TWD", owner: "me", owner_label: "我" },
  { id: 2, name: "生活帳戶", account_type: "bank", nature: "asset", currency: "TWD", owner: "me", owner_label: "我" },
  { id: 3, name: "學貸", account_type: "loan", nature: "liability", currency: "TWD", owner: "me", owner_label: "我" },
] as Account[];

const emptyPage: TransactionPage = {
  items: [], total: 0, page: 1, page_size: 50, matched_total: 0, transfer_count: 0, unclassified_count: 0,
};

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

function showTransactions() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={["/transactions?month=2026-08&search=&unclassified=0&excluded=0&page=1"]}>
      <QueryClientProvider client={client}>
        <TransactionsPage />
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  Object.defineProperty(window, "scrollY", { configurable: true, value: 720 });
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => { callback(0); return 1; },
  });
  Object.defineProperty(window, "cancelAnimationFrame", { configurable: true, value: vi.fn() });
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (options?.method === "POST" && path === "/transactions") return {};
    if (options?.method === "POST" && path === "/account-transfers") return {};
    if (options?.method === "POST" && path === "/loan-payments") return {};
    if (path.startsWith("/accounts?")) return accounts;
    if (path === "/categories") return [];
    if (path.startsWith("/transactions/page?")) return emptyPage;
    if (path.startsWith("/transactions/import-balance/pending?")) return [];
    throw new Error(`Unexpected API call: ${path}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("keeps the selected month and list position after saving a quick expense", async () => {
  showTransactions();
  const user = userEvent.setup();

  await screen.findByText("這個月份沒有交易");
  await user.click(screen.getByRole("button", { name: "新增交易" }));
  await user.type(screen.getByRole("spinbutton", { name: "花費金額" }), "80");
  await user.type(screen.getByRole("textbox", { name: "摘要" }), "午餐");
  await user.click(screen.getByRole("button", { name: "儲存支出" }));

  await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith(
    "/transactions",
    expect.objectContaining({ method: "POST" }),
  ));
  await waitFor(() => expect(window.scrollTo).toHaveBeenCalledWith({ top: 720, behavior: "instant" }));
  expect(screen.getByTestId("location").textContent).toContain("month=2026-08");
  expect(localStorage.getItem("finance.recent-transaction-account.v2.all.expense")).toBe("1");
});

it("keeps transaction type choices visible in the transfer dialog and switches back", async () => {
  showTransactions();
  const user = userEvent.setup();

  await screen.findByText("這個月份沒有交易");
  await user.click(screen.getByRole("button", { name: "新增交易" }));
  await user.click(within(screen.getByRole("group", { name: "交易類型" })).getByRole("button", { name: "轉帳" }));

  expect(await screen.findByRole("combobox", { name: "轉出帳戶" })).toBeTruthy();
  const typeChoices = screen.getByRole("group", { name: "交易類型" });
  expect(within(typeChoices).getAllByRole("button").map((button) => button.textContent)).toEqual(["支出", "收入", "轉帳", "還款"]);
  expect(within(typeChoices).getByRole("button", { name: "轉帳" }).getAttribute("aria-pressed")).toBe("true");

  await user.click(within(typeChoices).getByRole("button", { name: "收入" }));

  expect(await screen.findByRole("spinbutton", { name: "收到金額" })).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "轉出帳戶" })).toBeNull();
});

it("restores and remembers both transfer accounts", async () => {
  rememberTransactionAccount("all", "transfer:from", 2);
  rememberTransactionAccount("all", "transfer:to", 1);
  showTransactions();
  const user = userEvent.setup();

  await screen.findByText("這個月份沒有交易");
  await user.click(screen.getByRole("button", { name: "新增交易" }));
  await user.click(screen.getByRole("button", { name: "轉帳" }));

  await waitFor(() => expect((screen.getByRole("combobox", { name: "轉出帳戶" }) as HTMLSelectElement).value).toBe("2"));
  expect((screen.getByRole("combobox", { name: "轉入帳戶" }) as HTMLSelectElement).value).toBe("1");
  await user.type(screen.getByRole("spinbutton", { name: /轉出金額/ }), "500");
  await user.click(screen.getByRole("button", { name: "建立轉帳" }));

  await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith(
    "/account-transfers",
    expect.objectContaining({ method: "POST" }),
  ));
  expect(localStorage.getItem("finance.recent-transaction-account.v2.all.transfer:from")).toBe("2");
  expect(localStorage.getItem("finance.recent-transaction-account.v2.all.transfer:to")).toBe("1");
});

it("restores and remembers the payment and loan accounts for repayments", async () => {
  rememberTransactionAccount("all", "loan_payment:payment", 2);
  rememberTransactionAccount("all", "loan_payment:loan", 3);
  showTransactions();
  const user = userEvent.setup();

  await screen.findByText("這個月份沒有交易");
  await user.click(screen.getByRole("button", { name: "新增交易" }));
  await user.click(screen.getByRole("button", { name: "還款" }));

  await waitFor(() => expect((screen.getByRole("combobox", { name: "付款帳戶" }) as HTMLSelectElement).value).toBe("2"));
  expect((screen.getByRole("combobox", { name: "貸款帳戶" }) as HTMLSelectElement).value).toBe("3");
  await user.type(screen.getByRole("textbox", { name: "摘要" }), "學貸還款");
  await user.type(screen.getByRole("spinbutton", { name: "本金" }), "900");
  await user.type(screen.getByRole("spinbutton", { name: "利息" }), "100");
  await user.click(screen.getByRole("button", { name: "儲存還款" }));

  await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith(
    "/loan-payments",
    expect.objectContaining({ method: "POST" }),
  ));
  expect(localStorage.getItem("finance.recent-transaction-account.v2.all.loan_payment:payment")).toBe("2");
  expect(localStorage.getItem("finance.recent-transaction-account.v2.all.loan_payment:loan")).toBe("3");
});
