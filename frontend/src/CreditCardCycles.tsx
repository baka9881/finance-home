import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "./api";
import { Badge, Button, Card, money } from "./ui";

interface Bill {
  amount_due: number;
  due_date: string;
  status: string;
  period_start?: string | null;
  period_end?: string | null;
}

interface CycleAmount {
  amount: number;
  transaction_count: number;
  period_start?: string | null;
  period_end?: string | null;
}

export interface Cycle {
  rule_id: number;
  rule_name: string;
  card_account_id: number;
  currency: string;
  closing_day?: number | null;
  cycle_boundary_known: boolean;
  payment_due_day: number;
  current_cycle?: CycleAmount | null;
  unbilled: CycleAmount;
  next_cycle: CycleAmount;
  current_bill?: Bill | null;
  last_paid_bill?: Bill | null;
}

function billStatus(bill: Bill) {
  if (bill.status === "pending") return <Badge tone="blue">待記錄繳款</Badge>;
  if (bill.status === "insufficient_funds") return <Badge tone="amber">記帳餘額不足</Badge>;
  return <Badge tone="amber">需要確認</Badge>;
}

export default function CreditCardCycles({ accountIds }: { accountIds: number[] }) {
  const cycles = useQuery({
    queryKey: ["credit-card-cycles"],
    queryFn: () => api<Cycle[]>("/email/card-cycles"),
    enabled: Boolean(accountIds.length),
  });
  const visible = cycles.data?.filter((cycle) => accountIds.includes(cycle.card_account_id)) || [];
  if (!accountIds.length) return null;

  return (
    <Card className="mt-6 scroll-mt-24 p-4 sm:p-5" id="card-cycles">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold">信用卡帳期與繳款</h2>
        <Link to="/settings#email" className="rounded-xl px-3 py-2 text-sm font-semibold text-emerald-700">
          管理自動記帳
        </Link>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        本期應繳只採正式帳單金額；「已記錄繳款」僅代表財務居已記帳，不代表銀行已完成付款。
      </p>
      {cycles.isLoading && <p role="status" className="mt-4">正在載入帳期…</p>}
      {cycles.isError && (
        <div role="alert" className="mt-4 text-sm text-red-700">
          帳期暫時無法更新
          <Button variant="secondary" onClick={() => cycles.refetch()}>重試</Button>
        </div>
      )}
      {!cycles.isPending && !cycles.isError && !visible.length && (
        <p className="mt-4 text-sm text-slate-500">尚未設定信用卡郵件記帳，連接後可在這裡查看帳期。</p>
      )}
      <div className="mt-4 space-y-3">
        {visible.map((cycle) => (
          <details className="group rounded-2xl border border-slate-200 p-4" key={cycle.rule_id}>
            <summary className="cursor-pointer text-sm font-semibold">
              <span>{cycle.rule_name}</span>
              <span className="ml-2 font-normal text-slate-500">每月 {cycle.payment_due_day} 日繳款</span>
            </summary>
            <p className={`mt-3 text-xs ${cycle.cycle_boundary_known ? "text-slate-500" : "text-amber-700"}`}>
              {cycle.cycle_boundary_known
                ? `每月 ${cycle.closing_day} 日結帳`
                : "結帳日未知；系統不會以繳款日推算帳期"}
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl bg-slate-50 p-3">
                <p className="text-xs text-slate-500">未出帳消費</p>
                <p className="mt-1 font-semibold">{money(cycle.unbilled.amount, cycle.currency)}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {cycle.unbilled.transaction_count} 筆
                  {cycle.cycle_boundary_known && cycle.unbilled.period_start
                    ? ` · ${cycle.unbilled.period_start} 起`
                    : cycle.current_bill
                      ? " · 僅統計帳單寄達後可確認的消費"
                      : " · 尚未取得正式帳期，此金額不是應繳金額"}
                </p>
              </div>
              <div className="rounded-xl bg-blue-50 p-3">
                <p className="text-xs text-blue-700">本期帳單（正式金額）</p>
                <p className="mt-1 font-semibold">
                  {cycle.current_bill ? money(cycle.current_bill.amount_due, cycle.currency) : "等待正式帳單"}
                </p>
                {cycle.current_bill && (
                  <>
                    <p className="mt-1 text-xs">繳款日 {cycle.current_bill.due_date}</p>
                    {cycle.current_bill.period_start && cycle.current_bill.period_end && (
                      <p className="mt-1 text-xs">{cycle.current_bill.period_start}～{cycle.current_bill.period_end}</p>
                    )}
                    <div className="mt-2">{billStatus(cycle.current_bill)}</div>
                  </>
                )}
              </div>
              <div className="rounded-xl bg-emerald-50 p-3">
                <p className="text-xs text-emerald-700">已記錄繳款</p>
                <p className="mt-1 font-semibold">
                  {cycle.last_paid_bill ? money(cycle.last_paid_bill.amount_due, cycle.currency) : "尚無紀錄"}
                </p>
                <p className="mt-1 text-xs">
                  {cycle.last_paid_bill ? `帳單繳款日 ${cycle.last_paid_bill.due_date}` : "—"}
                </p>
              </div>
            </div>
            <Link
              to={`/transactions?account=${cycle.card_account_id}&month=all&search=&unclassified=0&excluded=0&page=1`}
              className="mt-3 inline-block py-2 text-sm font-semibold text-emerald-700"
            >
              查看這張卡的消費 →
            </Link>
          </details>
        ))}
      </div>
    </Card>
  );
}
