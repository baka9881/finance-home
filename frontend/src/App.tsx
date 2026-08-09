import { type FormEvent, lazy, Suspense, useEffect, useState } from "react";
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  BarChart3,
  ChevronLeft,
  Cloud,
  FileUp,
  Goal,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Menu,
  PieChart,
  Plus,
  RefreshCw,
  Settings,
  WalletCards,
  X,
} from "lucide-react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, AUTH_REQUIRED, clearAuthToken, getAuthToken, setAuthToken } from "./api";
import { prefetchPrimaryData, prefetchSecondaryData, preloadPageModules } from "./appQueries";
import { ownerFilterOptions, useOwnerFilter } from "./ownerFilter";
import { Button, cn, Input, Select } from "./ui";
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const AccountsPage = lazy(() => import("./pages/AccountsPage"));
const TransactionsPage = lazy(() => import("./pages/TransactionsPage"));
const InvestmentsPage = lazy(() => import("./pages/InvestmentsPage"));
const PlansPage = lazy(() => import("./pages/PlansPage"));
const AnalysisPage = lazy(() => import("./pages/AnalysisPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));

const navigation = [
  { to: "/", label: "總覽", icon: LayoutDashboard },
  { to: "/accounts", label: "帳戶", icon: WalletCards },
  { to: "/transactions", label: "交易", icon: ArrowLeftRight },
  { to: "/investments", label: "投資", icon: PieChart },
  { to: "/plans", label: "財務目標", icon: Goal },
  { to: "/analysis", label: "財務分析", icon: BarChart3 },
  { to: "/settings", label: "設定", icon: Settings },
];

const globalOwnerPaths = new Set(["/", "/accounts", "/transactions", "/investments", "/plans", "/analysis"]);

function useShowGlobalOwnerFilter() {
  const location = useLocation();
  return globalOwnerPaths.has(location.pathname);
}

function GlobalOwnerSelect({ compact = false }: { compact?: boolean }) {
  const [ownerFilter, setOwnerFilter] = useOwnerFilter();

  return (
    <label className={cn("flex items-center gap-2", compact ? "text-xs" : "text-sm")}>
      {!compact && <span className="font-medium text-slate-500">目前查看</span>}
      <Select
        className={cn(compact ? "h-10 w-24" : "h-10 w-32")}
        value={ownerFilter}
        onChange={(event) => setOwnerFilter(event.target.value)}
      >
        {ownerFilterOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </label>
  );
}

function GlobalOwnerBar() {
  const show = useShowGlobalOwnerFilter();
  if (!show) return null;

  return (
    <div className="sticky top-0 z-20 hidden h-14 items-center justify-between border-b border-slate-200/80 bg-canvas/90 px-10 backdrop-blur lg:flex">
      <GlobalOwnerSelect />
      <p className="text-xs text-slate-400">會套用到總覽、帳戶、交易、投資持倉、財務目標與財務分析。</p>
    </div>
  );
}

function MobileQuickActions() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  const actions = [
    {
      label: "花錢",
      description: "記錄日常支出",
      icon: ArrowUpRight,
      tone: "bg-orange-50 text-orange-700",
      target: "/transactions?quick=expense",
    },
    {
      label: "收錢",
      description: "記錄薪水或退款",
      icon: ArrowDownLeft,
      tone: "bg-emerald-50 text-emerald-700",
      target: "/transactions?quick=income",
    },
    {
      label: "帳戶互轉",
      description: "在自己的帳戶間移動",
      icon: ArrowLeftRight,
      tone: "bg-blue-50 text-blue-700",
      target: "/transactions?quick=transfer",
    },
    {
      label: "更新餘額",
      description: "建立最新帳戶快照",
      icon: RefreshCw,
      tone: "bg-violet-50 text-violet-700",
      target: "/accounts?quick=balance",
    },
    {
      label: "匯入信用卡帳單",
      description: "上傳銀行提供的 CSV",
      icon: FileUp,
      tone: "bg-slate-100 text-slate-700",
      target: "/transactions?quick=import",
    },
  ];

  return (
    <>
      {open && (
        <button
          type="button"
          aria-label="關閉快速操作"
          className="fixed inset-0 z-30 bg-slate-950/30 backdrop-blur-[2px] lg:hidden"
          onClick={() => setOpen(false)}
        />
      )}
      <div className="mobile-quick-actions fixed right-4 z-40 flex flex-col items-end gap-3 lg:hidden">
        {open && (
          <div
            role="menu"
            aria-label="快速操作"
            className="w-[min(21rem,calc(100vw-2rem))] overflow-hidden rounded-3xl border border-slate-200 bg-white p-2 shadow-2xl"
          >
            <div className="px-3 pb-2 pt-2">
              <p className="font-bold text-ink">快速新增</p>
              <p className="mt-0.5 text-xs text-slate-400">選一件現在要做的事</p>
            </div>
            <div className="space-y-1">
              {actions.map(({ label, description, icon: Icon, tone, target }) => (
                <button
                  key={label}
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition hover:bg-slate-50 active:scale-[.99]"
                  onClick={() => {
                    setOpen(false);
                    navigate(target);
                  }}
                >
                  <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl", tone)}>
                    <Icon size={18} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-slate-800">{label}</span>
                    <span className="block truncate text-xs text-slate-400">{description}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        <button
          type="button"
          aria-label={open ? "關閉快速操作" : "開啟快速操作"}
          aria-expanded={open}
          className="grid size-14 place-items-center rounded-2xl bg-forest text-white shadow-xl shadow-emerald-950/25 transition active:scale-95"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <X size={24} /> : <Plus size={25} />}
        </button>
      </div>
    </>
  );
}

function Sidebar({
  compact,
  mobileOpen,
  onToggle,
  onMobileClose,
}: {
  compact: boolean;
  mobileOpen: boolean;
  onToggle: () => void;
  onMobileClose: () => void;
}) {
  return (
    <>
      {mobileOpen && (
        <button
          aria-label="關閉選單"
          className="fixed inset-0 z-30 bg-slate-950/30 backdrop-blur-sm lg:hidden"
          onClick={onMobileClose}
        />
      )}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex flex-col bg-forest text-white transition-all duration-300",
          compact ? "lg:w-[86px]" : "lg:w-[250px]",
          mobileOpen ? "w-[270px] translate-x-0" : "w-[270px] -translate-x-full lg:translate-x-0",
        )}
      >
        <div className="flex h-24 items-center gap-3 px-6">
          <img
            src="/finance-home-icon-192.png"
            alt="財務居"
            className="size-12 shrink-0 rounded-2xl border-2 border-white/20 object-cover shadow-lg shadow-black/15"
          />
          {!compact && (
            <div className="min-w-0">
              <div className="text-lg font-bold tracking-wide">財務居</div>
              <div className="text-xs text-emerald-100/60">Personal Finance</div>
            </div>
          )}
          <button
            className="ml-auto rounded-lg p-2 text-emerald-100/70 hover:bg-white/10 lg:hidden"
            onClick={onMobileClose}
          >
            <X size={19} />
          </button>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-3">
          {navigation.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              onClick={onMobileClose}
              className={({ isActive }) =>
                cn(
                  "group flex h-12 items-center gap-3 rounded-xl px-4 text-sm font-medium transition",
                  isActive
                    ? "bg-white text-forest shadow-sm"
                    : "text-emerald-50/70 hover:bg-white/10 hover:text-white",
                  compact && "lg:justify-center lg:px-0",
                )
              }
            >
              <Icon size={19} className="shrink-0" />
              {!compact && <span>{label}</span>}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-white/10 p-3">
          <div className={cn("rounded-2xl bg-white/8 p-4", compact && "lg:hidden")}>
            <div className="flex items-center gap-3">
              <div className="grid size-9 place-items-center rounded-full bg-emerald-200 text-sm font-bold text-forest">
                我
              </div>
              <div>
                <p className="text-sm font-semibold">{AUTH_REQUIRED ? "雲端財務資料" : "本機財務資料"}</p>
                <p className="text-xs text-emerald-100/55">{AUTH_REQUIRED ? "已使用密碼保護" : "僅儲存在這台電腦"}</p>
              </div>
            </div>
            {AUTH_REQUIRED && (
              <button
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 py-2 text-xs font-medium text-emerald-50/80 hover:bg-white/10"
                onClick={clearAuthToken}
              >
                <LogOut size={14} /> 登出
              </button>
            )}
          </div>
          <button
            className="mt-2 hidden h-10 w-full items-center justify-center rounded-xl text-emerald-100/60 transition hover:bg-white/10 hover:text-white lg:flex"
            onClick={onToggle}
            aria-label="切換側邊欄"
          >
            <ChevronLeft className={cn("transition", compact && "rotate-180")} size={18} />
          </button>
        </div>
      </aside>
    </>
  );
}

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [serverStatus, setServerStatus] = useState<"waking" | "ready" | "error">("waking");

  useEffect(() => {
    const controller = new AbortController();

    void api<{ status: string }>("/health", { signal: controller.signal })
      .then(() => setServerStatus("ready"))
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setServerStatus("error");
      });

    return () => controller.abort();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const result = await api<{ token: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setAuthToken(result.token);
      onSuccess();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "無法登入");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-sky-100 px-4 py-10">
      <div className="absolute inset-0 bg-[url('/finance-home-cover.png?v=2')] bg-cover bg-center opacity-25" />
      <div className="absolute inset-0 bg-gradient-to-b from-white/25 via-white/55 to-canvas" />
      <div className="relative w-full max-w-md rounded-3xl border border-white/70 bg-white/90 p-7 shadow-2xl backdrop-blur sm:p-9">
        <img src="/finance-home-icon-192.png" alt="財務居" className="mx-auto size-24 rounded-3xl object-cover shadow-lg" />
        <div className="mt-5 text-center">
          <h1 className="text-2xl font-bold text-ink">登入財務居</h1>
          <p className="mt-2 text-sm text-slate-500">輸入你的專屬密碼，才能查看雲端財務資料。</p>
        </div>
        <div
          aria-live="polite"
          className={cn(
            "mt-5 flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm",
            serverStatus === "ready"
              ? "bg-emerald-50 text-emerald-700"
              : serverStatus === "error"
                ? "bg-amber-50 text-amber-700"
                : "bg-sky-50 text-sky-700",
          )}
        >
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              serverStatus === "ready"
                ? "bg-emerald-500"
                : serverStatus === "error"
                  ? "bg-amber-500"
                  : "animate-pulse bg-sky-500",
            )}
          />
          {serverStatus === "ready"
            ? "雲端伺服器已準備完成，可以立即登入。"
            : serverStatus === "error"
              ? "雲端連線較慢，按下登入後會繼續嘗試。"
              : "正在喚醒雲端伺服器，你可以先輸入密碼。"}
        </div>
        <form className="mt-7 space-y-4" onSubmit={submit}>
          <label className="block space-y-2">
            <span className="text-sm font-medium text-slate-700">登入密碼</span>
            <div className="relative">
              <LockKeyhole className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={17} />
              <Input
                className="pl-10"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="輸入密碼"
                autoFocus
                required
              />
            </div>
          </label>
          {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
          <Button className="w-full" type="submit" disabled={pending}>
            <Cloud size={16} />
            {pending
              ? serverStatus === "waking"
                ? "伺服器啟動中…"
                : "登入中…"
              : "登入雲端財務居"}
          </Button>
        </form>
      </div>
    </div>
  );
}

function FinanceApp() {
  const [compact, setCompact] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [ownerFilter] = useOwnerFilter();
  const queryClient = useQueryClient();
  const showGlobalOwnerFilter = useShowGlobalOwnerFilter();

  useEffect(() => {
    const moduleTimer = window.setTimeout(() => {
      void preloadPageModules();
    }, 100);
    const primaryTimer = window.setTimeout(() => {
      void prefetchPrimaryData(queryClient, ownerFilter);
    }, 250);
    const secondaryTimer = window.setTimeout(() => {
      void prefetchSecondaryData(queryClient, ownerFilter);
    }, 1_500);

    return () => {
      window.clearTimeout(moduleTimer);
      window.clearTimeout(primaryTimer);
      window.clearTimeout(secondaryTimer);
    };
  }, [ownerFilter, queryClient]);

  useEffect(() => {
    const syncExchanges = () => {
      void api<{ updated: number }>("/exchanges/sync", { method: "POST" })
        .then((result) => {
          if (!result.updated) return;
          void queryClient.invalidateQueries({ queryKey: ["accounts"] });
          void queryClient.invalidateQueries({ queryKey: ["positions"] });
          void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
        })
        .catch(() => undefined);
    };
    const exchangeTimer = window.setTimeout(syncExchanges, 800);
    const exchangeInterval = window.setInterval(syncExchanges, 15 * 60 * 1_000);
    return () => {
      window.clearTimeout(exchangeTimer);
      window.clearInterval(exchangeInterval);
    };
  }, [queryClient]);

  return (
    <div className="min-h-screen bg-canvas">
      <Sidebar
        compact={compact}
        mobileOpen={mobileOpen}
        onToggle={() => setCompact((value) => !value)}
        onMobileClose={() => setMobileOpen(false)}
      />
      <div className={cn("transition-all duration-300", compact ? "lg:pl-[86px]" : "lg:pl-[250px]")}>
        <div className="mobile-app-header sticky top-0 z-20 flex items-center justify-between border-b border-slate-200/80 bg-canvas/90 px-4 backdrop-blur lg:hidden">
          <button
            className="rounded-xl border border-slate-200 bg-white p-2.5 text-slate-700"
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={20} />
          </button>
          <div className="flex items-center gap-2 font-bold text-forest">
            <img src="/finance-home-icon-192.png" alt="" className="size-8 rounded-xl object-cover" />
            財務居
          </div>
          {showGlobalOwnerFilter ? <GlobalOwnerSelect compact /> : <div className="size-10" />}
        </div>
        <GlobalOwnerBar />
        <main className="mx-auto min-h-screen max-w-[1600px] px-4 pb-28 pt-7 sm:px-7 lg:px-10 lg:py-9">
          <Suspense
            fallback={
              <div className="space-y-5">
                <div className="h-20 animate-pulse rounded-2xl bg-slate-200/70" />
                <div className="h-72 animate-pulse rounded-2xl bg-slate-200/70" />
              </div>
            }
          >
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/accounts" element={<AccountsPage />} />
              <Route path="/transactions" element={<TransactionsPage />} />
              <Route path="/investments" element={<InvestmentsPage />} />
              <Route path="/plans" element={<PlansPage />} />
              <Route path="/analysis" element={<AnalysisPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </main>
      </div>
      <MobileQuickActions />
    </div>
  );
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(!AUTH_REQUIRED || Boolean(getAuthToken()));

  useEffect(() => {
    const syncAuth = () => setAuthenticated(!AUTH_REQUIRED || Boolean(getAuthToken()));
    window.addEventListener("finance:auth-changed", syncAuth);
    return () => window.removeEventListener("finance:auth-changed", syncAuth);
  }, []);

  if (!authenticated) return <LoginScreen onSuccess={() => setAuthenticated(true)} />;
  return <FinanceApp />;
}
