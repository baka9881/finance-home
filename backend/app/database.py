from __future__ import annotations

import os
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    create_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker


ROOT_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.getenv("FINANCE_DATA_DIR", ROOT_DIR / "data"))
APP_MODE = os.getenv("APP_MODE", "personal").lower()
DEFAULT_DB = DATA_DIR / ("demo.db" if APP_MODE == "demo" else "finance.db")
DATABASE_URL = os.getenv("FINANCE_DB_URL", f"sqlite:///{DEFAULT_DB.as_posix()}")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+psycopg://", 1)
elif DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+psycopg://", 1)

if DATABASE_URL.startswith("sqlite:///"):
    Path(DATABASE_URL.removeprefix("sqlite:///")).parent.mkdir(parents=True, exist_ok=True)

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class Account(Base, TimestampMixin):
    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    institution: Mapped[str | None] = mapped_column(String(100))
    account_type: Mapped[str] = mapped_column(String(30))
    nature: Mapped[str] = mapped_column(String(10), default="asset")
    currency: Mapped[str] = mapped_column(String(3), default="TWD")
    owner: Mapped[str] = mapped_column(String(20), default="me")
    is_liquid: Mapped[bool] = mapped_column(Boolean, default=False)
    balance_includes_positions: Mapped[bool] = mapped_column(Boolean, default=False)
    auto_balance_base_twd: Mapped[Decimal | None] = mapped_column(Numeric(18, 4))
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    note: Mapped[str | None] = mapped_column(Text)

    balances: Mapped[list["BalanceSnapshot"]] = relationship(
        back_populates="account", cascade="all, delete-orphan"
    )
    transactions: Mapped[list["Transaction"]] = relationship(back_populates="account")
    positions: Mapped[list["Position"]] = relationship(back_populates="account")


class BalanceSnapshot(Base, TimestampMixin):
    __tablename__ = "balance_snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), index=True)
    snapshot_date: Mapped[date] = mapped_column(Date, index=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 4))
    currency: Mapped[str] = mapped_column(String(3))
    fx_rate: Mapped[Decimal] = mapped_column(Numeric(18, 8), default=1)
    base_amount: Mapped[Decimal] = mapped_column(Numeric(18, 4))
    source: Mapped[str] = mapped_column(String(20), default="manual")

    account: Mapped["Account"] = relationship(back_populates="balances")


class Category(Base, TimestampMixin):
    __tablename__ = "categories"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(50), unique=True)
    kind: Mapped[str] = mapped_column(String(10), default="expense")
    essential: Mapped[bool] = mapped_column(Boolean, default=False)
    color: Mapped[str] = mapped_column(String(20), default="#64748b")
    icon: Mapped[str] = mapped_column(String(30), default="circle")


class Transaction(Base, TimestampMixin):
    __tablename__ = "transactions"
    __table_args__ = (UniqueConstraint("fingerprint", name="uq_transaction_fingerprint"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), index=True)
    transaction_date: Mapped[date] = mapped_column(Date, index=True)
    description: Mapped[str] = mapped_column(String(300))
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 4))
    currency: Mapped[str] = mapped_column(String(3), default="TWD")
    fx_rate: Mapped[Decimal] = mapped_column(Numeric(18, 8), default=1)
    base_amount: Mapped[Decimal] = mapped_column(Numeric(18, 4))
    fx_estimated: Mapped[bool] = mapped_column(Boolean, default=False)
    transaction_kind: Mapped[str] = mapped_column(String(20), default="expense")
    category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id"))
    fingerprint: Mapped[str] = mapped_column(String(64), index=True)
    source: Mapped[str] = mapped_column(String(20), default="manual")
    note: Mapped[str | None] = mapped_column(Text)

    account: Mapped["Account"] = relationship(back_populates="transactions")
    category: Mapped["Category | None"] = relationship()


class ClassificationRule(Base, TimestampMixin):
    __tablename__ = "classification_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    keyword: Mapped[str] = mapped_column(String(100), unique=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id"))
    transaction_kind: Mapped[str] = mapped_column(String(20), default="expense")
    priority: Mapped[int] = mapped_column(Integer, default=100)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)

    category: Mapped["Category"] = relationship()


class TransferLink(Base, TimestampMixin):
    __tablename__ = "transfer_links"

    id: Mapped[int] = mapped_column(primary_key=True)
    from_transaction_id: Mapped[int] = mapped_column(ForeignKey("transactions.id"))
    to_transaction_id: Mapped[int] = mapped_column(ForeignKey("transactions.id"))
    confirmed: Mapped[bool] = mapped_column(Boolean, default=True)


class Position(Base, TimestampMixin):
    __tablename__ = "positions"

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), index=True)
    market: Mapped[str] = mapped_column(String(20))
    symbol: Mapped[str] = mapped_column(String(40))
    name: Mapped[str | None] = mapped_column(String(100))
    quantity: Mapped[Decimal] = mapped_column(Numeric(24, 8))
    average_cost: Mapped[Decimal] = mapped_column(Numeric(18, 6), default=0)
    currency: Mapped[str] = mapped_column(String(3))
    manual_price: Mapped[Decimal | None] = mapped_column(Numeric(18, 8))
    archived: Mapped[bool] = mapped_column(Boolean, default=False)

    account: Mapped["Account"] = relationship(back_populates="positions")


class PriceSnapshot(Base, TimestampMixin):
    __tablename__ = "price_snapshots"
    __table_args__ = (
        UniqueConstraint("market", "symbol", "price_date", name="uq_price_snapshot"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    market: Mapped[str] = mapped_column(String(20))
    symbol: Mapped[str] = mapped_column(String(40), index=True)
    price_date: Mapped[date] = mapped_column(Date, index=True)
    price: Mapped[Decimal] = mapped_column(Numeric(18, 8))
    currency: Mapped[str] = mapped_column(String(3))
    source: Mapped[str] = mapped_column(String(30))
    stale: Mapped[bool] = mapped_column(Boolean, default=False)


class FxRate(Base, TimestampMixin):
    __tablename__ = "fx_rates"
    __table_args__ = (
        UniqueConstraint("currency", "rate_date", name="uq_fx_rate_currency_date"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    currency: Mapped[str] = mapped_column(String(3), index=True)
    rate_date: Mapped[date] = mapped_column(Date, index=True)
    rate_to_twd: Mapped[Decimal] = mapped_column(Numeric(18, 8))
    source: Mapped[str] = mapped_column(String(30))
    manual: Mapped[bool] = mapped_column(Boolean, default=False)


class Budget(Base, TimestampMixin):
    __tablename__ = "budgets"
    __table_args__ = (
        UniqueConstraint("month", "category_id", name="uq_budget_month_category"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    month: Mapped[str] = mapped_column(String(7), index=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id"))
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    currency: Mapped[str] = mapped_column(String(3), default="TWD")

    category: Mapped["Category"] = relationship()


class Goal(Base, TimestampMixin):
    __tablename__ = "goals"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    owner: Mapped[str] = mapped_column(String(20), default="me")
    goal_type: Mapped[str] = mapped_column(String(30), default="net_worth")
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id"))
    target_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    current_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=0)
    target_date: Mapped[date | None] = mapped_column(Date)
    currency: Mapped[str] = mapped_column(String(3), default="TWD")
    completed: Mapped[bool] = mapped_column(Boolean, default=False)
    note: Mapped[str | None] = mapped_column(Text)

    account: Mapped["Account | None"] = relationship()


class RecurringExpense(Base, TimestampMixin):
    __tablename__ = "recurring_expenses"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    owner: Mapped[str] = mapped_column(String(20), default="me", index=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    due_day: Mapped[int | None] = mapped_column(Integer)
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id"))
    category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id"))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    note: Mapped[str | None] = mapped_column(Text)

    account: Mapped["Account | None"] = relationship()
    category: Mapped["Category | None"] = relationship()


class IgnoredRecurringExpense(Base, TimestampMixin):
    __tablename__ = "ignored_recurring_expenses"
    __table_args__ = (
        UniqueConstraint(
            "account_id",
            "normalized_name",
            name="uq_ignored_recurring_account_name",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    owner: Mapped[str] = mapped_column(String(20), default="me", index=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), index=True)
    normalized_name: Mapped[str] = mapped_column(String(300))
    display_name: Mapped[str] = mapped_column(String(300))

    account: Mapped["Account"] = relationship()


class EmailCardRule(Base, TimestampMixin):
    __tablename__ = "email_card_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    owner: Mapped[str] = mapped_column(String(20), default="me", index=True)
    card_account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), index=True)
    payment_account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), index=True)
    sender_pattern: Mapped[str | None] = mapped_column(String(200))
    subject_pattern: Mapped[str | None] = mapped_column(String(200))
    card_last4: Mapped[str | None] = mapped_column(String(4))
    lookback_days: Mapped[int] = mapped_column(Integer, default=30)
    auto_pay: Mapped[bool] = mapped_column(Boolean, default=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    statement_password: Mapped[str | None] = mapped_column(Text)

    card_account: Mapped["Account"] = relationship(foreign_keys=[card_account_id])
    payment_account: Mapped["Account"] = relationship(foreign_keys=[payment_account_id])


class EmailImportRecord(Base, TimestampMixin):
    __tablename__ = "email_import_records"
    __table_args__ = (
        UniqueConstraint("provider", "provider_message_id", name="uq_email_provider_message"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    provider: Mapped[str] = mapped_column(String(20), default="gmail")
    provider_message_id: Mapped[str] = mapped_column(String(200), index=True)
    rule_id: Mapped[int | None] = mapped_column(ForeignKey("email_card_rules.id"), index=True)
    message_date: Mapped[datetime | None] = mapped_column(DateTime)
    sender: Mapped[str | None] = mapped_column(String(300))
    subject: Mapped[str | None] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(30), default="processed", index=True)
    imported_transactions: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)

    rule: Mapped["EmailCardRule | None"] = relationship()


class CreditCardBill(Base, TimestampMixin):
    __tablename__ = "credit_card_bills"
    __table_args__ = (
        UniqueConstraint("rule_id", "due_date", "amount_due", name="uq_card_bill_rule_due_amount"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    rule_id: Mapped[int] = mapped_column(ForeignKey("email_card_rules.id"), index=True)
    card_account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), index=True)
    payment_account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), index=True)
    statement_date: Mapped[date | None] = mapped_column(Date)
    due_date: Mapped[date] = mapped_column(Date, index=True)
    amount_due: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    currency: Mapped[str] = mapped_column(String(3), default="TWD")
    status: Mapped[str] = mapped_column(String(30), default="pending", index=True)
    source_message_id: Mapped[str | None] = mapped_column(String(200))
    transfer_link_id: Mapped[int | None] = mapped_column(ForeignKey("transfer_links.id"))
    last_error: Mapped[str | None] = mapped_column(Text)

    rule: Mapped["EmailCardRule"] = relationship()
    card_account: Mapped["Account"] = relationship(foreign_keys=[card_account_id])
    payment_account: Mapped["Account"] = relationship(foreign_keys=[payment_account_id])
    transfer_link: Mapped["TransferLink | None"] = relationship()


class ValuationSnapshot(Base, TimestampMixin):
    __tablename__ = "valuation_snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    snapshot_date: Mapped[date] = mapped_column(Date, index=True)
    owner: Mapped[str] = mapped_column(String(20), default="all", index=True)
    assets: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    liabilities: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    net_worth: Mapped[Decimal] = mapped_column(Numeric(18, 2))


class AppSetting(Base, TimestampMixin):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[str] = mapped_column(Text)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
