import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  CircleHelp,
  Gauge,
  EyeOff,
  Lightbulb,
  Pencil,
  PieChart as PieChartIcon,
  Plus,
  Repeat2,
  ShieldCheck,
  ShoppingBag,
  Trash2,
  TrendingUp,
  Undo2,
} from "lucide-react";
import {
  Bar,
  BarChart,
  Cell,
  CartesianGrid,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";
import { taipeiMonthInputValue } from "../date";
import { ownerFilterLabels, useOwnerFilter } from "../ownerFilter";
import type { Account, Category, Dashboard, HealthScore, IgnoredRecurringExpense, SpendingAnalysis } from "../types";
import { Badge, Button, Card, Dialog, EmptyState, Field, FormStep, Input, MonthInput, PageHeader, Select, Skeleton, money, number } from "../ui";

const recurringPresets = ["房貸", "車貸", "信貸", "學貸", "房租", "保險", "健身房月費", "手機費", "網路費", "訂閱服務"];
const recurringOwnerOptions = [
  { value: "me", label: "我" },
  { value: "partner", label: "女友" },
  { value: "shared", label: "共同" },
];

interface RecurringDraft {
  name: string;
  amount: string;
  due_day: string;
  account_id: string;
  category_id: string;
  owner: string;
  note: string;
}

function emptyRecurringDraft(ownerFilter: string): RecurringDraft {
  return {
    name: "",
    amount: "",
    due_day: "",
    account_id: "",
    category_id: "",
    owner: ownerFilter === "all" ? "me" : ownerFilter,
    note: "",
  };
}

function displayMonth(value: string) {
  const [year, month] = value.split("-");
  return `${year}年${Number(month)}月`;
}

function componentValue(key: string, value: number | null) {
  if (value === null) return "尚無資料";
  if (key === "emergency") return value >= 12 ? "12 個月以上" : `${number(value, 1)} 個月`;
  return `${number(value, 1)}%`;
}

function indicatorState(key: string, value: number | null) {
  if (value === null) {
    return {
      label: "資料不足",
      iconClass: "bg-slate-100 text-slate-400",
      badgeTone: "amber" as const,
      message: "補上近三個月的收支資料後會自動估算。",
    };
  }
  if (key === "savings") {
    return value >= 20
      ? { label: "穩定", iconClass: "bg-emerald-50 text-emerald-700", badgeTone: "green" as const, message: "儲蓄率已達 20% 以上。" }
      : { label: "需留意", iconClass: "bg-amber-50 text-amber-700", badgeTone: "amber" as const, message: "可先從最高的非必要支出開始調整。" };
  }
  if (key === "debt") {
    return value <= 20
      ? { label: "穩定", iconClass: "bg-emerald-50 text-emerald-700", badgeTone: "green" as const, message: "每月還款壓力目前在理想範圍。" }
      : { label: "需留意", iconClass: "bg-amber-50 text-amber-700", badgeTone: "amber" as const, message: "建議先降低每月還款壓力，再考慮新增負債。" };
  }
  return value >= 6
    ? { label: "充足", iconClass: "bg-emerald-50 text-emerald-700", badgeTone: "green" as const, message: "已超過 6 個月必要支出的建議水位。" }
    : { label: "需留意", iconClass: "bg-amber-50 text-amber-700", badgeTone: "amber" as const, message: "建議先累積到至少 3 個月的必要支出。" };
}

export default function AnalysisPage() {
  const client = useQueryClient();
  const [ownerFilter] = useOwnerFilter();
  const [selectedMonth, setSelectedMonth] = useState(taipeiMonthInputValue);
  const [recurringOpen, setRecurringOpen] = useState(false);
  const [ignoredRecurringOpen, setIgnoredRecurringOpen] = useState(false);
  const [editingRecurringId, setEditingRecurringId] = useState<number | null>(null);
  const [recurringDraft, setRecurringDraft] = useState<RecurringDraft>(() => emptyRecurringDraft("me"));
  const health = useQuery({
    queryKey: ["health", ownerFilter],
    queryFn: () => api<HealthScore>(`/analysis/health?owner=${ownerFilter}`),
  });
  const dashboard = useQuery({
    queryKey: ["dashboard", ownerFilter],
    queryFn: () => api<Dashboard>(`/dashboard?owner=${ownerFilter}`),
  });
  const spending = useQuery({
    queryKey: ["spending-analysis", selectedMonth, ownerFilter],
    queryFn: () => api<SpendingAnalysis>(`/analysis/spending?month=${selectedMonth}&owner=${ownerFilter}`),
  });
  const accounts = useQuery({
    queryKey: ["accounts", "all"],
    queryFn: () => api<Account[]>("/accounts?owner=all"),
  });
  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: () => api<Category[]>("/categories"),
  });
  const ignoredRecurring = useQuery({
    queryKey: ["ignored-recurring-expenses", ownerFilter],
    queryFn: () => api<IgnoredRecurringExpense[]>(`/recurring-expenses/ignored?owner=${ownerFilter}`),
  });

  const saveRecurring = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api(
        editingRecurringId
          ? `/recurring-expenses/${editingRecurringId}`
          : "/recurring-expenses",
        {
          method: editingRecurringId ? "PATCH" : "POST",
          body: JSON.stringify(payload),
        },
      ),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["spending-analysis"] });
      setRecurringOpen(false);
      setEditingRecurringId(null);
      setRecurringDraft(emptyRecurringDraft(ownerFilter));
    },
  });

  const deleteRecurring = useMutation({
    mutationFn: (id: number) => api(`/recurring-expenses/${id}`, { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["spending-analysis"] }),
  });

  const ignoreDetectedRecurring = useMutation({
    mutationFn: (item: SpendingAnalysis["recurring_expenses"][number]) =>
      api("/recurring-expenses/ignore-detected", {
        method: "POST",
        body: JSON.stringify({ account_id: item.account_id, name: item.name }),
      }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["spending-analysis"] });
      client.invalidateQueries({ queryKey: ["ignored-recurring-expenses"] });
    },
  });

  const restoreIgnoredRecurring = useMutation({
    mutationFn: (id: number) => api(`/recurring-expenses/ignored/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["spending-analysis"] });
      client.invalidateQueries({ queryKey: ["ignored-recurring-expenses"] });
    },
  });

  function openNewRecurring() {
    setEditingRecurringId(null);
    setRecurringDraft(emptyRecurringDraft(ownerFilter));
    saveRecurring.reset();
    setRecurringOpen(true);
  }

  function openEditRecurring(item: SpendingAnalysis["recurring_expenses"][number]) {
    if (!item.id || item.source !== "custom") return;
    setEditingRecurringId(item.id);
    setRecurringDraft({
      name: item.name,
      amount: String(item.average_amount),
      due_day: item.due_day ? String(item.due_day) : "",
      account_id: item.account_id ? String(item.account_id) : "",
      category_id: item.category_id ? String(item.category_id) : "",
      owner: item.owner || "me",
      note: item.note || "",
    });
    saveRecurring.reset();
    setRecurringOpen(true);
  }

  function submitRecurring(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    saveRecurring.mutate({
      name: recurringDraft.name.trim(),
      amount: Number(recurringDraft.amount),
      due_day: recurringDraft.due_day ? Number(recurringDraft.due_day) : null,
      account_id: recurringDraft.account_id ? Number(recurringDraft.account_id) : null,
      category_id: recurringDraft.category_id ? Number(recurringDraft.category_id) : null,
      owner: recurringDraft.owner,
      note: recurringDraft.note.trim() || null,
      active: true,
    });
  }

  const data = health.data;
  const recommendations = makeRecommendations(data);
  const componentsByKey = Object.fromEntries(
    (data?.components || []).map((component) => [component.key, component]),
  );
  const compactIndicators = [
    { key: "savings", label: "儲蓄率", description: "近 90 天平均收入中留下的比例" },
    { key: "debt", label: "負債支出比", description: "每月還款占收入的比例" },
    { key: "emergency", label: "緊急預備金", description: "流動資產可支應必要支出的時間" },
  ].map((item) => {
    const component = componentsByKey[item.key];
    return { ...item, component, state: indicatorState(item.key, component?.value ?? null) };
  });
  const validIndicatorCount = compactIndicators.filter((item) => item.component?.value !== null && item.component?.value !== undefined).length;
  const totalExpense = spending.data?.month_expense || 0;
  const categoryExpenses = spending.data?.category_expenses || [];
  const recurringExpenses = spending.data?.recurring_expenses || [];
  const monthLabel = displayMonth(selectedMonth);
  const primaryLoading = health.isLoading || dashboard.isLoading;
  const primaryError = health.isError || dashboard.isError;

  return (
    <>
      <PageHeader
        eyebrow="Insights"
        title="財務健康分析"
        description="用透明公式檢視現金流、預備金、負債與預算執行情況。"
      />

      {primaryError ? (
        <Card>
          <EmptyState
            icon={<AlertTriangle size={24} />}
            title="財務分析載入失敗"
            description="資料仍安全保留，請檢查連線後重新載入。"
            action={<Button onClick={() => { health.refetch(); dashboard.refetch(); }}>重新載入</Button>}
          />
        </Card>
      ) : primaryLoading || !data ? (
        <div className="space-y-6" aria-label="正在載入財務分析" aria-busy="true">
          <Card className="p-6">
            <div className="flex items-center justify-between"><Skeleton className="h-5 w-28" /><Skeleton className="h-7 w-24 rounded-full" /></div>
            <div className="mt-5 grid gap-4 md:grid-cols-3">
              {[1, 2, 3].map((item) => <Skeleton key={item} className="h-48 rounded-2xl" />)}
            </div>
          </Card>
          <Card className="p-6">
            <div className="flex items-center justify-between"><Skeleton className="h-5 w-36" /><Skeleton className="h-11 w-44" /></div>
            <Skeleton className="mt-6 h-64 rounded-2xl" />
          </Card>
        </div>
      ) : (
        <>
          <Card className="p-5 sm:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="font-bold text-ink">財務提醒</h2>
                <p className="mt-1 text-xs text-slate-400">保留最實用的三項指標，不再用總分評斷財務狀況</p>
              </div>
              <Badge tone={validIndicatorCount === 3 ? "green" : "amber"}>{validIndicatorCount}/3 指標有資料</Badge>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-3">
              {compactIndicators.map((item) => {
                const value = item.component?.value ?? null;
                const isMissing = value === null;
                const needsAttention = !isMissing && item.state.label === "需留意";
                return (
                  <div key={item.key} className="rounded-2xl border border-slate-200/80 bg-slate-50/60 p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className={`grid size-10 shrink-0 place-items-center rounded-xl ${item.state.iconClass}`}>
                        {isMissing ? <CircleHelp size={18} /> : needsAttention ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
                      </div>
                      <Badge tone={item.state.badgeTone}>{item.state.label}</Badge>
                    </div>
                    <p className="mt-5 text-sm font-semibold text-slate-500">{item.label}</p>
                    <p className="mt-1 text-2xl font-bold text-slate-800">{componentValue(item.key, value)}</p>
                    <p className="mt-2 text-xs leading-5 text-slate-400">{item.description}</p>
                    {(needsAttention || isMissing) && (
                      <p className={`mt-4 rounded-xl px-3 py-2 text-xs leading-5 ${needsAttention ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-500"}`}>
                        {item.state.message}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className="mt-6 p-5 sm:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="rounded-xl bg-purple-50 p-2.5 text-purple-700"><PieChartIcon size={18} /></div>
                <div>
                  <h2 className="font-bold text-ink">本月消費分布</h2>
                  <p className="mt-1 text-xs text-slate-400">{monthLabel} · {ownerFilterLabels[ownerFilter]} · 依支出分類統計</p>
                </div>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-slate-400">查看月份</span>
                  <MonthInput
                    className="w-full sm:w-44"
                    value={selectedMonth}
                    onChange={(event) => setSelectedMonth(event.target.value || taipeiMonthInputValue())}
                  />
                </label>
                <div className="rounded-xl bg-slate-50 px-4 py-2.5 sm:min-w-32 sm:text-right">
                  <p className="text-xs text-slate-400">當月總支出</p>
                  {spending.isPending
                    ? <Skeleton className="mt-1 h-6 w-24 sm:ml-auto" />
                    : <p className="mt-0.5 text-xl font-bold text-slate-800">{money(totalExpense)}</p>}
                </div>
              </div>
            </div>

            {spending.isError ? (
              <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-center">
                <p className="text-sm font-semibold text-amber-900">這個月份的消費資料載入失敗</p>
                <p className="mt-1 text-xs text-amber-700">目前不會顯示 NT$0，以免誤以為沒有消費。</p>
                <Button className="mt-4" variant="secondary" onClick={() => spending.refetch()}>重新載入</Button>
              </div>
            ) : spending.isPending ? (
              <div className="mt-6 grid gap-7 lg:grid-cols-[320px_1fr] lg:items-center" aria-busy="true">
                <Skeleton className="mx-auto h-60 w-60 rounded-full" />
                <div className="space-y-4">{[1, 2, 3, 4].map((item) => <Skeleton key={item} className="h-9" />)}</div>
              </div>
            ) : categoryExpenses.length ? (
              <div className="mt-6 grid gap-7 lg:grid-cols-[320px_1fr] lg:items-center">
                <div className="relative mx-auto h-[250px] w-full max-w-[320px] [&_*]:outline-none">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart accessibilityLayer={false}>
                      <Pie
                        data={categoryExpenses}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        innerRadius={70}
                        outerRadius={105}
                        paddingAngle={2}
                        stroke="transparent"
                      >
                        {categoryExpenses.map((item) => (
                          <Cell key={item.name} fill={item.color} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value) => money(Number(value))} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 grid place-content-center text-center">
                    <p className="text-xs text-slate-400">總消費</p>
                    <p className="mt-1 text-xl font-bold text-slate-800">{money(totalExpense)}</p>
                  </div>
                </div>

                <div className="space-y-4">
                  {categoryExpenses.map((item, index) => {
                    const percentage = totalExpense ? (item.value / totalExpense) * 100 : 0;
                    return (
                      <div key={item.name}>
                        <div className="mb-2 flex items-center gap-3">
                          <span className="w-5 text-xs font-semibold text-slate-400">{index + 1}</span>
                          <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-700">{item.name}</span>
                          <span className="text-sm font-bold text-slate-800">{money(item.value)}</span>
                          <span className="w-14 text-right text-xs font-semibold text-slate-400">{number(percentage, 1)}%</span>
                        </div>
                        <div className="ml-8 h-2 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full transition-[width]"
                            style={{ width: `${Math.min(100, percentage)}%`, backgroundColor: item.color }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <EmptyState
                icon={<ShoppingBag size={24} />}
                title="這個月份還沒有消費"
                description="選擇其他月份，或新增、匯入支出後查看餐飲、購物、交通等分類。"
              />
            )}
          </Card>

          <Card className="mt-6 p-5 sm:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="rounded-xl bg-blue-50 p-2.5 text-blue-700"><Repeat2 size={18} /></div>
                <div>
                  <h2 className="font-bold text-ink">每月固定花費</h2>
                  <p className="mt-1 text-xs text-slate-400">自動辨識重複交易，也可以自行建立房貸、車貸、信貸與月費</p>
                </div>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Button variant="secondary" onClick={() => setIgnoredRecurringOpen(true)}>
                  <EyeOff size={16} /> 已忽略項目
                  {ignoredRecurring.data?.length ? ` ${ignoredRecurring.data.length}` : ""}
                </Button>
                <Button variant="secondary" onClick={openNewRecurring}>
                  <Plus size={16} /> 自訂固定花費
                </Button>
                <div className="rounded-xl bg-slate-50 px-4 py-3 sm:text-right">
                  <p className="text-xs text-slate-400">預估每月固定支出</p>
                  <p className="mt-0.5 text-xl font-bold text-slate-800">{money(spending.data?.estimated_recurring_total || 0)}</p>
                </div>
              </div>
            </div>

            {spending.isError ? (
              <div className="mt-5 rounded-2xl bg-slate-50 p-5 text-center text-sm text-slate-500">固定花費暫時無法載入，請先重新載入上方的消費資料。</div>
            ) : spending.isPending ? (
              <div className="mt-5 h-36 animate-pulse rounded-2xl bg-slate-100" />
            ) : recurringExpenses.length ? (
              <div className="mt-5 grid min-w-0 gap-3 lg:grid-cols-2">
                {recurringExpenses.map((item) => (
                  <div
                    key={`${item.source}-${item.id || `${item.account_name}-${item.name}`}`}
                    className="min-w-0 overflow-hidden rounded-2xl border border-slate-200/80 p-4 sm:p-5"
                  >
                    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start">
                      <div className="flex min-w-0 items-start gap-3 sm:flex-1">
                        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-blue-50 text-blue-700">
                          <CalendarDays size={18} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <p className="w-full min-w-0 break-words font-semibold text-slate-800 [overflow-wrap:anywhere] sm:w-auto">
                              {item.name}
                            </p>
                            <Badge>{item.category_name}</Badge>
                            <Badge tone={item.source === "custom" ? "blue" : "slate"}>
                              {item.source === "custom" ? "自行設定" : "自動辨識"}
                            </Badge>
                            <Badge tone={item.status === "recorded" ? "green" : "amber"}>
                              {item.status === "recorded" ? "當月已發生" : "當月尚未出現"}
                            </Badge>
                          </div>
                          <p className="mt-1 break-words text-xs text-slate-400 [overflow-wrap:anywhere]">
                            {item.account_name}
                            {item.source === "custom"
                              ? item.due_day
                                ? ` · 每月 ${item.due_day} 日`
                                : " · 未指定扣款日"
                              : ` · 近六個月出現 ${item.months_detected} 個月`}
                          </p>
                        </div>
                      </div>
                      <div className="flex min-w-0 items-center justify-between gap-3 border-t border-slate-100 pt-3 sm:block sm:shrink-0 sm:border-0 sm:pt-0 sm:text-right">
                        <div className="flex flex-wrap items-center gap-2">
                          <div>
                            <p className="whitespace-nowrap font-bold text-slate-800">
                              {money(item.status === "recorded" ? item.current_month_amount : item.average_amount)}
                            </p>
                            <p className="mt-1 text-xs text-slate-400">
                              {item.status === "recorded" ? "當月金額" : "過去平均"}
                            </p>
                          </div>
                        </div>
                        {item.source === "custom" && item.id ? (
                          <div className="flex justify-end gap-1 sm:mt-2">
                            <button
                              type="button"
                              className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                              aria-label={`編輯${item.name}`}
                              onClick={() => openEditRecurring(item)}
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              type="button"
                              className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"
                              aria-label={`刪除${item.name}`}
                              onClick={() => {
                                if (window.confirm(`確定刪除「${item.name}」固定花費？`)) {
                                  deleteRecurring.mutate(item.id as number);
                                }
                              }}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ) : item.source === "detected" && item.account_id ? (
                          <div className="flex justify-end sm:mt-2">
                            <button
                              type="button"
                              className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"
                              aria-label={`移除自動辨識固定花費 ${item.name}`}
                              disabled={ignoreDetectedRecurring.isPending}
                              onClick={() => {
                                if (window.confirm(`不再把「${item.name}」辨識為固定花費嗎？原始交易不會被刪除。`)) {
                                  ignoreDetectedRecurring.mutate(item);
                                }
                              }}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={<Repeat2 size={24} />}
                title="還沒有辨識到固定花費"
                description="可以自行建立房貸、車貸、信貸、月費與訂閱；交易重複出現後也會自動辨識。"
                action={<Button onClick={openNewRecurring}>建立第一筆固定花費</Button>}
              />
            )}
            <p className="mt-4 text-xs leading-5 text-slate-400">
              自訂項目只用於每月預估與提醒，不會直接扣除帳戶餘額；實際交易匯入後會標記為「當月已發生」。已知訂閱近三個月出現兩次即可辨識；月費與貸款需連續出現兩個月，其他帳單需連續三個月，且扣款日與金額穩定。購物、餐飲、超商與車票不會自動列為固定花費。移除自動辨識項目只會隱藏固定花費，不會刪除原始交易。
            </p>
          </Card>

          <Dialog
            open={ignoredRecurringOpen}
            onClose={() => setIgnoredRecurringOpen(false)}
            title="已忽略的固定花費"
            description="恢復後，只要交易仍符合重複條件，就會重新出現在每月固定花費。"
          >
            {ignoredRecurring.isPending ? (
              <div className="space-y-3">
                <Skeleton className="h-20 w-full rounded-2xl" />
                <Skeleton className="h-20 w-full rounded-2xl" />
              </div>
            ) : ignoredRecurring.isError ? (
              <EmptyState
                icon={<AlertTriangle size={24} />}
                title="無法載入已忽略項目"
                description="請檢查連線後重新載入。"
                action={<Button onClick={() => ignoredRecurring.refetch()}>重新載入</Button>}
              />
            ) : ignoredRecurring.data?.length ? (
              <div className="space-y-3">
                {ignoredRecurring.data.map((item) => (
                  <div key={item.id} className="flex flex-col gap-3 rounded-2xl border border-slate-200/80 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-800">{item.name}</p>
                      <p className="mt-1 text-xs text-slate-400">{item.account_name} · {item.owner_label}</p>
                    </div>
                    <Button
                      variant="secondary"
                      disabled={restoreIgnoredRecurring.isPending}
                      onClick={() => restoreIgnoredRecurring.mutate(item.id)}
                    >
                      <Undo2 size={16} /> 恢復辨識
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={<EyeOff size={24} />}
                title="沒有已忽略項目"
                description="你移除的自動辨識固定花費會集中顯示在這裡。"
              />
            )}
          </Dialog>

          <Dialog
            open={recurringOpen}
            onClose={() => setRecurringOpen(false)}
            title={editingRecurringId ? "編輯固定花費" : "新增固定花費"}
            description="設定每月通常會發生的支出；這裡不會直接建立交易或扣款。"
          >
            <form className="space-y-5" onSubmit={submitRecurring}>
              <FormStep number={1} title="這是什麼固定花費？" description="可選常見項目後再自行修改名稱。">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="常見項目">
                    <Select
                      value={recurringPresets.includes(recurringDraft.name) ? recurringDraft.name : ""}
                      onChange={(event) => setRecurringDraft((draft) => ({ ...draft, name: event.target.value }))}
                    >
                      <option value="">選擇或自行輸入</option>
                      {recurringPresets.map((preset) => <option key={preset}>{preset}</option>)}
                    </Select>
                  </Field>
                  <Field label="顯示名稱">
                    <Input
                      value={recurringDraft.name}
                      onChange={(event) => setRecurringDraft((draft) => ({ ...draft, name: event.target.value }))}
                      placeholder="例如：汽車貸款"
                      required
                    />
                  </Field>
                </div>
              </FormStep>

              <FormStep number={2} title="每月大約多少錢？" tone="blue">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="每月金額（TWD）">
                    <Input
                      type="number"
                      inputMode="decimal"
                      min="1"
                      step="any"
                      value={recurringDraft.amount}
                      onChange={(event) => setRecurringDraft((draft) => ({ ...draft, amount: event.target.value }))}
                      placeholder="例如：12000"
                      required
                    />
                  </Field>
                  <Field label="每月扣款日" hint="日期不固定可以留空。">
                    <Input
                      type="number"
                      inputMode="numeric"
                      min="1"
                      max="31"
                      value={recurringDraft.due_day}
                      onChange={(event) => setRecurringDraft((draft) => ({ ...draft, due_day: event.target.value }))}
                      placeholder="例如：5"
                    />
                  </Field>
                </div>
              </FormStep>

              <FormStep number={3} title="由誰支付、從哪裡扣？" tone="purple">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="所有人">
                    <Select
                      value={recurringDraft.owner}
                      onChange={(event) => setRecurringDraft((draft) => ({ ...draft, owner: event.target.value }))}
                    >
                      {recurringOwnerOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </Select>
                  </Field>
                  <Field label="付款或貸款帳戶" hint="還沒建立帳戶也可以留空。">
                    <Select
                      value={recurringDraft.account_id}
                      onChange={(event) => setRecurringDraft((draft) => ({ ...draft, account_id: event.target.value }))}
                    >
                      <option value="">不指定帳戶</option>
                      {accounts.data?.map((account) => (
                        <option key={account.id} value={account.id}>{account.name}（{account.owner_label}）</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="支出分類">
                    <Select
                      value={recurringDraft.category_id}
                      onChange={(event) => setRecurringDraft((draft) => ({ ...draft, category_id: event.target.value }))}
                    >
                      <option value="">不指定分類</option>
                      {categories.data?.filter((category) => category.kind === "expense").map((category) => (
                        <option key={category.id} value={category.id}>{category.name}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="備註">
                    <Input
                      value={recurringDraft.note}
                      onChange={(event) => setRecurringDraft((draft) => ({ ...draft, note: event.target.value }))}
                      placeholder="例如：剩餘 24 期"
                    />
                  </Field>
                </div>
              </FormStep>

              {saveRecurring.isError && <p className="text-sm text-red-600">{(saveRecurring.error as Error).message}</p>}
              <div className="mobile-safe-actions sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-slate-100 bg-white/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0">
                <Button type="button" variant="ghost" onClick={() => setRecurringOpen(false)}>取消</Button>
                <Button type="submit" disabled={saveRecurring.isPending}>
                  {saveRecurring.isPending ? "儲存中…" : editingRecurringId ? "儲存修改" : "建立固定花費"}
                </Button>
              </div>
            </form>
          </Dialog>

          <div className="mt-6 grid gap-6 xl:grid-cols-[1.25fr_.75fr]">
            <Card className="p-6">
              <div className="flex items-center gap-3">
                <div className="rounded-xl bg-blue-50 p-2.5 text-blue-700"><TrendingUp size={18} /></div>
                <div>
                  <h2 className="font-bold text-ink">現金流趨勢</h2>
                  <p className="mt-1 text-xs text-slate-400">最近六個月收入與支出</p>
                </div>
              </div>
              <div className="mt-5 h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dashboard.data?.cashflow_trend || []} accessibilityLayer={false}>
                    <CartesianGrid vertical={false} stroke="#e8eeeb" strokeDasharray="4 4" />
                    <XAxis dataKey="month" tickLine={false} axisLine={false} />
                    <YAxis width={70} tickLine={false} axisLine={false} tickFormatter={(value) => `${value / 1000}k`} />
                    <Tooltip formatter={(value) => money(Number(value))} cursor={{ fill: "rgba(35, 132, 95, .08)" }} />
                    <Bar dataKey="income" name="收入" fill="#23845f" radius={[5, 5, 0, 0]} maxBarSize={34} />
                    <Bar dataKey="expense" name="支出" fill="#f1a15b" radius={[5, 5, 0, 0]} maxBarSize={34} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="p-6">
              <div className="flex items-center gap-3">
                <div className="rounded-xl bg-amber-50 p-2.5 text-amber-600"><Lightbulb size={18} /></div>
                <div>
                  <h2 className="font-bold text-ink">本月建議</h2>
                  <p className="mt-1 text-xs text-slate-400">依目前資料產生</p>
                </div>
              </div>
              {recommendations.length ? (
                <div className="mt-5 space-y-3">
                  {recommendations.map((item, index) => (
                    <div key={index} className="rounded-xl border border-slate-100 bg-slate-50/70 p-4">
                      <div className="flex items-start gap-3">
                        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-white text-xs font-bold text-emerald-700 shadow-sm">{index + 1}</span>
                        <p className="text-sm leading-6 text-slate-600">{item}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState icon={<ShieldCheck size={24} />} title="目前狀況穩定" description="繼續定期更新帳戶與交易資料。" />
              )}
            </Card>
          </div>

          <Card className="mt-6 p-6">
            <div className="flex items-start gap-4">
              <div className="rounded-2xl bg-slate-100 p-3 text-slate-600"><Gauge size={20} /></div>
              <div>
                <h2 className="font-bold text-slate-800">指標說明</h2>
                <p className="mt-2 text-sm leading-7 text-slate-500">
                  儲蓄率＝（近 90 天平均月收入－平均月支出）÷平均月收入；緊急預備金＝流動資產÷平均必要支出；
                  負債支出比＝近 90 天平均每月還款÷平均月收入。這些數字只用於提醒，不會再合併成容易誤解的總分。
                </p>
              </div>
            </div>
          </Card>
        </>
      )}
    </>
  );
}

export function makeRecommendations(health?: HealthScore) {
  if (!health) return [];
  const result: string[] = [];
  const byKey = Object.fromEntries(health.components.map((item) => [item.key, item]));
  const savings = byKey.savings?.value;
  const emergency = byKey.emergency?.value;
  const debt = byKey.debt?.value;
  const budget = byKey.budget?.value;
  if (typeof savings === "number" && savings < 20) {
    result.push(`目前儲蓄率約 ${number(savings, 1)}%，可先從最高的非必要支出分類設定預算。`);
  }
  if (typeof emergency === "number" && emergency < 3) {
    result.push(`緊急預備金約可支撐 ${number(emergency, 1)} 個月，建議先以 3 個月必要支出為短期目標。`);
  }
  if (typeof debt === "number" && debt > 30) {
    result.push(`債務支出比為 ${number(debt, 1)}%，新增負債前應先降低每月還款壓力。`);
  }
  if (typeof budget === "number" && budget > 100) {
    result.push(`本月已超出整體預算 ${number(budget - 100, 1)}%，檢查是否有一次性支出需要另外規劃。`);
  }
  const hasIncomeBasedIndicator = typeof savings === "number" || typeof debt === "number";
  if (!hasIncomeBasedIndicator) {
    result.push("補上最近三個月的收入交易，才能計算儲蓄率、必要支出比與債務支出比。");
  }
  return result.slice(0, 3);
}
