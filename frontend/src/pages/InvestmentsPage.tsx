import { FormEvent, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bitcoin,
  ChevronDown,
  Clock3,
  LineChart,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { api } from "../api";
import { taipeiDateInputValue } from "../date";
import { useOwnerFilter } from "../ownerFilter";
import type { Account, Position } from "../types";
import {
  Badge,
  Button,
  Card,
  DateInput,
  Dialog,
  EmptyState,
  Field,
  FormContext,
  FormStep,
  Input,
  MobileWizardActions,
  MobileWizardProgress,
  MobileWizardStep,
  PageHeader,
  Select,
  money,
  number,
  validateWizardStep,
} from "../ui";

const markets = [
  { value: "TWSE", label: "台灣上市", currency: "TWD" },
  { value: "TPEX", label: "台灣上櫃", currency: "TWD" },
  { value: "US", label: "美股", currency: "USD" },
  { value: "CRYPTO", label: "加密貨幣", currency: "USD" },
];

const customAssetValue = "__custom_asset__";

type AssetPreset = {
  symbol: string;
  name: string;
  currency: string;
};

const assetPresets: Record<string, AssetPreset[]> = {
  TWSE: [
    { symbol: "0050", name: "元大台灣50", currency: "TWD" },
    { symbol: "0056", name: "元大高股息", currency: "TWD" },
    { symbol: "00878", name: "國泰永續高股息", currency: "TWD" },
    { symbol: "00919", name: "群益台灣精選高息", currency: "TWD" },
    { symbol: "2330", name: "台積電", currency: "TWD" },
    { symbol: "2317", name: "鴻海", currency: "TWD" },
    { symbol: "2454", name: "聯發科", currency: "TWD" },
    { symbol: "2303", name: "聯電", currency: "TWD" },
    { symbol: "2881", name: "富邦金", currency: "TWD" },
    { symbol: "2882", name: "國泰金", currency: "TWD" },
    { symbol: "2891", name: "中信金", currency: "TWD" },
  ],
  TPEX: [
    { symbol: "8069", name: "元太", currency: "TWD" },
    { symbol: "6488", name: "環球晶", currency: "TWD" },
    { symbol: "3105", name: "穩懋", currency: "TWD" },
    { symbol: "3293", name: "鈊象", currency: "TWD" },
    { symbol: "5483", name: "中美晶", currency: "TWD" },
    { symbol: "3264", name: "欣銓", currency: "TWD" },
  ],
  US: [
    { symbol: "VOO", name: "Vanguard S&P 500 ETF", currency: "USD" },
    { symbol: "SPY", name: "SPDR S&P 500 ETF", currency: "USD" },
    { symbol: "QQQ", name: "Invesco QQQ ETF", currency: "USD" },
    { symbol: "VT", name: "Vanguard Total World Stock ETF", currency: "USD" },
    { symbol: "VTI", name: "Vanguard Total Stock Market ETF", currency: "USD" },
    { symbol: "AAPL", name: "Apple", currency: "USD" },
    { symbol: "MSFT", name: "Microsoft", currency: "USD" },
    { symbol: "NVDA", name: "NVIDIA", currency: "USD" },
    { symbol: "TSLA", name: "Tesla", currency: "USD" },
    { symbol: "MSTR", name: "MicroStrategy", currency: "USD" },
    { symbol: "GOOGL", name: "Alphabet", currency: "USD" },
    { symbol: "AMZN", name: "Amazon", currency: "USD" },
    { symbol: "META", name: "Meta", currency: "USD" },
  ],
  CRYPTO: [
    { symbol: "bitcoin", name: "Bitcoin", currency: "USD" },
    { symbol: "ethereum", name: "Ethereum", currency: "USD" },
    { symbol: "solana", name: "Solana", currency: "USD" },
    { symbol: "ripple", name: "XRP", currency: "USD" },
    { symbol: "binancecoin", name: "BNB", currency: "USD" },
    { symbol: "cardano", name: "Cardano", currency: "USD" },
    { symbol: "dogecoin", name: "Dogecoin", currency: "USD" },
    { symbol: "polkadot", name: "Polkadot", currency: "USD" },
    { symbol: "chainlink", name: "Chainlink", currency: "USD" },
    { symbol: "litecoin", name: "Litecoin", currency: "USD" },
    { symbol: "tether", name: "Tether", currency: "USD" },
    { symbol: "usd-coin", name: "USDC", currency: "USD" },
  ],
};

const defaultCurrencyForMarket = (market: string) =>
  markets.find((item) => item.value === market)?.currency || "TWD";

const defaultMarketForAccount = (account?: Account) =>
  account?.account_type === "crypto" ? "CRYPTO" : "TWSE";

export default function InvestmentsPage() {
  const client = useQueryClient();
  const [ownerFilter] = useOwnerFilter();
  const [createOpen, setCreateOpen] = useState(false);
  const [tradeSide, setTradeSide] = useState<"buy" | "sell">("buy");
  const [selectedMarket, setSelectedMarket] = useState("TWSE");
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [selectedCashAccountId, setSelectedCashAccountId] = useState("");
  const [selectedPositionId, setSelectedPositionId] = useState("");
  const [assetChoice, setAssetChoice] = useState("");
  const [customSymbol, setCustomSymbol] = useState("");
  const [customName, setCustomName] = useState("");
  const [selectedCurrency, setSelectedCurrency] = useState("TWD");
  const [tradeQuantity, setTradeQuantity] = useState("");
  const [tradeTotalAmount, setTradeTotalAmount] = useState("");
  const [refreshMessage, setRefreshMessage] = useState("");
  const [tradeStep, setTradeStep] = useState(1);
  const [adjustingPosition, setAdjustingPosition] = useState<Position | null>(null);
  const [adjustQuantity, setAdjustQuantity] = useState("");
  const [adjustAverageCost, setAdjustAverageCost] = useState("");
  const [adjustTotalCost, setAdjustTotalCost] = useState("");
  const [adjustCostInput, setAdjustCostInput] = useState<"unit" | "total">("total");
  const tradeFormRef = useRef<HTMLFormElement>(null);

  const positions = useQuery({
    queryKey: ["positions", ownerFilter],
    queryFn: () => api<Position[]>(`/positions?owner=${ownerFilter}`),
  });
  const accounts = useQuery({
    queryKey: ["accounts", ownerFilter],
    queryFn: () => api<Account[]>(`/accounts?owner=${ownerFilter}`),
  });

  const createTrade = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api("/investment-trades", { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["positions"] });
      client.invalidateQueries({ queryKey: ["accounts"] });
      client.invalidateQueries({ queryKey: ["dashboard"] });
      client.invalidateQueries({ queryKey: ["transactions"] });
      setCreateOpen(false);
      resetTradeDraft();
    },
  });

  const deletePosition = useMutation({
    mutationFn: (id: number) => api(`/positions/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["positions"] });
      client.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const updatePosition = useMutation({
    mutationFn: ({ id, quantity, averageCost }: { id: number; quantity: number; averageCost: number }) =>
      api(`/positions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ quantity, average_cost: averageCost }),
      }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["positions"] });
      client.invalidateQueries({ queryKey: ["accounts"] });
      client.invalidateQueries({ queryKey: ["dashboard"] });
      setAdjustingPosition(null);
      setAdjustQuantity("");
      setAdjustAverageCost("");
      setAdjustTotalCost("");
    },
  });

  function editableNumber(value: number) {
    if (!Number.isFinite(value)) return "";
    return String(Number(value.toFixed(8)));
  }

  function openQuantityAdjustment(position: Position) {
    setAdjustingPosition(position);
    setAdjustQuantity(String(position.quantity));
    setAdjustAverageCost(String(position.average_cost));
    setAdjustTotalCost(editableNumber(position.quantity * position.average_cost));
    setAdjustCostInput("total");
  }

  function changeAdjustQuantity(value: string) {
    setAdjustQuantity(value);
    const quantity = Number(value);
    if (!Number.isFinite(quantity) || quantity < 0) return;
    if (adjustCostInput === "total") {
      const total = Number(adjustTotalCost);
      setAdjustAverageCost(quantity > 0 && Number.isFinite(total) ? editableNumber(total / quantity) : "0");
    } else {
      const averageCost = Number(adjustAverageCost);
      setAdjustTotalCost(Number.isFinite(averageCost) ? editableNumber(quantity * averageCost) : "");
    }
  }

  function changeAdjustAverageCost(value: string) {
    setAdjustAverageCost(value);
    setAdjustCostInput("unit");
    const quantity = Number(adjustQuantity);
    const averageCost = Number(value);
    setAdjustTotalCost(
      Number.isFinite(quantity) && Number.isFinite(averageCost)
        ? editableNumber(quantity * averageCost)
        : "",
    );
  }

  function changeAdjustTotalCost(value: string) {
    setAdjustTotalCost(value);
    setAdjustCostInput("total");
    const quantity = Number(adjustQuantity);
    const totalCost = Number(value);
    setAdjustAverageCost(
      quantity > 0 && Number.isFinite(totalCost)
        ? editableNumber(totalCost / quantity)
        : "0",
    );
  }

  function submitQuantityAdjustment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const quantity = Number(adjustQuantity);
    const averageCost = Number(adjustAverageCost);
    if (
      !adjustingPosition ||
      !Number.isFinite(quantity) ||
      !Number.isFinite(averageCost) ||
      quantity < 0 ||
      averageCost < 0
    ) return;
    updatePosition.mutate({ id: adjustingPosition.id, quantity, averageCost });
  }

  const refresh = useMutation({
    mutationFn: () => api<{
      updated: number;
      skipped: number;
      updated_items?: string[];
      cached_items?: string[];
      manual_items?: string[];
      warnings?: string[];
      errors: string[];
    }>("/market/refresh?force=true", { method: "POST" }),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: ["positions"] });
      client.invalidateQueries({ queryKey: ["dashboard"] });
      const warnings = result.warnings || [];
      if (result.updated === 0 && result.errors.length === 0 && warnings.length === 0) {
        setRefreshMessage("目前行情已是最新，暫時不需要再次呼叫外部服務。");
        return;
      }
      const summary = [
        result.updated_items?.length
          ? `已更新：${result.updated_items.join("、")}`
          : `更新 ${result.updated} 筆`,
      ];
      if (result.cached_items?.length) {
        summary.push(`沿用舊價：${result.cached_items.join("、")}`);
      } else if (result.skipped > 0 && !result.manual_items?.length) {
        summary.push(`沿用 ${result.skipped} 筆現有行情`);
      }
      if (result.manual_items?.length) {
        summary.push(`手動價格未更新：${result.manual_items.join("、")}`);
      }
      if (warnings.length > 0) summary.push(warnings.join("、"));
      if (result.errors.length > 0) summary.push(`失敗 ${result.errors.length} 筆：${result.errors.join("、")}`);
      setRefreshMessage(`行情更新完成：${summary.join("、")}。`);
    },
    onError: (error) => setRefreshMessage(`行情更新失敗：${(error as Error).message}`),
  });

  function submitTrade(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const sellPosition = positions.data?.find((item) => String(item.id) === selectedPositionId);
    const market = tradeSide === "sell" && sellPosition ? sellPosition.market : selectedMarket;
    const rawSymbol = tradeSide === "sell" && sellPosition ? sellPosition.symbol : customSymbol.trim();
    const symbol = market === "CRYPTO" ? rawSymbol.toLowerCase() : rawSymbol.toUpperCase();
    const name = tradeSide === "sell" && sellPosition ? sellPosition.name || sellPosition.symbol : customName.trim();
    const quantity = Number(form.get("quantity") || 0);
    createTrade.mutate({
      account_id: Number(selectedAccountId),
      cash_account_id: Number(selectedCashAccountId || selectedAccountId),
      trade_date: form.get("trade_date"),
      side: tradeSide,
      market,
      symbol,
      name: name || null,
      quantity,
      total_amount: Number(form.get("total_amount") || 0),
      currency: selectedCurrency,
      manual_price: form.get("manual_price") ? Number(form.get("manual_price")) : null,
    });
  }

  const assetAccounts =
    accounts.data?.filter(
      (account) =>
        account.nature === "asset" &&
        (ownerFilter === "all" || account.owner === ownerFilter),
    ) || [];
  const investmentAccounts =
    assetAccounts.filter(
      (account) =>
        ["brokerage", "crypto"].includes(account.account_type),
    );
  const assetOptions = assetPresets[selectedMarket] || [];
  const sellPositions = positions.data || [];
  const selectedSellPosition = positions.data?.find((position) => String(position.id) === selectedPositionId);
  const selectedHoldingAccount = investmentAccounts.find((account) => String(account.id) === selectedAccountId);
  const selectedCashAccount = assetAccounts.find((account) => String(account.id) === selectedCashAccountId);
  const resolvedSymbol = customSymbol.trim();
  const tradeQuantityValue = Number(tradeQuantity || 0);
  const tradeTotalValue = Number(tradeTotalAmount || 0);
  const estimatedUnitPrice = tradeQuantityValue > 0 ? tradeTotalValue / tradeQuantityValue : 0;
  const selectedAssetName =
    tradeSide === "sell"
      ? selectedSellPosition?.name || selectedSellPosition?.symbol || "持倉"
      : customName.trim() || customSymbol.trim() || "投資標的";
  const balanceIncludesPositions = Boolean(
    selectedHoldingAccount &&
    selectedCashAccount &&
    selectedHoldingAccount.id === selectedCashAccount.id &&
    selectedCashAccount.balance_includes_positions,
  );
  const hasSellPosition = tradeSide === "buy" || Boolean(selectedSellPosition);
  const submitDisabled =
    !investmentAccounts.length ||
    !selectedAccountId ||
    !selectedCashAccountId ||
    !hasSellPosition ||
    (tradeSide === "buy" && !resolvedSymbol) ||
    createTrade.isPending;
  const submitButtonText = createTrade.isPending
    ? "儲存中…"
    : !investmentAccounts.length
      ? "先建立投資帳戶"
      : !selectedAccountId
        ? "請先選帳戶"
        : !selectedCashAccountId
          ? tradeSide === "buy" ? "請選扣款帳戶" : "請選入帳帳戶"
          : !hasSellPosition
            ? "請選持倉"
            : tradeSide === "buy" && !resolvedSymbol
          ? "請選標的"
          : tradeSide === "buy"
            ? "記錄買入"
            : "記錄賣出";
  const totalValue = positions.data?.reduce((sum, item) => sum + item.market_value_twd, 0) || 0;
  const totalCost = positions.data?.reduce((sum, item) => sum + item.cost_twd, 0) || 0;
  const totalProfit = totalValue - totalCost;

  useEffect(() => {
    if (!createOpen) return;
    const selectedStillVisible = investmentAccounts.some((account) => String(account.id) === selectedAccountId);
    if (!selectedStillVisible && investmentAccounts.length === 0) {
      setSelectedAccountId("");
      setSelectedCashAccountId("");
      return;
    }
    if (!selectedStillVisible) {
      const firstAccount = investmentAccounts[0];
      const nextMarket = defaultMarketForAccount(firstAccount);
      setSelectedAccountId(String(firstAccount.id));
      setSelectedCashAccountId(String(firstAccount.id));
      setSelectedMarket(nextMarket);
      setSelectedCurrency(defaultCurrencyForMarket(nextMarket));
      return;
    }
    const cashStillVisible = assetAccounts.some((account) => String(account.id) === selectedCashAccountId);
    if (!cashStillVisible) {
      setSelectedCashAccountId(selectedAccountId || (assetAccounts[0] ? String(assetAccounts[0].id) : ""));
    }
  }, [assetAccounts, createOpen, investmentAccounts, selectedAccountId, selectedCashAccountId]);

  useEffect(() => {
    if (!createOpen || tradeSide !== "sell" || selectedPositionId) return;
    const firstPosition = sellPositions[0];
    if (!firstPosition) return;
    setSelectedPositionId(String(firstPosition.id));
    setSelectedCurrency(firstPosition.currency);
  }, [createOpen, selectedPositionId, sellPositions, tradeSide]);

  function resetTradeDraft(initialAccount?: Account, initialPosition?: Position) {
    const nextMarket = defaultMarketForAccount(initialAccount);
    setSelectedAccountId(initialAccount ? String(initialAccount.id) : "");
    setSelectedCashAccountId(initialAccount ? String(initialAccount.id) : "");
    setSelectedPositionId(initialPosition ? String(initialPosition.id) : "");
    setSelectedMarket(nextMarket);
    setAssetChoice("");
    setCustomSymbol(initialPosition?.symbol || "");
    setCustomName(initialPosition?.name || "");
    setSelectedCurrency(initialPosition?.currency || defaultCurrencyForMarket(nextMarket));
    setTradeQuantity("");
    setTradeTotalAmount("");
  }

  function openTradeDialog(side: "buy" | "sell") {
    setTradeSide(side);
    const firstPosition = side === "sell" ? positions.data?.[0] : undefined;
    const initialAccount =
      investmentAccounts.find((account) => account.id === firstPosition?.account_id) || investmentAccounts[0];
    resetTradeDraft(initialAccount, firstPosition);
    setTradeStep(1);
    setCreateOpen(true);
  }

  function closeTradeDialog() {
    setCreateOpen(false);
    setTradeStep(1);
  }

  function changeMarket(nextMarket: string) {
    setSelectedMarket(nextMarket);
    setAssetChoice("");
    setCustomSymbol("");
    setCustomName("");
    setSelectedCurrency(defaultCurrencyForMarket(nextMarket));
  }

  function changeAccount(nextAccountId: string) {
    setSelectedAccountId(nextAccountId);
    if (!selectedCashAccountId) {
      setSelectedCashAccountId(nextAccountId);
    }
    if (tradeSide === "sell") {
      const firstPosition = positions.data?.find((position) => String(position.account_id) === nextAccountId);
      setSelectedPositionId(firstPosition ? String(firstPosition.id) : "");
      if (firstPosition) {
        setSelectedCurrency(firstPosition.currency);
      }
    }
  }

  function changeSellPosition(nextPositionId: string) {
    setSelectedPositionId(nextPositionId);
    const position = positions.data?.find((item) => String(item.id) === nextPositionId);
    if (!position) return;
    setSelectedAccountId(String(position.account_id));
    setSelectedMarket(position.market);
    setCustomSymbol(position.symbol);
    setCustomName(position.name || "");
    setSelectedCurrency(position.currency);
  }

  function changeAsset(nextSymbol: string) {
    setAssetChoice(nextSymbol);
    if (nextSymbol === customAssetValue) {
      setSelectedCurrency(defaultCurrencyForMarket(selectedMarket));
      return;
    }

    const asset = assetOptions.find((item) => item.symbol === nextSymbol);
    if (asset) {
      setCustomSymbol(asset.symbol);
      setCustomName(asset.name);
      setSelectedCurrency(asset.currency);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Portfolio"
        title="投資持倉"
        description="用買入與賣出記錄投資，系統會同步更新持倉、平均成本與帳戶餘額。"
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
              <RefreshCw size={16} className={refresh.isPending ? "animate-spin" : ""} />
              更新行情
            </Button>
            <Button variant="secondary" onClick={() => openTradeDialog("sell")} disabled={!positions.data?.length}>
              賣出
            </Button>
            <Button onClick={() => openTradeDialog("buy")}>
              <Plus size={16} /> 買入
            </Button>
          </div>
        }
      />

      {refreshMessage && (
        <div className="mb-5 flex items-start justify-between rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          <span>{refreshMessage}</span>
          <button onClick={() => setRefreshMessage("")}>×</button>
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <p className="text-sm text-slate-500">投資總市值（折合 TWD）</p>
          <p className="mt-2 text-2xl font-bold text-ink">{money(totalValue)}</p>
          <p className="mt-3 text-xs text-slate-400">{positions.data?.length || 0} 項持倉</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-slate-500">投入成本（折合 TWD）</p>
          <p className="mt-2 text-2xl font-bold text-ink">{money(totalCost)}</p>
          <p className="mt-3 text-xs text-slate-400">依每單位成本與目前匯率</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-slate-500">未實現損益（折合 TWD）</p>
          <p className={`mt-2 text-2xl font-bold ${totalProfit >= 0 ? "text-emerald-700" : "text-red-600"}`}>
            {totalProfit >= 0 ? "+" : ""}{money(totalProfit)}
          </p>
          <p className="mt-3 text-xs text-slate-400">
            {totalCost ? `${totalProfit >= 0 ? "+" : ""}${number((totalProfit / totalCost) * 100, 2)}%` : "尚無成本資料"}
          </p>
        </Card>
      </div>

      <Card className="overflow-hidden">
        {!positions.data?.length ? (
          <EmptyState
            icon={<LineChart size={26} />}
            title="還沒有投資紀錄"
            description="先建立交易所或證券帳戶，接著用買入紀錄第一筆投資。"
            action={<Button onClick={() => openTradeDialog("buy")}>買入第一筆</Button>}
          />
        ) : (
          <>
          <div className="divide-y divide-slate-100 md:hidden">
            {positions.data.map((position) => (
              <details key={position.id} className="group px-4 py-4">
                <summary className="cursor-pointer list-none">
                  <div className="flex items-start gap-3">
                    <div className={`grid size-11 shrink-0 place-items-center rounded-xl ${position.market === "CRYPTO" ? "bg-amber-50 text-amber-600" : "bg-blue-50 text-blue-700"}`}>
                      {position.market === "CRYPTO" ? <Bitcoin size={19} /> : <LineChart size={19} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-slate-800">{position.symbol}</p>
                          <p className="mt-0.5 truncate text-xs text-slate-400">{position.name || position.market}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="font-bold text-slate-800">{money(position.market_value_twd)}</p>
                          <p className={`mt-0.5 text-xs font-semibold ${position.profit_twd >= 0 ? "text-emerald-700" : "text-red-600"}`}>
                            {position.profit_twd >= 0 ? "+" : ""}{money(position.profit_twd)} · {number(position.profit_pct || 0, 2)}%
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-slate-500">
                        <span>持有 {number(position.quantity, 8)}</span>
                        <span className="flex items-center gap-1">查看細項 <ChevronDown size={14} className="transition group-open:rotate-180" /></span>
                      </div>
                    </div>
                  </div>
                </summary>
                <div className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-100 pt-4 text-sm">
                  <div className="rounded-xl bg-slate-50 p-3">
                    <p className="text-xs text-slate-400">目前價格</p>
                    <p className="mt-1 font-semibold text-slate-800">{money(position.price, position.currency)}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-3">
                    <p className="text-xs text-slate-400">平均成本</p>
                    <p className="mt-1 font-semibold text-slate-800">{money(position.average_cost, position.currency)}</p>
                    <div className="mt-2">
                      <Badge tone={position.cost_status === "estimated" ? "amber" : position.cost_status === "missing" ? "red" : "green"}>
                        {position.cost_status === "estimated"
                          ? "成本待確認"
                          : position.cost_status === "missing"
                            ? "尚未填成本"
                            : position.cost_status === "confirmed"
                              ? "成本已確認"
                              : "自動計算"}
                      </Badge>
                    </div>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-3">
                    <p className="text-xs text-slate-400">持倉帳戶</p>
                    <p className="mt-1 font-medium text-slate-700">{position.account_name}（{position.owner_label}）</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-3">
                    <p className="text-xs text-slate-400">資料狀態</p>
                    <div className="mt-1"><Badge tone={position.stale ? "amber" : "green"}>{position.price_source}</Badge></div>
                    <p className="mt-1 text-xs text-slate-400">{position.price_date || "尚無行情"}</p>
                  </div>
                  <div className="col-span-2 flex justify-end gap-2">
                    <Button
                      variant="secondary"
                      className="h-11"
                      onClick={() => openQuantityAdjustment(position)}
                    >
                      <Pencil size={15} /> 調整持倉與成本
                    </Button>
                    <Button
                      variant="danger"
                      className="h-11"
                      onClick={() => {
                        if (window.confirm(`確定刪除 ${position.symbol}？這會從持倉列表移除。`)) {
                          deletePosition.mutate(position.id);
                        }
                      }}
                      disabled={deletePosition.isPending}
                    >
                      <Trash2 size={15} /> 刪除持倉
                    </Button>
                  </div>
                </div>
              </details>
            ))}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[900px]">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-5 py-4">標的</th>
                  <th className="px-4 py-4">數量</th>
                  <th className="px-4 py-4 text-right">目前價格</th>
                  <th className="px-4 py-4 text-right">市值（折合 TWD）</th>
                  <th className="px-4 py-4 text-right">損益（折合 TWD）</th>
                  <th className="px-5 py-4">資料狀態</th>
                  <th className="w-14 px-3 py-4" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {positions.data.map((position) => (
                  <tr key={position.id} className="hover:bg-slate-50/60">
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        <div className={`grid size-10 place-items-center rounded-xl ${position.market === "CRYPTO" ? "bg-amber-50 text-amber-600" : "bg-blue-50 text-blue-700"}`}>
                          {position.market === "CRYPTO" ? <Bitcoin size={18} /> : <LineChart size={18} />}
                        </div>
                        <div>
                          <p className="font-semibold text-slate-800">{position.symbol}</p>
                          <p className="mt-1 text-xs text-slate-400">{position.name || position.market}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-4 text-sm text-slate-600">{number(position.quantity, 8)}</td>
                    <td className="px-4 py-4 text-right">
                      <p className="text-sm font-semibold text-slate-800">{money(position.price, position.currency)}</p>
                      <p className="mt-1 text-xs text-slate-400">每單位成本 {money(position.average_cost, position.currency)}</p>
                      {(position.cost_status === "estimated" || position.cost_status === "missing") && (
                        <p className="mt-1 text-xs font-medium text-amber-600">成本待確認</p>
                      )}
                    </td>
                    <td className="px-4 py-4 text-right">
                      <p className="text-sm font-bold text-slate-800">{money(position.market_value_twd)}</p>
                      {position.currency !== "TWD" && (
                        <p className="mt-1 text-xs text-slate-400">原幣 {money(position.market_value, position.currency)}</p>
                      )}
                    </td>
                    <td className="px-4 py-4 text-right">
                      <p className={`text-sm font-bold ${position.profit_twd >= 0 ? "text-emerald-700" : "text-red-600"}`}>
                        {position.profit_twd >= 0 ? "+" : ""}{money(position.profit_twd)}
                      </p>
                      {position.profit_pct !== undefined && (
                        <p className={`mt-1 inline-flex items-center gap-1 text-xs ${position.profit_twd >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                          {position.profit_twd >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                          {number(position.profit_pct, 2)}%
                        </p>
                      )}
                    </td>
                    <td className="px-5 py-4">
                      <Badge tone={position.stale ? "amber" : "green"}>
                        {position.stale ? <Clock3 size={12} className="mr-1" /> : null}
                        {position.price_source}
                      </Badge>
                      <p className="mt-1.5 text-xs text-slate-400">{position.price_date || "尚無行情"}</p>
                    </td>
                    <td className="px-3 py-4 text-right">
                      <Button
                        variant="ghost"
                        className="size-9 px-0 text-slate-500 hover:text-forest"
                        title="調整持倉與成本"
                        aria-label={`調整 ${position.symbol} 持倉與成本`}
                        onClick={() => openQuantityAdjustment(position)}
                      >
                        <Pencil size={15} />
                      </Button>
                      <Button
                        variant="ghost"
                        className="size-9 px-0 text-red-500 hover:bg-red-50 hover:text-red-700"
                        title="刪除持倉"
                        aria-label={`刪除 ${position.symbol}`}
                        onClick={() => {
                          if (window.confirm(`確定刪除 ${position.symbol}？這會從持倉列表移除。`)) {
                            deletePosition.mutate(position.id);
                          }
                        }}
                        disabled={deletePosition.isPending}
                      >
                        <Trash2 size={15} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Card>

      <Dialog
        open={Boolean(adjustingPosition)}
        onClose={() => {
          setAdjustingPosition(null);
          setAdjustQuantity("");
          setAdjustAverageCost("");
          setAdjustTotalCost("");
        }}
        title="調整持倉與成本"
        description="可用每單位成本或總投入金額校正；兩者會自動換算，不會新增收支或改動帳戶總額。"
      >
        <form className="space-y-5" onSubmit={submitQuantityAdjustment}>
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs text-slate-400">目前調整</p>
            <p className="mt-1 font-semibold text-slate-800">
              {adjustingPosition?.symbol} · {adjustingPosition?.account_name}
            </p>
          </div>
          <Field label="實際持有數量">
            <Input
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={adjustQuantity}
              onChange={(event) => changeAdjustQuantity(event.target.value)}
              autoFocus
              required
            />
          </Field>
          {adjustingPosition && (
            <div className={`rounded-2xl px-4 py-3 text-sm ${
              adjustingPosition.cost_status === "estimated" || adjustingPosition.cost_status === "missing"
                ? "bg-amber-50 text-amber-800"
                : "bg-emerald-50 text-emerald-800"
            }`}>
              <p className="font-semibold">
                {adjustingPosition.cost_status === "estimated"
                  ? "這筆成本需要你確認一次"
                  : adjustingPosition.cost_status === "missing"
                    ? "這筆持倉還沒有成本"
                    : "目前成本已有資料"}
              </p>
              <p className="mt-1 text-xs leading-5 opacity-80">{adjustingPosition.cost_note}</p>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={`每單位平均成本（${adjustingPosition?.currency || "TWD"}）`}
              hint="知道買入均價時填這裡"
            >
              <Input
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                value={adjustAverageCost}
                onChange={(event) => changeAdjustAverageCost(event.target.value)}
                required
              />
            </Field>
            <Field
              label={`總投入金額（${adjustingPosition?.currency || "TWD"}）`}
              hint="只知道總共投入多少時填這裡"
            >
              <Input
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                value={adjustTotalCost}
                onChange={(event) => changeAdjustTotalCost(event.target.value)}
                required
              />
            </Field>
          </div>
          <p className="rounded-xl bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-700">
            修改其中一個成本欄位，另一個會依持有數量自動換算。儲存後會立即重新計算損益。
          </p>
          {updatePosition.isError && (
            <p className="text-sm text-red-600">{(updatePosition.error as Error).message}</p>
          )}
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setAdjustingPosition(null);
                setAdjustQuantity("");
                setAdjustAverageCost("");
                setAdjustTotalCost("");
              }}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={
                updatePosition.isPending ||
                !adjustQuantity ||
                !adjustAverageCost ||
                Number(adjustQuantity) < 0 ||
                Number(adjustAverageCost) < 0
              }
            >
              儲存持倉與成本
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={createOpen}
        onClose={closeTradeDialog}
        title={tradeSide === "buy" ? "買入投資" : "賣出投資"}
        description="依照三個步驟填寫，儲存前可以先確認帳戶與持倉會怎麼變化。"
      >
        <form ref={tradeFormRef} className="space-y-4" onSubmit={submitTrade}>
          {investmentAccounts.length === 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              請先到「帳戶」建立證券或加密貨幣帳戶。
            </div>
          )}
          <FormContext
            value={tradeSide === "buy" ? "買入投資" : "賣出投資"}
            action={(
              <Button type="button" variant="ghost" className="h-9" onClick={() => openTradeDialog(tradeSide === "buy" ? "sell" : "buy")}>
                改成{tradeSide === "buy" ? "賣出" : "買入"}
              </Button>
            )}
          />

          <MobileWizardProgress current={tradeStep} labels={["選擇標的", "交易金額", "帳戶與確認"]} />

          <MobileWizardStep step={1} current={tradeStep}>
          <FormStep number={1} title={tradeSide === "buy" ? "要買什麼？" : "要賣哪一筆？"}>
            {tradeSide === "buy" ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="市場">
                    <Select name="market" value={selectedMarket} onChange={(event) => changeMarket(event.target.value)}>
                      {markets.map((market) => <option key={market.value} value={market.value}>{market.label}</option>)}
                    </Select>
                  </Field>
                  <Field label="投資標的">
                    <Select value={assetChoice} onChange={(event) => changeAsset(event.target.value)} required>
                      <option value="">選擇常用標的</option>
                      {assetOptions.map((asset) => (
                        <option key={asset.symbol} value={asset.symbol}>{asset.name}（{asset.symbol}）</option>
                      ))}
                      <option value={customAssetValue}>其他 / 自訂</option>
                    </Select>
                  </Field>
                </div>
                {assetChoice === customAssetValue && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="代號" hint={selectedMarket === "CRYPTO" ? "請填 CoinGecko ID，例如 bitcoin。" : undefined}>
                      <Input
                        value={customSymbol}
                        onChange={(event) => setCustomSymbol(event.target.value)}
                        placeholder={selectedMarket === "CRYPTO" ? "例如 bitcoin" : selectedMarket === "US" ? "例如 MSTR" : "例如 2330"}
                        required
                      />
                    </Field>
                    <Field label="名稱（選填）">
                      <Input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="例如：微策略" />
                    </Field>
                  </div>
                )}
              </>
            ) : (
              <Field label="持倉">
                <Select value={selectedPositionId} onChange={(event) => changeSellPosition(event.target.value)} required>
                  <option value="">選擇持倉</option>
                  {sellPositions.map((position) => (
                    <option key={position.id} value={position.id}>
                      {position.name || position.symbol}・{number(position.quantity, 8)}・{position.account_name}
                    </option>
                  ))}
                </Select>
                {sellPositions.length === 0 && <p className="text-xs text-amber-600">目前沒有可賣出的持倉。</p>}
                {selectedSellPosition && (
                  <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">
                    目前持有 {number(selectedSellPosition.quantity, 8)}，平均成本 {money(selectedSellPosition.average_cost, selectedSellPosition.currency)}
                  </p>
                )}
              </Field>
            )}
          </FormStep>
          </MobileWizardStep>

          <MobileWizardStep step={2} current={tradeStep}>
          <FormStep number={2} title="這次交易多少？" tone="blue">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={tradeSide === "buy" ? "買入數量" : "賣出數量"}>
                <Input
                  name="quantity"
                  type="number"
                  step="any"
                  min="0"
                  max={tradeSide === "sell" ? selectedSellPosition?.quantity : undefined}
                  value={tradeQuantity}
                  onChange={(event) => setTradeQuantity(event.target.value)}
                  inputMode="decimal"
                  placeholder="0"
                  required
                  autoFocus={tradeStep === 2}
                />
              </Field>
              <Field label="成交總額" hint={tradeSide === "buy" ? "這次總共付多少" : "這次總共拿回多少"}>
                <div className="flex gap-2">
                  <Select className="w-28 shrink-0" value={selectedCurrency} onChange={(event) => setSelectedCurrency(event.target.value)}>
                    {["TWD", "USD", "JPY", "EUR"].map((currency) => <option key={currency}>{currency}</option>)}
                  </Select>
                  <Input
                    name="total_amount"
                    type="number"
                    step="any"
                    min="0"
                    value={tradeTotalAmount}
                    onChange={(event) => setTradeTotalAmount(event.target.value)}
                    inputMode="decimal"
                    placeholder="0"
                    required
                  />
                </div>
              </Field>
            </div>
            {estimatedUnitPrice > 0 && (
              <p className="text-xs text-slate-500">推算成交單價：{money(estimatedUnitPrice, selectedCurrency)}</p>
            )}
          </FormStep>
          </MobileWizardStep>

          <MobileWizardStep step={3} current={tradeStep}>
          <FormStep number={3} title="錢和持倉放哪裡？" tone="purple">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={tradeSide === "buy" ? "從哪個帳戶扣款" : "賣出的錢進哪個帳戶"}>
                <Select value={selectedCashAccountId} onChange={(event) => setSelectedCashAccountId(event.target.value)} required>
                  <option value="">選擇帳戶</option>
                  {assetAccounts.map((account) => (
                    <option key={account.id} value={account.id}>{account.name}（{account.owner_label}）</option>
                  ))}
                </Select>
              </Field>
              {tradeSide === "buy" ? (
                <Field label="持倉記在哪個帳戶">
                  <Select value={selectedAccountId} onChange={(event) => changeAccount(event.target.value)} required>
                    <option value="">選擇投資帳戶</option>
                    {investmentAccounts.map((account) => (
                      <option key={account.id} value={account.id}>{account.name}（{account.owner_label}）</option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <div className="rounded-xl bg-slate-50 px-4 py-3">
                  <p className="text-xs text-slate-400">持倉帳戶</p>
                  <p className="mt-1 text-sm font-medium text-slate-700">{selectedHoldingAccount?.name || "選擇持倉後自動帶入"}</p>
                </div>
              )}
            </div>
          </FormStep>

          <details className="group rounded-2xl border border-slate-200 px-4 py-3">
            <summary className="cursor-pointer list-none text-sm font-medium text-slate-600">其他設定（日期、手動價格）</summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="交易日期">
                <DateInput name="trade_date" defaultValue={taipeiDateInputValue()} required />
              </Field>
              <Field label="手動價格" hint="選填；填寫後會用這個價格估值。">
                <Input name="manual_price" type="number" step="any" min="0" placeholder="選填" />
              </Field>
            </div>
          </details>

          {tradeQuantityValue > 0 && tradeTotalValue > 0 && selectedCashAccount && (
            <div className="rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-900">
              <p className="font-semibold">儲存後會發生：</p>
              <div className="mt-2 space-y-1 text-xs leading-5 text-emerald-800">
                <p>• {tradeSide === "buy" ? "增加" : "減少"} {number(tradeQuantityValue, 8)} 個 {selectedAssetName}</p>
                <p>
                  • {selectedCashAccount.name}：
                  {balanceIncludesPositions
                    ? "帳戶總額不重複變動"
                    : `${tradeSide === "buy" ? "−" : "+"}${money(tradeTotalValue, selectedCurrency)}`}
                </p>
                <p>• 不會列入日常收入或支出</p>
              </div>
            </div>
          )}

          {balanceIncludesPositions && !(tradeQuantityValue > 0 && tradeTotalValue > 0) && (
            <div className="rounded-xl bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-800">
              這個帳戶的餘額已包含持倉，本次只更新持倉明細，不會重複改動帳戶總額。
            </div>
          )}
          {createTrade.isError && <p className="text-sm text-red-600">{(createTrade.error as Error).message}</p>}
          </MobileWizardStep>
          <MobileWizardActions
            current={tradeStep}
            total={3}
            onPrevious={() => setTradeStep((step) => Math.max(1, step - 1))}
            onNext={() => {
              if (validateWizardStep(tradeFormRef.current, tradeStep)) {
                setTradeStep((step) => Math.min(3, step + 1));
              }
            }}
            onCancel={closeTradeDialog}
            submitLabel={submitButtonText}
            pending={submitDisabled}
          />
        </form>
      </Dialog>
    </>
  );
}
