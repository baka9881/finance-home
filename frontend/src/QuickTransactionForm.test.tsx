// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import QuickTransactionForm, { clearQuickDraft, rememberTransactionAccount } from "./QuickTransactionForm";
import type { Account } from "./types";
afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); });
it("remembers account and preserves amount on close without submitting", async () => {
  const accounts = [{ id: 1, name: "現金", currency: "TWD" }, { id: 2, name: "生活費", currency: "TWD" }] as Account[];
  rememberTransactionAccount("me", 2);
  const submit = vi.fn();
  const mount = () => render(<QuickTransactionForm accounts={accounts} categories={[]} kind="expense" owner="me" pending={false} onCancel={vi.fn()} onSubmit={submit} />);
  const initial = mount();
  const user = userEvent.setup();
  expect((screen.getByRole("combobox", { name: "付款帳戶" }) as HTMLSelectElement).value).toBe("2");
  await user.type(screen.getByRole("spinbutton", { name: "花費金額" }), "120");
  initial.unmount();
  const again = mount();
  expect((screen.getByRole("spinbutton", { name: "花費金額" }) as HTMLInputElement).value).toBe("120");
  expect(submit).not.toHaveBeenCalled();
  again.unmount();
  clearQuickDraft("me", "expense");
  mount();
  expect((screen.getByRole("spinbutton", { name: "花費金額" }) as HTMLInputElement).value).toBe("");
});
