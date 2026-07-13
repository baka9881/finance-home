import { FormEvent, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  Check,
  Database,
  Download,
  KeyRound,
  Moon,
  RefreshCw,
  Save,
  Shield,
  Sun,
  Trash2,
  Upload,
} from "lucide-react";
import { api } from "../api";
import { type AppTheme, getStoredTheme, saveTheme } from "../theme";
import type { Category } from "../types";
import {
  Badge,
  Button,
  Card,
  cn,
  FormStep,
  Input,
  PageHeader,
  Select,
} from "../ui";

interface SettingsData {
  mode: string;
  base_currency: string;
  alpha_vantage_configured: boolean;
}

interface FxRate {
  currency: string;
  rate_date: string;
  rate_to_twd: number;
  source: string;
  manual: boolean;
}

interface Rule {
  id: number;
  keyword: string;
  category_id: number;
  category_name: string;
  transaction_kind: string;
  priority: number;
  enabled: boolean;
}

export default function SettingsPage() {
  const client = useQueryClient();
  const restoreInput = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");
  const [marketSettingsOpen, setMarketSettingsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(() => getStoredTheme());
  const [lastBackupAt, setLastBackupAt] = useState(() => localStorage.getItem("finance:lastBackupAt") || "");

  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<SettingsData>("/settings") });
  const fx = useQuery({ queryKey: ["fx"], queryFn: () => api<FxRate[]>("/fx") });
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => api<Rule[]>("/rules") });
  const categories = useQuery({ queryKey: ["categories"], queryFn: () => api<Category[]>("/categories") });
  const latestFxDate = fx.data?.reduce((latest, rate) => (rate.rate_date > latest ? rate.rate_date : latest), "") || "";

  const saveSettings = useMutation({
    mutationFn: (key: string) =>
      api<SettingsData>("/settings", {
        method: "PUT",
        body: JSON.stringify({ alpha_vantage_api_key: key }),
      }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["settings"] });
      setMessage("API 設定已儲存。");
    },
  });
  const refreshFx = useMutation({
    mutationFn: () => api<{ saved: number; latest_date?: string }>("/fx/refresh", { method: "POST" }),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: ["fx"] });
      setMessage(`央行匯率更新完成，寫入 ${result.saved} 筆資料。`);
    },
  });
  const manualFx = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api("/fx/manual", { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["fx"] });
      setMessage("自訂匯率已儲存。");
    },
  });
  const createRule = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api("/rules", { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["rules"] });
      setMessage("分類規則已儲存。");
    },
  });
  const deleteRule = useMutation({
    mutationFn: (id: number) => api(`/rules/${id}`, { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["rules"] }),
  });
  const restore = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append("file", file);
      return api<{ ok: boolean }>("/backup/restore", { method: "POST", body });
    },
    onSuccess: () => {
      client.invalidateQueries();
      setMessage("備份已還原，現有財務資料已由備份內容取代。");
    },
  });

  async function downloadBackup() {
    const response = await fetch("/api/backup/export");
    if (!response.ok) {
      setMessage("備份下載失敗。");
      return;
    }
    const blob = await response.blob();
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = `finance-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(href);
    const backupTime = new Date().toLocaleString("zh-TW", { hour12: false });
    localStorage.setItem("finance:lastBackupAt", backupTime);
    setLastBackupAt(backupTime);
    setMessage("備份檔已下載。");
  }

  function submitSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    saveSettings.mutate(String(form.get("api_key") || ""));
    event.currentTarget.reset();
  }

  function submitManualFx(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    manualFx.mutate({
      currency: form.get("currency"),
      rate_date: form.get("rate_date"),
      rate_to_twd: Number(form.get("rate_to_twd")),
    });
  }

  function submitRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    createRule.mutate({
      keyword: form.get("keyword"),
      category_id: Number(form.get("category_id")),
      transaction_kind: form.get("transaction_kind"),
      priority: 100,
    });
    event.currentTarget.reset();
  }

  function changeTheme(nextTheme: AppTheme) {
    setTheme(nextTheme);
    saveTheme(nextTheme);
  }

  return (
    <>
      <PageHeader
        eyebrow="Toolkit"
        title="資料工具箱"
        description="把常用的備份、行情匯率與自動分類集中在這裡。"
      />

      {message && (
        <div className="mb-6 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <span className="flex items-center gap-2"><Check size={16} /> {message}</span>
          <button onClick={() => setMessage("")}>×</button>
        </div>
      )}

      <Card className="mb-6 p-6">
        <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
          <div>
            <h2 className="font-bold text-ink">外觀模式</h2>
            <p className="mt-1 text-sm text-slate-500">選擇舒服的畫面，設定會保存在這台裝置。</p>
          </div>
          <div className="grid grid-cols-2 gap-2 rounded-2xl bg-slate-50 p-1.5" role="group" aria-label="外觀模式">
            <button
              type="button"
              aria-pressed={theme === "light"}
              className={cn(
                "flex h-11 min-w-28 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition",
                theme === "light"
                  ? "bg-white text-forest shadow-sm ring-1 ring-slate-200"
                  : "text-slate-500 hover:bg-white/70 hover:text-slate-800",
              )}
              onClick={() => changeTheme("light")}
            >
              <Sun size={17} /> 淺色
            </button>
            <button
              type="button"
              aria-pressed={theme === "dark"}
              className={cn(
                "flex h-11 min-w-28 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition",
                theme === "dark"
                  ? "bg-forest text-white shadow-sm ring-1 ring-emerald-500/30"
                  : "text-slate-500 hover:bg-white/70 hover:text-slate-800",
              )}
              onClick={() => changeTheme("dark")}
            >
              <Moon size={17} /> 深色
            </button>
          </div>
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.05fr_.95fr]">
        <Card className="p-6">
          <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
            <div className="flex items-start gap-4">
              <div className="rounded-2xl bg-emerald-50 p-3 text-emerald-700"><Database size={20} /></div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-bold text-ink">資料備份</h2>
                  <Badge tone="green">最重要</Badge>
                </div>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
                  匯出帳戶、交易、持倉、預算與目標。還原會以備份內容取代目前資料。
                </p>
                <p className="mt-3 text-xs text-slate-400">
                  上次匯出：{lastBackupAt || "尚未在這台瀏覽器匯出"}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 flex-col gap-2 sm:flex-row lg:flex-col">
              <Button onClick={downloadBackup}><Download size={16} /> 匯出備份</Button>
              <Button
                variant="secondary"
                onClick={() => {
                  if (window.confirm("還原會取代目前財務資料。請先確認已匯出最新備份。")) restoreInput.current?.click();
                }}
              >
                <Upload size={16} /> 還原備份
              </Button>
              <input
                ref={restoreInput}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) restore.mutate(file);
                  event.target.value = "";
                }}
              />
            </div>
          </div>
          <div className="mt-5 grid gap-3 text-xs text-slate-500 sm:grid-cols-3">
            <div className="rounded-xl bg-slate-50 p-3">包含帳戶與餘額</div>
            <div className="rounded-xl bg-slate-50 p-3">包含交易與分類</div>
            <div className="rounded-xl bg-slate-50 p-3">不包含美股 API Key</div>
          </div>
          {restore.isError && <p className="mt-4 text-sm text-red-600">{(restore.error as Error).message}</p>}
        </Card>

        <Card className="p-6">
          <div className="flex items-start gap-4">
            <div className="rounded-2xl bg-blue-50 p-3 text-blue-700"><RefreshCw size={20} /></div>
            <div className="flex-1">
              <h2 className="font-bold text-ink">行情與匯率</h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                美股需要 Alpha Vantage 金鑰；匯率用來把外幣資產換算成新台幣。
              </p>
            </div>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-slate-100 p-4">
              <p className="text-xs text-slate-400">美股行情</p>
              <div className="mt-2">
                <Badge tone={settings.data?.alpha_vantage_configured ? "green" : "amber"}>
                  {settings.data?.alpha_vantage_configured ? "已設定" : "尚未設定"}
                </Badge>
              </div>
            </div>
            <div className="rounded-2xl border border-slate-100 p-4">
              <p className="text-xs text-slate-400">匯率資料</p>
              <p className="mt-2 text-sm font-semibold text-slate-800">
                {latestFxDate || "尚未更新"}
              </p>
            </div>
          </div>
          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <Button variant="secondary" onClick={() => refreshFx.mutate()} disabled={refreshFx.isPending}>
              <RefreshCw size={15} className={refreshFx.isPending ? "animate-spin" : ""} /> 更新匯率
            </Button>
            <Button variant="ghost" onClick={() => setMarketSettingsOpen((value) => !value)}>
              <KeyRound size={15} /> {settings.data?.alpha_vantage_configured ? "更換美股金鑰" : "設定美股金鑰"}
            </Button>
          </div>
          {marketSettingsOpen && (
            <form className="mt-5 space-y-3" onSubmit={submitSettings}>
              <FormStep number={1} title="貼上 Alpha Vantage API 金鑰">
                <div className="flex flex-col gap-3 sm:flex-row">
                  <Input name="api_key" type="password" placeholder="輸入 API key" required />
                  <Button type="submit" className="shrink-0" disabled={saveSettings.isPending}>
                    <Save size={16} /> 儲存金鑰
                  </Button>
                </div>
              </FormStep>
            </form>
          )}
        </Card>
      </div>

      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-slate-100 px-6 py-5">
          <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-violet-50 p-2.5 text-violet-700"><BookOpen size={18} /></div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-bold text-ink">自動分類</h2>
                  <Badge>{rules.data?.length || 0} 條規則</Badge>
                </div>
                <p className="mt-1 text-xs text-slate-400">摘要包含關鍵字時，自動套用指定分類。</p>
              </div>
            </div>
          </div>
          <form className="mt-5 space-y-4" onSubmit={submitRule}>
            <div className="grid gap-3 lg:grid-cols-3">
              <FormStep number={1} title="看到什麼文字？">
                <Input name="keyword" placeholder="例如：星巴克" required />
              </FormStep>
              <FormStep number={2} title="自動分到哪裡？" tone="blue">
                <Select name="category_id" required>
                  <option value="">選擇分類</option>
                  {categories.data?.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                </Select>
              </FormStep>
              <FormStep number={3} title="這是哪一種交易？" tone="purple">
                <Select name="transaction_kind" defaultValue="expense">
                  <option value="expense">支出</option>
                  <option value="income">收入</option>
                  <option value="transfer">轉帳</option>
                </Select>
              </FormStep>
            </div>
            <div className="flex justify-end"><Button type="submit"><Save size={15} /> 新增規則</Button></div>
          </form>
        </div>
        <div className="max-h-80 divide-y divide-slate-100 overflow-auto">
          {rules.data?.length ? rules.data.map((rule) => (
            <div key={rule.id} className="flex flex-wrap items-center gap-4 px-6 py-3">
              <code className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">{rule.keyword}</code>
              <span className="text-sm text-slate-400">→</span>
              <span className="text-sm font-medium text-slate-700">{rule.category_name}</span>
              <Badge>{rule.transaction_kind === "income" ? "收入" : rule.transaction_kind === "transfer" ? "轉帳" : "支出"}</Badge>
              <button className="ml-auto rounded-lg p-2 text-slate-300 hover:bg-red-50 hover:text-red-600" onClick={() => deleteRule.mutate(rule.id)}>
                <Trash2 size={15} />
              </button>
            </div>
          )) : (
            <div className="px-6 py-10 text-center text-sm text-slate-400">
              目前沒有自動分類規則。之後常出現的店名或收入來源可以加在這裡。
            </div>
          )}
        </div>
      </Card>

      <Card className="mt-6 overflow-hidden">
        <button
          className="flex w-full items-center justify-between px-6 py-5 text-left hover:bg-slate-50"
          onClick={() => setAdvancedOpen((value) => !value)}
        >
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-slate-100 p-2.5 text-slate-600"><Shield size={18} /></div>
            <div>
              <h2 className="font-bold text-ink">進階資料設定</h2>
              <p className="mt-1 text-xs text-slate-400">平常不需要碰；需要手動覆蓋匯率或查看明細時再展開。</p>
            </div>
          </div>
          <Badge>{advancedOpen ? "收起" : "展開"}</Badge>
        </button>

        {advancedOpen && (
          <div className="border-t border-slate-100 p-6">
            <div className="grid gap-6 xl:grid-cols-[.85fr_1.15fr]">
              <div className="space-y-6">
                <div className="rounded-2xl border border-slate-100 p-5">
                  <h3 className="font-bold text-ink">自訂匯率</h3>
                  <p className="mt-1 text-xs text-slate-400">可覆蓋指定日期的官方匯率。</p>
                  <form className="mt-5 space-y-4" onSubmit={submitManualFx}>
                    <FormStep number={1} title="選擇幣別">
                      <Select name="currency">
                        {["USD", "JPY", "EUR", "GBP", "CNY", "HKD", "AUD", "CAD", "SGD", "KRW"].map((item) => <option key={item}>{item}</option>)}
                      </Select>
                    </FormStep>
                    <FormStep number={2} title="匯率是哪一天的？" tone="blue">
                      <Input name="rate_date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} />
                    </FormStep>
                    <FormStep number={3} title="1 單位可以換多少台幣？" tone="purple">
                      <Input name="rate_to_twd" type="number" min="0.000001" step="any" placeholder="例如：32.5" required />
                    </FormStep>
                    <Button type="submit" className="w-full">儲存自訂匯率</Button>
                  </form>
                </div>

                <div className="rounded-2xl border border-slate-100 p-5">
                  <h3 className="font-bold text-ink">本機資料模式</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-500">
                    服務只開在 127.0.0.1，資料存在這台電腦。請不要把 data 資料夾或真實備份丟到公開地方。
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Badge tone="green">本機模式</Badge>
                    <Badge tone={settings.data?.mode === "demo" ? "blue" : "slate"}>
                      {settings.data?.mode === "demo" ? "匿名示範資料庫" : "個人資料庫"}
                    </Badge>
                  </div>
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-slate-100">
                <div className="border-b border-slate-100 px-5 py-4">
                  <h3 className="font-bold text-ink">匯率明細</h3>
                  <p className="mt-1 text-xs text-slate-400">1 單位外幣可換算的新台幣。</p>
                </div>
                <div className="grid grid-cols-2 gap-px bg-slate-100 sm:grid-cols-4">
                  {fx.data?.length ? fx.data.slice(0, 12).map((rate) => (
                    <div key={rate.currency} className="bg-white p-4">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-bold text-slate-700">{rate.currency}</span>
                        {rate.manual && <Badge tone="blue">手動</Badge>}
                      </div>
                      <p className="mt-2 text-lg font-bold text-ink">{rate.rate_to_twd.toLocaleString("zh-TW", { maximumFractionDigits: 5 })}</p>
                      <p className="mt-1 text-[11px] text-slate-400">{rate.rate_date}</p>
                    </div>
                  )) : (
                    <div className="col-span-full bg-white p-8 text-center text-sm text-slate-400">尚未下載匯率資料</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
