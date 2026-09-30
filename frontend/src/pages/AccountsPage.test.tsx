// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../api";
import AccountsPage from "./AccountsPage";

vi.mock("../api", () => ({ api: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/accounts?owner=all&include_archived=true") {
      return [{
        id: 1,
        name: "國泰世華銀行 信用卡",
        institution: "國泰世華銀行",
        account_type: "credit_card",
        nature: "liability",
        currency: "TWD",
        owner: "me",
        owner_label: "我",
        is_liquid: false,
        balance_includes_positions: false,
        valuation_mode: "cash_plus_positions",
        archived: false,
        linked_email_rules: ["國泰信用卡"],
        balance: 14027,
        balance_twd: 14027,
        balance_date: "2026-09-24",
        investments_twd: 0,
        total_twd: -14027,
        positions_count: 0,
      }];
    }
    if (path === "/email/card-cycles") {
      return [{
        rule_id: 1,
        rule_name: "國泰信用卡",
        card_account_id: 1,
        card_account_name: "國泰世華銀行 信用卡",
        currency: "TWD",
        closing_day: null,
        cycle_boundary_known: false,
        payment_due_day: 23,
        current_cycle: null,
        unbilled: { amount: 14027, transaction_count: 5, period_start: null, period_end: null },
        next_cycle: { amount: 0, transaction_count: 0, period_start: null, period_end: null },
        current_bill: null,
        last_paid_bill: null,
      }];
    }
    throw new Error(`Unexpected API call: ${path}`);
  });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("keeps the credit-card summary compact and gives clear next actions", async () => {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AccountsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );

  const card = await screen.findByRole("region", { name: "國泰世華銀行 信用卡 帳戶摘要" });
  expect(within(card).getByText("目前欠款")).toBeTruthy();
  expect(await within(card).findByText("本期應繳")).toBeTruthy();
  expect(within(card).getByText("尚無待繳")).toBeTruthy();
  expect(within(card).getByText("未出帳")).toBeTruthy();
  expect(within(card).getByText("每月 23 日繳款")).toBeTruthy();
  expect(within(card).getByRole("link", { name: "設定結帳日" })).toBeTruthy();
  const detailButton = within(card).getByRole("button", { name: "帳單明細" });
  expect(within(card).getByRole("link", { name: "查看消費" }).getAttribute("href")).toContain("account=1");
  expect(within(card).queryByRole("button", { name: /更新餘額|更新負債/ })).toBeNull();
  expect(within(card).queryByText("國泰世華銀行")).toBeNull();
  expect(within(card).queryByText("TWD")).toBeNull();
  expect(within(card).queryByText(/負債依消費與繳款記錄更新/)).toBeNull();
  expect(within(card).queryByText(/帳期範圍等待正式帳單確認/)).toBeNull();

  await user.click(detailButton);
  expect((document.getElementById("card-cycle-1") as HTMLDetailsElement).open).toBe(true);
  expect(vi.mocked(api).mock.calls.filter(([path]) => path === "/email/card-cycles")).toHaveLength(1);
});

it("keeps a manual credit card editable without showing sync actions", async () => {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/accounts?owner=all&include_archived=true") {
      return [{
        id: 2,
        name: "手動信用卡",
        institution: "",
        account_type: "credit_card",
        nature: "liability",
        currency: "TWD",
        owner: "me",
        owner_label: "我",
        is_liquid: false,
        balance_includes_positions: false,
        valuation_mode: "cash_plus_positions",
        archived: false,
        linked_email_rules: [],
        balance: 3000,
        balance_twd: 3000,
        balance_date: "2026-09-24",
        investments_twd: 0,
        total_twd: -3000,
        positions_count: 0,
      }];
    }
    if (path === "/email/card-cycles") return [];
    throw new Error(`Unexpected API call: ${path}`);
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AccountsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );

  const card = await screen.findByRole("region", { name: "手動信用卡 帳戶摘要" });
  expect(within(card).getByRole("button", { name: "更新負債" })).toBeTruthy();
  expect(within(card).queryByRole("button", { name: "帳單明細" })).toBeNull();
  expect(within(card).queryByRole("link", { name: "查看消費" })).toBeNull();
});
