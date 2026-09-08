import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { invalidateFinanceData } from "./appQueries";
import type { Category, Transaction } from "./types";
import { Button, Select } from "./ui";

interface UndoItem { id: number; category_id: number | null; expected_category_id: number }
export default function BatchClassification({ rows, categories, selected, onSelect, active, onToggle, onSaved }: {
  rows: Transaction[]; categories: Category[]; selected: number[]; onSelect: (ids: number[]) => void;
  active: boolean; onToggle: () => void; onSaved: () => void;
}) {
  const client = useQueryClient();
  const [category, setCategory] = useState("");
  const [undo, setUndo] = useState<UndoItem[]>([]);
  const eligible = rows.filter((row) => row.can_correct && !row.excluded);
  const chosen = eligible.filter((row) => selected.includes(row.id));
  const kind = chosen[0]?.amount > 0 ? "income" : "expense";
  const mixed = chosen.some((row) => (row.amount > 0 ? "income" : "expense") !== kind);
  const change = useMutation({
    mutationFn: () => api<{ updated: number; undo: UndoItem[] }>("/transactions/classify-batch", { method: "POST", body: JSON.stringify({ ids: chosen.map((row) => row.id), category_id: Number(category) }) }),
    onSuccess: async (result) => { setUndo(result.undo); onSelect([]); setCategory(""); await invalidateFinanceData(client); onSaved(); },
  });
  const revert = useMutation({
    mutationFn: () => api("/transactions/classify-batch/undo", { method: "POST", body: JSON.stringify({ items: undo }) }),
    onSuccess: async () => { setUndo([]); await invalidateFinanceData(client); },
  });
  const busy = change.isPending || revert.isPending;
  return <section className="mb-4 space-y-3" aria-label="批次分類">
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" disabled={busy} onClick={onToggle}>{active ? "結束選取" : "批次分類"}</Button>
      {active && <Button variant="ghost" disabled={busy} onClick={() => onSelect(selected.length ? [] : eligible.map((row) => row.id))}>{selected.length ? "取消選取" : "選取本頁可分類交易"}</Button>}
      {Boolean(undo.length) && <Button variant="secondary" disabled={busy} onClick={() => revert.mutate()}>{revert.isPending ? "復原中…" : `復原上次 ${undo.length} 筆分類`}</Button>}
    </div>
    {active && <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
      <p className="text-sm text-slate-600">已選 {chosen.length} 筆。只變更勾選的交易，不建立店家規則、不影響其他月份。</p>
      {mixed ? <p role="alert" className="text-sm text-amber-700">請將收入與支出分開分類。</p> : <div className="flex flex-col gap-2 sm:flex-row">
        <Select aria-label="批次套用分類" value={category} disabled={busy} onChange={(event) => setCategory(event.target.value)}><option value="">選擇分類</option>{categories.filter((item) => item.kind === kind).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select>
        <Button disabled={busy || !chosen.length || !categories.some((item) => String(item.id) === category && item.kind === kind)} onClick={() => { revert.reset(); change.mutate(); }}>{change.isPending ? "儲存中…" : `確認套用 ${chosen.length} 筆`}</Button>
      </div>}
    </div>}
    {(change.isError || revert.isError) && <p role="alert" className="text-sm text-red-700">{(change.error || revert.error)?.message}；選取內容已保留，請重試。</p>}
    {change.isSuccess && !revert.isSuccess && <p role="status" className="text-sm text-emerald-700">批次分類已儲存。</p>}
    {revert.isSuccess && <p role="status" className="text-sm text-emerald-700">已復原上次批次分類。</p>}
  </section>;
}
