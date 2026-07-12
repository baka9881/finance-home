import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  Gauge,
  Lightbulb,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";
import type { Dashboard, HealthScore } from "../types";
import { Badge, Card, EmptyState, PageHeader, Progress, money, number } from "../ui";

function scoreTone(score: number | null) {
  if (score === null) return { label: "資料不足", color: "text-slate-500", ring: "#cbd5e1" };
  if (score >= 80) return { label: "穩健", color: "text-emerald-700", ring: "#22a477" };
  if (score >= 60) return { label: "良好", color: "text-blue-700", ring: "#3b82f6" };
  if (score >= 40) return { label: "需留意", color: "text-amber-700", ring: "#f59e0b" };
  return { label: "優先改善", color: "text-red-700", ring: "#ef4444" };
}

function componentValue(key: string, value: number | null) {
  if (value === null) return "尚無資料";
  if (key === "emergency") return `${number(value, 1)} 個月`;
  return `${number(value, 1)}%`;
}

export default function AnalysisPage() {
  const health = useQuery({ queryKey: ["health"], queryFn: () => api<HealthScore>("/analysis/health") });
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: () => api<Dashboard>("/dashboard") });

  const data = health.data;
  const tone = scoreTone(data?.score ?? null);
  const recommendations = makeRecommendations(data, dashboard.data);

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
          <div className="grid gap-6 xl:grid-cols-[.8fr_1.2fr]">
            <Card className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-bold text-ink">財務健康分數</h2>
                  <p className="mt-1 text-xs text-slate-400">僅依目前輸入資料估算</p>
                </div>
                <Badge tone={data.completeness >= 3 ? "green" : "amber"}>{data.completeness}/5 指標有效</Badge>
              </div>
              <div className="relative mx-auto mt-8 grid size-52 place-items-center">
                <svg className="absolute inset-0 -rotate-90" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="42" fill="none" stroke="#edf1ef" strokeWidth="8" />
                  <circle
                    cx="50"
                    cy="50"
                    r="42"
                    fill="none"
                    stroke={tone.ring}
                    strokeWidth="8"
                    strokeLinecap="round"
                    pathLength="100"
                    strokeDasharray={`${data.score || 0} 100`}
                  />
                </svg>
                <div className="text-center">
                  <p className={`text-5xl font-bold ${tone.color}`}>{data.score === null ? "—" : number(data.score, 0)}</p>
                  <p className="mt-2 text-sm font-semibold text-slate-500">{tone.label}</p>
                </div>
              </div>
              <p className="mt-7 text-center text-xs leading-5 text-slate-400">
                至少需要三項有效指標才會產生總分。分數是管理提示，不是投資或信用評等。
              </p>
            </Card>

            <Card className="p-6">
              <h2 className="font-bold text-ink">指標明細</h2>
              <div className="mt-5 divide-y divide-slate-100">
                {data.components.map((component) => (
                  <div key={component.key} className="py-4 first:pt-0 last:pb-0">
                    <div className="flex items-center gap-3">
                      <div className={`grid size-9 place-items-center rounded-xl ${component.score === null ? "bg-slate-100 text-slate-400" : component.score >= 15 ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                        {component.score === null ? <CircleHelp size={16} /> : component.score >= 15 ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-semibold text-slate-700">{component.label}</p>
                          <p className="text-sm font-bold text-slate-800">{componentValue(component.key, component.value)}</p>
                        </div>
                        <div className="mt-2"><Progress value={(component.score || 0) * 5} color={component.score !== null && component.score >= 15 ? "bg-emerald-500" : "bg-amber-500"} /></div>
                        <p className="mt-1.5 text-xs text-slate-400">{component.detail}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>

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
                    <Tooltip formatter={(value) => money(Number(value))} cursor={{ fill: "#f4f8f6" }} />
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
                <h2 className="font-bold text-slate-800">計算方式</h2>
                <p className="mt-2 text-sm leading-7 text-slate-500">
                  儲蓄率＝（近 90 天平均月收入－平均月支出）÷平均月收入；緊急預備金＝流動資產÷平均必要支出；
                  債務支出比與必要支出比均以平均月收入為分母；預算遵守度比較本月實際支出與設定預算。
                  每項滿分 20 分，有效項目會等比例換算成 100 分。
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
