// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TransactionCorrection from "./TransactionCorrection";
import { api } from "./api";
import type { Transaction } from "./types";
vi.mock("./api", () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("requires preview and explicit confirmation and retains preview after failure", async () => {
  const values = { description: "商店", transaction_date: "2026-09-01", amount: "-100", excluded: false };
  vi.mocked(api).mockResolvedValueOnce({ token: "verified", before: values, after: { ...values, excluded: true }, currency: "TWD", account_currency: "TWD", balance_before: 1000, balance_after: 1100, cashflow_before: -100, cashflow_after: 0, balance_note: "保留帳單" }).mockRejectedValueOnce(new Error("連線中斷")).mockResolvedValue({ ok: true });
  const onSaved = vi.fn();
  render(<QueryClientProvider client={new QueryClient()}><TransactionCorrection transaction={{ id: 1, amount: -100, source: "gmail", description: "商店", transaction_date: "2026-09-01", currency: "TWD" } as Transaction} onClose={vi.fn()} onSaved={onSaved} /></QueryClientProvider>);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /^排除$/ }));
  expect(api).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "預覽影響" }));
  await screen.findByRole("region", { name: "更正影響預覽" });
  expect(api).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "確認並儲存" }));
  await screen.findByRole("alert");
  expect(onSaved).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "確認並儲存" }));
  await screen.findByRole("region", { name: "更正影響預覽" });
  expect(JSON.parse(String(vi.mocked(api).mock.calls[2][1]?.body))).toEqual({ action: "exclude", token: "verified" });
});
