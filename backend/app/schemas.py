from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field


class AuthLogin(BaseModel):
    password: str = Field(min_length=1, max_length=200)


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class AccountCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    institution: str | None = None
    account_type: str
    nature: str = "asset"
    currency: str = "TWD"
    owner: str = "me"
    is_liquid: bool = False
    balance_includes_positions: bool = False
    note: str | None = None
    opening_balance: Decimal | None = None
    opening_date: date | None = None


class AccountUpdate(BaseModel):
    name: str | None = None
    institution: str | None = None
    currency: str | None = None
    owner: str | None = None
    is_liquid: bool | None = None
    balance_includes_positions: bool | None = None
    note: str | None = None


class BalanceCreate(BaseModel):
    amount: Decimal
    snapshot_date: date = Field(default_factory=date.today)
    fx_rate: Decimal | None = None


class TransactionCreate(BaseModel):
    account_id: int
    transaction_date: date
    description: str
    amount: Decimal
    currency: str | None = None
    fx_rate: Decimal | None = None
    transaction_kind: str | None = None
    category_id: int | None = None
    note: str | None = None


class TransactionUpdate(BaseModel):
    description: str | None = None
    transaction_kind: str | None = None
    category_id: int | None = None
    note: str | None = None
    create_rule: bool = False
    rule_keyword: str | None = None


class PositionCreate(BaseModel):
    account_id: int
    market: str
    symbol: str
    name: str | None = None
    quantity: Decimal
    average_cost: Decimal = Decimal("0")
    currency: str
    manual_price: Decimal | None = None


class PositionUpdate(BaseModel):
    quantity: Decimal | None = None
    average_cost: Decimal | None = None
    name: str | None = None
    manual_price: Decimal | None = None


class InvestmentTradeCreate(BaseModel):
    account_id: int
    cash_account_id: int | None = None
    trade_date: date = Field(default_factory=date.today)
    side: str
    market: str
    symbol: str
    name: str | None = None
    quantity: Decimal = Field(gt=0)
    total_amount: Decimal = Field(gt=0)
    currency: str = "TWD"
    manual_price: Decimal | None = None
    note: str | None = None


class BudgetCreate(BaseModel):
    month: str = Field(pattern=r"^\d{4}-\d{2}$")
    category_id: int
    amount: Decimal = Field(gt=0)


class GoalCreate(BaseModel):
    name: str
    owner: str = "me"
    goal_type: str = "net_worth"
    account_id: int | None = None
    target_amount: Decimal = Field(gt=0)
    current_amount: Decimal = Decimal("0")
    target_date: date | None = None
    currency: str = "TWD"
    note: str | None = None


class GoalUpdate(BaseModel):
    name: str | None = None
    owner: str | None = None
    goal_type: str | None = None
    account_id: int | None = None
    target_amount: Decimal | None = None
    current_amount: Decimal | None = None
    target_date: date | None = None
    completed: bool | None = None
    note: str | None = None


class RuleCreate(BaseModel):
    keyword: str
    category_id: int
    transaction_kind: str = "expense"
    priority: int = 100


class FxRateCreate(BaseModel):
    currency: str
    rate_date: date = Field(default_factory=date.today)
    rate_to_twd: Decimal = Field(gt=0)


class TransferCreate(BaseModel):
    from_transaction_id: int
    to_transaction_id: int


class AccountTransferCreate(BaseModel):
    from_account_id: int
    to_account_id: int
    amount: Decimal = Field(gt=0)
    transfer_date: date = Field(default_factory=date.today)
    description: str | None = None
    to_amount: Decimal | None = Field(default=None, gt=0)
    note: str | None = None


class LoanPaymentCreate(BaseModel):
    payment_account_id: int
    loan_account_id: int
    payment_date: date = Field(default_factory=date.today)
    principal: Decimal = Field(ge=0)
    interest: Decimal = Field(ge=0)
    description: str | None = None
    note: str | None = None


class SettingsUpdate(BaseModel):
    alpha_vantage_api_key: str | None = None


class BinanceConnectionCreate(BaseModel):
    account_id: int
    api_key: str = Field(min_length=8, max_length=200)
    api_secret: str = Field(min_length=8, max_length=300)


class BackupPayload(BaseModel):
    version: int = 1
    exported_at: datetime
    data: dict[str, list[dict]]
