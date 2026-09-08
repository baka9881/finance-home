import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { invalidateFinanceData } from "./appQueries";
import type { Transaction } from "./types";
import { transactionSourceLabel } from "./transactionFilters";
import { Button, DateInput, Dialog, Field, Input, money } from "./ui";

type Action = "edit" | "exclude" | "restore";
interface Values { transaction_date: string; description: string; amount: string; excluded: boolean }
interface Preview {
  token: string; before: Values; after: Values; currency: string; account_currency: string;
  balance_before: number | null; balance_after: number | null; balance_note: string;
  cashflow_before: number; cashflow_after: number;
}
interface History { id: number; action: Action; created_at: string; before: Values; after: Values; balance_note: string }
const actionLabels = { edit: "更正", exclude: "排除", restore: "復原上次更正" };

export default function TransactionCorrection({ transaction, onClose, onSaved }: {
  transaction: Transaction; onClose: () => void; onSaved: (message: string) => void;
}) {
  const client = useQueryClient();
  const [action, setAction] = useState<Action>(transaction.excluded ? "restore" : "edit");
  const [draft, setDraft] = useState({ transaction_date: transaction.transaction_date, description: transaction.description, amount: String(Math.abs(transaction.amount)) });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const history = useQuery({ queryKey: ["transaction-history", transaction.id], queryFn: () => api<History[]>(`/transactions/${transaction.id}/history`), enabled: historyOpen });
  const payload = () => ({ action, ...(action === "edit" ? { ...draft, amount: Number(draft.amount) * (transaction.amount < 0 ? -1 : 1) } : {}) });
  const inspect = useMutation({
    mutationFn: () => api<Preview>(`/transactions/${transaction.id}/correction/preview`, { method: "POST", body: JSON.stringify(payload()) }),
    onSuccess: (result) => { setPreview(result); save.reset(); },
  });
  const save = useMutation({
    mutationFn: () => api(`/transactions/${transaction.id}/correction`, { method: "POST", body: JSON.stringify({ ...payload(), token: preview?.token }) }),
    onSuccess: async () => {
      await invalidateFinanceData(client, ["transaction-history"]);
      onSaved(`已${actionLabels[action]}「${transaction.description}」；保留匯入來源及修改紀錄。`);
    },
  });
  const busy = inspect.isPending || save.isPending;
  const error = save.error || inspect.error;
  return <Dialog open onClose={() => { if (!busy) onClose(); }} title="更正交易" description={`${transaction.account_name} · ${transactionSourceLabel(transaction.source)}`}>
    <div className="space-y-4">
      <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">先確認影響再儲存。原始匯入紀錄會保留，不會因再次同步而重新加入已排除的錯帳。</p>
      {!preview ? <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); inspect.mutate(); }}>
        <div className="flex flex-wrap gap-2" role="group" aria-label="更正方式">
          {(["edit", "exclude", "restore"] as Action[]).filter((item) => transaction.excluded ? item === "restore" : item !== "restore" || Boolean(transaction.revision)).map((item) => <Button key={item} variant={action === item ? "primary" : "secondary"} aria-pressed={action === item} disabled={busy} onClick={() => { setAction(item); inspect.reset(); save.reset(); }}>{actionLabels[item]}</Button>)}
        </div>
        {action === "edit" ? <>
          <Field label="摘要"><Input required maxLength={300} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="日期"><DateInput required value={draft.transaction_date} onChange={(event) => setDraft({ ...draft, transaction_date: event.target.value })} /></Field>
            <Field label={`${transaction.amount < 0 ? "支出" : "收入"}金額（${transaction.currency}）`}><Input required type="number" min="0.0001" step="0.0001" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} /></Field>
          </div>
        </> : <p className="text-sm text-slate-600">{action === "exclude" ? "這筆將移至「已排除」清單，不再列入收支、分析或固定花費推算，之後可以復原。" : "將還原上一次更正前的內容。預覽會顯示此次餘額與收支影響。"}</p>}
        <Button type="submit" disabled={busy}>{inspect.isPending ? "正在計算影響…" : "預覽影響"}</Button>
      </form> : <section className="space-y-4" aria-label="更正影響預覽">
        <div className="rounded-xl border border-slate-200 p-4 text-sm">
          <p className="font-semibold">{preview.before.description} → {preview.after.excluded ? "已排除" : preview.after.description}</p>
          <p className="mt-2 text-slate-500">日期：{preview.before.transaction_date} → {preview.after.transaction_date}</p>
          <p className="mt-2">收支記錄（TWD）：{money(preview.cashflow_before)} → {money(preview.cashflow_after)}</p>
          <p className="mt-2">帳戶餘額：{preview.balance_before === null ? "尚無餘額" : money(preview.balance_before, preview.account_currency)} → {preview.balance_after === null ? "不變" : money(preview.balance_after, preview.account_currency)}</p>
          <p className="mt-3 text-amber-700">{preview.balance_note}</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2"><Button variant="secondary" disabled={busy} onClick={() => { setPreview(null); save.reset(); }}>返回修改／重新預覽</Button><Button disabled={busy} onClick={() => save.mutate()}>{save.isPending ? "儲存中…" : "確認並儲存"}</Button></div>
      </section>}
      {error && <p role="alert" className="text-sm text-red-700">尚未儲存：{error.message}</p>}
      {Boolean(transaction.revision) && <details onToggle={(event) => setHistoryOpen(event.currentTarget.open)} className="border-t border-slate-100 pt-3">
        <summary className="cursor-pointer text-sm text-slate-600">查看修改紀錄</summary>
        {history.isLoading && <p role="status">載入紀錄中…</p>}
        {history.isError && <div role="alert">修改紀錄載入失敗<Button onClick={() => history.refetch()}>重試</Button></div>}
        <ol className="mt-3 space-y-3 text-sm">{history.data?.map((item) => <li key={item.id} className="rounded-xl bg-slate-50 p-3"><p>{actionLabels[item.action]} · {new Date(`${item.created_at}Z`).toLocaleString("zh-TW")}</p><p className="mt-1 break-words">{item.before.description}（{item.before.transaction_date}，{money(Number(item.before.amount), transaction.currency)}） → {item.after.excluded ? "已排除" : `${item.after.description}（${item.after.transaction_date}，${money(Number(item.after.amount), transaction.currency)}）`}</p><p className="mt-1 text-slate-500">{item.balance_note}</p></li>)}</ol>
      </details>}
    </div>
  </Dialog>;
}
