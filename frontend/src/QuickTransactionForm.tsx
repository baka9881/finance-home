import { type FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Account, Category } from "./types";
import { currencyOptions } from "./currencies";
import { taipeiDateInputValue } from "./date";
import { Button, DateInput, Field, FormOptions, Input, Select } from "./ui";

const recentKey = (owner: string) => `finance.recent-transaction-account.${owner}`;
const draftKey = (owner: string, kind: string) => `finance.quick-draft.${owner}.${kind}`;
export function clearQuickDraft(owner: string, kind: string) {
  try { sessionStorage.removeItem(draftKey(owner, kind)); } catch { /* unavailable */ }
}
export function rememberTransactionAccount(owner: string, accountId: number) {
  try { localStorage.setItem(recentKey(owner), String(accountId)); } catch { /* unavailable storage */ }
}
export default function QuickTransactionForm({ kind, accounts, categories, owner, pending, error, onSubmit, onCancel }: {
  kind: "income" | "expense"; accounts: Account[]; categories: Category[]; owner: string;
  pending: boolean; error?: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => {
    try { return { amount: "", description: "", transaction_date: taipeiDateInputValue(), category_id: "", ...JSON.parse(sessionStorage.getItem(draftKey(owner, kind)) || "{}") }; }
    catch { return { amount: "", description: "", transaction_date: taipeiDateInputValue(), category_id: "" }; }
  });
  const [accountId, setAccountId] = useState(() => {
    let recent: string | null = null;
    try { recent = localStorage.getItem(recentKey(owner)); } catch { /* unavailable storage */ }
    return String(accounts.find((account) => String(account.id) === draft.accountId)?.id || accounts.find((account) => String(account.id) === recent)?.id || accounts[0]?.id || "");
  });
  const account = accounts.find((item) => String(item.id) === accountId);
  const [currency, setCurrency] = useState(draft.currency || account?.currency || "TWD");
  useEffect(() => {
    try { sessionStorage.setItem(draftKey(owner, kind), JSON.stringify({ ...draft, accountId, currency })); } catch { /* unavailable */ }
  }, [draft, accountId, currency, owner, kind]);
  if (!accounts.length) return <div className="space-y-3"><p>先建立一個帳戶，就可以快速記帳。</p><Link to="/accounts?quick=create" onClick={onCancel} className="inline-block rounded-xl bg-forest px-4 py-3 text-white">建立帳戶</Link></div>;
  return <form onSubmit={onSubmit} className="space-y-4" aria-label={kind === "expense" ? "快速記錄支出" : "快速記錄收入"}>
    <input type="hidden" name="transaction_kind" value={kind} />
    <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
      <Field label={kind === "expense" ? "花費金額" : "收到金額"}><Input name="amount" type="number" min="0.01" step="any" inputMode="decimal" placeholder="0" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} required autoFocus className="h-14 text-2xl font-bold" /></Field>
      <Field label="幣別"><Select name="currency" value={currency} onChange={(event) => setCurrency(event.target.value)} className="h-14">{currencyOptions(currency).map((value) => <option key={value}>{value}</option>)}</Select></Field>
    </div>
    <Field label={kind === "expense" ? "付款帳戶" : "入帳帳戶"}>
      <Select name="account_id" value={accountId} required onChange={(event) => {
        setAccountId(event.target.value);
        setCurrency(accounts.find((item) => String(item.id) === event.target.value)?.currency || "TWD");
      }}><option value="">選擇帳戶</option>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.owner_label}）</option>)}</Select>
    </Field>
    <Field label="摘要"><Input name="description" required maxLength={300} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder={kind === "expense" ? "例如：早餐、房租" : "例如：薪水、退款"} /></Field>
    <FormOptions title={`日期與分類（${draft.transaction_date}）`}>
    <Field label="日期"><DateInput name="transaction_date" value={draft.transaction_date} onChange={(event) => setDraft({ ...draft, transaction_date: event.target.value })} required /></Field>
    <Field label="分類"><Select name="category_id" value={draft.category_id} onChange={(event) => setDraft({ ...draft, category_id: event.target.value })}><option value="">自動分類</option>{categories.filter((category) => category.kind === kind).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</Select></Field>
    </FormOptions>
    {(draft.amount || draft.description) && <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500"><span>尚未記帳；關閉後暫存草稿，僅限本次瀏覽。</span><Button variant="ghost" className="h-8 px-2 text-xs" disabled={pending} onClick={() => { setDraft({ amount: "", description: "", transaction_date: taipeiDateInputValue(), category_id: "" }); }}>清空草稿</Button></div>}
    {currency !== "TWD" && <details className="text-sm text-slate-500"><summary className="cursor-pointer">自訂匯率（選填）</summary><Input name="fx_rate" type="number" min="0.00000001" step="any" placeholder="1 單位外幣可換多少 TWD" className="mt-2" /></details>}
    {error && <p role="alert" className="text-sm text-red-700">尚未儲存：{error}</p>}
    <div className="mobile-safe-actions sticky bottom-0 -mx-4 flex justify-end gap-3 border-t border-slate-100 bg-white/95 px-4 py-3 backdrop-blur">
      <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>取消</Button>
      <Button type="submit" disabled={pending || !accountId}>{pending ? "儲存中…" : kind === "expense" ? "儲存支出" : "儲存收入"}</Button>
    </div>
  </form>;
}
