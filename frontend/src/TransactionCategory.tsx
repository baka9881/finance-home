import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { invalidateFinanceData } from "./appQueries";
import type { Category, Transaction } from "./types";
import { Button, Select } from "./ui";

export default function TransactionCategory({ transaction, categories, onSaved }: {
  transaction: Transaction; categories: Category[]; onSaved?: (transaction: Transaction) => void;
}) {
  const client = useQueryClient();
  const [selected, setSelected] = useState(String(transaction.category_id || ""));
  const [remember, setRemember] = useState(false);
  const before = useRef<number | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  useEffect(() => { setSelected(String(transaction.category_id || "")); }, [transaction.category_id]);
  const change = useMutation({
    mutationFn: ({ categoryId, rememberMerchant }: { categoryId: number | null; rememberMerchant: boolean }) =>
      api(`/transactions/${transaction.id}`, { method: "PATCH", body: JSON.stringify({ category_id: categoryId, create_rule: rememberMerchant, rule_keyword: transaction.description }) }),
    onSuccess: async (_result, values) => {
      if (values.categoryId && canUndo) onSaved?.(transaction);
      await invalidateFinanceData(client, ["rules"]);
    },
  });
  if (transaction.excluded) return <span className="text-sm text-slate-500">已排除，不列入統計</span>;
  if (["transfer", "investment", "debt_principal"].includes(transaction.transaction_kind)) return <span className="text-sm text-slate-500">不列入一般收支</span>;
  const options = categories.filter((category) => category.kind === (transaction.amount > 0 ? "income" : "expense"));
  function save(categoryId: number | null) {
    before.current = transaction.category_id || null;
    setCanUndo(true);
    setSelected(String(categoryId || ""));
    change.mutate({ categoryId, rememberMerchant: remember });
  }
  return <div className="min-w-40 space-y-1.5">
    <Select aria-label={`分類：${transaction.description}`} className="h-10" value={selected} disabled={change.isPending} onChange={(event) => save(Number(event.target.value) || null)}>
      <option value="">選擇分類</option>
      {options.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
    </Select>
    <label className="flex items-start gap-2 text-xs text-slate-500">
      <input type="checkbox" checked={remember} disabled={change.isPending} onChange={(event) => setRemember(event.target.checked)} className="mt-0.5 accent-emerald-600" />
      <span>記住此帳戶的同店家<span className="block text-[11px]">未勾選只改這筆；不更動其他歷史交易</span></span>
    </label>
    {change.isPending && <p role="status" className="text-xs text-emerald-700">儲存中…</p>}
    {change.isError && <div role="alert" className="text-xs text-red-700">尚未儲存：{change.error.message}<Button variant="ghost" className="h-7 px-2" onClick={() => change.mutate(change.variables!)}>重試</Button></div>}
    {change.isSuccess && <div role="status" className="flex flex-wrap items-center gap-1 text-xs text-emerald-700">已儲存
      {canUndo && <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => {
        setSelected(String(before.current || "")); setCanUndo(false);
        change.mutate({ categoryId: before.current, rememberMerchant: false });
      }}>復原此筆</Button>}
      {remember && <span className="block">店家規則可至設定修改或移除</span>}
    </div>}
  </div>;
}
