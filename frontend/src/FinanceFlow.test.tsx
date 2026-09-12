// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import TransactionCategory from "./TransactionCategory";
import { useTransactionScroll } from "./useTransactionScroll";
import { api } from "./api";
import type { Transaction, Category } from "./types";
vi.mock("./api", () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); sessionStorage.clear(); });
it("refreshes an already loaded analysis after saving a category", async () => {
  let total = 0;
  vi.mocked(api).mockImplementation(async (_path, options) => {
    if (options?.method === "PATCH") { total = 50; return { ok: true } as never; }
    return { total } as never;
  });
  function AnalysisProbe() {
    const query = useQuery({ queryKey: ["spending-analysis", "2026-09", "me"], queryFn: () => api<{total: number}>("/analysis/spending") });
    return <p>餐飲合計：{query.data?.total ?? "載入中"}</p>;
  }
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 300000 } } })}><AnalysisProbe /><TransactionCategory transaction={{ id: 1, description: "早餐", amount: -50, transaction_kind: "expense" } as Transaction} categories={[{id: 1, name: "餐飲", kind: "expense"}] as Category[]} /></QueryClientProvider>);
  await screen.findByText("餐飲合計：0");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "變更分類：早餐（未分類）" }));
  await user.selectOptions(screen.getByRole("combobox"), "1");
  expect(screen.getByText("餐飲合計：0")).toBeTruthy();
  expect(vi.mocked(api).mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(false);
  await user.click(screen.getByRole("button", { name: "儲存分類" }));
  await screen.findByText("餐飲合計：50");
});
it("restores the matching page scroll only when rows are ready", () => {
  let frame: FrameRequestCallback | undefined;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frame = callback; return 1; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  sessionStorage.setItem("finance.transaction-scroll.august", "720");
  function Probe({ ready }: {ready: boolean}) { useTransactionScroll("august", ready); return null; }
  const view = render(<Probe ready={false} />);
  expect(scroll).not.toHaveBeenCalled();
  view.rerender(<Probe ready />);
  frame?.(0);
  expect(scroll).toHaveBeenCalledWith({ top: 720, behavior: "instant" });
});
