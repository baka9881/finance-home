import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "./api";
import { Button, Card } from "./ui";

interface Reminder { id: string; label: string; action: string; href: string; tone: "info" | "warning" }
export default function AttentionReminders({ owner }: { owner: string }) {
  const reminders = useQuery({ queryKey: ["attention", owner], queryFn: () => api<Reminder[]>(`/attention?owner=${owner}`) });
  if (reminders.isError) return <div role="alert" className="mb-5 text-sm text-amber-700">提醒暫時無法更新；下方財務資料仍可查看。<Button variant="ghost" onClick={() => reminders.refetch()}>重試提醒</Button></div>;
  if (!reminders.data?.length) return null;
  return <Card className="mb-6 p-4 sm:p-5"><h2 className="font-semibold">待處理事項</h2><ul className="mt-2 divide-y divide-slate-100">{reminders.data.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-3"><p className={`text-sm ${item.tone === "warning" ? "text-amber-700" : "text-slate-600"}`}>{item.label}</p><Link className="rounded-xl px-3 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 focus-visible:outline focus-visible:outline-2" to={item.href}>{item.action} →</Link></li>)}</ul></Card>;
}
