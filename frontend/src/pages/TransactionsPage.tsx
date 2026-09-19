import { FormEvent, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowDownLeft,
  ArrowRightLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FileSpreadsheet,
  Landmark,
  Link2,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  SlidersHorizontal,
  Trash2,
  Upload,
} from "lucide-react";
import { api } from "../api";
import TransactionCategory from "../TransactionCategory";
import TransactionCorrection from "../TransactionCorrection";
import BatchClassification from "../BatchClassification";
import { COMMON_CURRENCIES } from "../currencies";
import { useTransactionScroll } from "../useTransactionScroll";
import QuickTransactionForm, { clearQuickDraft, rememberTransactionAccount } from "../QuickTransactionForm";
import { invalidateFinanceData } from "../appQueries";
import { readTransactionFilters, saveTransactionFilters, transactionFilterParams, transactionSourceLabel, type TransactionFilters } from "../transactionFilters";
import { taipeiDateInputValue, taipeiMonthInputValue } from "../date";
import { useOwnerFilter } from "../ownerFilter";
import type { Account, Category, CsvInspection, Transaction, TransactionPage } from "../types";
import {
  Badge,
  Button,
  Card,
  DateInput,
  Dialog,
  EmptyState,
  Field,
  FormActions,
  FormOptions,
  Input,
  MonthInput,
  PageHeader,
  Select,
  Skeleton,
  money,
} from "../ui";

interface TransferSuggestion {
  from: { id: number; account: string; date: string; description: string; amount: number };
  to: { id: number; account: string; date: string; description: string; amount: number };
}

interface PendingCsvBalance {
  account_id: number;
  account_name: string;
  currency: string;
  count: number;
  balance_change: number;
  current_balance: number;
  balance_after: number;
}

const currentMonth = taipeiMonthInputValue();
const monthLabel = (value: string) => {
  const [year, month] = value.split("-");
  return year && month ? `${year}年${Number(month)}月` : value;
};
const kindLabels: Record<string, string> = {
  income: "收入",
  expense: "支出",
  transfer: "轉帳",
  investment: "投資",
  debt_principal: "貸款本金",
  interest: "利息",
};

type ManualScenario = "income" | "expense" | "transfer" | "loan_payment";

export function categoriesForTransactionKind(categories: Category[], kind: string) {
  if (kind === "income") return categories.filter((category) => category.kind === "income");
  if (kind === "expense") return categories.filter((category) => category.kind === "expense");
  return [];
}

function normalizedAccountMatchText(value: string) {
  return value
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[\s_\-./\\()（）年月]/g, "");
}

function guessImportAccountId(fileName: string, accounts: Account[], selectedAccountId: string) {
  if (selectedAccountId && accounts.some((account) => String(account.id) === selectedAccountId)) {
    return selectedAccountId;
  }

  const fileText = normalizedAccountMatchText(fileName);
  const ranked = accounts
    .map((account) => {
      const name = normalizedAccountMatchText(account.name);
      const institution = normalizedAccountMatchText(account.institution || "");
      let score = 0;

      if (name.length >= 2 && (fileText.includes(name) || name.includes(fileText))) score += 120;
      if (institution.length >= 2 && fileText.includes(institution)) score += 60;
      if (/信用卡|card/.test(fileText) && account.account_type === "credit_card") score += 35;

      return { id: String(account.id), score };
    })
    .sort((left, right) => right.score - left.score);

  if (!ranked[0] || ranked[0].score < 35 || ranked[0].score === ranked[1]?.score) return "";
  return ranked[0].id;
}

export default function TransactionsPage() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState(() => readTransactionFilters(searchParams));
  const lastFilterUrl = useRef(searchParams.toString());
  useEffect(() => {
    const url = searchParams.toString();
    if (url !== lastFilterUrl.current) {
      lastFilterUrl.current = url;
      const next = readTransactionFilters(searchParams);
      setFilters(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      return;
    }
    const next = transactionFilterParams(filters, searchParams);
    if (next.toString() !== url) {
      lastFilterUrl.current = next.toString();
      setSearchParams(next, { replace: true });
    }
  }, [filters, searchParams, setSearchParams]);
  const { month, account: accountFilter, search, onlyUnclassified, showTransfers, page, excluded } = filters;
  function updateFilter<K extends keyof TransactionFilters>(key: K, next: SetStateAction<TransactionFilters[K]>) {
    setFilters((previous) => ({ ...previous, page: 1, [key]: typeof next === "function" ? (next as (value: TransactionFilters[K]) => TransactionFilters[K])(previous[key]) : next }));
  }
  const setMonth = (value: string) => updateFilter("month", value);
  const setAccountFilter = (value: string) => updateFilter("account", value);
  const setSearch = (value: string) => updateFilter("search", value);
  const setOnlyUnclassified = (value: SetStateAction<boolean>) => updateFilter("onlyUnclassified", value);
  const setShowTransfers = (value: SetStateAction<boolean>) => updateFilter("showTransfers", value);
  function shiftMonth(delta: number) {
    const [year, value] = (month || currentMonth).split("-").map(Number);
    const shifted = new Date(year, value - 1 + delta, 1);
    setMonth(`${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, "0")}`);
  }
  const [searchQuery, setSearchQuery] = useState(search);
  useEffect(() => { saveTransactionFilters(filters); }, [filters]);
  useEffect(() => { const timer = setTimeout(() => setSearchQuery(search), 250); return () => clearTimeout(timer); }, [search]);
  const [ownerFilter] = useOwnerFilter();
  const [manualOpen, setManualOpen] = useState(false);
  const [manualScenario, setManualScenario] = useState<ManualScenario | null>(null);
  const [manualKind, setManualKind] = useState("expense");
  const [loanAccountId, setLoanAccountId] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [accountTransferOpen, setAccountTransferOpen] = useState(false);
  const [transferFromAccountId, setTransferFromAccountId] = useState("");
  const [transferToAccountId, setTransferToAccountId] = useState("");
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<CsvInspection | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [importResult, setImportResult] = useState<Record<string, unknown> | null>(null);
  const [advancedMappingOpen, setAdvancedMappingOpen] = useState(false);
  const [classificationMessage, setClassificationMessage] = useState("");
  const [correcting, setCorrecting] = useState<Transaction | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  useEffect(() => { setSelectedIds([]); }, [month, accountFilter, ownerFilter, searchQuery, page, excluded]);
  const toggleSelected = (id: number) => setSelectedIds((ids) => ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]);


  useEffect(() => {
    const quickAction = searchParams.get("quick");
    if (!quickAction) return;

    if (quickAction === "expense" || quickAction === "income") {
      setManualScenario(quickAction);
      setManualKind(quickAction);
      setLoanAccountId("");

      setManualOpen(true);
    } else if (quickAction === "transfer") {

      setAccountTransferOpen(true);
    } else if (quickAction === "import") {
      setImportOpen(true);
    }

    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("quick");
    setSearchParams(nextParams, { replace: true });
  }, [searchParams, setSearchParams]);

  const accounts = useQuery({
    queryKey: ["accounts", ownerFilter],
    queryFn: () => api<Account[]>(`/accounts?owner=${ownerFilter}`),
  });
  const categories = useQuery({ queryKey: ["categories"], queryFn: () => api<Category[]>("/categories") });
  const filterAccounts = useQuery({
    queryKey: ["accounts", ownerFilter, "including-archived"],
    queryFn: () => api<Account[]>(`/accounts?owner=${ownerFilter}&include_archived=true`),
  });
  const transactions = useQuery({
    queryKey: ["transactions", "page", month, accountFilter, ownerFilter, searchQuery, showTransfers, onlyUnclassified, page, excluded],
    queryFn: () =>
      api<TransactionPage>(
        `/transactions/page?month=${month}&owner=${ownerFilter}&search=${encodeURIComponent(searchQuery)}&page=${page}&show_transfers=${showTransfers}&only_unclassified=${onlyUnclassified}&excluded=${excluded}${accountFilter ? `&account_id=${accountFilter}` : ""}`,
      ),
  });
  const pendingCsvBalances = useQuery({
    queryKey: ["pending-csv-balances", ownerFilter],
    queryFn: () =>
      api<PendingCsvBalance[]>(`/transactions/import-balance/pending?owner=${ownerFilter}`),
  });
  const suggestions = useQuery({
    queryKey: ["transfer-suggestions"],
    queryFn: () => api<TransferSuggestion[]>("/transfers/suggestions"),
    enabled: transferOpen,
  });
  const transferFromAccount = useMemo(
    () => accounts.data?.find((account) => String(account.id) === transferFromAccountId),
    [accounts.data, transferFromAccountId],
  );
  const transferToAccount = useMemo(
    () => accounts.data?.find((account) => String(account.id) === transferToAccountId),
    [accounts.data, transferToAccountId],
  );
  const accountFilterOptions = useMemo(
    () =>
      (filterAccounts.data || []).filter(
        (account) => ownerFilter === "all" || account.owner === ownerFilter,
      ),
    [filterAccounts.data, ownerFilter],
  );
  useEffect(() => {
    if (!accountFilter || !filterAccounts.data) return;
    if (!accountFilterOptions.some((account) => String(account.id) === accountFilter)) {
      setAccountFilter("");
    }
  }, [accountFilter, accountFilterOptions, filterAccounts.data]);
  const paymentAccountOptions = useMemo(
    () => (accounts.data || []).filter((account) => account.nature === "asset"),
    [accounts.data],
  );
  const loanAccountOptions = useMemo(
    () => (accounts.data || []).filter((account) => account.nature === "liability" && account.account_type === "loan"),
    [accounts.data],
  );

  const filteredTransactions = transactions.data?.items || [];
  useTransactionScroll(JSON.stringify([ownerFilter, month, accountFilter, searchQuery, page, onlyUnclassified, showTransfers, excluded]), Boolean(transactions.data));
  const importMappingReady = Boolean(
    mapping.date && mapping.description && (mapping.amount || mapping.debit || mapping.credit),
  );
  const selectedImportAccount = useMemo(
    () => accounts.data?.find((account) => String(account.id) === String(mapping.account_id)),
    [accounts.data, mapping.account_id],
  );
  const unclassifiedCount = excluded ? 0 : transactions.data?.unclassified_count || 0;
  const transferCount = transactions.data?.transfer_count || 0;
  const activeAdvancedFilterCount = Number(Boolean(onlyUnclassified)) + Number(Boolean(showTransfers)) + Number(Boolean(excluded));

  const createTransaction = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api("/transactions", { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: (_result, payload) => {
      rememberTransactionAccount(ownerFilter, Number(payload.account_id));
      clearQuickDraft(ownerFilter, String(payload.transaction_kind));
      invalidateFinanceData(client, ["transactions","accounts","dashboard"]);
      setManualOpen(false);
      setManualScenario(null);
      setManualKind("expense");
      setLoanAccountId("");
    },
  });

  function onCategorySaved(previous: Transaction) {
    if (onlyUnclassified && previous.category_name === "未分類") {
      const remaining = Math.max(0, unclassifiedCount - 1);
      if (!remaining) setOnlyUnclassified(false);
      setClassificationMessage(remaining ? `已完成一筆分類，還有 ${remaining} 筆待處理。` : "分類完成，已返回完整交易清單。");
    }
  }

  const reclassifyTransactions = useMutation({
    mutationFn: () =>
      api<{ updated: number; remaining: number }>(
        `/transactions/reclassify?owner=${ownerFilter}&month=${month}&search=${encodeURIComponent(searchQuery)}${accountFilter ? `&account_id=${accountFilter}` : ""}`,
        { method: "POST" },
      ),
    onSuccess: (result) => {
      const needsManualClassification = !result.updated && unclassifiedCount > 0;
      if (needsManualClassification) setOnlyUnclassified(true);
      setClassificationMessage(
        result.updated
          ? `已自動分類 ${result.updated} 筆交易。`
          : needsManualClassification
            ? "這筆交易無法自動判斷，已替你顯示出來，請手動選擇分類。"
            : "目前沒有能自動辨識的未分類交易。",
      );
      invalidateFinanceData(client, ["transactions","dashboard"]);
    },
  });

  const deleteTransaction = useMutation({
    mutationFn: (id: number) => api(`/transactions/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidateFinanceData(client, ["transactions","accounts","dashboard"]);
    },
  });

  const inspectMutation = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append("file", file);
      return api<CsvInspection>("/transactions/import/inspect", { method: "POST", body });
    },
    onSuccess: (data, file) => {
      setInspection(data);
      const guessed: Record<string, string> = {};
      for (const column of data.columns) {
        const normalized = column.toLowerCase();
        if (!guessed.date && /日期|date|交易日/.test(normalized)) guessed.date = column;
        if (!guessed.description && /摘要|說明|description|memo|交易內容/.test(normalized)) guessed.description = column;
        if (!guessed.amount && /金額|amount/.test(normalized) && !/收入|支出|借|貸/.test(normalized)) guessed.amount = column;
        if (!guessed.debit && /支出|debit|提款|借方/.test(normalized)) guessed.debit = column;
        if (!guessed.credit && /收入|credit|存入|貸方/.test(normalized)) guessed.credit = column;
        if (!guessed.currency && /幣別|currency/.test(normalized)) guessed.currency = column;
        if (!guessed.balance && /餘額|balance/.test(normalized)) guessed.balance = column;
      }
      const guessedAccountId = guessImportAccountId(file.name, accounts.data || [], accountFilter);
      if (guessedAccountId) guessed.account_id = guessedAccountId;
      setAdvancedMappingOpen(
        !guessed.date || !guessed.description || (!guessed.amount && !guessed.debit && !guessed.credit),
      );
      setMapping(guessed);
    },
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!csvFile) throw new Error("請選擇 CSV 檔案");
      const body = new FormData();
      body.append("file", csvFile);
      body.append("account_id", String(mapping.account_id));
      body.append("mapping_json", JSON.stringify(mapping));
      body.append("commit", "true");
      body.append("adjust_balance", "true");
      return api<Record<string, unknown>>("/transactions/import", { method: "POST", body });
    },
    onSuccess: (result) => {
      setImportResult(result);
      invalidateFinanceData(client, ["transactions","dashboard","accounts"]);
    },
  });

  const applyPendingCsvBalance = useMutation({
    mutationFn: (accountId: number) =>
      api<PendingCsvBalance>(`/transactions/import-balance/apply/${accountId}`, {
        method: "POST",
      }),
    onSuccess: () => {
      invalidateFinanceData(client, ["pending-csv-balances","accounts","dashboard"]);
    },
  });

  const confirmTransfer = useMutation({
    mutationFn: (suggestion: TransferSuggestion) =>
      api("/transfers", {
        method: "POST",
        body: JSON.stringify({
          from_transaction_id: suggestion.from.id,
          to_transaction_id: suggestion.to.id,
        }),
      }),
    onSuccess: () => {
      invalidateFinanceData(client, ["transactions","dashboard","transfer-suggestions"]);
    },
  });

  const createAccountTransfer = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api("/account-transfers", { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => {
      invalidateFinanceData(client, ["transactions","accounts","dashboard"]);
      setAccountTransferOpen(false);
      setTransferFromAccountId("");
      setTransferToAccountId("");
    },
  });

  const createLoanPayment = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api("/loan-payments", { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => {
      invalidateFinanceData(client, ["transactions","accounts","dashboard"]);
      setManualOpen(false);
      setManualKind("expense");
      setLoanAccountId("");
      setManualScenario(null);
    },
  });

  function openManualDialog() {
    setManualScenario("expense");
    setManualKind("expense");
    setLoanAccountId("");
    createTransaction.reset();
    createLoanPayment.reset();

    setManualOpen(true);
  }

  function closeManualDialog() {
    setManualOpen(false);
    setManualScenario(null);
    setManualKind("expense");
    setLoanAccountId("");
    createTransaction.reset();
    createLoanPayment.reset();

  }

  function chooseManualScenario(scenario: ManualScenario) {
    if (scenario === "transfer") {
      closeManualDialog();

      setAccountTransferOpen(true);
      return;
    }

    setManualScenario(scenario);
    setManualKind(scenario);
    setLoanAccountId("");
  }

  function closeAccountTransferDialog() {
    setAccountTransferOpen(false);

    setTransferFromAccountId("");
    setTransferToAccountId("");
    createAccountTransfer.reset();
  }

  function submitManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const amount = Number(form.get("amount"));
    const kind = String(form.get("transaction_kind"));
    if (kind === "loan_payment") {
      if (!loanAccountOptions.length || !form.get("loan_account_id")) return;
      createLoanPayment.mutate({
        payment_account_id: Number(form.get("account_id")),
        loan_account_id: Number(form.get("loan_account_id")),
        payment_date: form.get("transaction_date"),
        principal: Number(form.get("principal") || 0),
        interest: Number(form.get("interest") || 0),
        description: form.get("description") || null,
        note: form.get("note") || null,
      });
      return;
    }
    const signedAmount = kind === "expense" || kind === "interest" ? -Math.abs(amount) : Math.abs(amount);
    createTransaction.mutate({
      account_id: Number(form.get("account_id")),
      transaction_date: form.get("transaction_date"),
      description: form.get("description"),
      amount: signedAmount,
      currency: form.get("currency") || null,
      fx_rate: form.get("fx_rate") ? Number(form.get("fx_rate")) : null,
      transaction_kind: kind,
      category_id: form.get("category_id") ? Number(form.get("category_id")) : null,
      note: form.get("note") || null,
    });
  }

  function submitAccountTransfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    createAccountTransfer.mutate({
      from_account_id: Number(form.get("from_account_id")),
      to_account_id: Number(form.get("to_account_id")),
      transfer_date: form.get("transfer_date"),
      amount: Number(form.get("amount")),
      to_amount: form.get("to_amount") ? Number(form.get("to_amount")) : null,
      description: form.get("description") || null,
      note: form.get("note") || null,
    });
  }

  function resetImport() {
    setCsvFile(null);
    setInspection(null);
    setMapping({});
    setImportResult(null);
    setAdvancedMappingOpen(false);
    inspectMutation.reset();
    importMutation.reset();
  }

  return (
    <>
      <PageHeader
        eyebrow="Cash flow"
        title="交易與現金流"
        description="匯入銀行或信用卡 CSV，分類支出並排除自有帳戶間轉帳。"
        action={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setImportOpen(true)}>
              <Upload size={16} /> 匯入 CSV
            </Button>
            <Button onClick={openManualDialog}>
              <Plus size={16} /> 新增交易
            </Button>
          </div>
        }
      />

      {pendingCsvBalances.data?.map((pending) => (
        <div
          key={pending.account_id}
          className="mb-5 flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-amber-900 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <p className="font-semibold">{pending.account_name}有 {pending.count} 筆匯入明細尚未反映在餘額</p>
            <p className="mt-1 text-sm text-amber-700">
              同步後餘額會由 {money(pending.current_balance)} 變為 {money(pending.balance_after)}，且不會重複套用。
            </p>
          </div>
          <Button
            variant="secondary"
            className="shrink-0"
            onClick={() => applyPendingCsvBalance.mutate(pending.account_id)}
            disabled={applyPendingCsvBalance.isPending}
          >
            {applyPendingCsvBalance.isPending ? "同步中…" : "同步帳戶餘額"}
          </Button>
        </div>
      ))}

      {applyPendingCsvBalance.isError && (
        <p className="mb-5 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {(applyPendingCsvBalance.error as Error).message}
        </p>
      )}

      <Card className="mb-5 p-4">
        <div className="grid min-w-0 gap-3 sm:grid-cols-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
          <div className="relative min-w-0">
            <Search className="absolute left-3 top-3.5 text-slate-400" size={16} />
            <Input
              className="pl-9"
              placeholder="搜尋摘要、分類或帳戶"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="flex min-w-0 items-center gap-1">
            <Button variant="ghost" aria-label="上一個月" className="shrink-0 px-2" onClick={() => shiftMonth(-1)}><ChevronLeft size={16} /></Button>
            <MonthInput value={month} onChange={(event) => setMonth(event.target.value)} aria-label="查看月份" />
            <Button variant="ghost" aria-label="下一個月" className="shrink-0 px-2" onClick={() => shiftMonth(1)}><ChevronRight size={16} /></Button>
          </div>
          <Select value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)}>
            <option value="">全部帳戶</option>
            {accountFilterOptions.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}（{account.owner_label}{account.archived ? " · 已封存" : ""}）
              </option>
            ))}
          </Select>
          <Button
            variant={advancedFiltersOpen || activeAdvancedFilterCount ? "secondary" : "ghost"}
            className="justify-center whitespace-nowrap"
            onClick={() => setAdvancedFiltersOpen((value) => !value)}
            aria-expanded={advancedFiltersOpen}
          >
            <SlidersHorizontal size={16} />
            更多篩選{activeAdvancedFilterCount > 0 ? `（${activeAdvancedFilterCount}）` : ""}
          </Button>
        </div>
        {advancedFiltersOpen && <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3 text-sm [&>button]:h-8 [&>button]:px-3">
          <Button variant="ghost" onClick={() => setMonth(currentMonth)}>本月</Button>
          <Button variant="ghost" onClick={() => setMonth("")}>所有月份</Button>
          <Button variant={excluded ? "secondary" : "ghost"} onClick={() => setFilters((value) => ({ ...value, excluded: !excluded, onlyUnclassified: false, page: 1 }))}>{excluded ? "返回一般交易" : "查看已排除"}</Button>
          {(search || accountFilter || onlyUnclassified) && <Button variant="ghost" onClick={() => setFilters((value) => ({ ...value, search: "", account: "", onlyUnclassified: false, page: 1 }))}>清除篩選</Button>}
          {!month && <span className="self-center text-slate-500">目前搜尋所有月份</span>}
        </div>}
        {(transactions.isFetching || search !== searchQuery) && (
          <div
            className="mt-3 flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700"
            role="status"
            aria-live="polite"
          >
            <RefreshCw className="animate-spin" size={15} />
            正在載入 {month ? monthLabel(month) : "所有月份"}的交易…
          </div>
        )}
      </Card>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          {excluded && "已排除 · 不列入統計 · "}
          {transactions.isPending ? (
            "正在載入交易…"
          ) : (
            <>共 <strong className="text-slate-800">{transactions.data?.total || 0}</strong> 筆交易</>
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          {!advancedFiltersOpen && unclassifiedCount > 0 && (
            <Button
              variant={onlyUnclassified ? "secondary" : "ghost"}
              onClick={() => setOnlyUnclassified((current) => !current)}
            >
              <CircleAlert size={16} /> 待分類 {unclassifiedCount} 筆
            </Button>
          )}
          {advancedFiltersOpen && <>
          {transferCount > 0 && (
            <Button
              variant="ghost"
              onClick={() => setShowTransfers((current) => !current)}
            >
              <ArrowRightLeft size={16} />
              {showTransfers ? "隱藏帳戶互轉" : `顯示帳戶互轉（${transferCount}）`}
            </Button>
          )}
          {unclassifiedCount > 0 && (
            <Button
              variant="ghost"
              onClick={() => setOnlyUnclassified((current) => !current)}
            >
              {onlyUnclassified ? "顯示全部交易" : `只看未分類（${unclassifiedCount}）`}
            </Button>
          )}
          {unclassifiedCount > 0 && (
            <Button
              variant="secondary"
              onClick={() => {
                setClassificationMessage("");
                reclassifyTransactions.mutate();
              }}
              disabled={reclassifyTransactions.isPending}
            >
              <Sparkles size={16} />
              {reclassifyTransactions.isPending
                ? "整理中…"
                : `自動整理 ${unclassifiedCount} 筆未分類`}
            </Button>
          )}
          <Button variant="ghost" disabled={excluded} onClick={() => setTransferOpen(true)}>
            <Link2 size={16} /> 尋找帳戶間轉帳
          </Button>
          </>}
        </div>
      </div>

      {(classificationMessage || reclassifyTransactions.isError) && (
        <div className={`mb-5 rounded-xl px-4 py-3 text-sm ${
          reclassifyTransactions.isError
            ? "bg-red-50 text-red-700"
            : "bg-emerald-50 text-emerald-700"
        }`}>
          {reclassifyTransactions.isError
            ? (reclassifyTransactions.error as Error).message
            : classificationMessage}
        </div>
      )}

      {(!excluded || (transactions.data?.total || 0) > 50) && <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        {!excluded && <div className={`${batchMode ? "w-full" : "min-w-0 flex-1"} [&>section]:mb-0`}>
          <BatchClassification rows={filteredTransactions} categories={categories.data || []} selected={selectedIds} onSelect={setSelectedIds} active={batchMode} onToggle={() => { setBatchMode(!batchMode); setSelectedIds([]); }} onSaved={() => { if (onlyUnclassified) { setOnlyUnclassified(false); setClassificationMessage("批次分類完成，已返回交易清單。"); } }} />
        </div>}
        {(transactions.data?.total || 0) > 50 && (
          <nav aria-label="交易分頁" className="ml-auto flex items-center gap-2">
            <Button variant="ghost" className="px-2" aria-label="上一頁" disabled={transactions.isFetching || (transactions.data?.page || 1) <= 1} onClick={() => updateFilter("page", (transactions.data?.page || 1) - 1)}><ChevronLeft size={16} /></Button>
            <span className="whitespace-nowrap text-xs tabular-nums text-slate-500">第 {transactions.data?.page || 1} / {Math.ceil((transactions.data?.total || 0) / 50)} 頁</span>
            <Button variant="ghost" className="px-2" aria-label="下一頁" disabled={transactions.isFetching || (transactions.data?.page || 1) * 50 >= (transactions.data?.total || 0)} onClick={() => updateFilter("page", (transactions.data?.page || 1) + 1)}><ChevronRight size={16} /></Button>
          </nav>
        )}
      </div>}
      <Card className="overflow-hidden" aria-busy={transactions.isFetching}>
        {transactions.isError && transactions.data && <p role="alert" className="p-4 text-sm text-amber-700">更新失敗，保留上次載入的交易。<Button onClick={() => transactions.refetch()}>重試</Button></p>}
        {transactions.isError && !transactions.data ? (
          <EmptyState
            icon={<CircleAlert size={25} />}
            title="交易資料載入失敗"
            description={(transactions.error as Error).message || "目前無法取得這個月份的交易，請稍後再試。"}
            action={<Button onClick={() => transactions.refetch()}>重新載入</Button>}
          />
        ) : transactions.isPending ? (
          <div className="space-y-1 p-4" role="status" aria-live="polite">
            <span className="sr-only">正在載入 {month ? monthLabel(month) : "所有月份"}的交易</span>
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="flex items-center gap-3 rounded-xl px-1 py-3">
                <Skeleton className="size-10 shrink-0 rounded-xl" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
                <Skeleton className="h-5 w-20 shrink-0" />
              </div>
            ))}
          </div>
        ) : !filteredTransactions.length ? (
          <EmptyState
            icon={<ArrowRightLeft size={25} />}
            title={
              excluded ? "這個範圍沒有已排除交易" : search.trim() || accountFilter ? "找不到符合條件的交易" : onlyUnclassified
                ? "這個月份沒有未分類交易"
                : !showTransfers && transferCount > 0 && !search.trim()
                    ? "帳戶互轉已隱藏"
                    : "這個月份沒有交易"
            }
            description={
              excluded ? "已排除的交易會保留在此，隨時可以查看與復原。" : search.trim() || accountFilter ? "可以清除搜尋與帳戶篩選，或改查所有月份。" : onlyUnclassified
                ? "目前顯示範圍內的交易都已完成分類。"
                : !showTransfers && transferCount > 0 && !search.trim()
                    ? "自己的帳戶之間移動資金不算收入或支出，因此預設不顯示。"
                : "你可以手動新增交易，或匯入銀行與信用卡提供的 CSV 明細。"
            }
            action={
              excluded ? <Button onClick={() => updateFilter("excluded", false)}>返回一般交易</Button> : search.trim() || accountFilter ? <Button onClick={() => setFilters((value) => ({ ...value, search: "", account: "", page: 1 }))}>清除篩選</Button> : onlyUnclassified
                ? <Button onClick={() => setOnlyUnclassified(false)}>顯示全部交易</Button>
                : !showTransfers && transferCount > 0 && !search.trim()
                    ? <Button variant="secondary" onClick={() => setShowTransfers(true)}>查看帳戶互轉</Button>
                : <Button onClick={() => setImportOpen(true)}>匯入交易</Button>
            }
          />
        ) : (
          <>
          <div className="divide-y divide-slate-100 md:hidden">
            {filteredTransactions.map((transaction) => (
              <details key={transaction.id} className="group px-4 py-4">
                <summary className="cursor-pointer list-none">
                  <div className="flex items-start gap-3">
                    <div
                      className={`grid size-11 shrink-0 place-items-center rounded-xl ${
                        transaction.base_amount >= 0
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-orange-50 text-orange-700"
                      }`}
                    >
                      {transaction.base_amount >= 0 ? <ArrowDownLeft size={18} /> : <ArrowUpRight size={18} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-slate-800">{transaction.description}</p>
                          <p className="mt-0.5 truncate text-xs text-slate-400">{transaction.account_name}</p>
                        </div>
                        <p className={`shrink-0 font-bold ${transaction.base_amount >= 0 ? "text-emerald-700" : "text-slate-800"}`}>
                          {transaction.base_amount >= 0 ? "+" : "−"}{money(Math.abs(transaction.base_amount))}
                        </p>
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-slate-500">
                        <span>{transaction.transaction_date} · {kindLabels[transaction.transaction_kind] || transaction.transaction_kind}</span>
                        <span className="flex items-center gap-1">查看細項 <ChevronDown size={14} className="transition group-open:rotate-180" /></span>
                      </div>
                    </div>
                  </div>
                </summary>
                {batchMode && !excluded && transaction.can_correct && <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={selectedIds.includes(transaction.id)} onChange={() => toggleSelected(transaction.id)} />選取 {transaction.description}</label>}
                <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-xl bg-slate-50 p-3">
                      <p className="text-xs text-slate-400">來源</p>
                      <p className="mt-1 font-medium text-slate-700">{transactionSourceLabel(transaction.source)}</p>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-3">
                      <p className="text-xs text-slate-400">類型</p>
                      <div className="mt-1">
                        <Badge tone={transaction.transaction_kind === "transfer" ? "blue" : transaction.base_amount >= 0 ? "green" : "slate"}>
                          {kindLabels[transaction.transaction_kind] || transaction.transaction_kind}
                        </Badge>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs text-slate-500">分類</p>
                    <TransactionCategory transaction={transaction} categories={categories.data || []} onSaved={onCategorySaved} />
                  </div>
                  {transaction.currency !== "TWD" && (
                    <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">
                      原幣金額：{money(Math.abs(transaction.amount), transaction.currency)}
                      {transaction.fx_estimated ? " · 使用估算匯率" : ""}
                    </p>
                  )}
                  {transaction.can_correct && <Button variant="secondary" onClick={() => setCorrecting(transaction)}>{transaction.excluded ? "查看／復原" : "更正／排除"}</Button>}
                </div>
              </details>
            ))}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[680px] table-fixed">
              <colgroup>
                {batchMode && !excluded && <col className="w-12" />}
                <col />
                <col className="w-[23%]" />
                <col className="w-[17%]" />
                <col className="w-[18%]" />
                <col className="w-16" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-xs font-semibold uppercase tracking-wider text-slate-400">
                  {batchMode && !excluded && <th className="px-3 py-4">選取</th>}
                  <th className="px-5 py-4">日期與摘要</th>
                  <th className="px-4 py-4">帳戶</th>
                  <th className="px-4 py-4">分類</th>
                  <th className="px-5 py-4 text-right">金額</th>
                  <th className="px-3 py-4 text-right"><span className="sr-only">操作</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredTransactions.map((transaction) => (
                  <tr key={transaction.id} className="group hover:bg-slate-50/60">
                    {batchMode && !excluded && <td className="px-3">{transaction.can_correct && <input type="checkbox" aria-label={`選取 ${transaction.description}`} checked={selectedIds.includes(transaction.id)} onChange={() => toggleSelected(transaction.id)} />}</td>}
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <div className="min-w-0">
                          <p title={transaction.description} className="truncate text-sm font-semibold text-slate-800">{transaction.description}</p>
                          <p className="mt-1 flex flex-wrap items-center gap-x-1 text-xs text-slate-500">
                            {transaction.transaction_date} · {transactionSourceLabel(transaction.source)}
                            <span>· {kindLabels[transaction.transaction_kind] || transaction.transaction_kind}</span>
                            {transaction.fx_estimated ? " · 估算匯率" : ""}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-500"><span title={transaction.account_name} className="block truncate">{transaction.account_name}</span></td>
                    <td className="px-4 py-3">
                      <TransactionCategory transaction={transaction} categories={categories.data || []} onSaved={onCategorySaved} />
                    </td>
                    <td className={`whitespace-nowrap px-5 py-3 text-right text-sm font-semibold tabular-nums ${transaction.base_amount >= 0 ? "text-emerald-700" : "text-slate-800"}`}>
                      {transaction.base_amount >= 0 ? "+" : "−"}
                      {money(Math.abs(transaction.base_amount))}
                      {transaction.currency !== "TWD" && (
                        <div className="mt-1 text-xs font-normal text-slate-400">
                          {money(Math.abs(transaction.amount), transaction.currency)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {transaction.can_correct && <Button variant="ghost" aria-label={`${transaction.excluded ? "查看／復原" : "更正／排除"}：${transaction.description}`} className="h-9 px-1 text-xs font-medium" onClick={() => setCorrecting(transaction)}>{transaction.excluded ? "復原" : "編輯"}</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Card>

      {correcting && <TransactionCorrection transaction={correcting} onClose={() => setCorrecting(null)} onSaved={(message) => { setCorrecting(null); setClassificationMessage(message); }} />}
      <Dialog
        open={manualOpen}
        onClose={closeManualDialog}
        title="新增交易"
        description="記錄一筆收入、支出或帳戶轉帳。"
      >
        <div className="mb-4 grid grid-cols-4 gap-1 rounded-xl bg-slate-100 p-1" role="group" aria-label="交易類型">
          {(["expense", "income", "transfer", "loan_payment"] as const).map((kind) => <Button key={kind} variant="ghost" className={`px-1 text-xs ${manualScenario === kind ? "bg-white text-emerald-700 shadow-sm" : ""}`} aria-pressed={manualScenario === kind} disabled={createTransaction.isPending || createLoanPayment.isPending} onClick={() => chooseManualScenario(kind)}>{({ expense: "支出", income: "收入", transfer: "轉帳", loan_payment: "還款" })[kind]}</Button>)}
        </div>
        {manualScenario === "income" || manualScenario === "expense" ? (
          accounts.isLoading ? <p role="status">正在載入帳戶…</p> : accounts.isError ? <div role="alert">無法載入帳戶<Button onClick={() => accounts.refetch()}>重試</Button></div> : (
            <QuickTransactionForm key={`${ownerFilter}-${manualScenario}`} kind={manualScenario} accounts={accounts.data || []} categories={categories.data || []} owner={ownerFilter} pending={createTransaction.isPending} error={createTransaction.error?.message} onSubmit={submitManual} onCancel={closeManualDialog} />
          )
        ) : (
          <form className="space-y-5" onSubmit={submitManual}>
            <input type="hidden" name="transaction_kind" value={manualKind} />
            <div className="space-y-3">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={manualKind === "income" ? "入帳帳戶" : "付款帳戶"}>
                  <Select name="account_id" required>
                    <option value="">選擇帳戶</option>
                    {(manualKind === "loan_payment" ? paymentAccountOptions : accounts.data || []).map((account) => (
                      <option key={account.id} value={account.id}>{account.name}（{account.owner_label}）</option>
                    ))}
                  </Select>
                </Field>
                <Field label="日期">
                  <DateInput name="transaction_date" defaultValue={taipeiDateInputValue()} required />
                </Field>
              </div>
            </div>


            <div className="space-y-3">
              <Field label="摘要">
                <Input
                  name="description"
                  placeholder={
                    manualKind === "income"
                      ? "例如：薪水、退款"
                      : manualKind === "loan_payment"
                          ? "例如：學貸還款"
                          : "例如：午餐、房租"
                  }
                  required
                />
              </Field>
            </div>


            <div className="space-y-3">
              {manualKind === "loan_payment" ? (
              <>
                <div className="grid gap-4">
                  {accounts.isLoading ? (
                    <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">正在載入貸款帳戶…</div>
                  ) : loanAccountOptions.length > 0 ? (
                    <Field label="貸款帳戶">
                      <Select
                        name="loan_account_id"
                        value={loanAccountId}
                        onChange={(event) => setLoanAccountId(event.target.value)}
                        required
                      >
                        <option value="">選擇貸款帳戶</option>
                        {loanAccountOptions.map((account) => (
                          <option key={account.id} value={account.id}>{account.name}（{account.owner_label}）</option>
                        ))}
                      </Select>
                    </Field>
                  ) : (
                    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                      <div className="flex items-start gap-3">
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white text-amber-600">
                          <Landmark size={20} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-slate-800">目前沒有可選的貸款帳戶</p>
                          <p className="mt-1 text-xs leading-5 text-slate-500">
                            「車貸」固定花費是每月支出規則，不是貸款餘額帳戶。先建立貸款帳戶，才能分開記錄本金與利息。
                          </p>
                          <Button
                            type="button"
                            variant="secondary"
                            className="mt-3 w-full sm:w-auto"
                            onClick={() => navigate("/accounts?quick=loan")}
                          >
                            <Plus size={16} /> 建立貸款帳戶
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                {loanAccountOptions.length > 0 && (
                  <>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="本金">
                        <Input name="principal" type="number" inputMode="decimal" min="0" step="any" placeholder="0" required />
                      </Field>
                      <Field label="利息">
                        <Input name="interest" type="number" inputMode="decimal" min="0" step="any" placeholder="0" required />
                      </Field>
                    </div>
                    <p className="rounded-xl bg-slate-50 p-4 text-xs leading-5 text-slate-500">
                      系統會把本金用來降低貸款負債，利息列為支出；付款帳戶會扣除本金加利息。
                    </p>
                  </>
                )}
              </>
              ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label={
                      manualKind === "income"
                        ? "收到金額"
                        : "花費金額"
                    }
                  >
                    <Input name="amount" type="number" inputMode="decimal" min="0" step="any" placeholder="0" required />
                  </Field>
                  <Field label="幣別">
                    <Select name="currency" defaultValue="TWD">
                      {COMMON_CURRENCIES.map((currency) => (
                        <option key={currency}>{currency}</option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Field label="分類">
                  <Select name="category_id">
                    <option value="">自動分類</option>
                    {categoriesForTransactionKind(categories.data || [], manualKind).map((category) => (
                      <option key={category.id} value={category.id}>{category.name}</option>
                    ))}
                  </Select>
                </Field>
              </>
              )}
            </div>

            {manualKind !== "loan_payment" && (
              <details className="rounded-2xl border border-slate-200 px-4 py-3">
                <summary className="cursor-pointer list-none text-sm font-medium text-slate-600">其他設定（自訂匯率）</summary>
                <div className="mt-4">
                  <Field label="自訂匯率" hint="台幣或已有匯率資料時可以留空。">
                    <Input name="fx_rate" type="number" step="any" placeholder="1 單位原幣可換多少 TWD" />
                  </Field>
                </div>
              </details>
            )}

            {(createTransaction.isError || createLoanPayment.isError) && (
              <p className="text-sm text-red-600">
                {((createTransaction.error || createLoanPayment.error) as Error).message}
              </p>
            )}

            <FormActions onCancel={closeManualDialog} label={manualKind === "loan_payment" ? "儲存還款" : manualKind === "income" ? "儲存收入" : "儲存支出"} pending={createTransaction.isPending || createLoanPayment.isPending} disabled={manualKind === "loan_payment" && loanAccountOptions.length === 0} />
          </form>
        )}
      </Dialog>

      <Dialog
        open={accountTransferOpen}
        onClose={closeAccountTransferDialog}
        title="帳戶轉帳"
        description="從一個帳戶扣款、另一個帳戶入款；系統會標記為轉帳，不列入收入或支出。"
      >
        <form className="space-y-5" onSubmit={submitAccountTransfer}>

          <div className="space-y-3">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="轉出帳戶">
              <Select
                name="from_account_id"
                value={transferFromAccountId}
                onChange={(event) => setTransferFromAccountId(event.target.value)}
                required
              >
                <option value="">選擇轉出帳戶</option>
                {accounts.data?.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}（{account.owner_label}，{money(account.total_twd)}）
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="轉入帳戶">
              <Select
                name="to_account_id"
                value={transferToAccountId}
                onChange={(event) => setTransferToAccountId(event.target.value)}
                required
              >
                <option value="">選擇轉入帳戶</option>
                {accounts.data?.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}（{account.owner_label}，{money(account.total_twd)}）
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {transferFromAccountId && transferFromAccountId === transferToAccountId && (
            <p className="text-sm text-red-600">轉出與轉入帳戶不能相同。</p>
          )}
          </div>


          <div className="space-y-3">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="轉帳日期">
              <DateInput name="transfer_date" defaultValue={taipeiDateInputValue()} required />
            </Field>
            <Field label={`轉出金額${transferFromAccount ? `（${transferFromAccount.currency}）` : ""}`}>
              <Input name="amount" type="number" inputMode="decimal" min="0" step="any" placeholder="0" required />
            </Field>
          </div>
          {transferFromAccount &&
            transferToAccount &&
            transferFromAccount.currency !== transferToAccount.currency && (
              <Field
                label={`轉入金額（${transferToAccount.currency}，選填）`}
                hint="不同幣別時，不填會用目前匯率估算；實際換匯金額不同時可手動填。"
              >
              <Input name="to_amount" type="number" inputMode="decimal" min="0" step="any" placeholder="不填則自動估算" />
            </Field>
          )}
          </div>


          <FormOptions title="用途與備註（選填）">
            <Field label="說明"><Input name="description" placeholder="例如：轉到交易所" /></Field>
            <Field label="備註"><Input name="note" placeholder="選填" /></Field>
          </FormOptions>
          {createAccountTransfer.isError && (
            <p className="text-sm text-red-600">{(createAccountTransfer.error as Error).message}</p>
          )}

          <FormActions onCancel={closeAccountTransferDialog} label="建立轉帳" pending={createAccountTransfer.isPending} disabled={!transferFromAccountId || !transferToAccountId || transferFromAccountId === transferToAccountId} />
        </form>
      </Dialog>

      <Dialog
        open={importOpen}
        onClose={() => {
          setImportOpen(false);
          resetImport();
        }}
        title="匯入交易 CSV"
        description="選擇帳戶即可匯入，日期、摘要與金額會自動辨識。"
        size="lg"
      >
        {!inspection ? (
          <div>
            <label className="flex min-h-64 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50/60 p-8 text-center hover:border-emerald-400 hover:bg-emerald-50/40">
              <div className="rounded-2xl bg-white p-4 text-emerald-700 shadow-sm">
                <FileSpreadsheet size={28} />
              </div>
              <p className="mt-5 font-semibold text-slate-800">選擇銀行或信用卡 CSV</p>
              <p className="mt-2 text-sm text-slate-400">支援 UTF-8、Big5 與 CP950 編碼</p>
              <a
                href="/transaction-template.csv"
                download
                className="mt-3 text-sm font-semibold text-emerald-700 hover:underline"
                onClick={(event) => event.stopPropagation()}
              >
                下載標準 CSV 範本
              </a>
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    setCsvFile(file);
                    inspectMutation.mutate(file);
                  }
                }}
              />
            </label>
            {inspectMutation.isPending && <p className="mt-4 text-center text-sm text-slate-500">正在讀取欄位…</p>}
            {inspectMutation.isError && <p className="mt-4 text-center text-sm text-red-600">{(inspectMutation.error as Error).message}</p>}
          </div>
        ) : importResult ? (
          <div className="py-8 text-center">
            <div className="mx-auto grid size-16 place-items-center rounded-full bg-emerald-100 text-emerald-700">
              <Check size={30} />
            </div>
            <h3 className="mt-5 text-xl font-bold text-slate-800">匯入完成</h3>
            <p className="mt-2 text-sm text-slate-500">
              新增 {String(importResult.imported)} 筆，略過 {String(importResult.duplicates)} 筆重複資料。
            </p>
            {String(importResult.balance_source) === "statement" && (
              <div className="mx-auto mt-5 max-w-md rounded-2xl bg-emerald-50 px-4 py-3 text-left">
                <p className="text-sm font-semibold text-emerald-900">
                  {String(importResult.account_nature) === "liability" ? "信用卡負債已依帳單更新" : "帳戶餘額已依對帳單更新"}
                </p>
                <p className="mt-1 text-sm text-emerald-700">
                  {String(importResult.account_name)}目前為 {String(importResult.currency)} {Number(importResult.balance_after || 0).toLocaleString()}。
                </p>
              </div>
            )}
            {String(importResult.balance_source) === "transactions" && (
              <div className="mx-auto mt-5 max-w-md rounded-2xl bg-emerald-50 px-4 py-3 text-left">
                <p className="text-sm font-semibold text-emerald-900">
                  {String(importResult.account_nature) === "liability" ? "信用卡負債已同步" : "帳戶餘額已同步"}
                </p>
                <p className="mt-1 text-sm text-emerald-700">
                  已套用 {String(importResult.balance_applied_transactions)} 筆新明細，目前為 {String(importResult.currency)} {Number(importResult.balance_after || 0).toLocaleString()}。
                </p>
              </div>
            )}
            {String(importResult.balance_source) === "historical_statement" && (
              <div className="mx-auto mt-5 max-w-md rounded-2xl bg-blue-50 px-4 py-3 text-left">
                <p className="text-sm font-semibold text-blue-900">已保留這份歷史對帳單</p>
                <p className="mt-1 text-sm text-blue-700">檔案日期早於現有餘額快照，因此不會覆蓋目前帳戶餘額。</p>
              </div>
            )}
            <Button
              className="mt-6"
              onClick={() => {
                setImportOpen(false);
                resetImport();
              }}
            >
              完成
            </Button>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-700">{csvFile?.name}</p>
                <p className="mt-1 text-xs text-slate-400">{inspection.total_rows} 筆交易 · {inspection.encoding}</p>
              </div>
              <Button variant="ghost" className="shrink-0" onClick={resetImport}>更換檔案</Button>
            </div>

            <div className={`rounded-2xl border p-4 ${
              importMappingReady
                ? "border-emerald-200 bg-emerald-50/70"
                : "border-amber-200 bg-amber-50/70"
            }`}>
              <div className="flex items-start gap-3">
                <span className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-full ${
                  importMappingReady ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
                }`}>
                  <Check size={17} />
                </span>
                <div>
                  <p className={`font-semibold ${importMappingReady ? "text-emerald-900" : "text-amber-900"}`}>
                    {importMappingReady ? "欄位已自動辨識" : "有欄位無法辨識"}
                  </p>
                  <p className={`mt-1 text-sm leading-6 ${importMappingReady ? "text-emerald-700" : "text-amber-700"}`}>
                    {importMappingReady
                      ? "日期、摘要與金額都已準備完成，不需要另外設定。"
                      : "請展開下方的進階欄位設定，補上缺少的欄位。"}
                  </p>
                </div>
              </div>
            </div>

            <Field label="要匯入哪個帳戶？">
              <Select
                value={mapping.account_id || ""}
                onChange={(event) => setMapping({ ...mapping, account_id: event.target.value })}
              >
                <option value="">請選擇帳戶</option>
                {accounts.data?.map((account) => (
                  <option key={account.id} value={account.id}>{account.name}（{account.owner_label}）</option>
                ))}
              </Select>
            </Field>

            <div className="rounded-2xl border border-blue-100 bg-blue-50/70 px-4 py-3">
              <p className="text-sm font-semibold text-blue-900">
                {selectedImportAccount?.nature === "liability" ? "信用卡負債會一起更新" : "帳戶餘額會一起更新"}
              </p>
              <p className="mt-1 text-sm leading-6 text-blue-700">
                {selectedImportAccount?.nature === "liability"
                  ? "刷卡消費會增加信用卡負債，不會直接扣除銀行存款；實際繳卡費時再用帳戶互轉記錄。"
                  : "系統只套用尚未反映過的明細；同一份檔案再次匯入不會重複扣款。若 CSV 有餘額欄位，會以最新檔案餘額為準。"}
              </p>
            </div>

            <div>
              <p className="mb-2 text-sm font-semibold text-slate-700">內容預覽</p>
              <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200">
                {inspection.sample.slice(0, 3).map((row, index) => {
                  const amount = mapping.amount
                    ? row[mapping.amount]
                    : row[mapping.debit] || row[mapping.credit] || "—";
                  return (
                    <div key={index} className="flex items-center gap-3 px-4 py-3 text-sm">
                      <span className="shrink-0 text-slate-400">{row[mapping.date] || "—"}</span>
                      <span className="min-w-0 flex-1 truncate font-medium text-slate-700">
                        {row[mapping.description] || "—"}
                      </span>
                      <span className="shrink-0 font-semibold text-slate-700">{amount}</span>
                    </div>
                  );
                })}
              </div>
              {inspection.total_rows > 3 && (
                <p className="mt-2 text-center text-xs text-slate-400">另外還有 {inspection.total_rows - 3} 筆</p>
              )}
            </div>

            <details
              className="group rounded-2xl border border-slate-200 bg-white"
              open={advancedMappingOpen}
              onToggle={(event) => setAdvancedMappingOpen(event.currentTarget.open)}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium text-slate-600">
                進階欄位設定
                <ChevronDown className="transition group-open:rotate-180" size={17} />
              </summary>
              <div className="grid gap-4 border-t border-slate-100 p-4 sm:grid-cols-2">
                <MappingSelect label="日期欄位 *" value={mapping.date} columns={inspection.columns} onChange={(value) => setMapping({ ...mapping, date: value })} />
                <MappingSelect label="摘要欄位 *" value={mapping.description} columns={inspection.columns} onChange={(value) => setMapping({ ...mapping, description: value })} />
                <MappingSelect label="單一金額欄位" value={mapping.amount} columns={inspection.columns} onChange={(value) => setMapping({ ...mapping, amount: value })} />
                <MappingSelect label="支出／借方欄位" value={mapping.debit} columns={inspection.columns} onChange={(value) => setMapping({ ...mapping, debit: value })} />
                <MappingSelect label="收入／貸方欄位" value={mapping.credit} columns={inspection.columns} onChange={(value) => setMapping({ ...mapping, credit: value })} />
                <MappingSelect label="幣別欄位" value={mapping.currency} columns={inspection.columns} onChange={(value) => setMapping({ ...mapping, currency: value })} />
                <MappingSelect label="餘額欄位" value={mapping.balance} columns={inspection.columns} onChange={(value) => setMapping({ ...mapping, balance: value })} />
              </div>
            </details>
            {importMutation.isError && <p className="text-sm text-red-600">{(importMutation.error as Error).message}</p>}
            <div className="flex justify-end">
              <Button
                onClick={() => importMutation.mutate()}
                disabled={!mapping.account_id || !importMappingReady || importMutation.isPending}
              >
                {importMutation.isPending ? "匯入中…" : `匯入 ${inspection.total_rows} 筆資料`}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog open={transferOpen} onClose={() => setTransferOpen(false)} title="帳戶間轉帳建議" description="相隔三天內、換算金額相反的不同帳戶交易。配對後不列入收支。" size="lg">
        {!suggestions.data?.length ? (
          <EmptyState icon={<Link2 size={24} />} title="目前沒有轉帳建議" description="系統找不到可自動配對的交易，你仍可以在交易類型中手動標記轉帳。" />
        ) : (
          <div className="space-y-3">
            {suggestions.data.map((suggestion) => (
              <div key={`${suggestion.from.id}-${suggestion.to.id}`} className="rounded-2xl border border-slate-200 p-4">
                <div className="grid items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
                  {[suggestion.from, suggestion.to].map((item, index) => (
                    <div key={item.id} className={index ? "sm:text-right" : ""}>
                      <p className="text-sm font-semibold text-slate-800">{item.account}</p>
                      <p className="mt-1 text-xs text-slate-400">{item.date} · {item.description}</p>
                      <p className={`mt-2 text-sm font-bold ${item.amount >= 0 ? "text-emerald-700" : "text-slate-700"}`}>{money(item.amount)}</p>
                    </div>
                  )).reduce((result: React.ReactNode[], item, index) => {
                    if (index) result.push(<ArrowRightLeft key="arrow" className="mx-auto text-slate-300" size={20} />);
                    result.push(item);
                    return result;
                  }, [])}
                </div>
                <div className="mt-4 flex justify-end">
                  <Button variant="secondary" onClick={() => confirmTransfer.mutate(suggestion)} disabled={confirmTransfer.isPending}>
                    <Check size={15} /> 確認為轉帳
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Dialog>
    </>
  );
}

function MappingSelect({
  label,
  value,
  columns,
  onChange,
}: {
  label: string;
  value?: string;
  columns: string[];
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <Select value={value || ""} onChange={(event) => onChange(event.target.value)}>
        <option value="">不使用</option>
        {columns.map((column) => <option key={column}>{column}</option>)}
      </Select>
    </Field>
  );
}
