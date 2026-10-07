// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import CreditCardCycles, { type Cycle } from "./CreditCardCycles";

afterEach(cleanup);

const cycle: Cycle = {
  rule_id: 1,
  rule_name: "信用卡",
  card_account_id: 9,
  currency: "TWD",
  closing_day: null,
  cycle_boundary_known: false,
  payment_due_day: 23,
  current_cycle: null,
  unbilled: { amount: 11188, payments_total: 5000, transaction_count: 3 },
  next_cycle: { amount: 0, transaction_count: 0 },
  current_bill: null,
  last_paid_bill: null,
};

it("shows recorded payments against debt even without a formal statement", () => {
  render(<MemoryRouter><CreditCardCycles accountIds={[9]} cycles={[cycle]} /></MemoryRouter>);
  fireEvent.click(screen.getByText("信用卡"));
  expect(screen.getByText("待核對欠款")).toBeTruthy();
  expect(screen.getByText("NT$11,188")).toBeTruthy();
  expect(screen.getByText("已沖抵 NT$5,000")).toBeTruthy();
  expect(screen.getByText("財務居已記帳，請以銀行紀錄為準")).toBeTruthy();
});

it("shows the remaining formal statement and partial payment status", () => {
  render(<MemoryRouter><CreditCardCycles accountIds={[9]} cycles={[{
    ...cycle,
    unbilled: { amount: 0, transaction_count: 0 },
    current_bill: {
      amount_due: 12000,
      remaining_due: 7000,
      payments_total: 5000,
      due_date: "2026-10-23",
      status: "pending",
    },
  }]} /></MemoryRouter>);
  fireEvent.click(screen.getByText("信用卡"));
  expect(screen.getByText("NT$7,000")).toBeTruthy();
  expect(screen.getByText("部分已記錄")).toBeTruthy();
});

it("shows a settled statement instead of asking to wait for another bill", () => {
  render(<MemoryRouter><CreditCardCycles accountIds={[9]} cycles={[{
    ...cycle,
    unbilled: { amount: 0, transaction_count: 0 },
    last_paid_bill: {
      amount_due: 12000,
      remaining_due: 0,
      payments_total: 12000,
      due_date: "2026-10-23",
      status: "paid",
    },
  }]} /></MemoryRouter>);
  fireEvent.click(screen.getByText("信用卡"));
  expect(screen.getByText("最近帳單")).toBeTruthy();
  expect(screen.getByText("已繳清")).toBeTruthy();
  expect(screen.queryByText("等待正式帳單")).toBeNull();
});

it("explains why an imported debit needs review", () => {
  render(<MemoryRouter><CreditCardCycles accountIds={[9]} cycles={[{
    ...cycle,
    current_bill: {
      amount_due: 12000,
      due_date: "2026-10-23",
      status: "needs_review",
      last_error: "付款帳戶已有相同金額的扣款，請先配對信用卡繳款，未重複扣款",
    },
  }]} /></MemoryRouter>);
  fireEvent.click(screen.getByText("信用卡"));
  expect(screen.getByText("需要確認")).toBeTruthy();
  expect(screen.getByText("付款帳戶已有相同金額的扣款，請先配對信用卡繳款，未重複扣款")).toBeTruthy();
});
