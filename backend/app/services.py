from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import time
import unicodedata
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import urlencode

import httpx
import pandas as pd
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import Date as SQLDate
from sqlalchemy import DateTime as SQLDateTime
from sqlalchemy import Numeric as SQLNumeric
from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.orm import Session

from .database import (
    APP_MODE,
    Account,
    AppSetting,
    BalanceSnapshot,
    Budget,
    Category,
    ClassificationRule,
    FxRate,
    Goal,
    Position,
    PriceSnapshot,
    RecurringExpense,
    Transaction,
    TransferLink,
    ValuationSnapshot,
    DATA_DIR,
)


ZERO = Decimal("0")
ONE = Decimal("1")
OWNER_LABELS = {"me": "我", "partner": "女友", "shared": "共同"}

DEFAULT_CATEGORIES = [
    ("薪資", "income", False, "#22c55e", "briefcase"),
    ("獎金與其他收入", "income", False, "#10b981", "sparkles"),
    ("餐飲", "expense", True, "#f97316", "utensils"),
    ("交通", "expense", True, "#3b82f6", "bus"),
    ("居住", "expense", True, "#8b5cf6", "house"),
    ("水電與通訊", "expense", True, "#6366f1", "wifi"),
    ("醫療", "expense", True, "#ef4444", "heart-pulse"),
    ("教育", "expense", True, "#0ea5e9", "book-open"),
    ("購物", "expense", False, "#ec4899", "shopping-bag"),
    ("娛樂", "expense", False, "#a855f7", "gamepad"),
    ("訂閱", "expense", False, "#14b8a6", "repeat"),
    ("保險", "expense", True, "#64748b", "shield"),
    ("稅務", "expense", True, "#78716c", "landmark"),
    ("利息與費用", "expense", True, "#dc2626", "receipt"),
    ("未分類", "expense", False, "#94a3b8", "circle"),
]

DEFAULT_RULES = [
    ("薪資", "薪資", "income"),
    ("salary", "薪資", "income"),
    ("國外交易手續費", "利息與費用", "expense"),
    ("手續費", "利息與費用", "expense"),
    ("年費", "利息與費用", "expense"),
    ("uber", "交通", "expense"),
    ("高鐵", "交通", "expense"),
    ("台鐵", "交通", "expense"),
    ("臺灣鐵路", "交通", "expense"),
    ("捷運", "交通", "expense"),
    ("wemo", "交通", "expense"),
    ("加油站", "交通", "expense"),
    ("中油", "交通", "expense"),
    ("全聯", "餐飲", "expense"),
    ("家樂福", "餐飲", "expense"),
    ("便利商店", "餐飲", "expense"),
    ("統一超商", "餐飲", "expense"),
    ("7-eleven", "餐飲", "expense"),
    ("萊爾富", "餐飲", "expense"),
    ("ok超商", "餐飲", "expense"),
    ("麥當勞", "餐飲", "expense"),
    ("mcdonald", "餐飲", "expense"),
    ("黑松", "餐飲", "expense"),
    ("星巴克", "餐飲", "expense"),
    ("蝦皮", "購物", "expense"),
    ("shopee", "購物", "expense"),
    ("momo", "購物", "expense"),
    ("pchome", "購物", "expense"),
    ("東大騎士", "購物", "expense"),
    ("steam", "娛樂", "expense"),
    ("健身工廠", "娛樂", "expense"),
    ("運動中心", "娛樂", "expense"),
    ("netflix", "訂閱", "expense"),
    ("spotify", "訂閱", "expense"),
    ("apple.com/bill", "訂閱", "expense"),
    ("youtube", "訂閱", "expense"),
    ("disney+", "訂閱", "expense"),
    ("adobe", "訂閱", "expense"),
    ("藥局", "醫療", "expense"),
    ("診所", "醫療", "expense"),
    ("醫院", "醫療", "expense"),
    ("電信", "水電與通訊", "expense"),
    ("電費", "水電與通訊", "expense"),
    ("水費", "水電與通訊", "expense"),
    ("瓦斯", "水電與通訊", "expense"),
]

BINANCE_SPOT_SYMBOLS = {
    "bitcoin": "BTCUSDT",
    "ethereum": "ETHUSDT",
    "solana": "SOLUSDT",
    "ripple": "XRPUSDT",
    "binancecoin": "BNBUSDT",
    "cardano": "ADAUSDT",
    "dogecoin": "DOGEUSDT",
    "polkadot": "DOTUSDT",
    "chainlink": "LINKUSDT",
    "litecoin": "LTCUSDT",
}

BINANCE_ASSET_SYMBOLS = {
    "BTC": "bitcoin",
    "ETH": "ethereum",
    "SOL": "solana",
    "XRP": "ripple",
    "BNB": "binancecoin",
    "ADA": "cardano",
    "DOGE": "dogecoin",
    "DOT": "polkadot",
    "LINK": "chainlink",
    "LTC": "litecoin",
}
BINANCE_CASH_ASSETS = {"USDT", "USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD"}
BINANCE_MIN_POSITION_VALUE_TWD = Decimal("10")
BINANCE_FULL_SYNC_INTERVAL = timedelta(hours=1)
BINANCE_COST_SYNC_INTERVAL = timedelta(hours=24)
BINANCE_DEFAULT_RATE_LIMIT_BACKOFF = timedelta(minutes=15)


def decimal_value(value: Any, default: Decimal = ZERO) -> Decimal:
    if value is None:
        return default
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return default


def seed_defaults(db: Session) -> None:
    if db.scalar(select(func.count(Category.id))) == 0:
        for name, kind, essential, color, icon in DEFAULT_CATEGORIES:
            db.add(
                Category(
                    name=name,
                    kind=kind,
                    essential=essential,
                    color=color,
                    icon=icon,
                )
            )
        db.commit()

    categories = {item.name: item.id for item in db.scalars(select(Category)).all()}
    existing_keywords = {
        keyword.lower()
        for keyword in db.scalars(select(ClassificationRule.keyword)).all()
    }
    added_rules = 0
    for keyword, category, kind in DEFAULT_RULES:
        if keyword.lower() in existing_keywords or category not in categories:
            continue
        db.add(
            ClassificationRule(
                keyword=keyword,
                category_id=categories[category],
                transaction_kind=kind,
            )
        )
        existing_keywords.add(keyword.lower())
        added_rules += 1
    if added_rules:
        db.commit()


def merge_duplicate_positions(db: Session) -> int:
    groups: dict[tuple[int, str, str], list[Position]] = defaultdict(list)
    for position in db.scalars(
        select(Position)
        .where(Position.archived.is_(False))
        .order_by(Position.account_id, Position.market, Position.symbol, Position.id)
    ).all():
        key = (position.account_id, position.market, position.symbol)
        groups[key].append(position)

    merged = 0
    for rows in groups.values():
        if len(rows) < 2:
            continue

        primary = rows[0]
        total_quantity = sum(decimal_value(row.quantity) for row in rows)
        if total_quantity <= 0:
            continue

        total_cost = sum(decimal_value(row.quantity) * decimal_value(row.average_cost) for row in rows)
        primary.quantity = total_quantity
        primary.average_cost = total_cost / total_quantity

        latest_named = next((row for row in reversed(rows) if row.name), None)
        if latest_named:
            primary.name = latest_named.name

        latest_manual = next((row for row in reversed(rows) if row.manual_price is not None), None)
        if latest_manual:
            primary.manual_price = latest_manual.manual_price

        primary.currency = rows[-1].currency
        for duplicate in rows[1:]:
            duplicate.archived = True
            merged += 1

    if merged:
        db.flush()
        record_valuation(db)
        db.commit()
    return merged

def transaction_fingerprint(
    account_id: int, transaction_date: date, amount: Decimal, description: str
) -> str:
    normalized = " ".join(description.lower().split())
    raw = f"{account_id}|{transaction_date.isoformat()}|{amount.normalize()}|{normalized}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def classify_transaction(db: Session, description: str, amount: Decimal) -> tuple[int | None, str]:
    normalized_description = unicodedata.normalize("NFKC", description).casefold()
    rules = db.scalars(
        select(ClassificationRule)
        .where(ClassificationRule.enabled.is_(True))
        .order_by(ClassificationRule.priority.asc(), ClassificationRule.id.asc())
    ).all()
    for rule in rules:
        normalized_keyword = unicodedata.normalize("NFKC", rule.keyword).casefold()
        if normalized_keyword in normalized_description:
            return rule.category_id, rule.transaction_kind
    category_kind = "income" if amount > 0 else "expense"
    fallback = db.scalar(
        select(Category).where(
            Category.name == ("獎金與其他收入" if amount > 0 else "未分類")
        )
    )
    return (fallback.id if fallback else None), category_kind


def reclassify_uncategorized_transactions(db: Session, owner: str = "all") -> dict[str, int]:
    uncategorized = db.scalar(select(Category).where(Category.name == "未分類"))
    if not uncategorized:
        return {"updated": 0, "remaining": 0}

    query = select(Transaction).where(
        or_(Transaction.category_id.is_(None), Transaction.category_id == uncategorized.id),
        Transaction.transaction_kind.notin_(["transfer", "investment", "debt_principal"]),
    )
    if owner != "all":
        query = query.join(Account).where(Account.owner == owner)

    rows = db.scalars(query).all()
    updated = 0
    for row in rows:
        category_id, kind = classify_transaction(db, row.description, decimal_value(row.amount))
        if category_id and category_id != uncategorized.id:
            row.category_id = category_id
            row.transaction_kind = kind
            updated += 1

    if updated:
        db.commit()

    remaining_query = select(func.count(Transaction.id)).where(
        or_(Transaction.category_id.is_(None), Transaction.category_id == uncategorized.id),
        Transaction.transaction_kind.notin_(["transfer", "investment", "debt_principal"]),
    )
    if owner != "all":
        remaining_query = remaining_query.join(Account).where(Account.owner == owner)
    remaining = int(db.scalar(remaining_query) or 0)
    return {"updated": updated, "remaining": remaining}


def latest_fx_rate(db: Session, currency: str, on_date: date | None = None) -> tuple[Decimal, bool]:
    currency = currency.upper()
    if currency == "TWD":
        return ONE, False
    query = select(FxRate).where(FxRate.currency == currency)
    if on_date:
        query = query.where(FxRate.rate_date <= on_date)
    rate = db.scalar(query.order_by(FxRate.rate_date.desc(), FxRate.manual.desc()))
    if rate:
        return decimal_value(rate.rate_to_twd, ONE), rate.source == "fallback"
    return ONE, True


def create_balance_snapshot(
    db: Session,
    account: Account,
    amount: Decimal,
    snapshot_date: date,
    fx_rate: Decimal | None = None,
    source: str = "manual",
) -> BalanceSnapshot:
    rate, _ = latest_fx_rate(db, account.currency, snapshot_date)
    if fx_rate is not None:
        rate = fx_rate
    snapshot = BalanceSnapshot(
        account_id=account.id,
        snapshot_date=snapshot_date,
        amount=amount,
        currency=account.currency,
        fx_rate=rate,
        base_amount=amount * rate,
        source=source,
    )
    db.add(snapshot)
    db.flush()
    return snapshot


def get_latest_balance(db: Session, account_id: int) -> BalanceSnapshot | None:
    return db.scalar(
        select(BalanceSnapshot)
        .where(BalanceSnapshot.account_id == account_id)
        .order_by(BalanceSnapshot.snapshot_date.desc(), BalanceSnapshot.id.desc())
    )


def get_latest_price(db: Session, market: str, symbol: str) -> PriceSnapshot | None:
    return db.scalar(
        select(PriceSnapshot)
        .where(
            PriceSnapshot.market == market,
            PriceSnapshot.symbol == symbol,
        )
        .order_by(PriceSnapshot.price_date.desc(), PriceSnapshot.updated_at.desc())
    )


def _position_cost_setting_key(position_id: int) -> str:
    return f"position:{position_id}:cost_status"


def set_position_cost_status(db: Session, position: Position, status: str) -> None:
    if status not in {"automatic", "calculated", "confirmed", "estimated", "missing"}:
        raise ValueError("不支援的成本狀態")
    _set_setting_value(db, _position_cost_setting_key(position.id), status)


def position_cost_status(
    db: Session,
    position: Position,
    price_source: str,
) -> tuple[str, str]:
    average_cost = decimal_value(position.average_cost)
    stored = _get_setting_value(db, _position_cost_setting_key(position.id))
    if average_cost <= 0:
        return "missing", "尚未填入成本，損益暫時無法正確計算。"
    if stored == "automatic":
        return "automatic", "已由交易所可讀取的成交或合約資料自動計算。"
    if stored == "calculated":
        return "calculated", "已依財務居內的買入紀錄自動計算。"
    if stored == "confirmed":
        return "confirmed", "這筆成本已由你確認。"
    if stored == "estimated":
        return "estimated", "交易所只提供餘額或持倉，無法完整還原歷史成本，請確認一次。"

    institution = str(getattr(position.account, "institution", "") or "").casefold()
    is_binance_position = (
        "binance" in institution
        or "幣安" in institution
        or price_source.startswith("Binance")
    )
    if price_source == "Binance Futures":
        return "automatic", "已使用 Binance 合約回傳的進場成本。"
    if is_binance_position:
        return "estimated", "交易所只提供餘額或持倉，無法完整還原歷史成本，請確認一次。"
    return "confirmed", "這筆成本已有完整資料。"


def position_summary(db: Session, position: Position) -> dict[str, Any]:
    latest = get_latest_price(db, position.market, position.symbol)
    if position.manual_price is not None:
        price = decimal_value(position.manual_price)
        price_date = date.today()
        source = "manual"
        stale = False
    elif latest:
        price = decimal_value(latest.price)
        price_date = latest.price_date
        source = latest.source
        stale = latest.stale or (date.today() - latest.price_date).days > 3
    else:
        price = ZERO
        price_date = None
        source = "missing"
        stale = True

    rate, fx_estimated = latest_fx_rate(db, position.currency)
    quantity = decimal_value(position.quantity)
    value_original = quantity * price
    value_twd = value_original * rate
    cost_twd = quantity * decimal_value(position.average_cost) * rate
    cost_status, cost_note = position_cost_status(db, position, source)
    return {
        "id": position.id,
        "account_id": position.account_id,
        "account_name": position.account.name if position.account else "",
        "owner": getattr(position.account, "owner", None) or "me",
        "owner_label": OWNER_LABELS.get(getattr(position.account, "owner", None) or "me", "我"),
        "market": position.market,
        "symbol": position.symbol,
        "name": position.name,
        "quantity": float(quantity),
        "average_cost": float(decimal_value(position.average_cost)),
        "currency": position.currency,
        "manual_price": float(position.manual_price) if position.manual_price is not None else None,
        "price": float(price),
        "price_date": price_date.isoformat() if price_date else None,
        "price_source": source,
        "stale": stale,
        "fx_estimated": fx_estimated,
        "market_value": float(value_original),
        "market_value_twd": float(value_twd),
        "cost_twd": float(cost_twd),
        "cost_status": cost_status,
        "cost_note": cost_note,
        "profit_twd": float(value_twd - cost_twd),
        "profit_pct": float((value_twd / cost_twd - 1) * 100) if cost_twd else None,
    }


def account_summary(db: Session, account: Account) -> dict[str, Any]:
    latest = get_latest_balance(db, account.id)
    cash_twd = decimal_value(latest.base_amount) if latest else ZERO
    owner = getattr(account, "owner", None) or "me"
    positions = db.scalars(
        select(Position).where(
            Position.account_id == account.id, Position.archived.is_(False)
        )
    ).all()
    position_values = [position_summary(db, item) for item in positions]
    investments_twd = sum((Decimal(str(item["market_value_twd"])) for item in position_values), ZERO)
    auto_base_twd = (
        decimal_value(account.auto_balance_base_twd)
        if account.auto_balance_base_twd is not None
        else None
    )
    if auto_base_twd is not None:
        total_twd = auto_base_twd + investments_twd
        valuation_mode = "auto_estimate"
    elif account.balance_includes_positions:
        total_twd = cash_twd
        valuation_mode = "manual_total"
    else:
        total_twd = cash_twd + investments_twd
        valuation_mode = "cash_plus_positions"
    return {
        "id": account.id,
        "name": account.name,
        "institution": account.institution,
        "account_type": account.account_type,
        "nature": account.nature,
        "currency": account.currency,
        "owner": owner,
        "owner_label": OWNER_LABELS.get(owner, owner),
        "is_liquid": account.is_liquid,
        "balance_includes_positions": account.balance_includes_positions,
        "auto_balance_base_twd": float(auto_base_twd) if auto_base_twd is not None else None,
        "valuation_mode": valuation_mode,
        "archived": account.archived,
        "note": account.note,
        "balance": float(decimal_value(latest.amount)) if latest else 0,
        "balance_twd": float(cash_twd),
        "balance_date": latest.snapshot_date.isoformat() if latest else None,
        "investments_twd": float(investments_twd),
        "total_twd": float(total_twd),
        "positions_count": len(position_values),
    }


def _date_months(count: int = 6) -> list[str]:
    today = date.today()
    months: list[str] = []
    year, month = today.year, today.month
    for _ in range(count):
        months.append(f"{year:04d}-{month:02d}")
        month -= 1
        if month == 0:
            year -= 1
            month = 12
    return list(reversed(months))


def calculate_dashboard(db: Session, owner: str = "all") -> dict[str, Any]:
    account_query = select(Account).where(Account.archived.is_(False)).order_by(Account.id)
    if owner != "all":
        account_query = account_query.where(Account.owner == owner)
    accounts = db.scalars(account_query).all()
    account_items = [account_summary(db, item) for item in accounts]
    assets = sum(
        (Decimal(str(item["total_twd"])) for item in account_items if item["nature"] == "asset"),
        ZERO,
    )
    liabilities = sum(
        (
            abs(Decimal(str(item["total_twd"])))
            for item in account_items
            if item["nature"] == "liability"
        ),
        ZERO,
    )
    net_worth = assets - liabilities

    today = date.today()
    month_start = today.replace(day=1)
    transaction_query = select(Transaction).join(Account).where(
        Transaction.transaction_date >= month_start
    )
    if owner != "all":
        transaction_query = transaction_query.where(Account.owner == owner)
    month_transactions = db.scalars(transaction_query).all()
    income = sum(
        (
            decimal_value(tx.base_amount)
            for tx in month_transactions
            if tx.transaction_kind == "income"
        ),
        ZERO,
    )
    expenses = sum(
        (
            abs(decimal_value(tx.base_amount))
            for tx in month_transactions
            if tx.transaction_kind in {"expense", "interest"}
        ),
        ZERO,
    )
    savings = income - expenses
    savings_rate = (savings / income * 100) if income > 0 else None

    allocation: dict[str, Decimal] = defaultdict(lambda: ZERO)
    for item in account_items:
        if item["nature"] == "asset":
            allocation[item["account_type"]] += Decimal(str(item["total_twd"]))

    category_query = (
        select(Category.name, Category.color, func.sum(func.abs(Transaction.base_amount)))
        .join(Transaction, Transaction.category_id == Category.id)
        .join(Account, Transaction.account_id == Account.id)
        .where(
            Transaction.transaction_date >= month_start,
            Transaction.transaction_kind.in_(["expense", "interest"]),
        )
        .group_by(Category.id)
        .order_by(func.sum(func.abs(Transaction.base_amount)).desc())
    )
    if owner != "all":
        category_query = category_query.where(Account.owner == owner)
    category_rows = db.execute(category_query).all()

    months = _date_months(6)
    trend = []
    for month in months:
        year, month_number = map(int, month.split("-"))
        start = date(year, month_number, 1)
        end = (
            date(year + 1, 1, 1)
            if month_number == 12
            else date(year, month_number + 1, 1)
        )
        month_query = select(Transaction).join(Account).where(
            Transaction.transaction_date >= start, Transaction.transaction_date < end
        )
        if owner != "all":
            month_query = month_query.where(Account.owner == owner)
        rows = db.scalars(month_query).all()
        month_income = sum(
            (decimal_value(item.base_amount) for item in rows if item.transaction_kind == "income"),
            ZERO,
        )
        month_expense = sum(
            (
                abs(decimal_value(item.base_amount))
                for item in rows
                if item.transaction_kind in {"expense", "interest"}
            ),
            ZERO,
        )
        trend.append(
            {"month": month, "income": float(month_income), "expense": float(month_expense)}
        )

    snapshots = db.scalars(
        select(ValuationSnapshot)
        .where(ValuationSnapshot.owner == owner)
        .order_by(ValuationSnapshot.snapshot_date.asc())
        .limit(180)
    ).all()
    return {
        "owner": owner,
        "owner_label": OWNER_LABELS.get(owner, "全部"),
        "assets": float(assets),
        "liabilities": float(liabilities),
        "net_worth": float(net_worth),
        "month_income": float(income),
        "month_expense": float(expenses),
        "month_savings": float(savings),
        "savings_rate": float(savings_rate) if savings_rate is not None else None,
        "accounts": account_items,
        "allocation": [
            {"name": key, "value": float(value)} for key, value in allocation.items() if value
        ],
        "category_expenses": [
            {"name": name, "color": color, "value": float(value or 0)}
            for name, color, value in category_rows
        ],
        "cashflow_trend": trend,
        "net_worth_trend": [
            {
                "date": item.snapshot_date.isoformat(),
                "assets": float(item.assets),
                "liabilities": float(item.liabilities),
                "net_worth": float(item.net_worth),
            }
            for item in snapshots
        ],
        "updated_at": datetime.now().isoformat(),
    }


def _shift_month_start(value: date, offset: int) -> date:
    month_index = value.year * 12 + value.month - 1 + offset
    return date(month_index // 12, month_index % 12 + 1, 1)


def _recurring_display_name(description: str) -> str:
    normalized = unicodedata.normalize("NFKC", description or "").strip()
    normalized = re.sub(r"\s*[（(](?:本金|利息|沖抵本金)[）)]\s*$", "", normalized)
    return re.sub(r"\s+", " ", normalized).strip()


def calculate_spending_analysis(
    db: Session, month: str, owner: str = "all"
) -> dict[str, Any]:
    try:
        year, month_number = map(int, month.split("-"))
        month_start = date(year, month_number, 1)
    except (TypeError, ValueError) as exc:
        raise ValueError("月份格式必須是 YYYY-MM") from exc
    month_end = _shift_month_start(month_start, 1)

    month_query = select(Transaction).join(Account).where(
        Transaction.transaction_date >= month_start,
        Transaction.transaction_date < month_end,
        Transaction.base_amount < 0,
        Transaction.transaction_kind.in_(["expense", "interest"]),
    )
    if owner != "all":
        month_query = month_query.where(Account.owner == owner)
    month_rows = db.scalars(month_query).all()

    category_totals: dict[tuple[str, str], Decimal] = defaultdict(lambda: ZERO)
    month_expense = ZERO
    for row in month_rows:
        amount = abs(decimal_value(row.base_amount))
        month_expense += amount
        category_name = row.category.name if row.category else "未分類"
        category_color = row.category.color if row.category else "#94a3b8"
        category_totals[(category_name, category_color)] += amount

    history_start = _shift_month_start(month_start, -5)
    recurring_query = select(Transaction).join(Account).where(
        Transaction.transaction_date >= history_start,
        Transaction.transaction_date < month_end,
        Transaction.base_amount < 0,
        Transaction.transaction_kind.in_(["expense", "interest", "debt_principal"]),
    )
    if owner != "all":
        recurring_query = recurring_query.where(Account.owner == owner)
    recurring_rows = db.scalars(recurring_query).all()

    groups: dict[tuple[int, str], dict[str, Any]] = {}
    for row in recurring_rows:
        display_name = _recurring_display_name(row.description)
        if not display_name:
            continue
        key = (row.account_id, display_name.casefold())
        group = groups.setdefault(
            key,
            {
                "name": display_name,
                "account_id": row.account_id,
                "account_name": row.account.name,
                "months": defaultdict(lambda: {"amount": ZERO, "count": 0}),
                "categories": defaultdict(int),
                "has_loan_principal": False,
                "latest_date": row.transaction_date,
            },
        )
        row_month = row.transaction_date.strftime("%Y-%m")
        group["months"][row_month]["amount"] += abs(decimal_value(row.base_amount))
        group["months"][row_month]["count"] += 1
        category_name = row.category.name if row.category else "未分類"
        group["categories"][category_name] += 1
        group["has_loan_principal"] = group["has_loan_principal"] or row.transaction_kind == "debt_principal"
        group["latest_date"] = max(group["latest_date"], row.transaction_date)

    previous_month = _shift_month_start(month_start, -1).strftime("%Y-%m")
    recurring_expenses: list[dict[str, Any]] = []
    for group in groups.values():
        monthly = group["months"]
        if len(monthly) < 2 or max(item["count"] for item in monthly.values()) > 2:
            continue
        if month not in monthly and previous_month not in monthly:
            continue
        amounts = [item["amount"] for item in monthly.values()]
        average = sum(amounts, ZERO) / Decimal(len(amounts))
        if average <= 0:
            continue
        if any(abs(amount - average) / average > Decimal("0.20") for amount in amounts):
            continue
        if group["has_loan_principal"]:
            category_name = "貸款"
        else:
            category_name = max(group["categories"], key=group["categories"].get)
        current_amount = monthly.get(month, {}).get("amount", ZERO)
        recurring_expenses.append(
            {
                "name": group["name"],
                "account_id": group["account_id"],
                "account_name": group["account_name"],
                "category_name": category_name,
                "average_amount": float(average),
                "current_month_amount": float(current_amount),
                "months_detected": len(monthly),
                "latest_date": group["latest_date"].isoformat(),
                "status": "recorded" if current_amount > 0 else "expected",
            }
        )

    custom_query = select(RecurringExpense).where(RecurringExpense.active.is_(True))
    if owner != "all":
        custom_query = custom_query.where(RecurringExpense.owner == owner)
    custom_rows = db.scalars(custom_query.order_by(RecurringExpense.id)).all()

    custom_keys = {
        (row.account_id, _recurring_display_name(row.name).casefold())
        for row in custom_rows
    }
    recurring_expenses = [
        item
        for item in recurring_expenses
        if (item.get("account_id"), _recurring_display_name(item["name"]).casefold())
        not in custom_keys
        and (None, _recurring_display_name(item["name"]).casefold())
        not in custom_keys
    ]

    for row in custom_rows:
        normalized_name = _recurring_display_name(row.name).casefold()
        matching_rows = [
            transaction
            for transaction in month_rows
            if (row.account_id is None or transaction.account_id == row.account_id)
            and _recurring_display_name(transaction.description).casefold()
            == normalized_name
        ]
        current_amount = sum(
            (abs(decimal_value(transaction.base_amount)) for transaction in matching_rows),
            ZERO,
        )
        recurring_expenses.append(
            {
                "id": row.id,
                "name": row.name,
                "account_id": row.account_id,
                "account_name": row.account.name if row.account else "未指定帳戶",
                "category_id": row.category_id,
                "category_name": row.category.name if row.category else "自訂",
                "owner": row.owner,
                "average_amount": float(row.amount),
                "current_month_amount": float(current_amount),
                "months_detected": 0,
                "latest_date": max(
                    (transaction.transaction_date for transaction in matching_rows),
                    default=None,
                ),
                "status": "recorded" if current_amount > 0 else "expected",
                "source": "custom",
                "due_day": row.due_day,
                "note": row.note,
            }
        )

    for item in recurring_expenses:
        item.setdefault("id", None)
        item.setdefault("account_id", None)
        item.setdefault("category_id", None)
        item.setdefault("owner", None)
        item.setdefault("source", "detected")
        item.setdefault("due_day", None)
        item.setdefault("note", None)

    recurring_expenses.sort(key=lambda item: item["average_amount"], reverse=True)
    return {
        "month": month,
        "owner": owner,
        "month_expense": float(month_expense),
        "category_expenses": [
            {"name": name, "color": color, "value": float(value)}
            for (name, color), value in sorted(
                category_totals.items(), key=lambda item: item[1], reverse=True
            )
        ],
        "recurring_expenses": recurring_expenses,
        "estimated_recurring_total": float(
            sum((Decimal(str(item["average_amount"])) for item in recurring_expenses), ZERO)
        ),
    }


def record_valuation(db: Session) -> ValuationSnapshot:
    today = date.today()
    snapshots: dict[str, ValuationSnapshot] = {}
    for owner in ("all", "me", "partner", "shared"):
        dashboard = calculate_dashboard(db, owner=owner)
        snapshot = db.scalar(
            select(ValuationSnapshot).where(
                ValuationSnapshot.snapshot_date == today,
                ValuationSnapshot.owner == owner,
            )
        )
        if not snapshot:
            snapshot = ValuationSnapshot(snapshot_date=today, owner=owner)
            db.add(snapshot)
        snapshot.assets = Decimal(str(dashboard["assets"]))
        snapshot.liabilities = Decimal(str(dashboard["liabilities"]))
        snapshot.net_worth = Decimal(str(dashboard["net_worth"]))
        snapshots[owner] = snapshot
    db.flush()
    return snapshots["all"]


def calculate_health_score(db: Session, owner: str = "all") -> dict[str, Any]:
    end = date.today()
    start = end - timedelta(days=90)
    transaction_query = select(Transaction).join(Account).where(
        Transaction.transaction_date >= start
    )
    if owner != "all":
        transaction_query = transaction_query.where(Account.owner == owner)
    transactions = db.scalars(transaction_query).all()
    income = sum(
        (decimal_value(tx.base_amount) for tx in transactions if tx.transaction_kind == "income"),
        ZERO,
    ) / Decimal("3")
    expenses = sum(
        (
            abs(decimal_value(tx.base_amount))
            for tx in transactions
            if tx.transaction_kind in {"expense", "interest"}
        ),
        ZERO,
    ) / Decimal("3")
    essential = sum(
        (
            abs(decimal_value(tx.base_amount))
            for tx in transactions
            if tx.transaction_kind in {"expense", "interest"}
            and tx.category
            and tx.category.essential
        ),
        ZERO,
    ) / Decimal("3")
    debt_payments = sum(
        (
            abs(decimal_value(tx.base_amount))
            for tx in transactions
            if tx.transaction_kind in {"debt_principal", "interest"}
        ),
        ZERO,
    ) / Decimal("3")
    liquid = ZERO
    liquid_query = select(Account).where(
        Account.archived.is_(False),
        Account.nature == "asset",
        Account.is_liquid.is_(True),
    )
    if owner != "all":
        liquid_query = liquid_query.where(Account.owner == owner)
    for account in db.scalars(liquid_query).all():
        liquid += Decimal(str(account_summary(db, account)["total_twd"]))

    current_month = end.strftime("%Y-%m")
    budget_total = (
        db.scalar(select(func.sum(Budget.amount)).where(Budget.month == current_month))
        if owner == "all"
        else None
    )
    current_start = end.replace(day=1)
    current_transaction_query = select(Transaction).join(Account).where(
        Transaction.transaction_date >= current_start
    )
    if owner != "all":
        current_transaction_query = current_transaction_query.where(Account.owner == owner)
    current_spend = sum(
        (
            abs(decimal_value(tx.base_amount))
            for tx in db.scalars(
                current_transaction_query
            ).all()
            if tx.transaction_kind in {"expense", "interest"}
        ),
        ZERO,
    )

    components = []

    def add_component(
        key: str, label: str, value: Decimal | None, score: Decimal | None, detail: str
    ) -> None:
        components.append(
            {
                "key": key,
                "label": label,
                "value": float(value) if value is not None else None,
                "score": float(max(ZERO, min(Decimal("20"), score))) if score is not None else None,
                "detail": detail,
            }
        )

    if income > 0:
        rate = (income - expenses) / income * 100
        add_component("savings", "儲蓄率", rate, rate, "20% 以上為滿分")
        debt_ratio = debt_payments / income * 100
        debt_score = (Decimal("50") - debt_ratio) / Decimal("30") * Decimal("20")
        add_component("debt", "債務支出比", debt_ratio, debt_score, "20% 以下為滿分")
        essential_ratio = essential / income * 100
        essential_score = (Decimal("80") - essential_ratio) / Decimal("30") * Decimal("20")
        add_component("essential", "必要支出比", essential_ratio, essential_score, "50% 以下為滿分")
    else:
        add_component("savings", "儲蓄率", None, None, "需要近 90 天收入資料")
        add_component("debt", "債務支出比", None, None, "需要近 90 天收入資料")
        add_component("essential", "必要支出比", None, None, "需要近 90 天收入資料")

    if essential > 0:
        emergency_months = liquid / essential
        add_component(
            "emergency",
            "緊急預備金",
            emergency_months,
            emergency_months / Decimal("6") * Decimal("20"),
            "6 個月以上為滿分",
        )
    else:
        add_component("emergency", "緊急預備金", None, None, "需要必要支出與流動資產資料")

    if budget_total and Decimal(str(budget_total)) > 0:
        ratio = current_spend / Decimal(str(budget_total)) * 100
        budget_score = (Decimal("130") - ratio) / Decimal("30") * Decimal("20")
        if ratio <= 100:
            budget_score = Decimal("20")
        add_component("budget", "預算遵守度", ratio, budget_score, "支出不超過預算為滿分")
    else:
        budget_detail = "個人範圍尚未支援獨立預算" if owner != "all" else "尚未設定本月預算"
        add_component("budget", "預算遵守度", None, None, budget_detail)

    available = [item for item in components if item["score"] is not None]
    overall = (
        sum(Decimal(str(item["score"])) for item in available) / (Decimal(len(available)) * 20) * 100
        if len(available) >= 3
        else None
    )
    return {
        "score": round(float(overall), 1) if overall is not None else None,
        "completeness": len(available),
        "components": components,
    }


def inspect_csv(content: bytes) -> dict[str, Any]:
    encoding = detect_encoding(content)
    frame = pd.read_csv(io.BytesIO(content), encoding=encoding, dtype=str, keep_default_na=False)
    return {
        "encoding": encoding,
        "columns": [str(item) for item in frame.columns],
        "sample": frame.head(5).to_dict(orient="records"),
        "total_rows": len(frame.index),
    }


def detect_encoding(content: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "big5", "cp950"):
        try:
            content.decode(encoding)
            return encoding
        except UnicodeDecodeError:
            continue
    return "latin1"


def parse_number(value: Any) -> Decimal:
    text = str(value or "").strip().replace(",", "").replace("$", "")
    if not text:
        return ZERO
    negative = text.startswith("(") and text.endswith(")")
    text = text.strip("()")
    number = decimal_value(text)
    return -number if negative else number


def parse_transaction_date(value: Any) -> date:
    text = str(value).strip()
    parts = text.replace(".", "/").replace("-", "/").split("/")
    if len(parts) == 3 and parts[0].isdigit() and int(parts[0]) < 1911:
        text = f"{int(parts[0]) + 1911}/{parts[1]}/{parts[2]}"
    parsed = pd.to_datetime(text, errors="raise")
    return parsed.date()


def _csv_balance_applied_key(account_id: int) -> str:
    return f"csv_balance_applied:{account_id}"


def _csv_balance_applied_ids(db: Session, account_id: int) -> set[int]:
    setting = db.get(AppSetting, _csv_balance_applied_key(account_id))
    if not setting or not setting.value:
        return set()
    try:
        values = json.loads(setting.value)
        return {int(value) for value in values}
    except (TypeError, ValueError, json.JSONDecodeError):
        return set()


def _store_csv_balance_applied_ids(
    db: Session, account_id: int, transaction_ids: set[int]
) -> None:
    key = _csv_balance_applied_key(account_id)
    setting = db.get(AppSetting, key)
    if not setting:
        setting = AppSetting(key=key, value="[]")
        db.add(setting)
    setting.value = json.dumps(sorted(transaction_ids), separators=(",", ":"))


def _pending_csv_balance_transactions(db: Session, account: Account) -> list[Transaction]:
    setting = db.get(AppSetting, _csv_balance_applied_key(account.id))
    if setting is None:
        legacy_balance_snapshot = db.scalar(
            select(BalanceSnapshot.id).where(
                BalanceSnapshot.account_id == account.id,
                BalanceSnapshot.source == "csv",
            )
        )
        if legacy_balance_snapshot is not None:
            return []
    applied_ids = _csv_balance_applied_ids(db, account.id)
    return [
        transaction
        for transaction in db.scalars(
            select(Transaction).where(
                Transaction.account_id == account.id,
                Transaction.source == "csv",
            )
        ).all()
        if transaction.id not in applied_ids
    ]


def _csv_transactions_balance_delta(
    db: Session, account: Account, transactions: list[Transaction]
) -> Decimal:
    balance_delta = ZERO
    for transaction in transactions:
        if transaction.currency == account.currency:
            transaction_delta = decimal_value(transaction.amount)
        else:
            account_rate, _ = latest_fx_rate(db, account.currency, transaction.transaction_date)
            transaction_delta = decimal_value(transaction.base_amount) / account_rate
        balance_delta += transaction_delta
    return balance_delta


def pending_csv_balance_status(db: Session, account: Account) -> dict[str, Any]:
    transactions = _pending_csv_balance_transactions(db, account)
    latest = get_latest_balance(db, account.id)
    current_amount = decimal_value(latest.amount) if latest else ZERO
    transaction_delta = _csv_transactions_balance_delta(db, account, transactions)
    balance_change = -transaction_delta if account.nature == "liability" else transaction_delta
    return {
        "account_id": account.id,
        "account_name": account.name,
        "currency": account.currency,
        "count": len(transactions),
        "balance_change": float(balance_change),
        "current_balance": float(current_amount),
        "balance_after": float(current_amount + balance_change),
    }


def apply_pending_csv_balance(db: Session, account: Account) -> dict[str, Any]:
    transactions = _pending_csv_balance_transactions(db, account)
    status = pending_csv_balance_status(db, account)
    if not transactions:
        return status

    latest = get_latest_balance(db, account.id)
    snapshot_date = max(
        [transaction.transaction_date for transaction in transactions]
        + ([latest.snapshot_date] if latest else [])
    )
    create_balance_snapshot(
        db,
        account,
        Decimal(str(status["balance_after"])),
        snapshot_date,
        source="csv_transactions",
    )
    applied_ids = _csv_balance_applied_ids(db, account.id)
    applied_ids.update(transaction.id for transaction in transactions)
    _store_csv_balance_applied_ids(db, account.id, applied_ids)
    if account.auto_balance_base_twd is not None:
        summary = account_summary(db, account)
        account.auto_balance_base_twd = Decimal(str(summary["balance_twd"])) - Decimal(
            str(summary["investments_twd"])
        )
    record_valuation(db)
    db.commit()
    return status


def import_csv(
    db: Session,
    content: bytes,
    account: Account,
    mapping: dict[str, str | None],
    commit: bool = True,
    adjust_balance: bool = True,
) -> dict[str, Any]:
    inspected = inspect_csv(content)
    frame = pd.read_csv(
        io.BytesIO(content),
        encoding=inspected["encoding"],
        dtype=str,
        keep_default_na=False,
    )
    date_column = mapping.get("date")
    description_column = mapping.get("description")
    if not date_column or not description_column:
        raise ValueError("必須對應日期與摘要欄位")
    if not mapping.get("amount") and not (mapping.get("debit") or mapping.get("credit")):
        raise ValueError("必須對應金額，或至少一個收入／支出欄位")

    starting_balance_snapshot = get_latest_balance(db, account.id)
    balance_before = (
        decimal_value(starting_balance_snapshot.amount)
        if starting_balance_snapshot
        else ZERO
    )

    imported = 0
    duplicates = 0
    failed: list[dict[str, Any]] = []
    preview: list[dict[str, Any]] = []
    latest_balance: tuple[date, Decimal] | None = None
    existing_by_fingerprint = {
        transaction.fingerprint: transaction
        for transaction in db.scalars(select(Transaction)).all()
    }
    balance_candidates: dict[str, Transaction] = {}

    for index, row in frame.iterrows():
        try:
            tx_date = parse_transaction_date(row[date_column])
            description = str(row[description_column]).strip() or "未提供摘要"
            if mapping.get("amount"):
                amount = parse_number(row[mapping["amount"]])
            else:
                credit = parse_number(row[mapping["credit"]]) if mapping.get("credit") else ZERO
                debit = parse_number(row[mapping["debit"]]) if mapping.get("debit") else ZERO
                amount = credit - abs(debit)
            currency = (
                str(row[mapping["currency"]]).strip().upper()
                if mapping.get("currency") and str(row[mapping["currency"]]).strip()
                else account.currency
            )
            rate, estimated = latest_fx_rate(db, currency, tx_date)
            category_id, kind = classify_transaction(db, description, amount)
            fingerprint = transaction_fingerprint(account.id, tx_date, amount, description)
            existing_transaction = existing_by_fingerprint.get(fingerprint)
            is_duplicate = existing_transaction is not None
            if is_duplicate:
                duplicates += 1
            record = {
                "row": int(index) + 2,
                "date": tx_date.isoformat(),
                "description": description,
                "amount": float(amount),
                "currency": currency,
                "kind": kind,
                "duplicate": is_duplicate,
            }
            if len(preview) < 50:
                preview.append(record)
            if commit and not is_duplicate:
                existing_transaction = Transaction(
                    account_id=account.id,
                    transaction_date=tx_date,
                    description=description,
                    amount=amount,
                    currency=currency,
                    fx_rate=rate,
                    base_amount=amount * rate,
                    fx_estimated=estimated,
                    transaction_kind=kind,
                    category_id=category_id,
                    fingerprint=fingerprint,
                    source="csv",
                )
                db.add(existing_transaction)
                existing_by_fingerprint[fingerprint] = existing_transaction
                imported += 1
            if commit and existing_transaction and existing_transaction.source == "csv":
                balance_candidates[fingerprint] = existing_transaction
            if mapping.get("balance") and str(row[mapping["balance"]]).strip():
                balance = parse_number(row[mapping["balance"]])
                if latest_balance is None or tx_date >= latest_balance[0]:
                    latest_balance = (tx_date, balance)
        except Exception as exc:
            failed.append({"row": int(index) + 2, "error": str(exc)})

    balance_adjusted = False
    balance_applied_transactions = 0
    balance_change = ZERO
    balance_after: Decimal | None = None
    balance_source = "unchanged"
    if commit and latest_balance:
        create_balance_snapshot(
            db, account, latest_balance[1], latest_balance[0], source="csv"
        )
        if (
            starting_balance_snapshot is None
            or latest_balance[0] >= starting_balance_snapshot.snapshot_date
        ):
            balance_after = latest_balance[1]
            balance_change = balance_after - balance_before
            balance_adjusted = balance_change != ZERO
            balance_source = "statement"
        else:
            # Keep an older statement as historical data without presenting it
            # as the account's new current balance.
            balance_after = balance_before
            balance_source = "historical_statement"
    if commit:
        db.flush()
        applied_ids = _csv_balance_applied_ids(db, account.id)
        candidate_transactions = [
            transaction
            for transaction in balance_candidates.values()
            if transaction.id is not None and transaction.id not in applied_ids
        ]
        if latest_balance:
            balance_applied_transactions = len(candidate_transactions)
            applied_ids.update(transaction.id for transaction in candidate_transactions)
        elif adjust_balance and candidate_transactions:
            latest = get_latest_balance(db, account.id)
            current_amount = decimal_value(latest.amount) if latest else ZERO
            balance_delta = _csv_transactions_balance_delta(
                db, account, candidate_transactions
            )

            balance_after = (
                current_amount - balance_delta
                if account.nature == "liability"
                else current_amount + balance_delta
            )
            snapshot_date = max(
                [transaction.transaction_date for transaction in candidate_transactions]
                + ([latest.snapshot_date] if latest else [])
            )
            create_balance_snapshot(
                db,
                account,
                balance_after,
                snapshot_date,
                source="csv_transactions",
            )
            if account.auto_balance_base_twd is not None:
                summary = account_summary(db, account)
                account.auto_balance_base_twd = Decimal(str(summary["balance_twd"])) - Decimal(
                    str(summary["investments_twd"])
                )
            balance_change = balance_after - current_amount
            balance_adjusted = balance_change != ZERO
            balance_applied_transactions = len(candidate_transactions)
            balance_source = "transactions"
            applied_ids.update(transaction.id for transaction in candidate_transactions)

        if candidate_transactions:
            _store_csv_balance_applied_ids(db, account.id, applied_ids)
        record_valuation(db)
        db.commit()
    else:
        db.rollback()
    return {
        "total_rows": len(frame.index),
        "imported": imported,
        "duplicates": duplicates,
        "failed": failed[:50],
        "preview": preview,
        "encoding": inspected["encoding"],
        "account_name": account.name,
        "account_nature": account.nature,
        "currency": account.currency,
        "balance_source": balance_source,
        "balance_before": float(balance_before),
        "balance_adjusted": balance_adjusted,
        "balance_applied_transactions": balance_applied_transactions,
        "balance_change": float(balance_change),
        "balance_after": float(balance_after) if balance_after is not None else None,
    }


def _upsert_price(
    db: Session,
    market: str,
    symbol: str,
    price_date: date,
    price: Decimal,
    currency: str,
    source: str,
) -> None:
    current = db.scalar(
        select(PriceSnapshot).where(
            PriceSnapshot.market == market,
            PriceSnapshot.symbol == symbol,
            PriceSnapshot.price_date == price_date,
        )
    )
    if not current:
        current = PriceSnapshot(
            market=market,
            symbol=symbol,
            price_date=price_date,
            price=price,
            currency=currency,
            source=source,
        )
        db.add(current)
    else:
        current.price = price
        current.currency = currency
        current.source = source
        current.stale = False


def _reuse_cached_market_price(
    db: Session,
    result: dict[str, Any],
    position: Position,
    label: str,
    reason: str,
) -> None:
    latest = get_latest_price(db, position.market, position.symbol)
    if latest:
        result["skipped"] += 1
        _record_market_result_item(result, "cached_items", position)
        result["warnings"].append(
            f"{label}：{reason}，已沿用 {latest.price_date.isoformat()} 的價格"
        )
        return
    result["errors"].append(f"{label}：{reason}，且目前沒有可沿用的價格")


def _record_market_result_item(
    result: dict[str, Any],
    key: str,
    position: Position,
) -> None:
    label = str(position.symbol or position.name or "未知標的")
    items = result.setdefault(key, [])
    if label not in items:
        items.append(label)


def _binance_setting_key(account_id: int, suffix: str) -> str:
    return f"binance:{account_id}:{suffix}"


BINANCE_GLOBAL_BACKOFF_KEY = "binance:backoff_until"


class BinanceRateLimitError(Exception):
    def __init__(self, message: str, retry_at: datetime):
        super().__init__(message)
        self.retry_at = retry_at


def _get_setting_value(db: Session, key: str) -> str:
    row = db.get(AppSetting, key)
    return row.value if row else ""


def _set_setting_value(db: Session, key: str, value: str) -> None:
    row = db.get(AppSetting, key)
    if not row:
        row = AppSetting(key=key, value="")
        db.add(row)
    row.value = value


def _credential_cipher() -> Fernet:
    secret = (
        os.getenv("FINANCE_CREDENTIAL_SECRET", "").strip()
        or os.getenv("FINANCE_AUTH_SECRET", "").strip()
        or os.getenv("FINANCE_APP_PASSWORD", "").strip()
    )
    if not secret:
        local_key_path = DATA_DIR / ".credential.key"
        if local_key_path.exists():
            secret = local_key_path.read_text(encoding="utf-8").strip()
        else:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            secret = secrets.token_urlsafe(48)
            local_key_path.write_text(secret, encoding="utf-8")
    key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode("utf-8")).digest())
    return Fernet(key)


def encrypt_credential(value: str) -> str:
    encrypted = _credential_cipher().encrypt(value.strip().encode("utf-8")).decode("ascii")
    return f"enc:v1:{encrypted}"


def decrypt_credential(value: str) -> str:
    if not value.startswith("enc:v1:"):
        raise ValueError("交易所連線憑證格式不正確，請重新連線")
    try:
        return _credential_cipher().decrypt(value.removeprefix("enc:v1:").encode("ascii")).decode("utf-8")
    except InvalidToken as exc:
        raise ValueError("交易所連線憑證無法解密，請重新連線") from exc


def binance_connection_statuses(db: Session) -> list[dict[str, Any]]:
    accounts = db.scalars(
        select(Account)
        .where(Account.account_type == "crypto", Account.archived.is_(False))
        .order_by(Account.name)
    ).all()
    result: list[dict[str, Any]] = []
    for account in accounts:
        api_key = _get_setting_value(db, _binance_setting_key(account.id, "api_key"))
        api_secret = _get_setting_value(db, _binance_setting_key(account.id, "api_secret"))
        result.append(
            {
                "account_id": account.id,
                "account_name": account.name,
                "owner": account.owner,
                "owner_label": OWNER_LABELS.get(account.owner, account.owner),
                "connected": bool(api_key and api_secret),
                "last_sync_at": _get_setting_value(
                    db, _binance_setting_key(account.id, "last_sync_at")
                ) or None,
                "last_cost_sync_at": _get_setting_value(
                    db, _binance_setting_key(account.id, "last_cost_sync_at")
                ) or None,
                "backoff_until": _get_setting_value(db, BINANCE_GLOBAL_BACKOFF_KEY) or None,
            }
        )
    return result


def disconnect_binance_account(db: Session, account_id: int) -> None:
    keys = [
        _binance_setting_key(account_id, suffix)
        for suffix in (
            "api_key",
            "api_secret",
            "last_sync_at",
            "last_cost_sync_at",
            "position_ids",
            "stock_trade_ids",
        )
    ]
    db.execute(delete(AppSetting).where(AppSetting.key.in_(keys)))
    db.commit()


def _binance_response_payload(response: httpx.Response) -> Any:
    try:
        payload = response.json()
    except Exception as exc:
        raise ValueError("幣安暫時沒有回傳可讀取的資料") from exc
    if response.is_error:
        detail = payload.get("msg") if isinstance(payload, dict) else None
        code = payload.get("code") if isinstance(payload, dict) else None
        if response.status_code in {418, 429} or code == -1003:
            retry_at = datetime.utcnow() + BINANCE_DEFAULT_RATE_LIMIT_BACKOFF
            banned_match = re.search(r"banned until\s+(\d{10,13})", str(detail or ""), re.IGNORECASE)
            if banned_match:
                timestamp = int(banned_match.group(1))
                if timestamp < 10_000_000_000:
                    timestamp *= 1000
                retry_at = datetime.fromtimestamp(timestamp / 1000, timezone.utc).replace(tzinfo=None)
            else:
                retry_after = response.headers.get("Retry-After", "").strip()
                try:
                    retry_at = datetime.utcnow() + timedelta(seconds=max(1, int(retry_after)))
                except ValueError:
                    if response.status_code == 418:
                        retry_at = datetime.utcnow() + timedelta(hours=1)
            retry_label = retry_at.replace(tzinfo=timezone.utc).astimezone(
                timezone(timedelta(hours=8))
            ).strftime("%Y/%m/%d %H:%M")
            raise BinanceRateLimitError(
                f"幣安暫時限制同步，系統會在 {retry_label} 後自動重試",
                retry_at,
            )
        if code == -1022:
            raise ValueError(
                "Binance 簽章驗證失敗。請確認 API Key 與 Secret Key 是同一次建立的一組；"
                "如果 Secret Key 已離開建立頁面，請刪除舊金鑰並重新建立 HMAC 金鑰。"
            )
        if code == -1021:
            raise ValueError("Binance 時間驗證失敗，請稍後再試；系統會重新取得 Binance 伺服器時間。")
        if code == -2015:
            raise ValueError("API Key 無效、權限不足，或限制了目前的 IP")
        raise ValueError(f"幣安連線失敗：{detail or response.status_code}")
    return payload


def _clean_binance_credential(value: str) -> str:
    """Remove whitespace and invisible formatting copied with Binance credentials."""
    normalized = unicodedata.normalize("NFKC", value or "")
    return "".join(
        char
        for char in normalized
        if not char.isspace() and unicodedata.category(char) != "Cf"
    )


def _binance_signed_query(
    api_secret: str,
    timestamp: int,
    *params: tuple[str, str],
) -> str:
    query_params = [*params, ("recvWindow", "5000"), ("timestamp", str(timestamp))]
    signature_payload = urlencode(query_params)
    signature = hmac.new(
        api_secret.encode("utf-8"),
        signature_payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{signature_payload}&signature={signature}"


def _binance_wallet_total(payload: Any) -> Decimal | None:
    if not isinstance(payload, list):
        return None
    active_wallets = [
        decimal_value(item.get("balance"))
        for item in payload
        if isinstance(item, dict) and item.get("activate") is not False
    ]
    return sum(active_wallets, ZERO) if active_wallets else ZERO


def _binance_spot_average_cost(
    trades: Any,
    asset: str,
    current_quantity: Decimal,
) -> Decimal | None:
    if not isinstance(trades, list) or not trades or current_quantity <= 0:
        return None

    running_quantity = ZERO
    running_cost = ZERO
    for item in sorted(
        (row for row in trades if isinstance(row, dict)),
        key=lambda row: (int(row.get("time") or 0), int(row.get("id") or 0)),
    ):
        quantity = decimal_value(item.get("qty"))
        quote_quantity = decimal_value(item.get("quoteQty"))
        if quantity <= 0:
            continue
        if quote_quantity <= 0:
            quote_quantity = quantity * decimal_value(item.get("price"))
        commission = decimal_value(item.get("commission"))
        commission_asset = str(item.get("commissionAsset") or "").upper()
        is_buyer = item.get("isBuyer") is True or str(item.get("isBuyer")).lower() == "true"

        if is_buyer:
            acquired_quantity = quantity - (commission if commission_asset == asset else ZERO)
            if acquired_quantity <= 0:
                continue
            running_quantity += acquired_quantity
            running_cost += quote_quantity
            if commission_asset == "USDT":
                running_cost += commission
            continue

        removed_quantity = quantity + (commission if commission_asset == asset else ZERO)
        if running_quantity <= 0 or removed_quantity > running_quantity:
            return None
        average_cost = running_cost / running_quantity
        running_quantity -= removed_quantity
        running_cost = max(ZERO, running_cost - average_cost * removed_quantity)

    tolerance = max(Decimal("0.00000001"), current_quantity * Decimal("0.0001"))
    if running_quantity <= 0 or abs(running_quantity - current_quantity) > tolerance:
        return None
    return running_cost / running_quantity if running_cost > 0 else None


def _fetch_binance_spot_snapshot(
    api_key: str,
    api_secret: str,
    *,
    include_cost_details: bool = True,
) -> tuple[
    list[dict[str, Any]],
    dict[str, Decimal],
    Decimal | None,
    list[dict[str, Any]],
    dict[str, str],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[str],
]:
    api_key = _clean_binance_credential(api_key)
    api_secret = _clean_binance_credential(api_secret)
    if not api_key or not api_secret:
        raise ValueError("請同時填入 Binance API Key 與 Secret Key。")
    headers = {
        "Accept": "application/json",
        "User-Agent": "FinanceHome/1.0",
        "X-MBX-APIKEY": api_key,
    }
    with httpx.Client(timeout=20, follow_redirects=True, headers=headers) as client:
        time_response = client.get("https://api.binance.com/api/v3/time")
        time_payload = _binance_response_payload(time_response)
        local_time = int(time.time() * 1000)
        timestamp = int(time_payload.get("serverTime") or local_time)
        server_time_offset = timestamp - local_time
        signed_query = _binance_signed_query(
            api_secret,
            timestamp,
            ("omitZeroBalances", "true"),
        )
        account_response = client.get(
            f"https://api.binance.com/api/v3/account?{signed_query}",
        )
        account_payload = _binance_response_payload(account_response)

        wallet_total_usdt: Decimal | None = None
        wallet_warnings: list[str] = []
        try:
            wallet_query = _binance_signed_query(
                api_secret,
                timestamp,
                ("quoteAsset", "USDT"),
            )
            wallet_response = client.get(
                f"https://api.binance.com/sapi/v1/asset/wallet/balance?{wallet_query}",
            )
            wallet_payload = _binance_response_payload(wallet_response)
            wallet_total_usdt = _binance_wallet_total(wallet_payload)
        except (ValueError, httpx.HTTPError):
            wallet_warnings.append(
                "暫時無法讀取資金與合約等錢包總額，本次先以現貨資產估算"
            )

        funding_balances: list[dict[str, Any]] = []
        try:
            funding_timestamp = int(time.time() * 1000) + server_time_offset
            funding_query = _binance_signed_query(api_secret, funding_timestamp)
            funding_response = client.post(
                f"https://api.binance.com/sapi/v1/asset/get-funding-asset?{funding_query}",
            )
            funding_payload = _binance_response_payload(funding_response)
            if isinstance(funding_payload, list):
                funding_balances = [
                    item
                    for item in funding_payload
                    if isinstance(item, dict)
                    and (
                        decimal_value(item.get("free"))
                        + decimal_value(item.get("locked"))
                        + decimal_value(item.get("freeze"))
                    )
                    > ZERO
                ]
        except (ValueError, httpx.HTTPError):
            wallet_warnings.append(
                "暫時無法讀取資金帳戶持倉明細，現貨與帳戶總值仍會正常同步"
            )

        equity_asset_map: dict[str, str] = {}
        if funding_balances:
            try:
                exchange_response = client.get(
                    "https://api.binance.com/sapi/v1/equity/market/exchangeInfo"
                )
                exchange_payload = _binance_response_payload(exchange_response)
                tokenized_response = client.get(
                    "https://api.binance.com/sapi/v1/equity/market/tokenized-assets"
                )
                tokenized_payload = _binance_response_payload(tokenized_response)

                def equity_rows(payload: Any) -> list[dict[str, Any]]:
                    if isinstance(payload, list):
                        return [item for item in payload if isinstance(item, dict)]
                    if not isinstance(payload, dict):
                        return []
                    for key in ("symbols", "assets", "data", "rows"):
                        rows = payload.get(key)
                        if isinstance(rows, list):
                            return [item for item in rows if isinstance(item, dict)]
                    return []

                for item in equity_rows(exchange_payload):
                    symbol = str(
                        item.get("symbol")
                        or item.get("ticker")
                        or item.get("underlyingAsset")
                        or ""
                    ).upper()
                    if symbol:
                        equity_asset_map[symbol] = symbol
                for item in equity_rows(tokenized_payload):
                    underlying = str(
                        item.get("underlyingAsset")
                        or item.get("underlyingSymbol")
                        or item.get("symbol")
                        or ""
                    ).upper()
                    tokenized = str(
                        item.get("tokenizedAsset")
                        or item.get("asset")
                        or item.get("token")
                        or ""
                    ).upper()
                    if underlying:
                        equity_asset_map[underlying] = underlying
                    if tokenized and underlying:
                        equity_asset_map[tokenized] = underlying
            except (ValueError, httpx.HTTPError):
                wallet_warnings.append(
                    "暫時無法取得 Binance 股票代號對照，既有同代號持倉仍會正常同步"
                )

        equity_trades: list[dict[str, Any]] = []
        if include_cost_details:
            try:
                # Binance Stocks Trading launched on 2026-07-20. Reading from its
                # first day lets us rebuild current share quantities from every
                # BUY and SELL fill because the API has no direct positions route.
                stock_history_start = int(
                    datetime(2026, 7, 20, tzinfo=timezone.utc).timestamp() * 1000
                )
                stock_history_end = int(time.time() * 1000) + server_time_offset
                page = 1
                while page <= 20:
                    trade_timestamp = int(time.time() * 1000) + server_time_offset
                    trade_query = _binance_signed_query(
                        api_secret,
                        trade_timestamp,
                        ("startTime", str(stock_history_start)),
                        ("endTime", str(stock_history_end)),
                        ("current", str(page)),
                        ("size", "100"),
                    )
                    trade_response = client.get(
                        f"https://api.binance.com/sapi/v1/equity/trade/history?{trade_query}"
                    )
                    trade_payload = _binance_response_payload(trade_response)
                    rows = (
                        trade_payload.get("rows", [])
                        if isinstance(trade_payload, dict)
                        else []
                    )
                    if not isinstance(rows, list):
                        break
                    equity_trades.extend(
                        item for item in rows if isinstance(item, dict)
                    )
                    total = int(trade_payload.get("total") or len(equity_trades))
                    if page * 100 >= total or not rows:
                        break
                    page += 1
            except (ValueError, httpx.HTTPError):
                wallet_warnings.append(
                    "暫時無法讀取 Binance 股票成交紀錄，既有股票持倉會先保留"
                )

        um_positions: list[dict[str, Any]] = []
        try:
            portfolio_timestamp = int(time.time() * 1000) + server_time_offset
            portfolio_query = _binance_signed_query(api_secret, portfolio_timestamp)
            portfolio_response = client.get(
                f"https://papi.binance.com/papi/v1/um/positionRisk?{portfolio_query}",
            )
            portfolio_payload = _binance_response_payload(portfolio_response)
            if isinstance(portfolio_payload, list):
                um_positions = [
                    item
                    for item in portfolio_payload
                    if isinstance(item, dict)
                    and decimal_value(item.get("positionAmt")) != ZERO
                ]

                if um_positions:
                    exchange_response = client.get(
                        "https://fapi.binance.com/fapi/v1/exchangeInfo"
                    )
                    exchange_payload = _binance_response_payload(exchange_response)
                    contract_info = {
                        str(item.get("symbol")): item
                        for item in exchange_payload.get("symbols", [])
                        if isinstance(item, dict) and item.get("symbol")
                    }
                    for item in um_positions:
                        info = contract_info.get(str(item.get("symbol")), {})
                        item["baseAsset"] = info.get("baseAsset")
                        item["contractType"] = info.get("contractType")
                        item["underlyingType"] = info.get("underlyingType")
        except (ValueError, httpx.HTTPError):
            wallet_warnings.append(
                "暫時無法讀取 Portfolio Margin 合約持倉，現貨與帳戶總值仍會正常同步"
            )

        prices_response = client.get("https://data-api.binance.vision/api/v3/ticker/price")
        prices_payload = _binance_response_payload(prices_response)

        prices_for_cost = {
            str(item.get("symbol")): decimal_value(item.get("price"))
            for item in prices_payload
            if isinstance(item, dict)
            and item.get("symbol")
            and decimal_value(item.get("price")) > 0
        }
        for item in account_payload.get("balances", []) if include_cost_details else []:
            if not isinstance(item, dict):
                continue
            asset = str(item.get("asset") or "").upper()
            quantity = decimal_value(item.get("free")) + decimal_value(item.get("locked"))
            pair = f"{asset}USDT"
            price = prices_for_cost.get(pair)
            if (
                not asset
                or asset in BINANCE_CASH_ASSETS
                or quantity <= 0
                or not price
                or quantity * price < Decimal("0.30")
            ):
                continue
            try:
                trade_timestamp = int(time.time() * 1000) + server_time_offset
                trades_query = _binance_signed_query(
                    api_secret,
                    trade_timestamp,
                    ("symbol", pair),
                    ("limit", "1000"),
                )
                trades_response = client.get(
                    f"https://api.binance.com/api/v3/myTrades?{trades_query}"
                )
                trades_payload = _binance_response_payload(trades_response)
                average_cost = _binance_spot_average_cost(
                    trades_payload,
                    asset,
                    quantity,
                )
                if average_cost is not None:
                    item["_average_cost"] = str(average_cost)
                    item["_cost_status"] = "automatic"
                elif trades_payload:
                    wallet_warnings.append(
                        f"{asset} 的成交數量與目前餘額不同，成本需確認一次"
                    )
            except (ValueError, httpx.HTTPError):
                wallet_warnings.append(
                    f"暫時無法讀取 {asset} 的現貨成交紀錄，成本維持原值"
                )

    balances = account_payload.get("balances", []) if isinstance(account_payload, dict) else []
    prices = {
        str(item.get("symbol")): decimal_value(item.get("price"))
        for item in prices_payload
        if isinstance(item, dict) and item.get("symbol") and decimal_value(item.get("price")) > 0
    }
    return (
        balances,
        prices,
        wallet_total_usdt,
        funding_balances,
        equity_asset_map,
        equity_trades,
        um_positions,
        wallet_warnings,
    )


def sync_binance_account(
    db: Session,
    account: Account,
    *,
    force: bool = False,
    api_key: str | None = None,
    api_secret: str | None = None,
    save_credentials: bool = False,
) -> dict[str, Any]:
    if account.account_type != "crypto" or account.nature != "asset":
        raise ValueError("只能把幣安連接到加密貨幣資產帳戶")

    backoff_value = _get_setting_value(db, BINANCE_GLOBAL_BACKOFF_KEY)
    if backoff_value:
        try:
            backoff_until = datetime.fromisoformat(backoff_value)
            if datetime.utcnow() < backoff_until:
                retry_label = backoff_until.replace(tzinfo=timezone.utc).astimezone(
                    timezone(timedelta(hours=8))
                ).strftime("%Y/%m/%d %H:%M")
                return {
                    "account_id": account.id,
                    "account_name": account.name,
                    "updated": False,
                    "skipped": True,
                    "last_sync_at": _get_setting_value(
                        db, _binance_setting_key(account.id, "last_sync_at")
                    ) or None,
                    "positions": account_summary(db, account)["positions_count"],
                    "warnings": [f"幣安限流暫停中，將於 {retry_label} 後自動重試"],
                }
            _set_setting_value(db, BINANCE_GLOBAL_BACKOFF_KEY, "")
            db.commit()
        except ValueError:
            _set_setting_value(db, BINANCE_GLOBAL_BACKOFF_KEY, "")
            db.commit()

    last_sync_key = _binance_setting_key(account.id, "last_sync_at")
    last_sync_value = _get_setting_value(db, last_sync_key)
    if not force and not api_key and last_sync_value:
        try:
            last_sync_at = datetime.fromisoformat(last_sync_value)
            if datetime.utcnow() - last_sync_at < BINANCE_FULL_SYNC_INTERVAL:
                return {
                    "account_id": account.id,
                    "account_name": account.name,
                    "updated": False,
                    "skipped": True,
                    "last_sync_at": last_sync_value,
                    "positions": account_summary(db, account)["positions_count"],
                    "warnings": [],
                }
        except ValueError:
            pass

    if not api_key:
        encrypted_key = _get_setting_value(db, _binance_setting_key(account.id, "api_key"))
        encrypted_secret = _get_setting_value(db, _binance_setting_key(account.id, "api_secret"))
        if not encrypted_key or not encrypted_secret:
            raise ValueError("這個交易所帳戶尚未連接幣安")
        api_key = decrypt_credential(encrypted_key)
        api_secret = decrypt_credential(encrypted_secret)

    last_cost_sync_key = _binance_setting_key(account.id, "last_cost_sync_at")
    last_cost_sync_value = _get_setting_value(db, last_cost_sync_key)
    include_cost_details = not last_cost_sync_value
    if last_cost_sync_value:
        try:
            include_cost_details = (
                datetime.utcnow() - datetime.fromisoformat(last_cost_sync_value)
                >= BINANCE_COST_SYNC_INTERVAL
            )
        except ValueError:
            include_cost_details = True

    try:
        (
            balances,
            prices,
            wallet_total_usdt,
            funding_balances,
            equity_asset_map,
            equity_trades,
            um_positions,
            wallet_warnings,
        ) = _fetch_binance_spot_snapshot(
            api_key,
            api_secret or "",
            include_cost_details=include_cost_details,
        )
    except BinanceRateLimitError as exc:
        db.rollback()
        _set_setting_value(
            db,
            BINANCE_GLOBAL_BACKOFF_KEY,
            exc.retry_at.isoformat(timespec="seconds"),
        )
        db.commit()
        raise ValueError(str(exc)) from exc
    except ValueError:
        raise
    except httpx.HTTPError as exc:
        raise ValueError("目前無法連上幣安，請稍後再同步") from exc
    usd_rate, usd_estimated = latest_fx_rate(db, "USD")
    if usd_estimated and usd_rate == ONE:
        raise ValueError("尚未設定美元匯率，請先到設定更新匯率")

    warnings: list[str] = list(wallet_warnings)
    cash_usd = ZERO
    positions_twd = ZERO
    seen_position_ids: set[int] = set()
    for item in balances:
        asset = str(item.get("asset") or "").upper()
        quantity = decimal_value(item.get("free")) + decimal_value(item.get("locked"))
        if not asset or quantity <= 0:
            continue
        if asset in BINANCE_CASH_ASSETS:
            cash_usd += quantity
            continue

        pair = f"{asset}USDT"
        price = prices.get(pair)
        if not price:
            warnings.append(f"{asset} 暫時沒有 USDT 報價，未列入總值")
            continue
        position_value_twd = quantity * price * usd_rate
        if position_value_twd < BINANCE_MIN_POSITION_VALUE_TWD:
            continue
        positions_twd += position_value_twd
        synced_average_cost = decimal_value(item.get("_average_cost"))
        synced_cost_status = str(item.get("_cost_status") or "estimated")
        symbol = BINANCE_ASSET_SYMBOLS.get(asset, f"binance-{asset.lower()}")
        position = db.scalar(
            select(Position).where(
                Position.account_id == account.id,
                Position.market == "CRYPTO",
                Position.symbol == symbol,
            )
        )
        if not position:
            position = Position(
                account_id=account.id,
                market="CRYPTO",
                symbol=symbol,
                name=asset,
                quantity=quantity,
                average_cost=synced_average_cost or price,
                currency="USD",
            )
            db.add(position)
            db.flush()
            set_position_cost_status(db, position, synced_cost_status)
        else:
            position.quantity = quantity
            position.name = position.name or asset
            position.currency = "USD"
            position.manual_price = None
            position.archived = False
            if synced_average_cost > 0:
                position.average_cost = synced_average_cost
                set_position_cost_status(db, position, "automatic")
            elif decimal_value(position.average_cost) <= 0:
                position.average_cost = price
        db.flush()
        seen_position_ids.add(position.id)
        _upsert_price(db, "CRYPTO", symbol, date.today(), price, "USD", "Binance")

    for item in funding_balances:
        asset = str(item.get("asset") or "").upper()
        quantity = (
            decimal_value(item.get("free"))
            + decimal_value(item.get("locked"))
            + decimal_value(item.get("freeze"))
        )
        if not asset or quantity <= 0 or asset in BINANCE_CASH_ASSETS:
            continue

        # Binance Stocks holdings are kept in the Funding Wallet. When the
        # user already tracks that US-equity symbol, the Funding Wallet is the
        # authoritative source for its current quantity; cost and price stay
        # on the existing position because this endpoint does not return them.
        stock_symbol = equity_asset_map.get(asset, asset)
        position = db.scalar(
            select(Position).where(
                Position.account_id == account.id,
                Position.market == "US",
                Position.symbol == stock_symbol,
            )
        )
        if not position:
            warnings.append(
                f"資金帳戶資產 {asset} 已讀取，但尚未找到對應的投資持倉"
            )
            continue
        position.quantity = quantity
        position.archived = False
        db.flush()
        seen_position_ids.add(position.id)

    stock_trade_ids_key = _binance_setting_key(account.id, "stock_trade_ids")
    processed_trade_ids_row = db.get(AppSetting, stock_trade_ids_key)
    processed_trade_ids_value = (
        processed_trade_ids_row.value if processed_trade_ids_row else None
    )
    try:
        processed_trade_ids = {
            str(item) for item in json.loads(processed_trade_ids_value or "[]")
        }
    except (TypeError, ValueError, json.JSONDecodeError):
        processed_trade_ids = set()

    current_trade_ids: set[str] = set()
    new_stock_trades: list[dict[str, Any]] = []
    for item in equity_trades:
        trade_id = str(
            item.get("executionId")
            or "|".join(
                str(item.get(key) or "")
                for key in ("orderId", "symbol", "side", "qty", "price", "executionAt")
            )
        )
        current_trade_ids.add(trade_id)
        if processed_trade_ids_value is not None and trade_id not in processed_trade_ids:
            new_stock_trades.append(item)

    # A stock can have no new fills during this sync and still be an active
    # holding. Keep every existing US position referenced by the trade history
    # in the Binance-managed set so the general stale-position cleanup below
    # does not archive it.
    stock_history_symbols = {
        str(item.get("symbol") or "").upper()
        for item in equity_trades
        if str(item.get("symbol") or "").strip()
    }
    if stock_history_symbols:
        existing_stock_positions = db.scalars(
            select(Position).where(
                Position.account_id == account.id,
                Position.market == "US",
                Position.symbol.in_(stock_history_symbols),
                Position.archived.is_(False),
            )
        ).all()
        seen_position_ids.update(
            position.id
            for position in existing_stock_positions
            if decimal_value(position.quantity) > 0
        )

    # The Stocks API only exposes fills since the product launched; it does
    # not expose a complete positions endpoint. On the first sync, preserve
    # the user's reconciled quantity and checkpoint all existing fills. Every
    # later sync applies only newly seen BUY/SELL executions.
    for item in sorted(new_stock_trades, key=lambda row: int(row.get("executionAt") or 0)):
        symbol = str(item.get("symbol") or "").upper()
        side = str(item.get("side") or "").upper()
        quantity = decimal_value(item.get("qty"))
        price = decimal_value(item.get("price"))
        if not symbol or quantity <= 0 or side not in {"BUY", "SELL"}:
            continue
        position = db.scalar(
            select(Position).where(
                Position.account_id == account.id,
                Position.market == "US",
                Position.symbol == symbol,
            )
        )
        if not position:
            if side == "SELL":
                warnings.append(f"讀到 {symbol} 賣出成交，但目前沒有可扣除的持倉")
                continue
            position = Position(
                account_id=account.id,
                market="US",
                symbol=symbol,
                name=symbol,
                quantity=quantity,
                average_cost=price,
                currency="USD",
            )
            db.add(position)
            db.flush()
            set_position_cost_status(db, position, "automatic")
        elif side == "BUY":
            old_quantity = decimal_value(position.quantity)
            new_quantity = old_quantity + quantity
            if new_quantity > 0 and price > 0:
                position.average_cost = (
                    old_quantity * decimal_value(position.average_cost)
                    + quantity * price
                ) / new_quantity
            position.quantity = new_quantity
        else:
            position.quantity = max(ZERO, decimal_value(position.quantity) - quantity)
            position.archived = position.quantity <= 0
        position.currency = "USD"
        if position.quantity > 0:
            position.archived = False
        db.flush()
        if not position.archived:
            seen_position_ids.add(position.id)

    processed_trade_ids.update(current_trade_ids)
    _set_setting_value(
        db,
        stock_trade_ids_key,
        json.dumps(sorted(processed_trade_ids)),
    )

    for item in um_positions:
        raw_symbol = str(item.get("symbol") or "").upper()
        base_asset = str(item.get("baseAsset") or "").upper()
        contract_type = str(item.get("contractType") or "").upper()
        underlying_type = str(item.get("underlyingType") or "").upper()
        if not base_asset and raw_symbol.endswith("USDT"):
            base_asset = raw_symbol.removesuffix("USDT")
        if not base_asset or (
            underlying_type != "EQUITY"
            and contract_type != "TRADIFI_PERPETUAL"
        ):
            continue

        quantity = abs(decimal_value(item.get("positionAmt")))
        entry_price = decimal_value(item.get("entryPrice"))
        mark_price = decimal_value(item.get("markPrice"))
        if quantity <= 0 or mark_price <= 0:
            continue

        position = db.scalar(
            select(Position).where(
                Position.account_id == account.id,
                Position.market == "US",
                Position.symbol == base_asset,
            )
        )
        if not position:
            position = Position(
                account_id=account.id,
                market="US",
                symbol=base_asset,
                name=f"{base_asset}（Binance 合約）",
                quantity=quantity,
                average_cost=entry_price or mark_price,
                currency="USD",
            )
            db.add(position)
        else:
            position.quantity = quantity
            position.average_cost = entry_price or position.average_cost
            position.currency = "USD"
            position.manual_price = None
            position.archived = False
        db.flush()
        set_position_cost_status(db, position, "automatic")
        seen_position_ids.add(position.id)
        _upsert_price(
            db,
            "US",
            base_asset,
            date.today(),
            mark_price,
            "USD",
            "Binance Futures",
        )

    previous_ids_value = _get_setting_value(
        db, _binance_setting_key(account.id, "position_ids")
    )
    try:
        previous_ids = {int(item) for item in json.loads(previous_ids_value or "[]")}
    except (TypeError, ValueError, json.JSONDecodeError):
        previous_ids = set()
    for position_id in previous_ids - seen_position_ids:
        position = db.get(Position, position_id)
        if position and position.account_id == account.id:
            position.archived = True

    if save_credentials:
        _set_setting_value(
            db, _binance_setting_key(account.id, "api_key"), encrypt_credential(api_key)
        )
        _set_setting_value(
            db,
            _binance_setting_key(account.id, "api_secret"),
            encrypt_credential(api_secret or ""),
        )

    cash_twd = cash_usd * usd_rate
    wallet_total_twd = wallet_total_usdt * usd_rate if wallet_total_usdt is not None else None
    snapshot_twd = wallet_total_twd if wallet_total_twd is not None else cash_twd
    account_rate, _ = latest_fx_rate(db, account.currency)
    if wallet_total_twd is not None:
        # Binance's all-wallet total already includes Spot, Funding, Futures and
        # every position in those wallets. Keep imported positions as a
        # breakdown only; adding them to an auto base would double-count any
        # pre-existing/manual holding attached to the same account.
        account.auto_balance_base_twd = None
        account.balance_includes_positions = True
    else:
        # If the all-wallet endpoint is temporarily unavailable, fall back to
        # the old estimate: liquid Spot assets plus the visible positions.
        account.auto_balance_base_twd = cash_twd
        account.balance_includes_positions = False
    create_balance_snapshot(
        db,
        account,
        snapshot_twd / account_rate,
        date.today(),
        account_rate,
        source="binance_sync",
    )
    synced_at = datetime.utcnow().isoformat(timespec="seconds")
    _set_setting_value(db, last_sync_key, synced_at)
    if include_cost_details:
        _set_setting_value(db, last_cost_sync_key, synced_at)
    _set_setting_value(
        db,
        _binance_setting_key(account.id, "position_ids"),
        json.dumps(sorted(seen_position_ids)),
    )
    db.flush()
    record_valuation(db)
    db.commit()
    return {
        "account_id": account.id,
        "account_name": account.name,
        "updated": True,
        "skipped": False,
        "last_sync_at": synced_at,
        "positions": len(seen_position_ids),
        "warnings": warnings,
        "costs_updated": include_cost_details,
    }


def _refresh_crypto_from_binance(
    client: httpx.Client,
    db: Session,
    position: Position,
) -> bool:
    normalized_symbol = position.symbol.lower()
    pair = (
        f"{normalized_symbol.removeprefix('binance-').upper()}USDT"
        if normalized_symbol.startswith("binance-")
        else BINANCE_SPOT_SYMBOLS.get(normalized_symbol)
    )
    if not pair or position.currency.upper() != "USD":
        return False
    try:
        response = client.get(
            "https://data-api.binance.vision/api/v3/ticker/price",
            params={"symbol": pair},
        )
        response.raise_for_status()
        payload = response.json()
        price = decimal_value(payload.get("price"))
        if price <= 0:
            return False
        _upsert_price(
            db,
            "CRYPTO",
            position.symbol,
            date.today(),
            price,
            "USD",
            "Binance",
        )
        return True
    except Exception:
        return False


def _alpha_vantage_failure_reason(payload: Any) -> str:
    if not isinstance(payload, dict):
        return "Alpha Vantage 回傳格式異常"
    message = str(
        payload.get("Note")
        or payload.get("Information")
        or payload.get("Error Message")
        or ""
    ).strip()
    normalized = message.casefold()
    if "api key" in normalized and any(
        keyword in normalized
        for keyword in ("invalid", "not authorized", "not valid", "premium")
    ):
        return "Alpha Vantage API 金鑰無效或沒有此功能的權限"
    if "rate limit" in normalized or "requests per day" in normalized:
        return "Alpha Vantage 今日免費額度已用完"
    if message:
        return "Alpha Vantage 暫時未提供行情"
    return "Alpha Vantage 找不到這個美股代號"


def _fetch_nasdaq_quote(
    client: httpx.Client,
    symbol: str,
) -> tuple[date, Decimal, str]:
    nasdaq_symbol = symbol.strip().upper()
    if not nasdaq_symbol:
        raise ValueError("缺少美股代號")
    response = client.get(
        f"https://api.nasdaq.com/api/quote/{nasdaq_symbol}/info",
        params={"assetclass": "stocks"},
        headers={
            "Accept": "application/json, text/plain, */*",
            "Origin": "https://www.nasdaq.com",
            "Referer": f"https://www.nasdaq.com/market-activity/stocks/{nasdaq_symbol.lower()}",
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/127.0 Safari/537.36"
            ),
        },
    )
    response.raise_for_status()
    payload = response.json()
    data = payload.get("data") if isinstance(payload, dict) else None
    primary = data.get("primaryData") if isinstance(data, dict) else None
    price_text = str(primary.get("lastSalePrice") or "") if isinstance(primary, dict) else ""
    price = decimal_value(re.sub(r"[^0-9.\-]", "", price_text))
    if price <= 0:
        raise ValueError("Nasdaq 找不到這個美股代號")

    timestamp_text = str(primary.get("lastTradeTimestamp") or "").strip()
    quote_date = date.today()
    if timestamp_text:
        normalized_timestamp = re.sub(r"\s+[A-Z]{2,5}$", "", timestamp_text).strip()
        for timestamp_format in (
            "%b %d, %Y %I:%M %p",
            "%B %d, %Y %I:%M %p",
            "%m/%d/%Y %I:%M %p",
        ):
            try:
                quote_date = datetime.strptime(
                    normalized_timestamp, timestamp_format
                ).date()
                break
            except ValueError:
                continue
    currency = str(primary.get("currency") or data.get("currency") or "USD").upper()
    return quote_date, price, currency


def _fetch_yahoo_daily_quote(
    client: httpx.Client,
    symbol: str,
) -> tuple[date, Decimal, str]:
    yahoo_symbol = symbol.strip().upper().replace(".", "-")
    if not yahoo_symbol:
        raise ValueError("缺少美股代號")
    for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
        try:
            response = client.get(
                f"https://{host}/v8/finance/chart/{yahoo_symbol}",
                params={"interval": "1d", "range": "5d", "events": "history"},
                headers={
                    "Accept": "application/json, text/plain, */*",
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/127.0 Safari/537.36"
                    ),
                },
            )
            response.raise_for_status()
            payload = response.json()
            chart = payload.get("chart", {}) if isinstance(payload, dict) else {}
            if chart.get("error"):
                continue
            results = chart.get("result") or []
            if not results:
                continue
            result = results[0]
            timestamps = result.get("timestamp") or []
            indicators = result.get("indicators") or {}
            quotes = indicators.get("quote") or []
            closes = quotes[0].get("close", []) if quotes else []
            for timestamp, close in reversed(list(zip(timestamps, closes))):
                price = decimal_value(close)
                if price > 0:
                    price_date = datetime.fromtimestamp(
                        int(timestamp), timezone.utc
                    ).date()
                    currency = str(
                        result.get("meta", {}).get("currency") or "USD"
                    ).upper()
                    return price_date, price, currency
        except (ValueError, TypeError, httpx.HTTPError):
            continue
    raise ValueError("Yahoo Finance 沒有可用的每日收盤價")


def refresh_market_prices(db: Session, force: bool = False) -> dict[str, Any]:
    positions = db.scalars(select(Position).where(Position.archived.is_(False))).all()
    result = {
        "updated": 0,
        "skipped": 0,
        "updated_items": [],
        "cached_items": [],
        "manual_items": [],
        "warnings": [],
        "errors": [],
    }
    by_market: dict[str, list[Position]] = defaultdict(list)
    for position in positions:
        if position.manual_price is not None:
            result["skipped"] += 1
            _record_market_result_item(result, "manual_items", position)
            continue
        latest = get_latest_price(db, position.market, position.symbol)
        cache_duration = timedelta(minutes=15) if position.market == "CRYPTO" else timedelta(hours=24)
        if (
            not force
            and latest
            and datetime.utcnow() - latest.updated_at < cache_duration
        ):
            result["skipped"] += 1
            _record_market_result_item(result, "cached_items", position)
            continue
        by_market[position.market].append(position)

    with httpx.Client(
        timeout=20,
        follow_redirects=True,
        headers={"Accept": "application/json", "User-Agent": "FinanceHome/1.0"},
    ) as client:
        if by_market.get("TWSE"):
            try:
                rows = client.get(
                    "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
                ).json()
                prices = {str(row["Code"]): row for row in rows}
                for position in by_market["TWSE"]:
                    row = prices.get(position.symbol)
                    if not row:
                        raise ValueError(f"查無上市代號 {position.symbol}")
                    roc_date = str(row["Date"])
                    price_date = date(int(roc_date[:3]) + 1911, int(roc_date[3:5]), int(roc_date[5:7]))
                    _upsert_price(
                        db,
                        "TWSE",
                        position.symbol,
                        price_date,
                        decimal_value(row["ClosingPrice"]),
                        "TWD",
                        "TWSE",
                    )
                    result["updated"] += 1
                    _record_market_result_item(result, "updated_items", position)
            except Exception as exc:
                result["errors"].append(f"上市行情：{exc}")

        if by_market.get("TPEX"):
            try:
                rows = client.get(
                    "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes"
                ).json()
                prices = {str(row["SecuritiesCompanyCode"]): row for row in rows}
                for position in by_market["TPEX"]:
                    row = prices.get(position.symbol)
                    if not row:
                        raise ValueError(f"查無上櫃代號 {position.symbol}")
                    roc_date = str(row["Date"])
                    price_date = date(int(roc_date[:3]) + 1911, int(roc_date[3:5]), int(roc_date[5:7]))
                    _upsert_price(
                        db,
                        "TPEX",
                        position.symbol,
                        price_date,
                        decimal_value(row["Close"]),
                        "TWD",
                        "TPEX",
                    )
                    result["updated"] += 1
                    _record_market_result_item(result, "updated_items", position)
            except Exception as exc:
                result["errors"].append(f"上櫃行情：{exc}")

        if by_market.get("US"):
            setting = db.get(AppSetting, "alpha_vantage_api_key")
            api_key = os.getenv("ALPHA_VANTAGE_API_KEY") or (setting.value if setting else "")
            for position in by_market["US"]:
                try:
                    price_date, price, currency = _fetch_nasdaq_quote(
                        client, position.symbol
                    )
                    _upsert_price(
                        db,
                        "US",
                        position.symbol,
                        price_date,
                        price,
                        currency,
                        "Nasdaq",
                    )
                    result["updated"] += 1
                    _record_market_result_item(result, "updated_items", position)
                    continue
                except httpx.HTTPStatusError as exc:
                    nasdaq_failure = (
                        f"Nasdaq 連線失敗（HTTP {exc.response.status_code}）"
                    )
                except (ValueError, TypeError):
                    nasdaq_failure = "Nasdaq 回傳的行情格式無法辨識"
                except httpx.HTTPError:
                    nasdaq_failure = "Nasdaq 連線失敗"

                alpha_failure = "尚未設定 Alpha Vantage API 金鑰"
                if api_key:
                    try:
                        response = client.get(
                            "https://www.alphavantage.co/query",
                            params={
                                "function": "GLOBAL_QUOTE",
                                "symbol": position.symbol,
                                "apikey": api_key,
                            },
                        )
                        response.raise_for_status()
                        payload = response.json()
                        quote = payload.get("Global Quote", {})
                        alpha_price = decimal_value(quote.get("05. price"))
                        if alpha_price > 0:
                            price_date = date.fromisoformat(
                                quote.get(
                                    "07. latest trading day", date.today().isoformat()
                                )
                            )
                            _upsert_price(
                                db,
                                "US",
                                position.symbol,
                                price_date,
                                alpha_price,
                                "USD",
                                "Alpha Vantage",
                            )
                            result["updated"] += 1
                            _record_market_result_item(result, "updated_items", position)
                            result["warnings"].append(
                                f"美股 {position.symbol}：{nasdaq_failure}，"
                                f"已改用 Alpha Vantage {price_date.isoformat()} 的價格"
                            )
                            continue
                        alpha_failure = _alpha_vantage_failure_reason(payload)
                    except httpx.HTTPStatusError as exc:
                        alpha_failure = (
                            f"Alpha Vantage 連線失敗（HTTP {exc.response.status_code}）"
                        )
                    except (ValueError, TypeError):
                        alpha_failure = "Alpha Vantage 回傳的行情格式無法辨識"
                    except httpx.HTTPError:
                        alpha_failure = "Alpha Vantage 連線失敗"

                try:
                    price_date, price, currency = _fetch_yahoo_daily_quote(
                        client, position.symbol
                    )
                    _upsert_price(
                        db,
                        "US",
                        position.symbol,
                        price_date,
                        price,
                        currency,
                        "Yahoo Finance",
                    )
                    result["updated"] += 1
                    _record_market_result_item(result, "updated_items", position)
                    result["warnings"].append(
                        f"美股 {position.symbol}：{nasdaq_failure}；{alpha_failure}，"
                        f"已改用 Yahoo Finance {price_date.isoformat()} 的每日收盤價"
                    )
                except (ValueError, TypeError, httpx.HTTPError):
                    _reuse_cached_market_price(
                        db,
                        result,
                        position,
                        f"美股 {position.symbol}",
                        f"{nasdaq_failure}；{alpha_failure}；Yahoo Finance 備援也暫時無法使用",
                    )

        if by_market.get("CRYPTO"):
            try:
                ids = sorted({item.symbol.lower() for item in by_market["CRYPTO"]})
                payload = None
                for attempt in range(3):
                    response = client.get(
                        "https://api.coingecko.com/api/v3/simple/price",
                        params={
                            "ids": ",".join(ids),
                            "vs_currencies": "twd,usd",
                            "include_last_updated_at": "true",
                        },
                    )
                    if response.status_code == 429 and attempt < 2:
                        time.sleep(2**attempt)
                        continue
                    response.raise_for_status()
                    candidate = response.json()
                    if not isinstance(candidate, dict) or candidate.get("status"):
                        raise ValueError("CoinGecko 回應格式不正確")
                    payload = candidate
                    break
                if payload is None:
                    raise ValueError("CoinGecko 暫時無法回應")
                for position in by_market["CRYPTO"]:
                    quote = payload.get(position.symbol.lower())
                    if not quote:
                        if _refresh_crypto_from_binance(client, db, position):
                            result["updated"] += 1
                            _record_market_result_item(result, "updated_items", position)
                            continue
                        _reuse_cached_market_price(
                            db,
                            result,
                            position,
                            f"加密貨幣 {position.name or position.symbol}",
                            "CoinGecko 暫時沒有回傳此代號",
                        )
                        continue
                    currency = position.currency.lower()
                    if currency not in quote:
                        currency = "usd"
                    timestamp = quote.get("last_updated_at")
                    price_date = (
                        datetime.fromtimestamp(timestamp).date() if timestamp else date.today()
                    )
                    _upsert_price(
                        db,
                        "CRYPTO",
                        position.symbol,
                        price_date,
                        decimal_value(quote[currency]),
                        currency.upper(),
                        "CoinGecko",
                    )
                    result["updated"] += 1
                    _record_market_result_item(result, "updated_items", position)
            except Exception:
                for position in by_market["CRYPTO"]:
                    if _refresh_crypto_from_binance(client, db, position):
                        result["updated"] += 1
                        _record_market_result_item(result, "updated_items", position)
                        continue
                    _reuse_cached_market_price(
                        db,
                        result,
                        position,
                        f"加密貨幣 {position.name or position.symbol}",
                        "CoinGecko 暫時忙碌",
                    )

    db.flush()
    record_valuation(db)
    db.commit()
    return result


def refresh_fx_rates(db: Session) -> dict[str, Any]:
    url = "https://cpx.cbc.gov.tw/API/DataAPI/Get?FileName=BP01D01"
    payload = httpx.get(url, timeout=30, follow_redirects=True).json()
    rows = payload["data"]["dataSets"][-400:]
    saved = 0
    for row in rows:
        try:
            rate_date = datetime.strptime(row[0], "%Y%m%d").date()
            usd_twd = Decimal(row[1])
            values = {
                "TWD": ONE,
                "USD": usd_twd,
                "JPY": usd_twd / Decimal(row[2]),
                "GBP": usd_twd * Decimal(row[3]),
                "HKD": usd_twd / Decimal(row[4]),
                "KRW": usd_twd / Decimal(row[5]),
                "CAD": usd_twd / Decimal(row[6]),
                "SGD": usd_twd / Decimal(row[7]),
                "CNY": usd_twd / Decimal(row[8]),
                "AUD": usd_twd * Decimal(row[9]),
                "IDR": usd_twd / Decimal(row[10]),
                "THB": usd_twd / Decimal(row[11]),
                "MYR": usd_twd / Decimal(row[12]),
                "PHP": usd_twd / Decimal(row[13]),
                "EUR": usd_twd * Decimal(row[14]),
                "VND": usd_twd / Decimal(row[18]),
            }
            for currency, rate in values.items():
                current = db.scalar(
                    select(FxRate).where(
                        FxRate.currency == currency, FxRate.rate_date == rate_date
                    )
                )
                if current and current.manual:
                    continue
                if not current:
                    current = FxRate(currency=currency, rate_date=rate_date)
                    db.add(current)
                current.rate_to_twd = rate
                current.source = "CBC"
                current.manual = False
                saved += 1
        except (InvalidOperation, IndexError, ValueError, ZeroDivisionError):
            continue
    db.commit()
    return {"saved": saved, "latest_date": rows[-1][0] if rows else None}


def seed_demo(db: Session) -> None:
    if APP_MODE != "demo" or db.scalar(select(func.count(Account.id))) > 0:
        return
    categories = {item.name: item.id for item in db.scalars(select(Category)).all()}
    today = date.today()
    bank = Account(
        name="日常銀行帳戶",
        institution="示範銀行",
        account_type="bank",
        nature="asset",
        currency="TWD",
        is_liquid=True,
    )
    broker = Account(
        name="長期投資帳戶",
        institution="示範證券",
        account_type="brokerage",
        nature="asset",
        currency="TWD",
    )
    crypto = Account(
        name="加密貨幣",
        institution="示範交易所",
        account_type="crypto",
        nature="asset",
        currency="USD",
    )
    card = Account(
        name="信用卡",
        institution="示範銀行",
        account_type="credit_card",
        nature="liability",
        currency="TWD",
    )
    db.add_all([bank, broker, crypto, card])
    db.flush()
    create_balance_snapshot(db, bank, Decimal("128500"), today)
    create_balance_snapshot(db, broker, Decimal("18500"), today)
    create_balance_snapshot(db, crypto, Decimal("350"), today, Decimal("31.8"))
    create_balance_snapshot(db, card, Decimal("12680"), today)
    db.add_all(
        [
            Position(
                account_id=broker.id,
                market="TWSE",
                symbol="0050",
                name="元大台灣50",
                quantity=Decimal("800"),
                average_cost=Decimal("145"),
                currency="TWD",
                manual_price=Decimal("182.5"),
            ),
            Position(
                account_id=crypto.id,
                market="CRYPTO",
                symbol="bitcoin",
                name="Bitcoin",
                quantity=Decimal("0.035"),
                average_cost=Decimal("52000"),
                currency="USD",
                manual_price=Decimal("67000"),
            ),
        ]
    )
    samples = [
        (today - timedelta(days=12), "本月薪資", Decimal("42000"), "薪資", "income"),
        (today - timedelta(days=10), "房租", Decimal("-9000"), "居住", "expense"),
        (today - timedelta(days=8), "全聯採買", Decimal("-1650"), "餐飲", "expense"),
        (today - timedelta(days=5), "捷運加值", Decimal("-500"), "交通", "expense"),
        (today - timedelta(days=3), "Netflix", Decimal("-390"), "訂閱", "expense"),
        (today - timedelta(days=1), "朋友聚餐", Decimal("-1280"), "餐飲", "expense"),
    ]
    for tx_date, description, amount, category, kind in samples:
        db.add(
            Transaction(
                account_id=bank.id,
                transaction_date=tx_date,
                description=description,
                amount=amount,
                currency="TWD",
                fx_rate=ONE,
                base_amount=amount,
                transaction_kind=kind,
                category_id=categories[category],
                fingerprint=transaction_fingerprint(bank.id, tx_date, amount, description),
                source="demo",
            )
        )
    db.add(
        Budget(
            month=today.strftime("%Y-%m"),
            category_id=categories["餐飲"],
            amount=Decimal("6000"),
        )
    )
    db.add(
        Goal(
            name="日本旅行基金",
            target_amount=Decimal("80000"),
            current_amount=Decimal("32000"),
            target_date=today + timedelta(days=240),
        )
    )
    db.flush()
    record_valuation(db)
    db.commit()


def serialize_model(row: Any) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for column in row.__table__.columns:
        value = getattr(row, column.name)
        if isinstance(value, (datetime, date)):
            result[column.name] = value.isoformat()
        elif isinstance(value, Decimal):
            result[column.name] = str(value)
        else:
            result[column.name] = value
    return result


BACKUP_MODELS = [
    Category,
    Account,
    BalanceSnapshot,
    Transaction,
    ClassificationRule,
    TransferLink,
    Position,
    PriceSnapshot,
    FxRate,
    Budget,
    Goal,
    RecurringExpense,
    ValuationSnapshot,
]


def export_backup(db: Session) -> dict[str, Any]:
    return {
        "version": 1,
        "exported_at": datetime.now().isoformat(),
        "mode": APP_MODE,
        "data": {
            model.__tablename__: [
                serialize_model(row) for row in db.scalars(select(model)).all()
            ]
            for model in BACKUP_MODELS
        },
    }


def restore_backup(db: Session, payload: dict[str, Any]) -> dict[str, int]:
    if payload.get("version") != 1 or not isinstance(payload.get("data"), dict):
        raise ValueError("不支援的備份格式")
    data = payload["data"]
    known_tables = {model.__tablename__ for model in BACKUP_MODELS}
    if not set(data).issubset(known_tables):
        raise ValueError("備份包含未知資料表")

    for model in reversed(BACKUP_MODELS):
        db.execute(delete(model))
    db.flush()

    restored: dict[str, int] = {}
    for model in BACKUP_MODELS:
        table_name = model.__tablename__
        rows = data.get(table_name, [])
        restored[table_name] = 0
        for raw in rows:
            values: dict[str, Any] = {}
            for column in model.__table__.columns:
                if column.name not in raw:
                    continue
                value = raw[column.name]
                if value is None:
                    values[column.name] = None
                elif isinstance(column.type, SQLDateTime):
                    values[column.name] = datetime.fromisoformat(value)
                elif isinstance(column.type, SQLDate):
                    values[column.name] = date.fromisoformat(value)
                elif isinstance(column.type, SQLNumeric):
                    values[column.name] = Decimal(str(value))
                else:
                    values[column.name] = value
            db.add(model(**values))
            restored[table_name] += 1
        db.flush()
    if db.bind and db.bind.dialect.name == "postgresql":
        for model in BACKUP_MODELS:
            table_name = model.__tablename__
            db.execute(
                text(
                    f"SELECT setval(pg_get_serial_sequence('{table_name}', 'id'), "
                    f"COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM {table_name}"
                )
            )
    db.commit()
    seed_defaults(db)
    return restored
