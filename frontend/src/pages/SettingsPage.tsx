import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bitcoin,
  BookOpen,
  Check,
  ChevronDown,
  Database,
  Download,
  ImageUp,
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

function MobileSettingsSection({
  id,
  icon,
  title,
  description,
  status,
  children,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  description: string;
  status?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section id={`settings-${id}`} className={cn("settings-mobile-section", open && "is-open")}>
      <button
        type="button"
        className="settings-mobile-section-summary"
        aria-expanded={open}
        aria-controls={`settings-${id}-content`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="settings-mobile-section-icon">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="font-bold text-ink">{title}</span>
          <span className="mt-1 block truncate text-xs text-slate-500">{description}</span>
        </span>
        {status && <span className="settings-mobile-section-status shrink-0 text-xs font-semibold text-emerald-700">{status}</span>}
        <ChevronDown className="settings-mobile-section-chevron shrink-0 text-slate-400" size={18} />
      </button>
      <div
        id={`settings-${id}-content`}
        className={cn("settings-mobile-section-content", open ? "block" : "hidden")}
      >
        {children}
      </div>
    </section>
  );
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
  transactions_recognized?: number;
  transactions_imported: number;
  bills_found: number;
  payments_created: number;
  already_processed?: number;
  no_finance_data?: number;
  retries_attempted?: number;
  retries_recovered?: number;
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
  closing_day?: number;
  payment_due_day: number;
  auto_pay: boolean;
  active: boolean;
  statement_password_configured: boolean;
}

interface GmailCardCandidate {
  key: string;
  institution: string;
  account_name: string;
  sender_pattern: string;
  matched_messages: number;
  latest_message_at?: string;
  sample_sender?: string;
  sample_subject?: string;
}

interface GmailCardDiscovery {
  lookback_days: number;
  messages_scanned: number;
  metadata_only: boolean;
  candidates: GmailCardCandidate[];
}

interface GmailQuickSetupResult {
  account_created: boolean;
  rule: EmailCardRule;
  sync_result: EmailSyncResult;
}

interface EmailScreenshotAnalysis {
  detected: boolean;
  candidate_key?: string;
  institution?: string;
  account_name?: string;
  sender_pattern?: string;
  card_last4?: string;
  subject_hint?: string;
  confidence: "high" | "medium" | "unknown";
  evidence: string[];
}

const SHOW_ENGINEERING_SETTINGS = false;

const SUPPORTED_CARD_PROVIDERS = [
  { key: "cathay", label: "國泰世華銀行信用卡" },
  { key: "ctbc", label: "中國信託銀行信用卡" },
  { key: "esun", label: "玉山銀行信用卡" },
  { key: "taishin", label: "台新銀行信用卡" },
  { key: "fubon", label: "台北富邦銀行信用卡" },
  { key: "sinopac", label: "永豐銀行信用卡" },
] as const;

interface CreditCardBill {
  id: number;
  rule_name: string;
  card_account_name: string;
  payment_account_name: string;
  statement_date?: string;
  period_start?: string;
  period_end?: string;
  due_date: string;
  amount_due: number;
  currency: string;
  status: "pending" | "paid" | "insufficient_funds" | "needs_review" | "duplicate";
  last_error?: string;
}

interface CardCycleAmount {
  amount: number;
  period_start?: string;
  period_end?: string;
  transaction_count: number;
}

interface CreditCardCycle {
  rule_id: number;
  rule_name: string;
  card_account_name: string;
  currency: string;
  closing_day?: number;
  payment_due_day: number;
  unbilled: CardCycleAmount;
  current_bill?: CreditCardBill;
  last_paid_bill?: CreditCardBill;
  next_cycle: CardCycleAmount;
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
  if (/signature.*not valid/i.test(message)) return "連線驗證失敗，請重新複製幣安顯示的完整安全密鑰。";
  if (/restricted location|eligibility/i.test(message)) return "目前無法連線幣安，系統會保留上次成功更新的資料。";
  if (/invalid api-key|api-key format|permissions/i.test(message)) return "連線金鑰無效或缺少讀取權限，請回到幣安檢查設定。";
  return "同步遇到問題，系統會稍後重試。";
}

function friendlySettingsMessage(message?: string, fallback = "目前無法完成操作，請稍後再試。") {
  if (!message) return fallback;
  if (/401|403|unauthor|forbidden|登入|login|session|token/i.test(message)) {
    return "登入狀態已失效，請重新登入後再試。";
  }
  if (/network|failed to fetch|timeout|timed out|連線/i.test(message)) {
    return "目前連線不穩定，請確認網路後再試。";
  }
  return fallback;
}

export default function SettingsPage() {
  const client = useQueryClient();
  const restoreInput = useRef<HTMLInputElement>(null);
  const emailScreenshotInput = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");
  const [marketSettingsOpen, setMarketSettingsOpen] = useState(false);
  const [exchangeSettingsOpen, setExchangeSettingsOpen] = useState(false);
  const [emailSettingsOpen, setEmailSettingsOpen] = useState(false);
  const [editingEmailRule, setEditingEmailRule] = useState<EmailCardRule | null>(null);
  const [manualEmailSetupOpen, setManualEmailSetupOpen] = useState(false);
  const [gmailCandidates, setGmailCandidates] = useState<GmailCardCandidate[]>([]);
  const [selectedGmailCandidate, setSelectedGmailCandidate] = useState("");
  const [quickPaymentAccountId, setQuickPaymentAccountId] = useState("");
  const [emailScreenshotName, setEmailScreenshotName] = useState("");
  const [emailScreenshotProgress, setEmailScreenshotProgress] = useState(0);
  const [emailScreenshotBusy, setEmailScreenshotBusy] = useState(false);
  const [emailScreenshotAnalysis, setEmailScreenshotAnalysis] = useState<EmailScreenshotAnalysis | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(() => getStoredTheme());
  const [lastBackupAt, setLastBackupAt] = useState(() => localStorage.getItem("finance:lastBackupAt") || "");
  const [ruleSearch, setRuleSearch] = useState("");
  const [ruleKindFilter, setRuleKindFilter] = useState("all");
  const [editingRuleId, setEditingRuleId] = useState<number | null>(null);
  const [ruleKeyword, setRuleKeyword] = useState("");
  const [ruleCategoryId, setRuleCategoryId] = useState("");
  const [ruleTransactionKind, setRuleTransactionKind] = useState("expense");

  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<SettingsData>("/settings"),
    enabled: SHOW_ENGINEERING_SETTINGS,
  });
  const fx = useQuery({
    queryKey: ["fx"],
    queryFn: () => api<FxRate[]>("/fx"),
    enabled: SHOW_ENGINEERING_SETTINGS,
  });
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
  const cardCycles = useQuery({
    queryKey: ["credit-card-cycles"],
    queryFn: () => api<CreditCardCycle[]>("/email/card-cycles"),
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
    return !rule.is_default
      && (!query || rule.keyword.toLocaleLowerCase("zh-TW").includes(query) || rule.category_name.toLocaleLowerCase("zh-TW").includes(query))
      && (ruleKindFilter === "all" || rule.transaction_kind === ruleKindFilter);
  });
  const ruleGroups = [
    { key: "custom", label: "我的自動分類", items: filteredRules },
  ].filter((group) => group.items.length > 0);

  const saveSettings = useMutation({
    mutationFn: (key: string) =>
      api<SettingsData>("/settings", {
        method: "PUT",
        body: JSON.stringify({ alpha_vantage_api_key: key }),
      }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["settings"] });
      setMessage("行情備援設定已儲存。");
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
    onError: (error) => setMessage(friendlySettingsMessage((error as Error).message, "目前無法連接 Gmail，請稍後再試。")),
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
      client.invalidateQueries({ queryKey: ["credit-card-cycles"] });
      client.invalidateQueries({ queryKey: ["transactions"] });
      client.invalidateQueries({ queryKey: ["accounts"] });
      client.invalidateQueries({ queryKey: ["dashboard"] });
      setMessage(
        `郵件同步完成：掃描 ${result.messages_scanned} 封、辨識 ${result.transactions_recognized ?? 0} 筆、新增 ${result.transactions_imported} 筆消費${result.errors.length ? `；${result.errors.length} 封處理失敗` : ""}。`,
      );
    },
    onError: (error) => setMessage(friendlySettingsMessage((error as Error).message, "郵件同步暫時未完成，系統會在下一次自動更新時重試。")),
  });
  const discoverGmailCards = useMutation({
    mutationFn: () => api<GmailCardDiscovery>("/email/gmail/discover", { method: "POST" }),
    onSuccess: (result) => {
      setGmailCandidates(result.candidates);
      setSelectedGmailCandidate(result.candidates[0]?.key || "");
      if (result.candidates.length) {
        setMessage(`已從郵件標頭找到 ${result.candidates.length} 家信用卡；請確認扣款帳戶。`);
      } else {
        setMessage("近六個月沒有找到支援的信用卡郵件，可以改用郵件截圖快速建立。");
      }
    },
    onError: (error) => setMessage(friendlySettingsMessage((error as Error).message, "目前無法自動尋找信用卡郵件，請稍後再試或上傳郵件截圖。")),
  });
  const quickSetupGmailCard = useMutation({
    mutationFn: (payload: { candidate_key: string; payment_account_id: number; card_last4?: string }) =>
      api<GmailQuickSetupResult>("/email/gmail/quick-setup", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: ["email-card-rules"] });
      client.invalidateQueries({ queryKey: ["gmail-status"] });
      client.invalidateQueries({ queryKey: ["credit-card-bills"] });
      client.invalidateQueries({ queryKey: ["credit-card-cycles"] });
      client.invalidateQueries({ queryKey: ["transactions"] });
      client.invalidateQueries({ queryKey: ["accounts"] });
      client.invalidateQueries({ queryKey: ["dashboard"] });
      setEmailSettingsOpen(false);
      setManualEmailSetupOpen(false);
      setEditingEmailRule(null);
      setEmailScreenshotAnalysis(null);
      setEmailScreenshotName("");
      setEmailScreenshotProgress(0);
      const imported = result.sync_result.transactions_imported || 0;
      const syncWarning = result.sync_result.errors?.length
        ? "；設定已完成，首次同步尚未成功，系統稍後會自動重試"
        : `，首次同步新增 ${imported} 筆消費`;
      setMessage(
        `${result.rule.name}已完成自動設定${result.account_created ? "，並建立信用卡帳戶" : ""}${syncWarning}。`,
      );
    },
    onError: (error) => setMessage(friendlySettingsMessage((error as Error).message, "目前無法完成信用卡自動記帳設定，請稍後再試。")),
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
      client.invalidateQueries({ queryKey: ["credit-card-cycles"] });
      setEmailSettingsOpen(false);
      setEditingEmailRule(null);
      setMessage("信用卡自動記帳設定已儲存；可以立即同步測試。");
    },
    onError: (error) => setMessage(friendlySettingsMessage((error as Error).message, "目前無法儲存信用卡設定，請檢查必填欄位後再試。")),
  });
  const deactivateEmailRule = useMutation({
    mutationFn: (id: number) => api(`/email/card-rules/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["email-card-rules"] });
      client.invalidateQueries({ queryKey: ["gmail-status"] });
      client.invalidateQueries({ queryKey: ["credit-card-cycles"] });
      setMessage("已停止這張信用卡的郵件自動記帳。");
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
        closing_day: String(form.get("closing_day") || "").trim() ? Number(form.get("closing_day")) : null,
        payment_due_day: Number(form.get("payment_due_day") || 23),
        auto_pay: form.get("auto_pay") === "on",
        ...(String(form.get("statement_password") || "")
          ? { statement_password: String(form.get("statement_password")) }
          : {}),
      },
    });
  }

  function startEditingEmailRule(rule: EmailCardRule) {
    setEditingEmailRule(rule);
    setManualEmailSetupOpen(true);
    setEmailSettingsOpen(true);
  }

  function startCreatingEmailRule() {
    setEditingEmailRule(null);
    setManualEmailSetupOpen(false);
    setEmailSettingsOpen(true);
  }

  async function readEmailScreenshot(file: File) {
    if (!file.type.startsWith("image/")) {
      setMessage("請選擇 PNG、JPG 或手機截圖圖片。");
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setMessage("圖片超過 15 MB，請先裁切到郵件寄件者與主旨所在區域再上傳。");
      return;
    }

    setEmailScreenshotBusy(true);
    setEmailScreenshotName(file.name);
    setEmailScreenshotAnalysis(null);
    setEmailScreenshotProgress(1);
    setMessage("");
    let worker: Awaited<ReturnType<(typeof import("tesseract.js"))["createWorker"]>> | null = null;
    try {
      const { createWorker, OEM } = await import("tesseract.js");
      worker = await createWorker(["eng", "chi_tra"], OEM.LSTM_ONLY, {
        logger: ({ progress }) => setEmailScreenshotProgress(Math.max(1, Math.round(progress * 90))),
      });
      const result = await worker.recognize(file, { rotateAuto: true });
      const extractedText = result.data.text.trim();
      if (extractedText.length < 5) throw new Error("圖片中的文字太少，請上傳包含寄件者、主旨與銀行名稱的完整郵件截圖。");
      setEmailScreenshotProgress(94);
      const analysis = await api<EmailScreenshotAnalysis>("/email/gmail/screenshot/analyze", {
        method: "POST",
        body: JSON.stringify({ extracted_text: extractedText }),
      });
      setEmailScreenshotAnalysis(analysis);
      setSelectedGmailCandidate(analysis.candidate_key || "");
      setEmailScreenshotProgress(100);
      setMessage(
        analysis.detected
          ? `已從截圖辨識為${analysis.account_name}，確認扣款帳戶後即可建立。`
          : "已讀取截圖，但無法確定銀行；請從清單確認，或換一張有顯示寄件者的截圖。",
      );
    } catch (error) {
      setEmailScreenshotProgress(0);
      setMessage(`截圖辨識失敗：${(error as Error).message}`);
    } finally {
      await worker?.terminate();
      setEmailScreenshotBusy(false);
      if (emailScreenshotInput.current) emailScreenshotInput.current.value = "";
    }
  }

  useEffect(() => {
    if (quickPaymentAccountId || !paymentAccounts.length) return;
    const preferred = paymentAccounts.find((account) => account.name.includes("生活費"))
      || paymentAccounts.find((account) => account.is_liquid)
      || paymentAccounts[0];
    setQuickPaymentAccountId(String(preferred.id));
  }, [accounts.data, paymentAccounts, quickPaymentAccountId]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gmailResult = params.get("gmail");
    if (!gmailResult) return;
    setMessage(
      gmailResult === "connected"
        ? "Gmail 已安全連接。接著按一下自動偵測，就能完成信用卡設定。"
        : "Gmail 連接沒有完成，請再試一次。",
    );
    if (gmailResult === "connected") setEmailSettingsOpen(true);
    window.history.replaceState({}, "", window.location.pathname);
    client.invalidateQueries({ queryKey: ["gmail-status"] });
  }, [client]);

  return (
    <>
      <div className="settings-page-header">
        <PageHeader
          eyebrow="偏好與自動化"
          title="設定"
          description="選擇想調整的功能，其他內容會保持收起。"
        />
      </div>

      {message && (
        <div className="mb-6 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <span className="flex items-center gap-2"><Check size={16} /> {message}</span>
          <button onClick={() => setMessage("")}>×</button>
        </div>
      )}

      <p className="mb-2 text-xs font-bold uppercase tracking-[.16em] text-slate-400 md:hidden">常用設定</p>

      <MobileSettingsSection
        id="appearance"
        icon={theme === "dark" ? <Moon size={18} /> : <Sun size={18} />}
        title="外觀模式"
        description="切換淺色或深色畫面"
        status={theme === "dark" ? "深色" : "淺色"}
      >
      <Card className="settings-detail-card mb-6 p-6">
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
      </MobileSettingsSection>

      <div className="settings-primary-grid grid gap-6 xl:grid-cols-[1.05fr_.95fr]">
        <MobileSettingsSection
          id="backup"
          icon={<Database size={18} />}
          title="資料備份"
          description="保存或還原你的財務資料"
          status={lastBackupAt ? "已備份" : "尚未備份"}
        >
        <Card className="settings-detail-card p-6">
          <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
            <div className="flex items-start gap-4">
              <div className="rounded-2xl bg-emerald-50 p-3 text-emerald-700"><Database size={20} /></div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-bold text-ink">資料備份</h2>
                  <Badge tone="green">最重要</Badge>
                </div>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
                  匯出帳戶、交易、投資與分類。還原時會先請你再次確認。
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
            <div className="rounded-xl bg-slate-50 p-3">連線密碼不會匯出</div>
          </div>
          {restore.isError && (
            <p className="mt-4 text-sm text-red-600">
              {friendlySettingsMessage((restore.error as Error).message, "無法還原這份備份，請確認檔案是否由財務居匯出。")}
            </p>
          )}
        </Card>
        </MobileSettingsSection>

        <MobileSettingsSection
          id="market"
          icon={<RefreshCw size={18} />}
          title="行情與匯率"
          description="更新投資價格與外幣換算"
          status={latestFxDate || "尚未更新"}
        >
        <Card className="settings-detail-card p-6">
          <div className="flex items-start gap-4">
            <div className="rounded-2xl bg-blue-50 p-3 text-blue-700"><RefreshCw size={20} /></div>
            <div className="flex-1">
              <h2 className="font-bold text-ink">行情與匯率</h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                系統會自動更新投資價格與匯率，讓外幣資產正確換算成新台幣。
              </p>
            </div>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-slate-100 p-4">
              <p className="text-xs text-slate-400">美股行情</p>
              <div className="mt-2"><Badge tone="green">自動更新</Badge></div>
              <p className="mt-2 text-xs leading-5 text-slate-400">主要來源暫時無法使用時會自動切換。</p>
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
        </MobileSettingsSection>
      </div>

      <MobileSettingsSection
        id="exchange"
        icon={<Bitcoin size={18} />}
        title="交易所同步"
        description="連接投資帳戶並自動更新持倉"
        status={binanceConnections.data?.some((item) => item.connected) ? "已連接" : "未連接"}
      >
      <Card className="settings-detail-card mt-6 p-6">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
          <div className="flex items-start gap-4">
            <div className="rounded-2xl bg-amber-50 p-3 text-amber-700"><Bitcoin size={20} /></div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-bold text-ink">交易所自動同步</h2>
                <Badge tone={binanceConnections.data?.some((item) => item.connected) ? "green" : "amber"}>
                  {binanceConnections.data?.some((item) => item.connected) ? "已連接" : "尚未連接"}
                </Badge>
                <Badge tone={automationStatus.data?.enabled ? "green" : "amber"}>
                  {automationStatus.data?.enabled ? "自動更新中" : "只在開啟時更新"}
                </Badge>
              </div>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
                {automationStatus.data?.enabled
                  ? "帳戶餘額與持倉會定期更新，不需要持續開著財務居。"
                  : "目前會在你開啟財務居時更新資料。"}
              </p>
              <p className="mt-2 text-xs leading-5 text-amber-700">
                連接時請使用唯讀金鑰，並關閉交易與提領權限。
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
              <KeyRound size={15} /> {exchangeSettingsOpen ? "收起" : "連接帳戶"}
            </Button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-4 text-sm sm:grid-cols-3">
          <div>
            <p className="text-xs text-slate-400">自動更新</p>
            <p className="mt-1 font-semibold text-slate-800">
              {automationStatus.data?.running
                ? "正在更新"
                : automationStatus.data?.enabled
                  ? "已啟用"
                  : "僅開啟時更新"}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-400">最近更新</p>
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
              <FormStep number={2} title="貼上唯讀金鑰" tone="blue">
                <Input name="api_key" type="password" autoComplete="off" placeholder="從幣安複製第一組金鑰" required />
              </FormStep>
              <FormStep number={3} title="貼上安全密鑰" tone="purple">
                <Input name="api_secret" type="password" autoComplete="off" placeholder="從幣安複製安全密鑰" required />
              </FormStep>
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={connectBinance.isPending || !binanceConnections.data?.length}>
                <Save size={15} /> {connectBinance.isPending ? "驗證並同步中…" : "安全連接並同步"}
              </Button>
            </div>
            {connectBinance.isError && (
              <p className="text-sm text-red-600">
                {friendlySettingsMessage((connectBinance.error as Error).message, "目前無法連接投資帳戶，請確認唯讀金鑰後再試。")}
              </p>
            )}
            {!binanceConnections.data?.length && (
              <p className="text-sm text-amber-700">請先到帳戶頁新增「加密貨幣交易所」帳戶。</p>
            )}
            <p className="text-xs leading-5 text-slate-400">
              系統會根據可讀取的成交紀錄估算平均成本；資料不足時會標示「成本待確認」。
            </p>
          </form>
        )}
      </Card>
      </MobileSettingsSection>

      <MobileSettingsSection
        id="email"
        icon={<Mail size={18} />}
        title="信用卡自動記帳"
        description="自動匯入刷卡消費與帳單"
        status={gmail.data?.connected ? "已連接" : "未連接"}
      >
      <Card className="settings-detail-card mt-6 p-6">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
          <div className="flex items-start gap-4">
            <div className="rounded-2xl bg-blue-50 p-3 text-blue-700"><Mail size={20} /></div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-bold text-ink">信用卡郵件自動記帳</h2>
                <Badge tone={gmail.data?.connected ? "green" : "amber"}>
                  {gmail.data?.connected ? "已連接" : "尚未連接 Gmail"}
                </Badge>
                {gmail.data?.connected && automationStatus.data?.enabled && <Badge tone="green">每小時同步</Badge>}
              </div>
              <p className="mt-1 truncate text-sm text-slate-500">
                {gmail.data?.connected ? gmail.data.email || "Gmail" : "連接 Gmail 後自動辨識信用卡消費與帳單"}
              </p>
              <p className="mt-1 text-xs leading-5 text-slate-400">
                唯讀取信；到期只在財務居記帳，不會向銀行發動付款。
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
                      setManualEmailSetupOpen(false);
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
            目前無法連接 Gmail，請稍後再試。
          </p>
        )}

        {gmail.data?.connected && !automationStatus.data?.enabled && (
          <p className="mt-5 rounded-xl bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
            目前會在你開啟財務居或按「立即同步」時更新信用卡資料。
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl bg-slate-50 px-4 py-3 text-sm">
          <p className="text-slate-500">
            最近同步 <span className="ml-1 font-semibold text-slate-800">
              {gmail.data?.last_sync_at
                ? new Date(`${gmail.data.last_sync_at}Z`).toLocaleString("zh-TW", { hour12: false })
                : "尚未執行"}
            </span>
          </p>
          <p className="text-slate-500"><span className="font-semibold text-slate-800">{gmail.data?.active_rules || 0}</span> 張卡</p>
          <p className="text-slate-500"><span className="font-semibold text-slate-800">{gmail.data?.pending_bills || 0}</span> 份待處理帳單</p>
          {gmail.data?.last_result && (
            <p className="w-full border-t border-slate-200 pt-2 text-xs text-slate-500">
              最近結果：新增 <span className="font-semibold text-slate-800">{gmail.data.last_result.transactions_imported}</span> 筆消費
              {gmail.data.last_result.bills_found ? `，更新 ${gmail.data.last_result.bills_found} 份帳單` : ""}
              {gmail.data.last_result.errors.length ? "；部分郵件需要稍後重試" : "，已完成"}。
            </p>
          )}
          {gmail.data?.last_error && (
            <p className="w-full text-xs leading-5 text-amber-700">最近一次同步遇到問題，系統會在下次更新時自動重試。</p>
          )}
        </div>

        {gmail.data?.connected && emailSettingsOpen && !editingEmailRule && !manualEmailSetupOpen && (
          <div className="mt-5 rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50 to-emerald-50 p-5">
            <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
              <div>
                <p className="font-bold text-slate-800">上傳郵件截圖，快速建立信用卡</p>
                <p className="mt-1 text-sm leading-6 text-slate-500">
                  截圖只在這台裝置辨識文字，不會上傳圖片；辨識完成後確認一次即可建立帳戶並開始自動記帳。
                </p>
              </div>
              <input
                ref={emailScreenshotInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void readEmailScreenshot(file);
                }}
              />
              <Button
                type="button"
                onClick={() => emailScreenshotInput.current?.click()}
                disabled={emailScreenshotBusy || quickSetupGmailCard.isPending}
              >
                <ImageUp size={16} className={emailScreenshotBusy ? "animate-pulse" : ""} />
                {emailScreenshotBusy ? "正在讀取截圖…" : "選擇郵件截圖"}
              </Button>
            </div>

            {emailScreenshotBusy && (
              <div className="mt-4 rounded-xl bg-white/80 p-4">
                <div className="flex items-center justify-between gap-3 text-sm text-slate-600">
                  <span>{emailScreenshotName || "郵件截圖"}</span>
                  <span className="font-semibold text-blue-700">{emailScreenshotProgress}%</span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${emailScreenshotProgress}%` }} />
                </div>
                <p className="mt-2 text-xs text-slate-400">第一次使用需要下載繁體中文字庫，之後會使用瀏覽器快取。</p>
              </div>
            )}

            {!emailScreenshotBusy && emailScreenshotAnalysis && (
              <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
                <label className="block">
                  <span className="mb-2 block text-sm font-semibold text-slate-700">辨識到哪張信用卡？</span>
                  <Select
                    value={selectedGmailCandidate}
                    onChange={(event) => setSelectedGmailCandidate(event.target.value)}
                  >
                    <option value="">請確認銀行</option>
                    {SUPPORTED_CARD_PROVIDERS.map((provider) => (
                      <option key={provider.key} value={provider.key}>{provider.label}</option>
                    ))}
                  </Select>
                  <span className={cn("mt-2 block truncate text-xs", emailScreenshotAnalysis.detected ? "text-emerald-700" : "text-amber-700")}>
                    {emailScreenshotAnalysis.detected
                      ? `${emailScreenshotAnalysis.confidence === "high" ? "高可信度" : "請再確認"}${emailScreenshotAnalysis.card_last4 ? ` · 卡號末四碼 ${emailScreenshotAnalysis.card_last4}` : ""}`
                      : "圖片未顯示清楚的銀行名稱，請手動確認"}
                  </span>
                </label>
                <label className="block">
                  <span className="mb-2 block text-sm font-semibold text-slate-700">帳單從哪個帳戶扣款？</span>
                  <Select
                    value={quickPaymentAccountId}
                    onChange={(event) => setQuickPaymentAccountId(event.target.value)}
                  >
                    <option value="">選擇扣款帳戶</option>
                    {paymentAccounts.map((account) => (
                      <option key={account.id} value={account.id}>{account.name}（{account.owner_label}）</option>
                    ))}
                  </Select>
                  <span className="mt-2 block text-xs text-slate-400">信用卡負債帳戶會自動建立，不用先去帳戶頁。</span>
                </label>
                <Button
                  type="button"
                  disabled={quickSetupGmailCard.isPending || !selectedGmailCandidate || !quickPaymentAccountId}
                  onClick={() => quickSetupGmailCard.mutate({
                    candidate_key: selectedGmailCandidate,
                    payment_account_id: Number(quickPaymentAccountId),
                    ...(emailScreenshotAnalysis.card_last4 ? { card_last4: emailScreenshotAnalysis.card_last4 } : {}),
                  })}
                >
                  <Check size={16} /> {quickSetupGmailCard.isPending ? "建立並同步中…" : "確認並建立"}
                </Button>
              </div>
            )}

            <div className="my-5 flex items-center gap-3 text-xs text-slate-400">
              <span className="h-px flex-1 bg-white" />或<span className="h-px flex-1 bg-white" />
            </div>

            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <p className="text-sm font-semibold text-slate-700">直接從已連接的 Gmail 尋找</p>
                <p className="mt-1 text-xs text-slate-400">只檢查近六個月郵件的寄件者、主旨與日期。</p>
              </div>
              <Button
                type="button"
                variant="secondary"
                onClick={() => discoverGmailCards.mutate()}
                disabled={discoverGmailCards.isPending}
              >
                <Search size={16} className={discoverGmailCards.isPending ? "animate-pulse" : ""} />
                {discoverGmailCards.isPending ? "正在安全偵測…" : gmailCandidates.length ? "重新偵測 Gmail" : "自動偵測 Gmail"}
              </Button>
            </div>

            {discoverGmailCards.isPending && (
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                {["檢查銀行寄件者", "比對信用卡郵件", "準備自動設定"].map((label) => (
                  <div key={label} className="animate-pulse rounded-xl bg-white/80 px-4 py-3 text-sm text-slate-500">{label}…</div>
                ))}
              </div>
            )}

            {!discoverGmailCards.isPending && gmailCandidates.length > 0 && !emailScreenshotAnalysis && (
              <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
                <label className="block">
                  <span className="mb-2 block text-sm font-semibold text-slate-700">偵測到的信用卡</span>
                  <Select value={selectedGmailCandidate} onChange={(event) => setSelectedGmailCandidate(event.target.value)}>
                    {gmailCandidates.map((candidate) => (
                      <option key={candidate.key} value={candidate.key}>{candidate.account_name}（找到 {candidate.matched_messages} 封）</option>
                    ))}
                  </Select>
                  <span className="mt-2 block truncate text-xs text-slate-400">
                    {gmailCandidates.find((item) => item.key === selectedGmailCandidate)?.sample_subject || "已確認銀行寄件者"}
                  </span>
                </label>
                <label className="block">
                  <span className="mb-2 block text-sm font-semibold text-slate-700">帳單從哪個帳戶扣款？</span>
                  <Select value={quickPaymentAccountId} onChange={(event) => setQuickPaymentAccountId(event.target.value)}>
                    <option value="">選擇扣款帳戶</option>
                    {paymentAccounts.map((account) => (
                      <option key={account.id} value={account.id}>{account.name}（{account.owner_label}）</option>
                    ))}
                  </Select>
                </label>
                <Button
                  type="button"
                  disabled={quickSetupGmailCard.isPending || !selectedGmailCandidate || !quickPaymentAccountId}
                  onClick={() => quickSetupGmailCard.mutate({
                    candidate_key: selectedGmailCandidate,
                    payment_account_id: Number(quickPaymentAccountId),
                  })}
                >
                  <Check size={16} /> {quickSetupGmailCard.isPending ? "建立並同步中…" : "確認並開始同步"}
                </Button>
              </div>
            )}

            {!discoverGmailCards.isPending && discoverGmailCards.isSuccess && !gmailCandidates.length && (
              <p className="mt-4 rounded-xl bg-white/80 px-4 py-3 text-sm text-amber-700">
                尚未找到信用卡通知，可以改用上方的郵件截圖建立。
              </p>
            )}
          </div>
        )}

        {gmail.data?.connected && emailSettingsOpen && (editingEmailRule || manualEmailSetupOpen) && (
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
                  取消
                </button>
              </div>
            )}
            <input type="hidden" name="sender_pattern" value={editingEmailRule?.sender_pattern || ""} />
            <input type="hidden" name="subject_pattern" value={editingEmailRule?.subject_pattern || ""} />
            <input type="hidden" name="card_last4" value={editingEmailRule?.card_last4 || ""} />
            <input type="hidden" name="lookback_days" value={editingEmailRule?.lookback_days || 90} />
            <input type="hidden" name="closing_day" value={editingEmailRule?.closing_day || ""} />
            <div className="grid gap-3 lg:grid-cols-2">
              <FormStep number={1} title="信用卡">
                <div className="space-y-3">
                  <Input name="name" defaultValue={editingEmailRule?.name || ""} placeholder="例如：國泰信用卡" required />
                  <Select name="card_account_id" defaultValue={editingEmailRule ? String(editingEmailRule.card_account_id) : ""} required>
                    <option value="">選擇信用卡帳戶</option>
                    {cardAccounts.map((account) => (
                      <option key={account.id} value={account.id}>{account.name}（{account.owner_label}）</option>
                    ))}
                  </Select>
                  <p className="text-xs leading-5 text-slate-400">郵件來源與辨識方式會沿用目前設定，不需要另外調整。</p>
                </div>
              </FormStep>
              <FormStep number={2} title="繳款設定" tone="blue">
                <div className="space-y-3">
                  <Select name="payment_account_id" defaultValue={editingEmailRule ? String(editingEmailRule.payment_account_id) : ""} required>
                    <option value="">選擇扣款帳戶</option>
                    {paymentAccounts.map((account) => (
                      <option key={account.id} value={account.id}>{account.name}（{account.owner_label}）</option>
                    ))}
                  </Select>
                  <Input
                    name="payment_due_day"
                    type="number"
                    min={1}
                    max={31}
                    defaultValue={editingEmailRule?.payment_due_day || 23}
                    placeholder="每月繳款日"
                  />
                  <label className="flex items-start gap-3 rounded-xl bg-slate-50 p-3 text-sm text-slate-600">
                    <input name="auto_pay" type="checkbox" defaultChecked={editingEmailRule?.auto_pay ?? true} className="mt-1" />
                    <span>到繳款日自動在財務居記錄扣款；餘額不足或金額不合理時先暫停並提醒。</span>
                  </label>
                  <details className="rounded-xl border border-slate-100 px-3 py-2">
                    <summary className="cursor-pointer list-none text-xs font-semibold text-slate-500">電子帳單需要密碼？</summary>
                    <Input name="statement_password" type="password" autoComplete="off" className="mt-3" placeholder="輸入電子帳單 PDF 密碼" />
                  </details>
                </div>
              </FormStep>
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={saveEmailRule.isPending || !cardAccounts.length || !paymentAccounts.length}>
                <Save size={15} /> {saveEmailRule.isPending ? "儲存中…" : editingEmailRule ? "儲存變更" : "開始自動記帳"}
              </Button>
            </div>
            {!cardAccounts.length && (
              <p className="text-sm text-amber-700">請先到帳戶頁建立一個「信用卡」負債帳戶。</p>
            )}
          </form>
        )}

        {emailRules.data?.some((rule) => rule.active) && (
          <div className="mt-4 space-y-2">
            {emailRules.data.filter((rule) => rule.active).map((rule) => (
              <details key={rule.id} className="group rounded-xl border border-slate-100 px-4 py-3">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800">{rule.name}</p>
                    <p className="mt-1 truncate text-xs text-slate-400">
                      {rule.payment_account_name}扣款 · 每月 {rule.payment_due_day || 23} 日
                    </p>
                  </div>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge tone={rule.auto_pay ? "green" : "slate"}>{rule.auto_pay ? "自動記帳" : "只匯入"}</Badge>
                    <ChevronDown size={16} className="text-slate-400 transition group-open:rotate-180" />
                  </span>
                </summary>
                <div className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
                  <p>{rule.closing_day ? `每月 ${rule.closing_day} 日結帳` : "結帳日會從第一份帳單自動確認"}</p>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => startEditingEmailRule(rule)}>
                    編輯設定
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (window.confirm(`停止「${rule.name}」的郵件同步嗎？既有資料會保留。`)) {
                        deactivateEmailRule.mutate(rule.id);
                      }
                    }}
                  >
                    停止自動記帳
                  </Button>
                </div>
              </details>
            ))}
          </div>
        )}

        {cardCycles.data?.length ? (
          <details className="group mt-4 rounded-xl border border-slate-100">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
              <span>
                <span className="block text-sm font-semibold text-slate-800">帳期與繳款</span>
                <span className="mt-1 block text-xs text-slate-400">{cardCycles.data.length} 張信用卡 · 點擊查看未出帳與繳款紀錄</span>
              </span>
              <ChevronDown size={16} className="shrink-0 text-slate-400 transition group-open:rotate-180" />
            </summary>
            <div className="space-y-3 border-t border-slate-100 p-4">
            {cardCycles.data.map((cycle) => {
              const money = (amount: number) => `${cycle.currency} ${amount.toLocaleString("zh-TW")}`;
              return (
                <div key={cycle.rule_id} className="rounded-2xl border border-slate-100 p-4">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <p className="font-semibold text-slate-800">{cycle.rule_name}</p>
                    <p className="text-xs text-slate-400">
                      {cycle.closing_day ? `每月 ${cycle.closing_day} 日結帳` : "結帳日待帳單確認"} · 每月 {cycle.payment_due_day || 23} 日繳款
                    </p>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-xl bg-slate-50 p-3">
                      <p className="text-xs text-slate-400">未出帳消費</p>
                      <p className="mt-1 font-semibold text-slate-800">{money(cycle.unbilled.amount)}</p>
                      <p className="mt-1 text-xs text-slate-400">{cycle.unbilled.transaction_count} 筆</p>
                    </div>
                    <div className="rounded-xl bg-blue-50 p-3">
                      <p className="text-xs text-blue-500">本期帳單</p>
                      <p className="mt-1 font-semibold text-blue-900">{cycle.current_bill ? money(cycle.current_bill.amount_due) : "尚未出帳"}</p>
                      <p className="mt-1 text-xs text-blue-500">{cycle.current_bill ? `繳款日 ${cycle.current_bill.due_date}` : "等待電子帳單"}</p>
                    </div>
                    <div className="rounded-xl bg-emerald-50 p-3">
                      <p className="text-xs text-emerald-600">已繳款</p>
                      <p className="mt-1 font-semibold text-emerald-900">{cycle.last_paid_bill ? money(cycle.last_paid_bill.amount_due) : "尚無紀錄"}</p>
                      <p className="mt-1 text-xs text-emerald-600">{cycle.last_paid_bill ? cycle.last_paid_bill.due_date : "—"}</p>
                    </div>
                    <div className="rounded-xl bg-violet-50 p-3">
                      <p className="text-xs text-violet-500">下期消費</p>
                      <p className="mt-1 font-semibold text-violet-900">{money(cycle.next_cycle.amount)}</p>
                      <p className="mt-1 text-xs text-violet-500">{cycle.next_cycle.transaction_count} 筆</p>
                    </div>
                  </div>
                </div>
              );
            })}
            </div>
          </details>
        ) : null}

        {cardBills.data?.length ? (
          <details className="group mt-3 overflow-hidden rounded-xl border border-slate-100">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-slate-700">
              最近信用卡帳單（{cardBills.data.length}）
              <ChevronDown size={16} className="shrink-0 text-slate-400 transition group-open:rotate-180" />
            </summary>
            <div className="divide-y divide-slate-100 border-t border-slate-100">
              {cardBills.data.slice(0, 6).map((bill) => (
                <div key={bill.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-slate-800">{bill.rule_name} · {bill.currency} {bill.amount_due.toLocaleString()}</p>
                    <p className="mt-1 text-xs text-slate-400">
                      {bill.period_start && bill.period_end ? `帳期 ${bill.period_start}～${bill.period_end} · ` : ""}繳款日 {bill.due_date} · {bill.payment_account_name}
                    </p>
                    {bill.last_error && <p className="mt-1 text-xs text-amber-700">這份帳單尚未完成辨識，系統稍後會自動重試。</p>}
                  </div>
                  <Badge tone={bill.status === "paid" ? "green" : bill.status === "pending" ? "blue" : bill.status === "duplicate" ? "slate" : "amber"}>
                    {bill.status === "paid"
                      ? "已記錄扣款"
                      : bill.status === "pending"
                        ? "等待繳款日"
                        : bill.status === "insufficient_funds"
                          ? "餘額不足"
                          : bill.status === "duplicate"
                            ? "已合併"
                            : "需要確認"}
                  </Badge>
                </div>
              ))}
            </div>
          </details>
        ) : null}

        {gmail.data?.connected && (
          <details className="group mt-3 rounded-xl border border-transparent px-2 py-1">
            <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-semibold text-slate-400">
              其他連線設定
              <ChevronDown size={15} className="transition group-open:rotate-180" />
            </summary>
            <div className="mt-2 flex justify-end border-t border-slate-100 pt-2">
              <Button
                variant="ghost"
                onClick={() => {
                  if (window.confirm("停止 Gmail 連接嗎？既有交易、自動分類與帳單會保留。")) disconnectGmail.mutate();
                }}
                disabled={disconnectGmail.isPending}
              >
                停止 Gmail 連接
              </Button>
            </div>
          </details>
        )}
      </Card>
      </MobileSettingsSection>

      <p className="mb-2 mt-6 text-xs font-bold uppercase tracking-[.16em] text-slate-400 md:hidden">其他設定</p>

      <MobileSettingsSection
        id="categories"
        icon={<BookOpen size={18} />}
        title="自動分類"
        description="教系統記住常用店家分類"
        status={`${rules.data?.filter((rule) => !rule.is_default).length || 0} 項`}
      >
      <Card className="settings-detail-card mt-6 overflow-hidden">
        <div className="border-b border-slate-100 px-6 py-5">
          <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-violet-50 p-2.5 text-violet-700"><BookOpen size={18} /></div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-bold text-ink">自動分類</h2>
                  <Badge>{rules.data?.filter((rule) => !rule.is_default).length || 0} 項我的自動分類</Badge>
                </div>
                <p className="mt-1 text-xs text-slate-400">輸入常見店名，下次出現時會自動分類；內建規則會在背景運作。</p>
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
            {saveRule.isError && (
              <p className="text-sm text-red-600">
                {friendlySettingsMessage((saveRule.error as Error).message, "目前無法儲存自動分類，請稍後再試。")}
              </p>
            )}
            <div className="flex justify-end gap-2">
              {editingRuleId && <Button type="button" variant="ghost" onClick={resetRuleForm}>取消修改</Button>}
              <Button type="submit" disabled={saveRule.isPending || !ruleKeyword.trim() || !ruleCategoryId}>
                <Save size={15} /> {editingRuleId ? "儲存修改" : "新增自動分類"}
              </Button>
            </div>
          </form>
        </div>
        <div className="grid gap-3 border-b border-slate-100 px-6 py-4 md:grid-cols-[1fr_160px]">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <Input className="pl-9" value={ruleSearch} onChange={(event) => setRuleSearch(event.target.value)} placeholder="搜尋店名或分類" aria-label="搜尋自動分類" />
          </label>
          <Select value={ruleKindFilter} onChange={(event) => setRuleKindFilter(event.target.value)} aria-label="依交易類型篩選">
            <option value="all">全部類型</option>
            <option value="expense">支出</option>
            <option value="income">收入</option>
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
              {rules.data?.some((rule) => !rule.is_default) ? "找不到符合條件的自動分類。" : "目前沒有自己建立的自動分類；常見店家仍會正常分類。"}
            </div>
          )}
        </div>
      </Card>
      </MobileSettingsSection>

      {SHOW_ENGINEERING_SETTINGS && (
      <Card className="settings-advanced-card mt-6 overflow-hidden">
        <button
          className="flex w-full items-center justify-between px-6 py-5 text-left hover:bg-slate-50"
          onClick={() => setAdvancedOpen((value) => !value)}
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="rounded-xl bg-slate-100 p-2.5 text-slate-600"><Shield size={18} /></div>
            <div className="min-w-0">
              <h2 className="font-bold text-ink">進階資料設定</h2>
              <p className="mt-1 truncate text-xs text-slate-400 md:whitespace-normal">平常不需要碰；需要設定備援行情、手動匯率或查看明細時再展開。</p>
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
      )}
    </>
  );
}
