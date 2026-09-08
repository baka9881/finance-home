// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TransactionCategory from "./TransactionCategory";
import { api } from "./api";
import type { Category, Transaction } from "./types";

vi.mock("./api", () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const transaction = { id: 1, description: "早餐店", amount: -50, category_id: 3, transaction_kind: "expense" } as Transaction;
const categories = [{ id: 1, name: "餐飲", kind: "expense" }, { id: 2, name: "薪資", kind: "income" }, { id: 3, name: "未分類", kind: "expense" }] as Category[];
function setup() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  render(<QueryClientProvider client={client}><TransactionCategory transaction={transaction} categories={categories} /></QueryClientProvider>);
  return userEvent.setup();
}
describe("transaction classification", () => {
  it("shows only expense categories and defaults to changing a single row", async () => {
    vi.mocked(api).mockResolvedValue({ ok: true });
    const user = setup();
    expect(screen.queryByRole("option", { name: "薪資" })).toBeNull();
    await user.selectOptions(screen.getByRole("combobox"), "1");
    await screen.findByText("已儲存");
    expect(JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body))).toMatchObject({ category_id: 1, create_rule: false });
    await user.click(screen.getByRole("button", { name: "復原此筆" }));
    expect(JSON.parse(String(vi.mocked(api).mock.calls[1][1]?.body))).toMatchObject({ category_id: 3, create_rule: false });
  });
  it("preserves the selection on failure and lets the user retry", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("連線失敗")).mockResolvedValue({ ok: true });
    const user = setup();
    await user.selectOptions(screen.getByRole("combobox"), "1");
    await screen.findByRole("alert");
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("1");
    await user.click(screen.getByRole("button", { name: "重試" }));
    await screen.findByText("已儲存");
    expect(vi.mocked(api)).toHaveBeenCalledTimes(2);
  });
});
