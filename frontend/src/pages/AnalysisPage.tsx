import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  CircleHelp,
  Gauge,
  Lightbulb,
  PieChart as PieChartIcon,
  Repeat2,
  ShieldCheck,
  ShoppingBag,
  TrendingUp,
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
import { ownerFilterLabels, useOwnerFilter } from "../ownerFilter";
import type { Dashboard, HealthScore, SpendingAnalysis } from "../types";
import { Badge, Card, EmptyState, MonthInput, PageHeader, money, number } from "../ui";

function currentMonth() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
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
  const [ownerFilter] = useOwnerFilter();
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);
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

  const data = health.data;
  const recommendations = makeRecommendations(data, dashboard.data);
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

  return (
    <>
      <PageHeader
        eyebrow="Insights"
        title="財務健康分析"
        description="用透明公式檢視現金流、預備金、負債與預算執行情況。"
      />

      {!data ? (
        <div className="h-80 animate-pulse rounded-2xl bg-slate-200/70" />
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
                    onChange={(event) => setSelectedMonth(event.target.value || currentMonth())}
                  />
                </label>
                <div className="rounded-xl bg-slate-50 px-4 py-2.5 sm:min-w-32 sm:text-right">
                  <p className="text-xs text-slate-400">當月總支出</p>
                  <p className="mt-0.5 text-xl font-bold text-slate-800">{money(totalExpense)}</p>
                </div>
              </div>
            </div>

            {categoryExpenses.length ? (
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
                  <p className="mt-1 text-xs text-slate-400">根據最近六個月重複出現的交易自動辨識</p>
                </div>
              </div>
              <div className="rounded-xl bg-slate-50 px-4 py-3 sm:text-right">
                <p className="text-xs text-slate-400">預估每月固定支出</p>
                <p className="mt-0.5 text-xl font-bold text-slate-800">{money(spending.data?.estimated_recurring_total || 0)}</p>
              </div>
            </div>

            {spending.isPending ? (
              <div className="mt-5 h-36 animate-pulse rounded-2xl bg-slate-100" />
            ) : recurringExpenses.length ? (
              <div className="mt-5 grid gap-3 lg:grid-cols-2">
                {recurringExpenses.map((item) => (
                  <div key={`${item.account_name}-${item.name}`} className="rounded-2xl border border-slate-200/80 p-4 sm:p-5">
                    <div className="flex items-start gap-3">
                      <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-blue-50 text-blue-700">
                        <CalendarDays size={18} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="min-w-0 truncate font-semibold text-slate-800">{item.name}</p>
                          <Badge>{item.category_name}</Badge>
                          <Badge tone={item.status === "recorded" ? "green" : "amber"}>
                            {item.status === "recorded" ? "當月已發生" : "當月尚未出現"}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs text-slate-400">
                          {item.account_name} · 近六個月出現 {item.months_detected} 個月
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="font-bold text-slate-800">
                          {money(item.status === "recorded" ? item.current_month_amount : item.average_amount)}
                        </p>
                        <p className="mt-1 text-xs text-slate-400">
                          {item.status === "recorded" ? "當月金額" : "過去平均"}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={<Repeat2 size={24} />}
                title="還沒有辨識到固定花費"
                description="同一項交易至少在兩個月重複出現、金額相近後，會自動列出貸款、月費與訂閱等項目。"
              />
            )}
            <p className="mt-4 text-xs leading-5 text-slate-400">
              辨識規則：最近六個月內至少出現兩個月，且每月金額差異不超過 20%。這是管理提示，不會自動新增未來交易。
            </p>
          </Card>

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

function makeRecommendations(health?: HealthScore, dashboard?: Dashboard) {
  if (!health) return [];
  const result: string[] = [];
  const byKey = Object.fromEntries(health.components.map((item) => [item.key, item]));
  if (byKey.savings?.value !== null && byKey.savings.value < 20) {
    result.push(`目前儲蓄率約 ${number(byKey.savings.value, 1)}%，可先從最高的非必要支出分類設定預算。`);
  }
  if (byKey.emergency?.value !== null && byKey.emergency.value < 3) {
    result.push(`緊急預備金約可支撐 ${number(byKey.emergency.value, 1)} 個月，建議先以 3 個月必要支出為短期目標。`);
  }
  if (byKey.debt?.value !== null && byKey.debt.value > 30) {
    result.push(`債務支出比為 ${number(byKey.debt.value, 1)}%，新增負債前應先降低每月還款壓力。`);
  }
  if (byKey.budget?.value !== null && byKey.budget.value > 100) {
    result.push(`本月已超出整體預算 ${number(byKey.budget.value - 100, 1)}%，檢查是否有一次性支出需要另外規劃。`);
  }
  if (!dashboard?.month_income) {
    result.push("補上最近三個月的收入交易，才能計算儲蓄率、必要支出比與債務支出比。");
  }
  return result.slice(0, 3);
}
