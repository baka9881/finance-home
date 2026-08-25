import { FormEvent, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bitcoin,
  BookOpen,
  Check,
  Database,
  Download,
  Mail,
  KeyRound,
  Moon,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Shield,
  Sun,
  Trash2,
  Upload,
} from "lucide-react";
import { api } from "../api";
import { taipeiDateInputValue } from "../date";
import { type AppTheme, getStoredTheme, saveTheme } from "../theme";
import type { Account, Category } from "../types";
import {
  Badge,
  Button,
  Card,
  cn,
  DateInput,
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
  is_default: boolean;
}

interface BinanceConnection {
  account_id: number;
  account_name: string;
  owner: "me" | "partner" | "shared";
  owner_label: string;
  connected: boolean;
  last_sync_at?: string;
  last_cost_sync_at?: string;
  backoff_until?: string;
}

interface ExchangeSyncResult {
  connected: number;
  updated: number;
  skipped: number;
  results: Array<{ account_name: string; skipped?: boolean; warnings?: string[] }>;
  errors: string[];
}

interface AutomationStatus {
  enabled: boolean;
  schedule: "hourly";
  running: boolean;
  connected_exchanges: number;
  email_connected: boolean;
  last_status: "idle" | "running" | "success" | "warning" | "failed";
  last_started_at?: string;
  last_run_at?: string;
  last_error?: string;
  last_result?: {
    exchanges_updated: number;
    exchanges_skipped: number;
    market_updated: number;
    market_skipped: number;
    fx_saved: number;
    warnings: string[];
    errors: string[];
  };
}

interface GmailStatus {
  configured: boolean;
  connected: boolean;
  email?: string;
  last_sync_at?: string;
  last_error?: string;
  active_rules: number;
  pending_bills: number;
  last_result?: EmailSyncResult;
}

interface EmailSyncResult {
  messages_scanned: number;
  matched: number;
  transactions_imported: number;
  bills_found: number;
  payments_created: number;
  ignored: number;
  errors: string[];
}

interface EmailCardRule {
  id: number;
  name: string;
  owner: "me" | "partner" | "shared";
  card_account_id: number;
  card_account_name: string;
  payment_account_id: number;
  payment_account_name: string;
  sender_pattern?: string;
  subject_pattern?: string;
  card_last4?: string;
  lookback_days: number;
  auto_pay: boolean;
  active: boolean;
  statement_password_configured: boolean;
}

interface CreditCardBill {
  id: number;
  rule_name: string;
  card_account_name: string;
  payment_account_name: string;
  statement_date?: string;
  due_date: string;
  amount_due: number;
  currency: string;
  status: "pending" | "paid" | "insufficient_funds" | "needs_review";
  last_error?: string;
}

function utcDate(value?: string) {
  if (!value) return null;
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function friendlyExchangeMessage(message?: string) {
  if (!message) return "";
  const bannedUntil = message.match(/banned until\s+(\d{10,13})/i)?.[1];
  if (/way too much request|request weight|ip banned/i.test(message)) {
    const timestamp = bannedUntil ? Number(bannedUntil) : 0;
    const retryAt = timestamp ? new Date(timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp) : null;
    const retryLabel = retryAt && !Number.isNaN(retryAt.getTime())
      ? retryAt.toLocaleString("zh-TW", { hour12: false })
      : "稍後";
    return `幣安請求過於頻繁，已暫停同步至 ${retryLabel}；系統會自動重試。`;
  }
  if (/signature.*not valid/i.test(message)) return "API Secret 驗證失敗，請重新貼上建立 API 時顯示的完整 Secret Key。";
  if (/restricted location|eligibility/i.test(message)) return "目前的伺服器所在地無法連線幣安，系統會保留上次成功資料。";
  if (/invalid api-key|api-key format|permissions/i.test(message)) return "API Key 無效或缺少讀取權限，請檢查幣安 API 設定。";
  return message;
}

export default function SettingsPage() {
  const client = useQueryClient();
  const restoreInput = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");
  const [marketSettingsOpen, setMarketSettingsOpen] = useState(false);
  const [exchangeSettingsOpen, setExchangeSettingsOpen] = useState(false);
  const [emailSettingsOpen, setEmailSettingsOpen] = useState(false);
  const [editingEmailRule, setEditingEmailRule] = useState<EmailCardRule | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(() => getStoredTheme());
  const [lastBackupAt, setLastBackupAt] = useState(() => localStorage.getItem("finance:lastBackupAt") || "");
  const [ruleSearch, setRuleSearch] = useState("");
  const [ruleKindFilter, setRuleKindFilter] = useState("all");
  const [ruleSourceFilter, setRuleSourceFilter] = useState("all");
  const [editingRuleId, setEditingRuleId] = useState<number | null>(null);
  const [ruleKeyword, setRuleKeyword] = useState("");
  const [ruleCategoryId, setRuleCategoryId] = useState("");
  const [ruleTransactionKind, setRuleTransactionKind] = useState("expense");

  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<SettingsData>("/settings") });
  const fx = useQuery({ queryKey: ["fx"], queryFn: () => api<FxRate[]>("/fx") });
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => api<Rule[]>("/rules") });
  const categories = useQuery({ queryKey: ["categories"], queryFn: () => api<Category[]>("/categories") });
  const binanceConnections = useQuery({
    queryKey: ["binance-connections"],
    queryFn: () => api<BinanceConnection[]>("/exchanges/binance"),
  });
  const automationStatus = useQuery({
    queryKey: ["automation-status"],
    queryFn: () => api<AutomationStatus>("/automation/status"),
    refetchInterval: 60_000,
  });
  const accounts = useQuery({
    queryKey: ["accounts", "settings"],
    queryFn: () => api<Account[]>("/accounts"),
  });
  const gmail = useQuery({
    queryKey: ["gmail-status"],
    queryFn: () => api<GmailStatus>("/email/gmail/status"),
    refetchInterval: 60_000,
  });
  const emailRules = useQuery({
    queryKey: ["email-card-rules"],
    queryFn: () => api<EmailCardRule[]>("/email/card-rules"),
  });
  const cardBills = useQuery({
    queryKey: ["credit-card-bills"],
    queryFn: () => api<CreditCardBill[]>("/email/card-bills"),
  });
  const cardAccounts = (accounts.data || []).filter(
    (account) => account.account_type === "credit_card" && account.nature === "liability",
  );
  const paymentAccounts = (accounts.data || []).filter((account) => account.nature === "asset");
  const latestFxDate = fx.data?.reduce((latest, rate) => (rate.rate_date > latest ? rate.rate_date : latest), "") || "";
  const blockedConnections = (binanceConnections.data || []).filter((item) => {
    const until = utcDate(item.backoff_until);
    return Boolean(until && until.getTime() > Date.now());
  });
  const nextRetryAt = blockedConnections
    .map((item) => utcDate(item.backoff_until))
    .filter((item): item is Date => Boolean(item))
    .sort((left, right) => left.getTime() - right.getTime())[0];
  const filteredRules = (rules.data || []).filter((rule) => {
    const query = ruleSearch.trim().toLocaleLowerCase("zh-TW");
    return (!query || rule.keyword.toLocaleLowerCase("zh-TW").includes(query) || rule.category_name.toLocaleLowerCase("zh-TW").includes(query))
      && (ruleKindFilter === "all" || rule.transaction_kind === ruleKindFilter)
      && (ruleSourceFilter === "all" || (ruleSourceFilter === "default" ? rule.is_default : !rule.is_default));
  });
  const ruleGroups = [
    { key: "custom", label: "我的規則", items: filteredRules.filter((rule) => !rule.is_default) },
    { key: "default", label: "系統預設", items: filteredRules.filter((rule) => rule.is_default) },
  ].filter((group) => group.items.length > 0);

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
  const connectBinance = useMutation({
    mutationFn: (payload: { account_id: number; api_key: string; api_secret: string }) =>
      api("/exchanges/binance/connect", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["binance-connections"] });
      client.invalidateQueries({ queryKey: ["accounts"] });
      client.invalidateQueries({ queryKey: ["positions"] });
      client.invalidateQueries({ queryKey: ["dashboard"] });
      client.invalidateQueries({ queryKey: ["automation-status"] });
      setExchangeSettingsOpen(false);
      setMessage("幣安已連接，交易所餘額與持倉已同步。");
    },
  });
  const syncBinance = useMutation({
    mutationFn: (accountId?: number) =>
      api<ExchangeSyncResult>(
        `/exchanges/sync${accountId ? `?account_id=${accountId}` : ""}`,
        { method: "POST" },
      ),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: ["binance-connections"] });
      client.invalidateQueries({ queryKey: ["accounts"] });
      client.invalidateQueries({ queryKey: ["positions"] });
      client.invalidateQueries({ queryKey: ["dashboard"] });
      const warnings = result.results.flatMap((item) => item.warnings || []).map(friendlyExchangeMessage);
      const errors = result.errors.map(friendlyExchangeMessage);
      setMessage(
        errors.length
          ? `同步未完成：${errors.join("、")}`
          : warnings.length
            ? `交易所已同步；${warnings.join("、")}`
            : result.updated
              ? `交易所同步完成，更新 ${result.updated} 個帳戶。`
              : "距離上次完整同步未滿一小時，已保留最新資料；行情仍會每 15 分鐘更新。",
      );
    },
    onError: (error) => setMessage(`同步未完成：${friendlyExchangeMessage((error as Error).message)}`),
  });
  const disconnectBinance = useMutation({
    mutationFn: (accountId: number) => api(`/exchanges/binance/${accountId}`, { method: "DELETE" }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["binance-connections"] });
      setMessage("已停止交易所自動同步；既有持倉資料會保留。");
    },
  });
  const authorizeGmail = useMutation({
    mutationFn: () => api<{ authorization_url: string }>("/email/gmail/authorize", { method: "POST" }),
    onSuccess: ({ authorization_url }) => window.location.assign(authorization_url),
    onError: (error) => setMessage((error as Error).message),
  });
  const disconnectGmail = useMutation({
    mutationFn: () => api("/email/gmail", { method: "DELETE" }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["gmail-status"] });
      setMessage("已停止 Gmail 同步；既有交易與帳單紀錄會保留。");
    },
  });
  const syncGmail = useMutation({
    mutationFn: () => api<EmailSyncResult>("/email/gmail/sync", { method: "POST" }),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: ["gmail-status"] });
      client.invalidateQueries({ queryKey: ["credit-card-bills"] });
      client.invalidateQueries({ queryKey: ["transactions"] });
      client.invalidateQueries({ queryKey: ["accounts"] });
      client.invalidateQueries({ queryKey: ["dashboard"] });
      setMessage(
        `郵件同步完成：新增 ${result.transactions_imported} 筆消費、找到 ${result.bills_found} 份帳單、建立 ${result.payments_created} 筆到期扣款紀錄。`,
      );
    },
    onError: (error) => setMessage(`郵件同步失敗：${(error as Error).message}`),
  });
  const saveEmailRule = useMutation({
    mutationFn: ({ ruleId, payload }: { ruleId?: number; payload: Record<string, unknown> }) =>
      api<EmailCardRule>(ruleId ? `/email/card-rules/${ruleId}` : "/email/card-rules", {
        method: ruleId ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["email-card-rules"] });
      client.invalidateQueries({ queryKey: ["gmail-status"] });
      setEmailSettingsOpen(false);
      setEditingEmailRule(null);
      setMessage("信用卡郵件規則已儲存；可以立即同步測試。");
    },
    onError: (error) => setMessage((error as Error).message),
  });
  const deactivateEmailRule = useMutation({
    mutationFn: (id: number) => api(`/email/card-rules/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["email-card-rules"] });
      client.invalidateQueries({ queryKey: ["gmail-status"] });
      setMessage("已停用這張信用卡的郵件同步規則。");
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
  const saveRule = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api(editingRuleId ? `/rules/${editingRuleId}` : "/rules", {
        method: editingRuleId ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["rules"] });
      setMessage(editingRuleId ? "分類規則已更新。" : "分類規則已儲存。");
      resetRuleForm();
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
    link.download = `finance-backup-${taipeiDateInputValue()}.json`;
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

  function submitBinance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    connectBinance.mutate({
      account_id: Number(form.get("account_id")),
      api_key: String(form.get("api_key") || ""),
      api_secret: String(form.get("api_secret") || ""),
    });
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
    saveRule.mutate({
      keyword: ruleKeyword.trim(),
      category_id: Number(ruleCategoryId),
      transaction_kind: ruleTransactionKind,
      priority: 100,
    });
  }

  function resetRuleForm() {
    setEditingRuleId(null);
    setRuleKeyword("");
    setRuleCategoryId("");
    setRuleTransactionKind("expense");
  }

  function editRule(rule: Rule) {
    setEditingRuleId(rule.id);
    setRuleKeyword(rule.keyword);
    setRuleCategoryId(String(rule.category_id));
    setRuleTransactionKind(rule.transaction_kind);
  }

  function changeTheme(nextTheme: AppTheme) {
    setTheme(nextTheme);
    saveTheme(nextTheme);
  }

  function submitEmailRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const cardAccountId = Number(form.get("card_account_id"));
    const cardAccount = cardAccounts.find((account) => account.id === cardAccountId);
    saveEmailRule.mutate({
      ruleId: editingEmailRule?.id,
      payload: {
        name: String(form.get("name") || "").trim(),
        owner: cardAccount?.owner || "me",
        card_account_id: cardAccountId,
        payment_account_id: Number(form.get("payment_account_id")),
        sender_pattern: String(form.get("sender_pattern") || "").trim() || null,
        subject_pattern: String(form.get("subject_pattern") || "").trim() || null,
        card_last4: String(form.get("card_last4") || "").trim() || null,
        lookback_days: Number(form.get("lookback_days") || 30),
        auto_pay: form.get("auto_pay") === "on",
        ...(String(form.get("statement_password") || "")
          ? { statement_password: String(form.get("statement_password")) }
          : {}),
      },
    });
  }

  function startEditingEmailRule(rule: EmailCardRule) {
    setEditingEmailRule(rule);
    setEmailSettingsOpen(true);
  }

  function startCreatingEmailRule() {
    setEditingEmailRule(null);
    setEmailSettingsOpen(true);
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gmailResult = params.get("gmail");
    if (!gmailResult) return;
    setMessage(
      gmailResult === "connected"
        ? "Gmail 已安全連接。接著請建立信用卡郵件規則。"
        : "Gmail 連接沒有完成，請再試一次。",
    );
    if (gmailResult === "connected") setEmailSettingsOpen(true);
    window.history.replaceState({}, "", window.location.pathname);
    client.invalidateQueries({ queryKey: ["gmail-status"] });
  }, [client]);

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
                美股行情會自動從公開來源更新；匯率用來把外幣資產換算成新台幣。
              </p>
            </div>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-slate-100 p-4">
              <p className="text-xs text-slate-400">美股行情</p>
              <div className="mt-2"><Badge tone="green">自動更新</Badge></div>
              <p className="mt-2 text-xs leading-5 text-slate-400">Nasdaq 優先，失敗時自動改用備援來源。</p>
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
          </div>
        </Card>
      </div>

      <Card className="mt-6 p-6">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
          <div className="flex items-start gap-4">
            <div className="rounded-2xl bg-amber-50 p-3 text-amber-700"><Bitcoin size={20} /></div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-bold text-ink">交易所自動同步</h2>
                <Badge tone={binanceConnections.data?.some((item) => item.connected) ? "green" : "amber"}>
                  {binanceConnections.data?.some((item) => item.connected) ? "已連接幣安" : "尚未連接"}
                </Badge>
                <Badge tone={automationStatus.data?.enabled ? "green" : "amber"}>
                  {automationStatus.data?.enabled ? "背景排程已啟用" : "背景排程未啟用"}
                </Badge>
              </div>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
                {automationStatus.data?.enabled
                  ? "帳戶餘額與持倉每小時完整同步；行情每 15 分鐘更新，成交成本每天更新一次。不需要持續開著財務居。"
                  : "開啟財務居時每 15 分鐘更新行情；部署背景排程後，帳戶與持倉會每小時自動同步。"}
              </p>
              <p className="mt-2 text-xs leading-5 text-amber-700">
                請建立只有讀取權限的 API Key，務必關閉現貨交易、合約交易與提領權限。
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {binanceConnections.data?.some((item) => item.connected) && (
              <Button
                variant="secondary"
                onClick={() => syncBinance.mutate(undefined)}
                disabled={syncBinance.isPending || blockedConnections.length > 0}
                title={blockedConnections.length ? "幣安暫時限制請求，請等待系統自動重試" : undefined}
              >
                <RefreshCw size={15} className={syncBinance.isPending ? "animate-spin" : ""} />
                立即同步
              </Button>
            )}
            <Button variant="ghost" onClick={() => setExchangeSettingsOpen((value) => !value)}>
              <KeyRound size={15} /> {exchangeSettingsOpen ? "收起設定" : "連接交易所"}
            </Button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-4 text-sm sm:grid-cols-3">
          <div>
            <p className="text-xs text-slate-400">伺服器排程</p>
            <p className="mt-1 font-semibold text-slate-800">
              {automationStatus.data?.running
                ? "正在更新"
                : automationStatus.data?.enabled
                  ? "每小時自動執行"
                  : "尚未啟用"}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-400">上次背景更新</p>
            <p className="mt-1 font-semibold text-slate-800">
              {automationStatus.data?.last_run_at
                ? new Date(`${automationStatus.data.last_run_at}Z`).toLocaleString("zh-TW", { hour12: false })
                : "尚未執行"}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-400">上次結果</p>
            <p className={cn(
              "mt-1 font-semibold",
              automationStatus.data?.last_status === "failed" || automationStatus.data?.last_status === "warning"
                ? "text-amber-700"
                : "text-emerald-700",
            )}>
              {automationStatus.data?.last_status === "success"
                ? "更新成功"
                : automationStatus.data?.last_status === "warning"
                  ? "部分資料沿用舊值"
                  : automationStatus.data?.last_status === "failed"
                    ? "更新失敗"
                    : automationStatus.data?.last_status === "running"
                      ? "執行中"
                      : "等待第一次執行"}
            </p>
          </div>
          {automationStatus.data?.last_error && (
            <p className="text-xs leading-5 text-amber-700 sm:col-span-3">
              {friendlyExchangeMessage(automationStatus.data.last_error)}
            </p>
          )}
          {nextRetryAt && (
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 sm:col-span-3">
              為避免再次被限制，手動同步已暫停；預計 {nextRetryAt.toLocaleString("zh-TW", { hour12: false })} 後由系統自動重試。
            </p>
          )}
        </div>

        {binanceConnections.data?.some((item) => item.connected) && (
          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {binanceConnections.data.filter((item) => item.connected).map((item) => (
              <div key={item.account_id} className="rounded-2xl border border-slate-100 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-slate-800">{item.account_name}</p>
                    <p className="mt-1 text-xs text-slate-400">所有人：{item.owner_label}</p>
                  </div>
                  <Badge tone="green">自動同步</Badge>
                </div>
                <p className="mt-3 text-xs text-slate-500">
                  上次同步：{item.last_sync_at
                    ? new Date(`${item.last_sync_at}Z`).toLocaleString("zh-TW", { hour12: false })
                    : "尚未同步"}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  成本更新：{item.last_cost_sync_at
                    ? new Date(`${item.last_cost_sync_at}Z`).toLocaleString("zh-TW", { hour12: false })
                    : "尚未更新"}
                </p>
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => syncBinance.mutate(item.account_id)}
                    disabled={syncBinance.isPending || Boolean(utcDate(item.backoff_until) && (utcDate(item.backoff_until)?.getTime() || 0) > Date.now())}
                  >
                    同步
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (window.confirm("停止同步後會保留目前帳戶與持倉資料，確定要停止嗎？")) {
                        disconnectBinance.mutate(item.account_id);
                      }
                    }}
                    disabled={disconnectBinance.isPending}
                  >
                    停止同步
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {exchangeSettingsOpen && (
          <form className="mt-5 space-y-4" onSubmit={submitBinance}>
            <div className="grid gap-3 lg:grid-cols-3">
              <FormStep number={1} title="同步到哪個帳戶？">
                <Select name="account_id" required>
                  <option value="">選擇交易所帳戶</option>
                  {binanceConnections.data?.map((item) => (
                    <option key={item.account_id} value={item.account_id}>
                      {item.account_name}（{item.owner_label}）{item.connected ? "－已連接" : ""}
                    </option>
                  ))}
                </Select>
              </FormStep>
              <FormStep number={2} title="貼上 API Key" tone="blue">
                <Input name="api_key" type="password" autoComplete="off" placeholder="Binance API Key" required />
              </FormStep>
              <FormStep number={3} title="貼上 Secret Key" tone="purple">
                <Input name="api_secret" type="password" autoComplete="off" placeholder="Binance Secret Key" required />
              </FormStep>
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={connectBinance.isPending || !binanceConnections.data?.length}>
                <Save size={15} /> {connectBinance.isPending ? "驗證並同步中…" : "安全連接並同步"}
              </Button>
            </div>
            {connectBinance.isError && (
              <p className="text-sm text-red-600">{(connectBinance.error as Error).message}</p>
            )}
            {!binanceConnections.data?.length && (
              <p className="text-sm text-amber-700">請先到帳戶頁新增「加密貨幣交易所」帳戶。</p>
            )}
            <p className="text-xs leading-5 text-slate-400">
              系統會比對 Binance 可讀取的 USDT 現貨成交紀錄與目前餘額，自動計算能確認的平均成本；如果有外部轉入、理財收益或歷史缺漏，就會保留原值並標示「成本待確認」。
            </p>
          </form>
        )}
      </Card>

      <Card className="mt-6 p-6">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
          <div className="flex items-start gap-4">
            <div className="rounded-2xl bg-blue-50 p-3 text-blue-700"><Mail size={20} /></div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-bold text-ink">信用卡郵件自動記帳</h2>
                <Badge tone={gmail.data?.connected ? "green" : "amber"}>
                  {gmail.data?.connected ? `已連接 ${gmail.data.email || "Gmail"}` : "尚未連接 Gmail"}
                </Badge>
                {gmail.data?.connected && <Badge tone="green">只讀郵件</Badge>}
                {gmail.data?.connected && automationStatus.data?.enabled && <Badge tone="green">每小時背景同步</Badge>}
              </div>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
                只讀取符合你設定的銀行寄件者或主旨，辨識刷卡消費、帳單金額與繳款日；重複郵件會自動跳過。
              </p>
              <p className="mt-2 text-xs leading-5 text-amber-700">
                到期「扣款」只會在財務居建立帳戶轉帳並更新餘額，不會登入銀行，也不會真的從銀行發動付款。
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {gmail.data?.connected ? (
              <>
                <Button
                  variant="secondary"
                  onClick={() => syncGmail.mutate()}
                  disabled={syncGmail.isPending || !emailRules.data?.some((rule) => rule.active)}
                >
                  <RefreshCw size={15} className={syncGmail.isPending ? "animate-spin" : ""} />
                  {syncGmail.isPending ? "同步中…" : "立即同步"}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (emailSettingsOpen) {
                      setEmailSettingsOpen(false);
                      setEditingEmailRule(null);
                    } else {
                      startCreatingEmailRule();
                    }
                  }}
                >
                  <KeyRound size={15} /> {emailSettingsOpen ? "收起設定" : "新增信用卡"}
                </Button>
              </>
            ) : (
              <Button
                onClick={() => authorizeGmail.mutate()}
                disabled={authorizeGmail.isPending || !gmail.data?.configured}
              >
                <Mail size={15} /> {authorizeGmail.isPending ? "正在前往 Google…" : "連接 Gmail"}
              </Button>
            )}
          </div>
        </div>

        {!gmail.isLoading && !gmail.data?.configured && (
          <p className="mt-5 rounded-xl bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
            伺服器尚未設定 Google OAuth。需要先在 Google Cloud 建立 OAuth 用戶端，並設定 Gmail 唯讀權限。
          </p>
        )}

        {gmail.data?.connected && !automationStatus.data?.enabled && (
          <p className="mt-5 rounded-xl bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
            目前沒有背景排程，系統只會在你按「立即同步」時讀取郵件；設定伺服器自動更新密鑰後，才會每小時檢查新消費與到期帳單。
          </p>
        )}

        <div className="mt-5 grid gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-4 text-sm sm:grid-cols-3">
          <div>
            <p className="text-xs text-slate-400">上次同步</p>
            <p className="mt-1 font-semibold text-slate-800">
              {gmail.data?.last_sync_at
                ? new Date(`${gmail.data.last_sync_at}Z`).toLocaleString("zh-TW", { hour12: false })
                : "尚未執行"}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-400">使用中規則</p>
            <p className="mt-1 font-semibold text-slate-800">{gmail.data?.active_rules || 0} 張信用卡</p>
          </div>
          <div>
            <p className="text-xs text-slate-400">待處理帳單</p>
            <p className="mt-1 font-semibold text-slate-800">{gmail.data?.pending_bills || 0} 份</p>
          </div>
          {gmail.data?.last_error && (
            <p className="text-xs leading-5 text-red-600 sm:col-span-3">{gmail.data.last_error}</p>
          )}
        </div>

        {gmail.data?.connected && emailSettingsOpen && (
          <form
            key={editingEmailRule?.id || "new-email-rule"}
            className="mt-5 space-y-4"
            onSubmit={submitEmailRule}
          >
            {editingEmailRule && (
              <div className="flex items-center justify-between rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-800">
                <span>正在編輯「{editingEmailRule.name}」</span>
                <button
                  type="button"
                  className="font-semibold"
                  onClick={startCreatingEmailRule}
                >
                  改為新增
                </button>
              </div>
            )}
            <div className="grid gap-3 lg:grid-cols-3">
              <FormStep number={1} title="是哪張信用卡？">
                <div className="space-y-3">
                  <Input name="name" defaultValue={editingEmailRule?.name || ""} placeholder="例如：國泰信用卡" required />
                  <Select name="card_account_id" defaultValue={editingEmailRule ? String(editingEmailRule.card_account_id) : ""} required>
                    <option value="">選擇信用卡帳戶</option>
                    {cardAccounts.map((account) => (
                      <option key={account.id} value={account.id}>{account.name}（{account.owner_label}）</option>
                    ))}
                  </Select>
                  <Input name="card_last4" defaultValue={editingEmailRule?.card_last4 || ""} inputMode="numeric" pattern="[0-9]{4}" maxLength={4} placeholder="卡號末四碼（選填）" />
                </div>
              </FormStep>
              <FormStep number={2} title="只看哪些郵件？" tone="blue">
                <div className="space-y-3">
                  <Input name="sender_pattern" defaultValue={editingEmailRule?.sender_pattern || ""} placeholder="寄件者，例如 cathaybk.com.tw" />
                  <Input name="subject_pattern" defaultValue={editingEmailRule?.subject_pattern || ""} placeholder="主旨關鍵字，例如 消費彙整通知" />
                  <Select name="lookback_days" defaultValue={String(editingEmailRule?.lookback_days || 30)}>
                    <option value="14">第一次回看 14 天</option>
                    <option value="30">第一次回看 30 天</option>
                    <option value="60">第一次回看 60 天</option>
                    <option value="90">第一次回看 90 天</option>
                  </Select>
                  <p className="text-xs leading-5 text-slate-400">寄件者或主旨至少填一項，避免讀到不相關郵件。</p>
                </div>
              </FormStep>
              <FormStep number={3} title="繳款怎麼記錄？" tone="purple">
                <div className="space-y-3">
                  <Select name="payment_account_id" defaultValue={editingEmailRule ? String(editingEmailRule.payment_account_id) : ""} required>
                    <option value="">選擇扣款帳戶</option>
                    {paymentAccounts.map((account) => (
                      <option key={account.id} value={account.id}>{account.name}（{account.owner_label}）</option>
                    ))}
                  </Select>
                  <Input name="statement_password" type="password" autoComplete="off" placeholder="電子帳單 PDF 密碼（選填）" />
                  <label className="flex items-start gap-3 rounded-xl bg-slate-50 p-3 text-sm text-slate-600">
                    <input name="auto_pay" type="checkbox" defaultChecked={editingEmailRule?.auto_pay ?? true} className="mt-1" />
                    <span>到繳款日自動在財務居記錄扣款；餘額不足或金額不合理時先暫停並提醒。</span>
                  </label>
                </div>
              </FormStep>
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={saveEmailRule.isPending || !cardAccounts.length || !paymentAccounts.length}>
                <Save size={15} /> {saveEmailRule.isPending ? "儲存中…" : editingEmailRule ? "儲存規則變更" : "儲存自動記帳規則"}
              </Button>
            </div>
            {!cardAccounts.length && (
              <p className="text-sm text-amber-700">請先到帳戶頁建立一個「信用卡」負債帳戶。</p>
            )}
          </form>
        )}

        {emailRules.data?.some((rule) => rule.active) && (
          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {emailRules.data.filter((rule) => rule.active).map((rule) => (
              <div key={rule.id} className="rounded-2xl border border-slate-100 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-slate-800">{rule.name}</p>
                    <p className="mt-1 text-xs text-slate-400">
                      {rule.card_account_name} ← {rule.payment_account_name}
                    </p>
                  </div>
                  <Badge tone={rule.auto_pay ? "green" : "slate"}>{rule.auto_pay ? "到期自動記帳" : "只匯入"}</Badge>
                </div>
                <div className="mt-3 space-y-1 text-xs text-slate-500">
                  <p>寄件者：{rule.sender_pattern || "不限"}</p>
                  <p>主旨：{rule.subject_pattern || "不限"}</p>
                  <p>繳款日：依每期電子帳單</p>
                  <p>PDF 密碼：{rule.statement_password_configured ? "已安全儲存" : "未設定"}</p>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => startEditingEmailRule(rule)}>
                    編輯規則
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (window.confirm(`停止「${rule.name}」的郵件同步嗎？既有資料會保留。`)) {
                        deactivateEmailRule.mutate(rule.id);
                      }
                    }}
                  >
                    停止規則
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {cardBills.data?.length ? (
          <div className="mt-5 overflow-hidden rounded-2xl border border-slate-100">
            <div className="border-b border-slate-100 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">最近信用卡帳單</div>
            <div className="divide-y divide-slate-100">
              {cardBills.data.slice(0, 6).map((bill) => (
                <div key={bill.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-slate-800">{bill.rule_name} · {bill.currency} {bill.amount_due.toLocaleString()}</p>
                    <p className="mt-1 text-xs text-slate-400">繳款日 {bill.due_date} · {bill.payment_account_name}</p>
                    {bill.last_error && <p className="mt-1 text-xs text-amber-700">{bill.last_error}</p>}
                  </div>
                  <Badge tone={bill.status === "paid" ? "green" : bill.status === "pending" ? "blue" : "amber"}>
                    {bill.status === "paid"
                      ? "已記錄扣款"
                      : bill.status === "pending"
                        ? "等待繳款日"
                        : bill.status === "insufficient_funds"
                          ? "餘額不足"
                          : "需要確認"}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {gmail.data?.connected && (
          <div className="mt-5 flex justify-end">
            <Button
              variant="ghost"
              onClick={() => {
                if (window.confirm("停止 Gmail 連接嗎？既有交易、規則與帳單會保留。")) disconnectGmail.mutate();
              }}
              disabled={disconnectGmail.isPending}
            >
              停止 Gmail 連接
            </Button>
          </div>
        )}
      </Card>

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
                <Input value={ruleKeyword} onChange={(event) => setRuleKeyword(event.target.value)} placeholder="例如：星巴克" required />
              </FormStep>
              <FormStep number={2} title="自動分到哪裡？" tone="blue">
                <Select value={ruleCategoryId} onChange={(event) => setRuleCategoryId(event.target.value)} required>
                  <option value="">選擇分類</option>
                  {categories.data?.filter((category) => category.kind === ruleTransactionKind).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                </Select>
              </FormStep>
              <FormStep number={3} title="這是哪一種交易？" tone="purple">
                <Select value={ruleTransactionKind} onChange={(event) => { setRuleTransactionKind(event.target.value); setRuleCategoryId(""); }}>
                  <option value="expense">支出</option>
                  <option value="income">收入</option>
                </Select>
              </FormStep>
            </div>
            {saveRule.isError && <p className="text-sm text-red-600">{(saveRule.error as Error).message}</p>}
            <div className="flex justify-end gap-2">
              {editingRuleId && <Button type="button" variant="ghost" onClick={resetRuleForm}>取消修改</Button>}
              <Button type="submit" disabled={saveRule.isPending || !ruleKeyword.trim() || !ruleCategoryId}>
                <Save size={15} /> {editingRuleId ? "儲存修改" : "新增規則"}
              </Button>
            </div>
          </form>
        </div>
        <div className="grid gap-3 border-b border-slate-100 px-6 py-4 md:grid-cols-[1fr_160px_160px]">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <Input className="pl-9" value={ruleSearch} onChange={(event) => setRuleSearch(event.target.value)} placeholder="搜尋關鍵字或分類" aria-label="搜尋分類規則" />
          </label>
          <Select value={ruleKindFilter} onChange={(event) => setRuleKindFilter(event.target.value)} aria-label="依交易類型篩選">
            <option value="all">全部類型</option>
            <option value="expense">支出</option>
            <option value="income">收入</option>
          </Select>
          <Select value={ruleSourceFilter} onChange={(event) => setRuleSourceFilter(event.target.value)} aria-label="依規則來源篩選">
            <option value="all">全部來源</option>
            <option value="custom">我的規則</option>
            <option value="default">系統預設</option>
          </Select>
        </div>
        <div className="max-h-96 overflow-auto">
          {ruleGroups.length ? ruleGroups.map((group) => (
            <section key={group.key} aria-labelledby={`rule-group-${group.key}`}>
              <div className="sticky top-0 z-10 flex items-center justify-between border-y border-slate-100 bg-slate-50/95 px-6 py-2 backdrop-blur">
                <h3 id={`rule-group-${group.key}`} className="text-xs font-semibold text-slate-500">{group.label}</h3>
                <span className="text-xs text-slate-400">{group.items.length} 條</span>
              </div>
              <div className="divide-y divide-slate-100">
                {group.items.map((rule) => (
                  <div key={rule.id} className="flex flex-wrap items-center gap-3 px-6 py-3">
                    <code className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">{rule.keyword}</code>
                    <span className="text-sm text-slate-400">→</span>
                    <span className="text-sm font-medium text-slate-700">{rule.category_name}</span>
                    <Badge>{rule.transaction_kind === "income" ? "收入" : "支出"}</Badge>
                    <div className="ml-auto flex items-center gap-1">
                      <button type="button" aria-label={`編輯規則 ${rule.keyword}`} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={() => editRule(rule)}>
                        <Pencil size={15} />
                      </button>
                      <button type="button" aria-label={`刪除規則 ${rule.keyword}`} className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => deleteRule.mutate(rule.id)}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )) : (
            <div className="px-6 py-10 text-center text-sm text-slate-400">
              {rules.data?.length ? "找不到符合條件的規則。" : "目前沒有自動分類規則。之後常出現的店名或收入來源可以加在這裡。"}
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
              <p className="mt-1 text-xs text-slate-400">平常不需要碰；需要設定備援行情、手動匯率或查看明細時再展開。</p>
            </div>
          </div>
          <Badge>{advancedOpen ? "收起" : "展開"}</Badge>
        </button>

        {advancedOpen && (
          <div className="border-t border-slate-100 p-6">
            <div className="grid gap-6 xl:grid-cols-[.85fr_1.15fr]">
              <div className="space-y-6">
                <div className="rounded-2xl border border-slate-100 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-bold text-ink">美股備援行情</h3>
                        <Badge tone={settings.data?.alpha_vantage_configured ? "green" : "slate"}>
                          {settings.data?.alpha_vantage_configured ? "備援金鑰已設定" : "選填"}
                        </Badge>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-slate-400">
                        平常會優先使用 Nasdaq；Alpha Vantage 金鑰只在主要來源失敗時作為備援，沒有設定也能更新行情。
                      </p>
                    </div>
                    <Button variant="ghost" onClick={() => setMarketSettingsOpen((value) => !value)}>
                      <KeyRound size={15} />
                      {marketSettingsOpen
                        ? "收起"
                        : settings.data?.alpha_vantage_configured
                          ? "更換備援金鑰"
                          : "設定備援金鑰"}
                    </Button>
                  </div>
                  {marketSettingsOpen && (
                    <form className="mt-5 space-y-3" onSubmit={submitSettings}>
                      <FormStep number={1} title="貼上 Alpha Vantage API 金鑰">
                        <div className="flex flex-col gap-3 sm:flex-row">
                          <Input name="api_key" type="password" autoComplete="off" placeholder="輸入 API key" required />
                          <Button type="submit" className="shrink-0" disabled={saveSettings.isPending}>
                            <Save size={16} /> 儲存備援金鑰
                          </Button>
                        </div>
                      </FormStep>
                    </form>
                  )}
                </div>

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
                      <DateInput name="rate_date" defaultValue={taipeiDateInputValue()} />
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
