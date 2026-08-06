export interface Account {
  id: number;
  name: string;
  institution?: string;
  account_type: string;
  nature: "asset" | "liability";
  currency: string;
  owner: "me" | "partner" | "shared";
  owner_label: string;
  is_liquid: boolean;
  balance_includes_positions: boolean;
  auto_balance_base_twd?: number | null;
  valuation_mode: "cash_plus_positions" | "manual_total" | "auto_estimate";
  archived: boolean;
  note?: string;
  balance: number;
  balance_twd: number;
  balance_date?: string;
  investments_twd: number;
  total_twd: number;
  positions_count: number;
}

export interface Dashboard {
  owner: "all" | "me" | "partner" | "shared";
  owner_label: string;
  assets: number;
  liabilities: number;
  net_worth: number;
  month_income: number;
  month_expense: number;
  month_savings: number;
  savings_rate: number | null;
  accounts: Account[];
  allocation: { name: string; value: number }[];
  category_expenses: { name: string; color: string; value: number }[];
  cashflow_trend: { month: string; income: number; expense: number }[];
  net_worth_trend: { date: string; assets: number; liabilities: number; net_worth: number }[];
  updated_at: string;
}

export interface Category {
  id: number;
  name: string;
  kind: string;
  essential: boolean;
  color: string;
  icon: string;
}

export interface Transaction {
  id: number;
  account_id: number;
  account_name: string;
  transaction_date: string;
  description: string;
  amount: number;
  currency: string;
  base_amount: number;
  fx_rate: number;
  fx_estimated: boolean;
  transaction_kind: string;
  category_id?: number;
  category_name: string;
  category_color: string;
  source: string;
  note?: string;
}

export interface Position {
  id: number;
  account_id: number;
  account_name: string;
  owner: "me" | "partner" | "shared";
  owner_label: string;
  market: string;
  symbol: string;
  name?: string;
  quantity: number;
  average_cost: number;
  currency: string;
  manual_price?: number;
  price: number;
  price_date?: string;
  price_source: string;
  stale: boolean;
  fx_estimated: boolean;
  market_value: number;
  market_value_twd: number;
  cost_twd: number;
  cost_status: "automatic" | "calculated" | "confirmed" | "estimated" | "missing";
  cost_note: string;
  profit_twd: number;
  profit_pct?: number;
}

export interface Budget {
  id: number;
  month: string;
  category_id: number;
  category_name: string;
  category_color: string;
  amount: number;
  spent: number;
  percentage: number;
}

export interface Goal {
  id: number;
  name: string;
  owner: "me" | "partner" | "shared";
  owner_label: string;
  goal_type: "net_worth" | "liquid_assets" | "account_balance" | "investment_cost" | "debt_payoff";
  account_id?: number | null;
  account_name?: string | null;
  target_amount: number;
  current_amount: number;
  target_date?: string;
  currency: string;
  completed: boolean;
  note?: string;
  progress: number;
}

export interface HealthScore {
  score: number | null;
  completeness: number;
  components: {
    key: string;
    label: string;
    value: number | null;
    score: number | null;
    detail: string;
  }[];
}

export interface SpendingAnalysis {
  month: string;
  owner: "all" | "me" | "partner" | "shared";
  month_expense: number;
  category_expenses: { name: string; color: string; value: number }[];
  recurring_expenses: {
    name: string;
    account_name: string;
    category_name: string;
    average_amount: number;
    current_month_amount: number;
    months_detected: number;
    latest_date: string;
    status: "recorded" | "expected";
  }[];
  estimated_recurring_total: number;
}

export interface CsvInspection {
  encoding: string;
  columns: string[];
  sample: Record<string, string>[];
  total_rows: number;
}
