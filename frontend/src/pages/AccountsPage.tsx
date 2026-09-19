import { FormEvent, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  Banknote,
  Bitcoin,
  Building2,
  ChevronDown,
  CreditCard,
  Landmark,
  Plus,
  RefreshCw,
  Smartphone,
  Trash2,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { api } from "../api";
import CreditCardCycles, { type Cycle } from "../CreditCardCycles";
import { invalidateFinanceData } from "../appQueries";
import { COMMON_CURRENCIES } from "../currencies";
import { daysBetweenDateValues, taipeiDateInputValue } from "../date";
import { useOwnerFilter } from "../ownerFilter";
import type { Account } from "../types";
import {
  Badge,
  Button,
  Card,
  DateInput,
  Dialog,
  EmptyState,
  Field,
  FormContext,
  FormOptions,
  FormActions,
  FormStep,
  Input,
  PageHeader,
  Select,
  money,
} from "../ui";

const accountTypes = [
  { value: "bank", label: "銀行帳戶", icon: Building2 },
  { value: "cash", label: "現金", icon: Banknote },
  { value: "ewallet", label: "電子支付", icon: Smartphone },
  { value: "brokerage", label: "證券帳戶", icon: TrendingUp },
  { value: "crypto", label: "加密貨幣交易所", icon: Bitcoin },
  { value: "credit_card", label: "信用卡", icon: CreditCard },
  { value: "loan", label: "貸款", icon: Landmark },
  { value: "other", label: "其他", icon: Wallet },
];

const ownerOptions = [
  { value: "all", label: "全部" },
  { value: "me", label: "我" },
  { value: "partner", label: "小居" },
];
const accountOwnerOptions = ownerOptions.filter((option) => option.value !== "all");
const customInstitutionValue = "__custom__";
const customAccountNameValue = "__custom_account_name__";

function AccountNamePicker({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const choices = [
    { value: "", label: "選擇名稱" },
    ...options.map((option) => ({ value: option, label: option })),
    { value: customAccountNameValue, label: "其他 / 自訂" },
  ];
  const selected = choices.find((choice) => choice.value === value);

  useEffect(() => {
    if (!open) return;
    const closeWhenOutside = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeWhenOutside);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("mousedown", closeWhenOutside);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        className="flex h-11 w-full items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 text-left text-sm text-slate-800 outline-none transition hover:border-slate-300 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="帳戶名稱"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className={!selected?.value ? "text-slate-400" : undefined}>{selected?.label || "選擇名稱"}</span>
        <ChevronDown size={17} aria-hidden="true" className={`shrink-0 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="帳戶名稱選項"
          className="absolute inset-x-0 top-full z-30 mt-2 max-h-64 overflow-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl shadow-slate-900/10"
        >
          {choices.map((choice) => {
            const isSelected = choice.value === value;
            return (
              <button
                key={choice.value || "empty"}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm transition ${
                  isSelected
                    ? "bg-emerald-50 font-semibold text-emerald-800"
                    : "text-slate-700 hover:bg-slate-50"
                }`}
                onClick={() => {
                  onChange(choice.value);
                  setOpen(false);
                }}
              >
                <span>{choice.label}</span>
                {isSelected && <span aria-hidden="true" className="text-emerald-600">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const institutionPresets: Record<string, string[]> = {
  bank: [
    "國泰世華銀行",
    "中國信託銀行",
    "台新銀行",
    "玉山銀行",
    "台北富邦銀行",
    "兆豐銀行",
    "第一銀行",
    "合作金庫",
    "華南銀行",
    "彰化銀行",
    "臺灣銀行",
    "土地銀行",
    "中華郵政",
    "永豐銀行",
    "聯邦銀行",
    "新光銀行",
    "上海商銀",
    "LINE Bank",
    "將來銀行",
    "樂天銀行",
  ],
  ewallet: ["LINE Pay Money", "街口支付", "全支付", "悠遊付", "一卡通 MONEY", "icash Pay", "Pi 拍錢包"],
  brokerage: [
    "國泰證券",
    "富邦證券",
    "元大證券",
    "永豐金證券",
    "凱基證券",
    "玉山證券",
    "群益金鼎證券",
    "統一證券",
    "Firstrade",
    "Interactive Brokers",
    "Charles Schwab",
    "富途牛牛",
  ],
  crypto: ["Binance", "MAX", "MaiCoin", "OKX", "Bybit", "Coinbase", "Kraken"],
  credit_card: [
    "國泰世華銀行",
    "中國信託銀行",
    "台新銀行",
    "玉山銀行",
    "台北富邦銀行",
    "永豐銀行",
    "聯邦銀行",
    "花旗銀行",
    "滙豐銀行",
    "American Express",
  ],
  loan: ["臺灣銀行", "土地銀行", "合作金庫", "中國信託銀行", "國泰世華銀行", "台北富邦銀行", "勞保局", "學貸"],
  cash: ["現金", "皮夾", "家中現金"],
  other: ["其他資產", "保險", "貴金屬", "收藏品"],
};

const institutionsFor = (type: string) => institutionPresets[type] || institutionPresets.other;

function defaultAccountName(type: string, institution: string) {
  if (type === "bank") return institution ? `${institution} 薪轉帳戶` : "薪轉帳戶";
  if (type === "cash") return institution && institution !== "現金" ? institution : "皮夾現金";
  if (type === "ewallet") return institution ? `${institution} 錢包` : "電子支付錢包";
  if (type === "brokerage") return institution ? `${institution} 證券戶` : "台股證券戶";
  if (type === "crypto") return institution ? `${institution} 交易所` : "加密貨幣交易所";
  if (type === "credit_card") return institution ? `${institution} 信用卡` : "信用卡";
  if (type === "loan") return institution ? `${institution} 貸款` : "貸款";
  return institution || "其他資產";
}

function accountNameSuggestions(type: string, institution: string) {
  const prefix = institution ? `${institution} ` : "";
  const suggestions: Record<string, string[]> = {
    bank: [`${prefix}薪轉帳戶`, `${prefix}活存帳戶`, `${prefix}儲蓄帳戶`, `${prefix}外幣帳戶`, "生活費帳戶"],
    cash: ["皮夾現金", "家中現金", "零用金"],
    ewallet: [`${prefix}錢包`, `${prefix}電子支付`, "日常支付錢包"],
    brokerage: [`${prefix}證券戶`, "台股證券戶", "美股證券戶", "複委託帳戶"],
    crypto: [`${prefix}交易所`, `${prefix}錢包`, "冷錢包"],
    credit_card: [`${prefix}信用卡`, "主力信用卡", "網購信用卡"],
    loan: [`${prefix}貸款`, "學貸", "信貸", "房貸", "車貸"],
    other: [`${prefix}資產`, "保險價值", "其他資產"],
  };

  return Array.from(new Set((suggestions[type] || suggestions.other).filter(Boolean)));
}

const iconFor = (type: string) =>
  accountTypes.find((item) => item.value === type)?.icon || Wallet;
const labelFor = (type: string) =>
  accountTypes.find((item) => item.value === type)?.label || type;

export default function AccountsPage() {
  const client = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const [balancePickerOpen, setBalancePickerOpen] = useState(false);
  const [balanceAccount, setBalanceAccount] = useState<Account | null>(null);
  const [detailAccount, setDetailAccount] = useState<Account | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Account | null>(null);
  const [message, setMessage] = useState("");
  const [ownerFilter] = useOwnerFilter();
  const [accountType, setAccountType] = useState("bank");
  const [nature, setNature] = useState("asset");
  const [institutionChoice, setInstitutionChoice] = useState("");
  const [customInstitution, setCustomInstitution] = useState("");
  const [accountName, setAccountName] = useState("");
  const [useCustomAccountName, setUseCustomAccountName] = useState(false);

  useEffect(() => {
    const quickAction = searchParams.get("quick");
    if (quickAction === "balance") {
      setBalancePickerOpen(true);
    } else if (quickAction === "create") {
      setCreateOpen(true);
    } else if (quickAction === "loan") {
      setAccountType("loan");
      setNature("liability");
      setInstitutionChoice("");
      setCustomInstitution("");
      setAccountName("貸款");
      setUseCustomAccountName(false);
      setCreateOpen(true);
    } else {
      return;
    }
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("quick");
    setSearchParams(nextParams, { replace: true });
  }, [searchParams, setSearchParams]);

  const selectedInstitution =
    institutionChoice === customInstitutionValue ? customInstitution.trim() : institutionChoice;
  const institutionOptions = institutionsFor(accountType);
  const nameOptions = accountNameSuggestions(accountType, selectedInstitution);
  const showCustomAccountName =
    useCustomAccountName || Boolean(accountName.trim() && !nameOptions.includes(accountName.trim()));
  const accountNameSelectValue = showCustomAccountName ? customAccountNameValue : accountName;

  function resetAccountDraft() {
    setAccountType("bank");
    setNature("asset");
    setInstitutionChoice("");
    setCustomInstitution("");
    setAccountName("");
    setUseCustomAccountName(false);
  }

  function openCreateDialog() {
    resetAccountDraft();
    setCreateOpen(true);
  }

  function closeCreateDialog() {
    setCreateOpen(false);
  }

  function shouldReplaceDraftName() {
    return !accountName.trim() || (!showCustomAccountName && nameOptions.includes(accountName.trim()));
  }

  function changeAccountType(nextType: string) {
    const canAutoReplaceName = shouldReplaceDraftName();
    setAccountType(nextType);
    setNature(nextType === "credit_card" || nextType === "loan" ? "liability" : "asset");
    // Preserve an institution already entered; banks can offer both deposits and cards.
    if (selectedInstitution && !institutionsFor(nextType).includes(selectedInstitution)) {
      setInstitutionChoice(customInstitutionValue);
      setCustomInstitution(selectedInstitution);
    }
    if (canAutoReplaceName) {
      setAccountName(defaultAccountName(nextType, selectedInstitution));
      setUseCustomAccountName(false);
    }
  }

  function changeInstitutionChoice(nextInstitution: string) {
    const canAutoReplaceName = shouldReplaceDraftName();
    setInstitutionChoice(nextInstitution);
    if (nextInstitution !== customInstitutionValue) {
      setCustomInstitution("");
      if (canAutoReplaceName) {
        setAccountName(defaultAccountName(accountType, nextInstitution));
        setUseCustomAccountName(false);
      }
    }
  }

  function changeCustomInstitution(nextInstitution: string) {
    const canAutoReplaceName = shouldReplaceDraftName();
    setCustomInstitution(nextInstitution);
    if (canAutoReplaceName) {
      setAccountName(defaultAccountName(accountType, nextInstitution));
      setUseCustomAccountName(false);
    }
  }

  function changeAccountNameChoice(nextName: string) {
    if (nextName === customAccountNameValue) {
      setUseCustomAccountName(true);
      if (!showCustomAccountName) {
        setAccountName("");
      }
      return;
    }

    setUseCustomAccountName(false);
    setAccountName(nextName);
  }

  const accounts = useQuery({
    queryKey: ["accounts", ownerFilter, "including-archived"],
    queryFn: () => api<Account[]>(`/accounts?owner=${ownerFilter}&include_archived=true`),
  });

  const createAccount = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api<Account>("/accounts", { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => {
      invalidateFinanceData(client, ["accounts","dashboard"]);
      setCreateOpen(false);
      resetAccountDraft();
      setMessage("帳戶已建立。");
    },
  });

  const addBalance = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: Record<string, unknown> }) =>
      api(`/accounts/${id}/balance`, { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => {
      invalidateFinanceData(client, ["accounts","dashboard"]);
      setBalanceAccount(null);
      setMessage("帳戶餘額已更新。");
    },
  });

  const deleteAccount = useMutation({
    mutationFn: (id: number) => api(`/accounts/${id}/archive`, { method: "POST" }),
    onSuccess: () => {
      invalidateFinanceData(client, ["accounts","dashboard"]);
      setArchiveTarget(null);
      setMessage("帳戶已封存，歷史資料保留；可隨時從下方恢復。");
    },
  });

  const restoreAccount = useMutation({
    mutationFn: (id: number) => api(`/accounts/${id}/restore`, { method: "POST" }),
    onSuccess: () => {
      setMessage("帳戶已恢復，重新列入總資產；原本啟用的同步會繼續運作。");
      return invalidateFinanceData(client, ["email-card-rules", "gmail-status"]);
    },
  });

  const calibrateAutoEstimate = useMutation({
    mutationFn: (id: number) => api<Account>(`/accounts/${id}/auto-estimate`, { method: "POST" }),
    onSuccess: (account) => {
      invalidateFinanceData(client, ["accounts","dashboard"]);
      setDetailAccount(account);
      setMessage("已啟用並校準自動估算總資產。");
    },
  });

  function submitAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    createAccount.mutate({
      name: accountName.trim() || defaultAccountName(accountType, selectedInstitution),
      institution: selectedInstitution || null,
      account_type: accountType,
      nature,
      currency: form.get("currency"),
      owner: form.get("owner"),
      is_liquid: form.get("is_liquid") === "on",
      balance_includes_positions: form.get("balance_includes_positions") === "on",
      opening_balance: form.get("opening_balance") ? Number(form.get("opening_balance")) : null,
      opening_date: form.get("opening_date") || null,
      note: form.get("note") || null,
    });
  }

  function submitBalance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!balanceAccount) return;
    const form = new FormData(event.currentTarget);
    addBalance.mutate({
      id: balanceAccount.id,
      payload: {
        amount: Number(form.get("amount")),
        snapshot_date: form.get("snapshot_date"),
        fx_rate: form.get("fx_rate") ? Number(form.get("fx_rate")) : null,
      },
    });
  }

  const visibleAccounts = accounts.data?.filter((item) => !item.archived) || [];
  const assetAccounts = visibleAccounts.filter((item) => item.nature === "asset");
  const liabilityAccounts = visibleAccounts.filter((item) => item.nature === "liability");
  const archivedAccounts = (accounts.data || []).filter((item) => item.archived);
  const cardCycles = useQuery({
    queryKey: ["credit-card-cycles"],
    queryFn: () => api<Cycle[]>("/email/card-cycles"),
    enabled: visibleAccounts.some((account) => account.account_type === "credit_card"),
  });

  return (
    <>
      <PageHeader
        eyebrow="Accounts"
        title="帳戶與餘額"
        description="查看銀行、投資與信用卡餘額，也可以更新或恢復已封存帳戶。"
        action={
          <div className="flex flex-wrap gap-2">
            <Button onClick={openCreateDialog}>
            <Plus size={17} /> 新增帳戶
            </Button>
          </div>
        }
      />

      {message && (
        <div className="mb-5 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {message}
          <button onClick={() => setMessage("")}>×</button>
        </div>
      )}

      {accounts.isError && (
        <Card className="mb-5">
          <EmptyState icon={<RefreshCw size={24} />} title="帳戶資料暫時無法更新" description="原有帳戶不會因此消失，請重試。" action={<Button onClick={() => accounts.refetch()}>重新載入</Button>} />
        </Card>
      )}
      {accounts.isLoading ? (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3].map((item) => (
            <div key={item} className="h-64 animate-pulse rounded-2xl bg-slate-200/70" />
          ))}
        </div>
      ) : !accounts.data ? null : !visibleAccounts.length ? (
        <Card>
          <EmptyState
            icon={<Building2 size={26} />}
            title="尚未建立任何帳戶"
            description="建議先加入常用銀行帳戶，再加入信用卡、證券或加密貨幣帳戶。"
            action={<Button onClick={openCreateDialog}>新增第一個帳戶</Button>}
          />
        </Card>
      ) : (
        <div className="space-y-8">
          <AccountGroup
            title="資產帳戶"
            subtitle={`${assetAccounts.length} 個帳戶`}
            accounts={assetAccounts}
            onBalance={setBalanceAccount}
            onDetail={setDetailAccount}
            onDelete={setArchiveTarget}
          />
          {liabilityAccounts.length > 0 && (
            <AccountGroup
              title="負債帳戶"
              subtitle={`${liabilityAccounts.length} 個帳戶`}
              accounts={liabilityAccounts}
              cardCycles={cardCycles.data}
              onBalance={setBalanceAccount}
              onDetail={setDetailAccount}
              onDelete={setArchiveTarget}
            />
          )}
        </div>
      )}

      <CreditCardCycles accountIds={visibleAccounts.filter((item) => item.account_type === "credit_card").map((item) => item.id)} />
      {archivedAccounts.length > 0 && (
        <details className="group mt-6 rounded-xl border border-slate-200 bg-white">
          <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl px-4 py-3.5 text-slate-600 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-sm font-semibold">
                已封存帳戶
                <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-xs font-medium tabular-nums text-slate-500">{archivedAccounts.length}</span>
              </span>
              <span className="mt-1 block text-xs font-normal leading-5 text-slate-500">不列入總資產，歷史交易保留；展開可恢復。</span>
            </span>
            <ChevronDown size={17} aria-hidden="true" className="shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
          </summary>
          <ul className="divide-y divide-slate-100 border-t border-slate-100 px-4">
            {archivedAccounts.map((account) => (
              <li key={account.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium text-slate-700">{account.name}</p>
                  <p className="mt-1 text-xs tabular-nums text-slate-500">{account.owner_label} · {account.currency} {account.balance.toLocaleString()}</p>
                  {!!account.linked_email_rules?.length && <p className="mt-1 text-xs text-amber-700">信用卡同步已暫停</p>}
                </div>
                <Button variant="ghost" className="shrink-0 px-3 text-emerald-700 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600" aria-label={`恢復${account.name}`} disabled={restoreAccount.isPending} onClick={() => restoreAccount.mutate(account.id)}>
                  {restoreAccount.isPending && restoreAccount.variables === account.id ? "恢復中…" : "恢復"}
                </Button>
              </li>
            ))}
          </ul>
          {restoreAccount.isError && <p role="alert" className="px-4 pb-3 text-sm text-red-600">恢復失敗：{restoreAccount.error.message}</p>}
        </details>
      )}

      <Dialog open={Boolean(archiveTarget)} onClose={() => { if (!deleteAccount.isPending) setArchiveTarget(null); }} title="封存帳戶" description="不刪除歷史交易，可以隨時恢復。">
        {archiveTarget && <div className="space-y-4">
          <p>「{archiveTarget.name}」封存後，餘額不再列入總資產，且不能新增交易。</p>
          {!!archiveTarget.linked_email_rules?.length && <div className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">下列信用卡的郵件同步與繳款記帳將暫停：{archiveTarget.linked_email_rules.join("、")}。恢復帳戶後繼續。</div>}
          {archiveTarget.account_type === "crypto" && <p className="text-sm text-amber-700">交易所自動同步也會暫停。</p>}
          {deleteAccount.isError && <p role="alert" className="text-sm text-red-600">{deleteAccount.error.message}</p>}
          <div className="flex justify-end gap-3"><Button variant="ghost" disabled={deleteAccount.isPending} onClick={() => setArchiveTarget(null)}>取消</Button><Button disabled={deleteAccount.isPending} onClick={() => deleteAccount.mutate(archiveTarget.id)}>{deleteAccount.isPending ? "封存中…" : "確認封存"}</Button></div>
        </div>}
      </Dialog>

      <Dialog
        open={createOpen}
        onClose={closeCreateDialog}
        title="新增帳戶"
        description="帳戶餘額和交易明細分開記錄。"
        size="lg"
      >
        <form className="space-y-4" onSubmit={submitAccount}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="帳戶類型">
              <Select name="account_type" value={accountType} onChange={(event) => changeAccountType(event.target.value)}>
                {accountTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </Select>
            </Field>
            <Field label="金融機構">
              <Select value={institutionChoice} onChange={(event) => changeInstitutionChoice(event.target.value)}>
                <option value="">不指定</option>
                {institutionOptions.map((institution) => <option key={institution}>{institution}</option>)}
                <option value={customInstitutionValue}>其他 / 自訂</option>
              </Select>
            </Field>
          </div>
          {institutionChoice === customInstitutionValue && <Field label="自訂金融機構"><Input value={customInstitution} onChange={(event) => changeCustomInstitution(event.target.value)} placeholder="銀行、券商或交易所" /></Field>}
          <Field label="帳戶名稱">
            <AccountNamePicker value={accountNameSelectValue} options={nameOptions} onChange={changeAccountNameChoice} />
            {showCustomAccountName && <Input name="name" value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder="輸入帳戶名稱" required />}
          </Field>
          <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
            <Field label={nature === "liability" ? "目前負債" : "目前餘額"}><Input name="opening_balance" type="number" inputMode="decimal" step="any" placeholder="選填" /></Field>
            <Field label="幣別"><Select name="currency" defaultValue="TWD">{COMMON_CURRENCIES.map((currency) => <option key={currency}>{currency}</option>)}</Select></Field>
          </div>
          {["brokerage", "crypto"].includes(accountType) && <label className="flex items-start gap-2 text-sm text-slate-600">
            <input name="balance_includes_positions" type="checkbox" className="mt-1 accent-emerald-600" defaultChecked />
            <span>餘額已包含投資持倉<span className="mt-1 block text-xs text-slate-500">輸入券商或交易所總資產時勾選，避免重複計算。</span></span>
          </label>}
          <FormOptions title="其他設定（日期、所有人、資產性質）">
            <div className="grid grid-cols-2 gap-3">
              <Field label="餘額日期"><DateInput name="opening_date" defaultValue={taipeiDateInputValue()} /></Field>
              <Field label="所有人"><Select name="owner" defaultValue={ownerFilter === "all" ? "me" : ownerFilter}>{accountOwnerOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></Field>
            </div>
            <Field label="帳戶性質"><Select name="nature" value={nature} onChange={(event) => setNature(event.target.value)}><option value="asset">資產</option><option value="liability">負債</option></Select></Field>
            <label className="flex items-center gap-2 text-sm text-slate-600"><input name="is_liquid" type="checkbox" className="accent-emerald-600" />列入流動資產（可立即使用的現金或存款）</label>
          </FormOptions>
          {createAccount.isError && <p role="alert" className="text-sm text-red-600">{createAccount.error.message}</p>}
          <FormActions onCancel={closeCreateDialog} pending={createAccount.isPending} label="建立帳戶" />
        </form>
      </Dialog>

      <Dialog
        open={balancePickerOpen}
        onClose={() => setBalancePickerOpen(false)}
        title="更新帳戶餘額"
        description="先選擇要更新的帳戶，再輸入現在看到的實際餘額。"
      >
        <div className="space-y-2">
          {visibleAccounts.length ? (
            visibleAccounts.map((account) => {
              const Icon = iconFor(account.account_type);
              return (
                <button
                  key={account.id}
                  type="button"
                  className="flex w-full items-center gap-3 rounded-2xl border border-slate-200 p-3 text-left transition hover:border-emerald-300 hover:bg-emerald-50/40"
                  onClick={() => {
                    setBalancePickerOpen(false);
                    setBalanceAccount(account);
                  }}
                >
                  <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-700">
                    <Icon size={19} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-slate-800">{account.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-slate-400">
                      {account.institution || labelFor(account.account_type)} · {account.owner_label}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold text-slate-700">
                    {account.currency} {Number(account.balance || 0).toLocaleString()}
                  </span>
                </button>
              );
            })
          ) : (
            <EmptyState
              icon={<Wallet size={22} />}
              title="目前沒有可更新的帳戶"
              description="請先建立帳戶，再新增餘額紀錄。"
              action={<Button onClick={() => { setBalancePickerOpen(false); openCreateDialog(); }}>新增帳戶</Button>}
            />
          )}
        </div>
      </Dialog>

      <Dialog
        open={Boolean(balanceAccount)}
        onClose={() => setBalanceAccount(null)}
        title={`更新${balanceAccount?.name || ""}餘額`}
        description="這會建立一筆新的餘額紀錄，不會改動舊資料。"
      >
        <form className="space-y-5" onSubmit={submitBalance}>
          <FormContext value={balanceAccount?.name || "更新帳戶餘額"} />
          <FormStep number={1} title="現在的帳戶餘額是多少？">
            <Field label={`餘額（${balanceAccount?.currency || ""}）`}>
              <Input name="amount" type="number" step="any" defaultValue={balanceAccount?.balance} required autoFocus />
            </Field>
          </FormStep>
          <FormStep number={2} title="這筆餘額是哪一天的？" tone="blue">
            <Field label="餘額日期">
              <DateInput name="snapshot_date" defaultValue={taipeiDateInputValue()} required />
            </Field>
          </FormStep>
          {balanceAccount?.currency !== "TWD" && (
            <details className="rounded-2xl border border-slate-200 px-4 py-3">
              <summary className="cursor-pointer list-none text-sm font-medium text-slate-600">其他設定（自訂匯率）</summary>
              <div className="mt-4">
                <Field label="自訂換算匯率" hint="留空時使用系統中最近的匯率。">
                  <Input name="fx_rate" type="number" step="any" placeholder="1 單位外幣可換多少 TWD" />
                </Field>
              </div>
            </details>
          )}
          {addBalance.isError && (
            <p className="text-sm text-red-600">{(addBalance.error as Error).message}</p>
          )}
          <div className="flex justify-end gap-3">
            <Button type="button" variant="ghost" onClick={() => setBalanceAccount(null)}>
              取消
            </Button>
            <Button type="submit" disabled={addBalance.isPending}>
              {addBalance.isPending ? "儲存中…" : "儲存餘額"}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={Boolean(detailAccount)}
        onClose={() => setDetailAccount(null)}
        title={`${detailAccount?.name || ""}明細`}
        description="此處顯示帳戶總資產的組成方式。"
      >
        {detailAccount && (
          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
              <p className="text-xs font-medium text-slate-400">帳戶總價值</p>
              <p className="mt-1 text-2xl font-bold text-ink">{money(Math.abs(detailAccount.total_twd))}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-slate-100 p-4">
                <p className="text-xs font-medium text-slate-400">
                  {detailAccount.valuation_mode === "auto_estimate" ? "非持倉估算餘額" : "餘額紀錄"}
                </p>
                <p className="mt-1 text-lg font-bold text-slate-800">
                  {money(
                    detailAccount.valuation_mode === "auto_estimate"
                      ? detailAccount.auto_balance_base_twd || 0
                      : detailAccount.balance_twd,
                  )}
                </p>
                <p className="mt-1 text-xs text-slate-400">{detailAccount.balance_date || "尚未記錄餘額"}</p>
              </div>
              <div className="rounded-2xl border border-slate-100 p-4">
                <p className="text-xs font-medium text-slate-400">投資持倉明細</p>
                <p className="mt-1 text-lg font-bold text-slate-800">{money(detailAccount.investments_twd)}</p>
                <p className="mt-1 text-xs text-slate-400">{detailAccount.positions_count} 筆持倉</p>
              </div>
            </div>
            <div className="rounded-2xl bg-emerald-50 p-4 text-sm leading-6 text-emerald-800">
              {detailAccount.valuation_mode === "auto_estimate"
                ? "此帳戶使用「自動估算總資產」：總資產 = 非持倉估算餘額 + 最新持倉市值。之後持倉行情變動會反映到帳戶總值。"
                : detailAccount.valuation_mode === "manual_total"
                  ? "此帳戶使用「手動總資產」：總資產只採用餘額紀錄，持倉明細不會重複加總。"
                  : "此帳戶使用「餘額 + 持倉」：總資產會由餘額紀錄加上持倉市值。"}
            </div>
            {detailAccount.positions_count > 0 && (
              <div className="flex flex-col gap-2 rounded-2xl border border-slate-100 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-slate-800">自動估算總資產</p>
                  <p className="mt-1 text-xs leading-5 text-slate-400">
                    用目前總資產校準一次，之後按「更新行情」時，帳戶總值會跟著持倉市值變動。
                  </p>
                </div>
                <Button
                  type="button"
                  className="shrink-0"
                  onClick={() => calibrateAutoEstimate.mutate(detailAccount.id)}
                  disabled={calibrateAutoEstimate.isPending}
                >
                  {detailAccount.valuation_mode === "auto_estimate" ? "重新校準" : "啟用"}
                </Button>
              </div>
            )}
            {calibrateAutoEstimate.isError && (
              <p className="text-sm text-red-600">{(calibrateAutoEstimate.error as Error).message}</p>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}

function AccountGroup({
  title,
  subtitle,
  accounts,
  onBalance,
  onDetail,
  onDelete,
  cardCycles = [],
}: {
  title: string;
  subtitle: string;
  accounts: Account[];
  onBalance: (account: Account) => void;
  onDetail: (account: Account) => void;
  onDelete: (account: Account) => void;
  cardCycles?: Cycle[];
}) {
  return (
    <section>
      <div className="mb-4 flex items-center gap-3">
        <h2 className="text-lg font-bold text-ink">{title}</h2>
        <Badge>{subtitle}</Badge>
      </div>
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {accounts.map((account) => {
          const Icon = iconFor(account.account_type);
          const isCreditCard = account.account_type === "credit_card";
          const cycle = cardCycles.find((item) => item.card_account_id === account.id);
          const staleDays = daysBetweenDateValues(account.balance_date);
          const snapshotIsStale = staleDays !== null && staleDays >= 7;
          return (
            <Card key={account.id} className="overflow-hidden">
              <div className="p-5">
                <div className="flex items-start gap-4">
                  <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-emerald-50 text-emerald-700">
                    <Icon size={21} />
                  </div>
                  <div className="min-w-0">
                    <h3 className="truncate font-bold text-slate-800">{account.name}</h3>
                    <p className="mt-1 truncate text-xs text-slate-400">
                      {account.institution || labelFor(account.account_type)}
                    </p>
                  </div>
                  <div className="ml-auto flex shrink-0 flex-col items-end gap-1">
                    <Badge>{account.owner_label}</Badge>
                    <Badge tone={account.nature === "asset" ? "green" : "red"}>
                      {account.currency}
                    </Badge>
                  </div>
                </div>
                <div className="mt-7">
                  <p className="text-xs font-medium text-slate-400">
                    {account.nature === "asset" ? "帳戶總價值" : isCreditCard ? "未償還負債" : "目前負債"}
                  </p>
                  <p className={`mt-1 text-2xl font-bold ${account.nature === "liability" ? "text-red-600" : "text-ink"}`}>
                    {money(Math.abs(account.total_twd))}
                  </p>
                </div>
                {isCreditCard && <div className="mt-3 space-y-1 text-xs text-slate-500">
                  {cycle && <p>{cycle.closing_day ? `每月 ${cycle.closing_day} 日結帳 · ` : "結帳日尚未設定 · "}每月 {cycle.payment_due_day} 日繳款</p>}
                  {cycle?.current_cycle && <p>本帳期匯入消費 {money(cycle.current_cycle.amount, cycle.currency)}<span className="mt-1 block">{cycle.current_cycle.period_start}～{cycle.current_cycle.period_end}</span></p>}
                  <p>負債依消費與繳款記錄更新，不會在結帳日自動歸零。</p>
                  <a href="#card-cycles" className="inline-block py-1 font-medium text-emerald-700">查看帳單與繳款紀錄 →</a>
                </div>}
                <div className="mt-6 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
                  <span>{isCreditCard ? "資料更新" : "餘額更新"} {account.balance_date || "尚未建立"}</span>
                  <div className="flex flex-wrap items-center gap-2">
                    {!account.balance_date && <Badge tone="amber">尚未更新</Badge>}
                    {snapshotIsStale && <Badge tone="amber">{staleDays} 天未更新</Badge>}
                    {account.is_liquid && <Badge tone="blue">流動資產</Badge>}
                  </div>
                </div>
              </div>
              <div className="flex border-t border-slate-100 bg-slate-50/60 p-2">
                <Button variant="ghost" className="flex-1" onClick={() => onBalance(account)}>
                  <RefreshCw size={15} /> 更新餘額
                </Button>
                {account.positions_count > 0 && (
                  <Button variant="ghost" className="px-3" onClick={() => onDetail(account)}>
                    明細
                  </Button>
                )}
                <Button
                  variant="ghost"
                  className="px-3 text-slate-400 hover:bg-red-50 hover:text-red-600"
                  onClick={() => onDelete(account)}
                  title="封存帳戶"
                  aria-label={`封存${account.name}`}
                >
                  <Trash2 size={15} />
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
