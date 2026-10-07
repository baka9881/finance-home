// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../api";
import AccountsPage from "./AccountsPage";

vi.mock("../api", () => ({ api: vi.fn() }));

let formalBill: Record<string, unknown> | null = null;
let lastPaidBill: Record<string, unknown> | null = null;

beforeEach(() => {
  localStorage.clear();
  formalBill = null;
  lastPaidBill = null;
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
      }, {
        id: 2,
        name: "生活費帳戶",
        institution: "",
        account_type: "bank",
        nature: "asset",
        currency: "TWD",
        owner: "me",
        owner_label: "我",
        is_liquid: true,
        balance_includes_positions: false,
        valuation_mode: "cash_plus_positions",
        archived: false,
        linked_email_rules: [],
        balance: 30000,
        balance_twd: 30000,
        balance_date: "2026-09-24",
        investments_twd: 0,
        total_twd: 30000,
        positions_count: 0,
      }];
    }
    if (path === "/email/card-cycles") {
      return [{
        rule_id: 1,
        rule_name: "國泰信用卡",
        card_account_id: 1,
        payment_account_id: 2,
        card_account_name: "國泰世華銀行 信用卡",
        currency: "TWD",
        closing_day: null,
        cycle_boundary_known: false,
        payment_due_day: 23,
        current_cycle: null,
        unbilled: { amount: 14027, transaction_count: 5, period_start: null, period_end: null },
        next_cycle: { amount: 0, transaction_count: 0, period_start: null, period_end: null },
        current_bill: formalBill,
        last_paid_bill: lastPaidBill,
      }];
    }
    if (path === "/card-payment-candidates?card_account_id=1&payment_account_id=2") {
      return [{
        id: 91,
        transaction_date: "2026-09-23",
        description: "國泰信用卡自動扣繳",
        amount: -5000,
        source: "csv",
      }];
    }
    if (path === "/loan-payments") return { transaction_ids: [3, 4] };
    throw new Error(`Unexpected API call: ${path}`);
  });
});

it("associates a payment with the pending formal bill when one exists", async () => {
  formalBill = {
    id: 17,
    amount_due: 14027,
    remaining_due: 9027,
    payments_total: 5000,
    due_date: "2026-10-23",
    status: "pending",
  };
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
  await within(card).findByText("NT$9,027");
  await user.click(within(card).getByRole("button", { name: "記錄繳款" }));
  const dialog = screen.getByRole("dialog", { name: "記錄信用卡繳款" });
  expect((within(dialog).getByRole("spinbutton", { name: "繳款金額（TWD）" }) as HTMLInputElement).value).toBe("9027");
  await user.click(within(dialog).getByRole("button", { name: "儲存繳款" }));

  await waitFor(() => expect(vi.mocked(api).mock.calls.some(([path, options]) =>
    path === "/loan-payments" && JSON.parse(String(options?.body)).bill_id === 17,
  )).toBe(true));
});

it("links a selected existing debit without creating another bank debit", async () => {
  formalBill = {
    id: 17,
    amount_due: 14027,
    remaining_due: 9027,
    payments_total: 5000,
    due_date: "2026-10-23",
    status: "pending",
  };
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
  await within(card).findByText("NT$9,027");
  await user.click(within(card).getByRole("button", { name: "記錄繳款" }));
  const dialog = screen.getByRole("dialog", { name: "記錄信用卡繳款" });
  expect(vi.mocked(api).mock.calls.some(([path]) => path.startsWith("/card-payment-candidates"))).toBe(false);
  await user.click(within(dialog).getByRole("checkbox", { name: /已在付款帳戶記錄扣款/ }));
  expect(await within(dialog).findByRole("option", { name: /2026-09-23 · 國泰信用卡自動扣繳 · NT\$5,000/ })).toBeTruthy();
  expect(within(dialog).getByRole("option", { name: /銀行匯入/ })).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "儲存繳款" }).hasAttribute("disabled")).toBe(true);
  expect(vi.mocked(api).mock.calls.some(([path]) => path === "/card-payment-candidates?card_account_id=1&payment_account_id=2")).toBe(true);
  await user.click(within(dialog).getByRole("button", { name: "已記錄的扣款" }));
  await user.click(within(within(dialog).getByRole("listbox", { name: "已記錄的扣款" })).getByRole("option", { name: /2026-09-23 · 國泰信用卡自動扣繳/ }));
  expect(within(dialog).getByText("繳款金額：NT$5,000")).toBeTruthy();
  expect(within(dialog).getByText("繳款日期：2026-09-23")).toBeTruthy();
  expect((within(dialog).getByRole("checkbox", { name: /這筆扣款用來銷帳目前帳單/ }) as HTMLInputElement).checked).toBe(false);
  expect(within(dialog).getByText(/繳款期限 2026-10-23 · 尚待繳 NT\$9,027/)).toBeTruthy();
  expect(within(dialog).queryByRole("spinbutton", { name: "繳款金額（TWD）" })).toBeNull();
  await user.click(within(dialog).getByRole("button", { name: "儲存繳款" }));

  await waitFor(() => expect(vi.mocked(api).mock.calls.some(([path, options]) => {
    if (path !== "/loan-payments") return false;
    const payload = JSON.parse(String(options?.body));
    return payload.payment_account_id === 2
      && payload.loan_account_id === 1
      && payload.existing_payment_transaction_id === 91
      && payload.principal === 5000
      && payload.payment_date === "2026-09-23"
      && !Object.hasOwn(payload, "bill_id");
  })).toBe(true));
  expect(await screen.findByText("已連結現有扣款並更新信用卡欠款。")).toBeTruthy();
  await user.click(within(card).getByRole("button", { name: "記錄繳款" }));
  const reopened = screen.getByRole("dialog", { name: "記錄信用卡繳款" });
  expect((within(reopened).getByRole("checkbox", { name: /已在付款帳戶記錄扣款/ }) as HTMLInputElement).checked).toBe(false);
  expect(within(reopened).queryByRole("button", { name: "已記錄的扣款" })).toBeNull();
});

it("only assigns an existing debit to the current bill when explicitly selected", async () => {
  formalBill = {
    id: 17,
    amount_due: 14027,
    remaining_due: 9027,
    payments_total: 5000,
    due_date: "2026-10-23",
    status: "pending",
  };
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
  await within(card).findByText("NT$9,027");
  await user.click(within(card).getByRole("button", { name: "記錄繳款" }));
  const dialog = screen.getByRole("dialog", { name: "記錄信用卡繳款" });
  await user.click(within(dialog).getByRole("checkbox", { name: /已在付款帳戶記錄扣款/ }));
  await within(dialog).findByRole("option", { name: /國泰信用卡自動扣繳/ });
  await user.click(within(dialog).getByRole("button", { name: "已記錄的扣款" }));
  await user.click(within(within(dialog).getByRole("listbox", { name: "已記錄的扣款" })).getByRole("option", { name: /國泰信用卡自動扣繳/ }));
  let assignBill = within(dialog).getByRole("checkbox", { name: /這筆扣款用來銷帳目前帳單/ }) as HTMLInputElement;
  expect(assignBill.checked).toBe(false);
  await user.click(assignBill);
  expect(assignBill.checked).toBe(true);

  await user.click(within(dialog).getByRole("button", { name: "已記錄的扣款" }));
  await user.click(within(within(dialog).getByRole("listbox", { name: "已記錄的扣款" })).getByRole("option", { name: "請選擇一筆扣款" }));
  expect(within(dialog).queryByRole("checkbox", { name: /這筆扣款用來銷帳目前帳單/ })).toBeNull();
  await user.click(within(dialog).getByRole("button", { name: "已記錄的扣款" }));
  await user.click(within(within(dialog).getByRole("listbox", { name: "已記錄的扣款" })).getByRole("option", { name: /國泰信用卡自動扣繳/ }));
  assignBill = within(dialog).getByRole("checkbox", { name: /這筆扣款用來銷帳目前帳單/ }) as HTMLInputElement;
  expect(assignBill.checked).toBe(false);
  await user.click(assignBill);
  await user.click(within(dialog).getByRole("button", { name: "儲存繳款" }));

  await waitFor(() => expect(vi.mocked(api).mock.calls.some(([path, options]) => {
    if (path !== "/loan-payments") return false;
    const payload = JSON.parse(String(options?.body));
    return payload.existing_payment_transaction_id === 91
      && payload.bill_id === 17
      && payload.principal === 5000
      && payload.payment_date === "2026-09-23";
  })).toBe(true));

  await user.click(within(card).getByRole("button", { name: "記錄繳款" }));
  const reopened = screen.getByRole("dialog", { name: "記錄信用卡繳款" });
  await user.click(within(reopened).getByRole("checkbox", { name: /已在付款帳戶記錄扣款/ }));
  await within(reopened).findByRole("option", { name: /國泰信用卡自動扣繳/ });
  await user.click(within(reopened).getByRole("button", { name: "已記錄的扣款" }));
  await user.click(within(within(reopened).getByRole("listbox", { name: "已記錄的扣款" })).getByRole("option", { name: /國泰信用卡自動扣繳/ }));
  expect((within(reopened).getByRole("checkbox", { name: /這筆扣款用來銷帳目前帳單/ }) as HTMLInputElement).checked).toBe(false);
});

it("shows the most recent bill as paid after full settlement", async () => {
  lastPaidBill = {
    id: 17,
    amount_due: 14027,
    remaining_due: 0,
    payments_total: 14027,
    due_date: "2026-09-23",
    status: "paid",
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AccountsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );

  const card = await screen.findByRole("region", { name: "國泰世華銀行 信用卡 帳戶摘要" });
  expect(await within(card).findByText("最近帳單 · 2026-09-23")).toBeTruthy();
  expect(within(card).getByText("已繳清")).toBeTruthy();
  expect(within(card).queryByText("尚未匯入")).toBeNull();
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
  expect(await within(card).findByText("正式帳單")).toBeTruthy();
  expect(within(card).getByText("尚未匯入")).toBeTruthy();
  expect(within(card).getByText("待核對欠款")).toBeTruthy();
  expect(within(card).getByText("每月 23 日繳款")).toBeTruthy();
  expect(within(card).getByRole("link", { name: "設定結帳日" })).toBeTruthy();
  const detailButton = within(card).getByRole("button", { name: "帳單明細" });
  expect(within(card).queryByRole("link", { name: "查看消費" })).toBeNull();
  expect(within(card).queryByRole("button", { name: /更新餘額|更新負債/ })).toBeNull();
  expect(within(card).getByRole("button", { name: "記錄繳款" })).toBeTruthy();
  expect(within(card).queryByText("國泰世華銀行")).toBeNull();
  expect(within(card).queryByText("TWD")).toBeNull();
  expect(within(card).queryByText(/負債依消費與繳款記錄更新/)).toBeNull();
  expect(within(card).queryByText(/帳期範圍等待正式帳單確認/)).toBeNull();

  await user.click(detailButton);
  expect((document.getElementById("card-cycle-1") as HTMLDetailsElement).open).toBe(true);
  expect(vi.mocked(api).mock.calls.filter(([path]) => path === "/email/card-cycles")).toHaveLength(1);
});

it("records a credit-card payment without requiring a formal bill", async () => {
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
  await within(card).findByText("待核對欠款");
  await user.click(within(card).getByRole("button", { name: "記錄繳款" }));
  const dialog = screen.getByRole("dialog", { name: "記錄信用卡繳款" });
  expect(within(dialog).getByText("尚無正式帳單，仍可記錄已支付的金額。")).toBeTruthy();
  expect((within(dialog).getByRole("spinbutton", { name: "繳款金額（TWD）" }) as HTMLInputElement).value).toBe("14027");
  await user.click(within(dialog).getByRole("button", { name: "儲存繳款" }));

  await waitFor(() => expect(vi.mocked(api).mock.calls.some(([path, options]) =>
    path === "/loan-payments"
      && options?.method === "POST"
      && JSON.parse(String(options.body)).payment_account_id === 2
      && JSON.parse(String(options.body)).loan_account_id === 1
      && JSON.parse(String(options.body)).principal === 14027,
  )).toBe(true));
  expect(await screen.findByText("信用卡繳款已記錄，欠款與付款帳戶會同步更新。")).toBeTruthy();
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
  expect(within(card).getByRole("button", { name: "記錄繳款" })).toBeTruthy();
});
