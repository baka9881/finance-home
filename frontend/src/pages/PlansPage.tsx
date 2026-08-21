import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarDays, CheckCircle2, Goal as GoalIcon, Plus, Target } from "lucide-react";
import { api } from "../api";
import { useOwnerFilter } from "../ownerFilter";
import type { Account, Dashboard, Goal, Position } from "../types";
import {
  Badge,
  Button,
  Card,
  DateInput,
  Dialog,
  EmptyState,
  Field,
  FormContext,
  FormStep,
  Input,
  PageHeader,
  Progress,
  Select,
  Skeleton,
  money,
  number,
} from "../ui";

const goalTypeOptions = [
  { value: "net_worth", label: "淨資產目標", description: "用目前淨資產當進度。" },
  { value: "liquid_assets", label: "緊急預備金", description: "只看流動資產，例如現金與活存。" },
  { value: "account_balance", label: "指定帳戶儲蓄", description: "用某個帳戶的餘額當進度。" },
  { value: "investment_cost", label: "投資本金", description: "用目前投入成本當進度。" },
  { value: "debt_payoff", label: "還清貸款", description: "用指定負債帳戶的剩餘金額計算。" },
] as const;

type GoalType = (typeof goalTypeOptions)[number]["value"];

const goalTypeLabels = Object.fromEntries(goalTypeOptions.map((item) => [item.value, item.label])) as Record<
  GoalType,
  string
>;

export default function PlansPage() {
  const client = useQueryClient();
  const [goalOpen, setGoalOpen] = useState(false);
  const [ownerFilter] = useOwnerFilter();
  const [goalType, setGoalType] = useState<GoalType>("net_worth");
  const [goalAccountId, setGoalAccountId] = useState("");

  const goals = useQuery({
    queryKey: ["goals", ownerFilter],
    queryFn: () => api<Goal[]>(`/goals?owner=${ownerFilter}`),
  });
  const dashboard = useQuery({
    queryKey: ["dashboard", ownerFilter],
    queryFn: () => api<Dashboard>(`/dashboard?owner=${ownerFilter}`),
  });
  const positions = useQuery({
    queryKey: ["positions", ownerFilter],
    queryFn: () => api<Position[]>(`/positions?owner=${ownerFilter}`),
  });

  const createGoal = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api("/goals", { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["goals"] });
      setGoalOpen(false);
      setGoalType("net_worth");
      setGoalAccountId("");
    },
  });

  function submitGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    createGoal.mutate({
      name: form.get("name"),
      owner: ownerFilter === "all" ? "me" : ownerFilter,
      goal_type: goalType,
      account_id: goalType === "account_balance" || goalType === "debt_payoff" ? Number(goalAccountId) : null,
      target_amount: Number(form.get("target_amount")),
      current_amount: 0,
      target_date: form.get("target_date") || null,
      currency: "TWD",
      note: form.get("note") || null,
    });
  }

  const goalItems = goals.data || [];
  const currentNetWorth = Math.max(0, dashboard.data?.net_worth || 0);
  const liquidAssets =
    dashboard.data?.accounts
      .filter((account) => account.nature === "asset" && account.is_liquid)
      .reduce((sum, account) => sum + account.total_twd, 0) || 0;
  const investmentCost = positions.data?.reduce((sum, position) => sum + position.cost_twd, 0) || 0;
  const dashboardAccounts = dashboard.data?.accounts || [];
  const goalAccountOptions = dashboardAccounts.filter((account) =>
    goalType === "debt_payoff" ? account.nature === "liability" : account.nature === "asset",
  );
  const selectedGoalType = goalTypeOptions.find((item) => item.value === goalType) || goalTypeOptions[0];
  const needsGoalAccount = goalType === "account_balance" || goalType === "debt_payoff";
  const goalMetrics = goalItems.map((goal) => resolveGoalMetric(goal, {
    accounts: dashboardAccounts,
    currentNetWorth,
    investmentCost,
    liquidAssets,
  }));
  const totalTarget = goalMetrics.reduce((sum, item) => sum + item.target, 0);
  const totalCurrent = goalMetrics.reduce((sum, item) => sum + item.current, 0);
  const totalProgress = totalTarget ? Math.min(100, (totalCurrent / totalTarget) * 100) : 0;
  const activeGoals = goalMetrics.filter((item) => item.remaining > 0);
  const remaining = goalMetrics.reduce((sum, item) => sum + item.remaining, 0);
  const isLoading = goals.isLoading || dashboard.isLoading || positions.isLoading;
  const hasLoadError = goals.isError || dashboard.isError || positions.isError;

  return (
    <>
      <PageHeader
        eyebrow="Goals"
        title="財務目標"
        description="進度會自動使用目前淨資產計算，不用另外手動更新累積金額。"
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                setGoalType("net_worth");
                setGoalAccountId("");
                setGoalOpen(true);
              }}
            >
              <Plus size={16} /> 新增目標
            </Button>
          </div>
        }
      />

      <div className="mb-6 rounded-2xl border border-emerald-100 bg-emerald-50/80 p-4 text-sm leading-6 text-emerald-800">
        目前累積金額取自「總覽」的淨資產；如果你新增帳戶、更新餘額或投資行情，這裡的目標進度會跟著變。
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-3" aria-busy={isLoading}>
        {isLoading || hasLoadError ? [1, 2, 3].map((item) => (
          <Card key={item} className="p-5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-3 h-8 w-40" />
            <Skeleton className="mt-5 h-3 w-32" />
          </Card>
        )) : (
          <>
            <Card className="p-5">
              <p className="text-sm text-slate-500">目標總額</p>
              <p className="mt-2 text-2xl font-bold text-ink">{money(totalTarget)}</p>
              <p className="mt-4 text-xs text-slate-400">{activeGoals.length} 個進行中目標</p>
            </Card>
            <Card className="p-5">
              <p className="text-sm text-slate-500">目前累積</p>
              <p className="mt-2 text-2xl font-bold text-emerald-700">{money(totalCurrent)}</p>
              <p className="mt-4 text-xs text-slate-400">{number(totalProgress, 1)}% 的總進度</p>
            </Card>
            <Card className="p-5">
              <p className="text-sm text-slate-500">剩餘金額</p>
              <p className="mt-2 text-2xl font-bold text-ink">{money(remaining)}</p>
              <p className="mt-4 text-xs text-slate-400">距離所有目標還需要累積</p>
            </Card>
          </>
        )}
      </div>

      {hasLoadError ? (
        <Card>
          <EmptyState
            icon={<AlertTriangle size={26} />}
            title="財務目標載入失敗"
            description="資料沒有被清空，請檢查連線後再試一次。"
            action={<Button onClick={() => { goals.refetch(); dashboard.refetch(); positions.refetch(); }}>重新載入</Button>}
          />
        </Card>
      ) : isLoading ? (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3].map((item) => (
            <div key={item} className="h-64 animate-pulse rounded-2xl bg-slate-200/70" />
          ))}
        </div>
      ) : !goalItems.length ? (
        <Card>
          <EmptyState
            icon={<Target size={26} />}
            title="還沒有財務目標"
            description="可以先建立一個淨資產目標，例如一百萬、緊急預備金或投資本金目標。"
            action={<Button onClick={() => setGoalOpen(true)}>建立第一個目標</Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {goalMetrics.map(({ goal, current, remaining: goalRemaining, progress, typeLabel, accountName }) => {
            const achieved = progress >= 100;

            return (
              <Card key={goal.id} className="p-5">
                <div className="flex items-start justify-between">
                  <div className="grid size-11 place-items-center rounded-2xl bg-violet-50 text-violet-700">
                    {achieved ? <CheckCircle2 size={20} /> : <GoalIcon size={20} />}
                  </div>
                  <Badge tone={achieved ? "green" : "blue"}>
                    {achieved ? "已達成" : `${number(progress, 0)}%`}
                  </Badge>
                </div>
                <div className="mt-5 flex items-center gap-2">
                  <h3 className="text-lg font-bold text-slate-800">{goal.name}</h3>
                  {ownerFilter === "all" && <Badge>{goal.owner_label}</Badge>}
                </div>
                <p className="mt-1 text-sm text-slate-400">
                  {typeLabel}{accountName ? ` · ${accountName}` : ""} · 目標 {money(goal.target_amount)}
                </p>
                <div className="mt-5">
                  <Progress value={progress} color="bg-violet-500" />
                </div>
                <div className="mt-4 flex items-center justify-between text-sm">
                  <span className="font-semibold text-slate-700">{money(current)}</span>
                  <span className="text-slate-400">剩餘 {money(goalRemaining)}</span>
                </div>
                {goal.target_date && (
                  <div className="mt-5 flex items-center gap-2 border-t border-slate-100 pt-4 text-xs text-slate-400">
                    <CalendarDays size={14} /> 目標日期 {goal.target_date}
                  </div>
                )}
                {goal.note && <p className="mt-4 text-sm leading-6 text-slate-500">{goal.note}</p>}
              </Card>
            );
          })}
        </div>
      )}

      <Dialog
        open={goalOpen}
        onClose={() => setGoalOpen(false)}
        title="新增財務目標"
        description="依照三個步驟設定，進度之後會依目前查看的資產自動累積。"
      >
        <form className="space-y-5" onSubmit={submitGoal}>
          <FormContext value={`新增${dashboard.data?.owner_label || "目前查看"}的財務目標`} />
          <FormStep number={1} title="想完成什麼？">
            <Field label="目標名稱">
              <Input name="name" placeholder="例如：一百萬、緊急預備金" required autoFocus />
            </Field>
            <Field label="目標類型" hint={selectedGoalType.description}>
              <Select
                value={goalType}
                onChange={(event) => {
                  setGoalType(event.target.value as GoalType);
                  setGoalAccountId("");
                }}
              >
                {goalTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </Select>
            </Field>
          </FormStep>
          <FormStep number={2} title="目標是多少？" tone="blue">
            <Field label="目標金額">
              <Input
                name="target_amount"
                type="number"
                min="1"
                required
                placeholder={goalType === "debt_payoff" ? "原始貸款金額或想還掉的金額" : "想達成的金額"}
              />
            </Field>
            {needsGoalAccount && (
              <Field
                label={goalType === "debt_payoff" ? "貸款帳戶" : "指定帳戶"}
                hint={goalAccountOptions.length ? "目標進度會使用這個帳戶目前的餘額。" : "目前沒有符合條件的帳戶。"}
              >
                <Select value={goalAccountId} onChange={(event) => setGoalAccountId(event.target.value)} required>
                  <option value="">選擇帳戶</option>
                  {goalAccountOptions.map((account) => <option key={account.id} value={account.id}>{account.name}（{account.owner_label}）</option>)}
                </Select>
              </Field>
            )}
          </FormStep>
          <FormStep number={3} title="希望什麼時候完成？" description="沒有期限也可以先留空。" tone="purple">
            <Field label="目標日期">
              <DateInput name="target_date" />
            </Field>
          </FormStep>
          <details className="rounded-2xl border border-slate-200 px-4 py-3">
            <summary className="cursor-pointer list-none text-sm font-medium text-slate-600">其他設定（備註）</summary>
            <div className="mt-4"><Field label="備註"><Input name="note" placeholder="選填" /></Field></div>
          </details>
          {createGoal.isError && <p className="text-sm text-red-600">{(createGoal.error as Error).message}</p>}
          <div className="flex justify-end gap-3">
            <Button type="button" variant="ghost" onClick={() => setGoalOpen(false)}>
              取消
            </Button>
            <Button type="submit" disabled={createGoal.isPending || (needsGoalAccount && !goalAccountId)}>
              建立目標
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function resolveGoalMetric(
  goal: Goal,
  context: {
    accounts: Account[];
    currentNetWorth: number;
    investmentCost: number;
    liquidAssets: number;
  },
) {
  const target = goal.target_amount || 0;
  const type = (goal.goal_type || "net_worth") as GoalType;
  const account = goal.account_id ? context.accounts.find((item) => item.id === goal.account_id) : undefined;
  let current = context.currentNetWorth;
  let remaining = Math.max(0, target - current);

  if (type === "liquid_assets") {
    current = context.liquidAssets;
    remaining = Math.max(0, target - current);
  } else if (type === "account_balance") {
    current = account ? Math.max(0, account.total_twd) : 0;
    remaining = Math.max(0, target - current);
  } else if (type === "investment_cost") {
    current = context.investmentCost;
    remaining = Math.max(0, target - current);
  } else if (type === "debt_payoff") {
    const debtRemaining = account ? Math.abs(account.total_twd) : target;
    remaining = Math.max(0, Math.min(target, debtRemaining));
    current = Math.max(0, target - remaining);
  }

  const progress = target ? Math.min(100, Math.max(0, (current / target) * 100)) : 0;

  return {
    goal,
    target,
    current,
    remaining,
    progress,
    typeLabel: goalTypeLabels[type] || "淨資產目標",
    accountName: account?.name || goal.account_name || "",
  };
}
