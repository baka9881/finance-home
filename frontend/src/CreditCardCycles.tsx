import { Link } from "react-router-dom";
import { Badge, Button, Card, money } from "./ui";

interface Bill {
  id?: number;
  amount_due: number;
  remaining_due?: number;
  payments_total?: number;
  due_date: string;
  status: string;
  last_error?: string | null;
  period_start?: string | null;
  period_end?: string | null;
}

interface CycleAmount {
  amount: number;
  payments_total?: number;
  transaction_count: number;
  period_start?: string | null;
  period_end?: string | null;
}

export interface Cycle {
  rule_id: number;
  rule_name: string;
  card_account_id: number;
  payment_account_id?: number;
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
  if (bill.status === "pending") {
    if ((bill.remaining_due ?? bill.amount_due) <= 0) return <Badge tone="green">已記錄繳款</Badge>;
    return <Badge tone="blue">{bill.payments_total ? "部分已記錄" : "待記錄繳款"}</Badge>;
  }
  if (bill.status === "insufficient_funds") return <Badge tone="amber">記帳餘額不足</Badge>;
  return <Badge tone="amber">需要確認</Badge>;
}

type CreditCardCyclesProps = {
  accountIds: number[];
  cycles?: Cycle[];
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
};

export default function CreditCardCycles({
  accountIds,
  cycles = [],
  isLoading = false,
  isError = false,
  onRetry,
}: CreditCardCyclesProps) {
  const visible = cycles.filter((cycle) => accountIds.includes(cycle.card_account_id));
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
        本期應繳以正式帳單為準；未收到帳單也可以記錄實際繳款。
      </p>
      {isLoading && <p role="status" className="mt-4">正在載入帳期…</p>}
      {isError && (
        <div role="alert" className="mt-4 text-sm text-red-700">
          帳期暫時無法更新
          {onRetry && <Button variant="secondary" className="ml-3" onClick={onRetry}>重試</Button>}
        </div>
      )}
      {!isLoading && !isError && !visible.length && (
        <p className="mt-4 text-sm text-slate-500">尚未設定信用卡郵件記帳，連接後可在這裡查看帳期。</p>
      )}
      <div className="mt-4 space-y-3">
        {visible.map((cycle) => (
          <details
            className="group scroll-mt-24 rounded-2xl border border-slate-200 p-4"
            id={`card-cycle-${cycle.card_account_id}`}
            key={cycle.rule_id}
          >
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
                <p className="text-xs text-slate-500">{cycle.cycle_boundary_known ? "未出帳欠款" : "待核對欠款"}</p>
                <p className="mt-1 font-semibold">{money(cycle.unbilled.amount, cycle.currency)}</p>
                {Boolean(cycle.unbilled.payments_total) && (
                  <p className="mt-1 text-xs text-emerald-700">已沖抵 {money(cycle.unbilled.payments_total || 0, cycle.currency)}</p>
                )}
                <p className="mt-1 text-xs text-slate-500">
                  {cycle.unbilled.transaction_count} 筆
                  {cycle.cycle_boundary_known && cycle.unbilled.period_start
                    ? ` · ${cycle.unbilled.period_start} 起`
                    : cycle.current_bill
                      ? " · 僅統計帳單寄達後可確認的消費"
                      : " · 帳期未知，此金額不是應繳金額"}
                </p>
              </div>
              <div className="rounded-xl bg-blue-50 p-3">
                <p className="text-xs text-blue-700">{cycle.current_bill ? "本期剩餘應繳" : cycle.last_paid_bill ? "最近帳單" : "正式帳單"}</p>
                <p className="mt-1 font-semibold">
                  {cycle.current_bill
                    ? money(cycle.current_bill.remaining_due ?? cycle.current_bill.amount_due, cycle.currency)
                    : cycle.last_paid_bill ? "已繳清" : "等待正式帳單"}
                </p>
                {!cycle.current_bill && cycle.last_paid_bill && <p className="mt-1 text-xs">原繳款期限 {cycle.last_paid_bill.due_date}</p>}
                {cycle.current_bill && (
                  <>
                    {Boolean(cycle.current_bill.payments_total) && <p className="mt-1 text-xs text-blue-700">已記錄 {money(cycle.current_bill.payments_total || 0, cycle.currency)}</p>}
                    <p className="mt-1 text-xs">繳款日 {cycle.current_bill.due_date}</p>
                    {cycle.current_bill.period_start && cycle.current_bill.period_end && (
                      <p className="mt-1 text-xs">{cycle.current_bill.period_start}～{cycle.current_bill.period_end}</p>
                    )}
                    <div className="mt-2">{billStatus(cycle.current_bill)}</div>
                    {cycle.current_bill.last_error && <p className="mt-2 text-xs text-amber-700">{cycle.current_bill.last_error}</p>}
                  </>
                )}
              </div>
              <div className="rounded-xl bg-emerald-50 p-3">
                <p className="text-xs text-emerald-700">已記錄繳款</p>
                <p className="mt-1 font-semibold">
                  {(cycle.current_bill?.payments_total || 0) + (cycle.unbilled.payments_total || 0) > 0
                    ? money((cycle.current_bill?.payments_total || 0) + (cycle.unbilled.payments_total || 0), cycle.currency)
                    : cycle.last_paid_bill ? money(cycle.last_paid_bill.amount_due, cycle.currency) : "尚無紀錄"}
                </p>
                <p className="mt-1 text-xs">
                  {(cycle.current_bill?.payments_total || 0) + (cycle.unbilled.payments_total || 0) > 0
                    ? "財務居已記帳，請以銀行紀錄為準"
                    : cycle.last_paid_bill ? `原繳款期限 ${cycle.last_paid_bill.due_date}` : "—"}
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
