import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { api } from "./api";
import { invalidateFinanceData } from "./appQueries";
import type { Category, Transaction } from "./types";
import { Button, Dialog, Field, Select } from "./ui";

interface CategoryChange {
  categoryId: number | null;
  previousCategoryId: number | null;
  rememberMerchant: boolean;
  undo?: boolean;
}

export default function TransactionCategory({ transaction, categories, onSaved }: {
  transaction: Transaction; categories: Category[]; onSaved?: (transaction: Transaction) => void;
}) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [savedCategoryId, setSavedCategoryId] = useState(transaction.category_id || null);
  const [selected, setSelected] = useState(String(transaction.category_id || ""));
  const [remember, setRemember] = useState(false);
  const [hasCreatedRule, setHasCreatedRule] = useState(false);
  const [undoCategory, setUndoCategory] = useState<{ id: number | null } | null>(null);
  useEffect(() => { setSavedCategoryId(transaction.category_id || null); }, [transaction.category_id]);
  const change = useMutation({
    mutationFn: ({ categoryId, rememberMerchant }: CategoryChange) =>
      api(`/transactions/${transaction.id}`, { method: "PATCH", body: JSON.stringify({ category_id: categoryId, create_rule: rememberMerchant, rule_keyword: transaction.description }) }),
    onSuccess: async (_result, values) => {
      setSavedCategoryId(values.categoryId);
      setUndoCategory(values.undo ? null : { id: values.previousCategoryId });
      if (values.rememberMerchant) setHasCreatedRule(true);
      setEditing(false);
      if (values.categoryId && categories.find((category) => category.id === values.categoryId)?.name !== "未分類" && !values.undo) onSaved?.(transaction);
      await invalidateFinanceData(client, ["rules"]);
    },
  });
  if (transaction.excluded) return <span className="text-sm text-slate-500">已排除，不列入統計</span>;
  if (["transfer", "investment", "debt_principal"].includes(transaction.transaction_kind)) return <span className="text-sm text-slate-500">不列入一般收支</span>;
  const options = categories.filter((category) => category.kind === (transaction.amount > 0 ? "income" : "expense"));
  const categoryName = savedCategoryId ? options.find((category) => category.id === savedCategoryId)?.name || transaction.category_name || "未分類" : "未分類";
  const unclassified = !savedCategoryId || categoryName === "未分類";
  function openEditor() {
    setSelected(String(savedCategoryId || ""));
    setRemember(false);
    change.reset();
    setEditing(true);
  }
  const saveError = change.isError && <div role="alert" className="text-xs text-red-700">尚未儲存：{change.error.message}<Button variant="ghost" className="h-8 px-2" onClick={() => change.mutate(change.variables!)}>重試</Button></div>;
  return <div className="min-w-0">
    <button type="button" aria-label={`變更分類：${transaction.description}（${categoryName}）`} aria-haspopup="dialog" onClick={openEditor} disabled={change.isPending}
      className={`inline-flex min-h-9 max-w-full items-center gap-2 rounded-lg px-2.5 text-xs font-medium transition hover:ring-1 hover:ring-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50 ${unclassified ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600 hover:bg-emerald-50 hover:text-emerald-700"}`}>
      <span className="truncate">{categoryName}</span><ChevronDown size={13} className="shrink-0" aria-hidden="true" />
    </button>
    {!editing && change.isPending && <p role="status" className="mt-1 text-xs text-emerald-700">儲存中…</p>}
    {!editing && saveError}
    {change.isSuccess && <div role="status" className="mt-1 flex flex-wrap items-center gap-1 text-xs text-emerald-700">{change.variables.undo ? "已復原" : "已儲存"}
      {undoCategory && <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => change.mutate({ categoryId: undoCategory.id, previousCategoryId: savedCategoryId, rememberMerchant: false, undo: true })}>復原此筆</Button>}
      {hasCreatedRule && <span className="w-full">復原只還原此筆；店家規則可至設定移除。</span>}
    </div>}
    {createPortal(<Dialog open={editing} onClose={() => { if (!change.isPending) setEditing(false); }} title="變更分類" description="只調整這筆交易，其他歷史交易不受影響。">
      <form className="space-y-5 pb-4 sm:pb-0" onSubmit={(event) => {
        event.preventDefault();
        if (change.isPending) return;
        change.mutate({ categoryId: Number(selected) || null, previousCategoryId: savedCategoryId, rememberMerchant: remember });
      }}>
        <div className="rounded-xl bg-slate-50 p-4">
          <p className="break-words text-sm font-semibold text-slate-800">{transaction.description}</p>
          <p className="mt-1 text-xs text-slate-500">{[transaction.transaction_date, transaction.account_name].filter(Boolean).join(" · ")}</p>
        </div>
        <Field label="分類">
          <Select aria-label={`分類：${transaction.description}`} value={selected} disabled={change.isPending} onChange={(event) => { setSelected(event.target.value); if (!event.target.value) setRemember(false); }}>
            <option value="">清除分類</option>
            {options.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </Select>
        </Field>
        <label className="flex items-start gap-3 text-sm text-slate-600">
          <input type="checkbox" checked={remember} disabled={change.isPending || !selected} onChange={(event) => setRemember(event.target.checked)} className="mt-1 size-4 shrink-0 accent-emerald-600" />
          <span>記住此帳戶的同店家<span className="mt-1 block text-xs leading-5 text-slate-500">勾選後，這個帳戶未來的同店家交易也會套用此分類。</span></span>
        </label>
        {saveError}
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
          <Button variant="secondary" disabled={change.isPending} onClick={() => setEditing(false)}>取消</Button>
          <Button type="submit" disabled={change.isPending || (!remember && selected === String(savedCategoryId || "")) || (remember && !selected)}>{change.isPending ? "儲存中…" : "儲存分類"}</Button>
        </div>
      </form>
    </Dialog>, document.body)}
  </div>;
}
