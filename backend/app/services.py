from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import time
from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

import httpx
import pandas as pd
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
    Transaction,
    TransferLink,
    ValuationSnapshot,
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
    lowered = description.lower()
    rules = db.scalars(
        select(ClassificationRule)
        .where(ClassificationRule.enabled.is_(True))
        .order_by(ClassificationRule.priority.asc(), ClassificationRule.id.asc())
    ).all()
    for rule in rules:
        if rule.keyword.lower() in lowered:
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
        or_(Transaction.category_id.is_(None), Transaction.category_id == uncategorized.id)
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
        or_(Transaction.category_id.is_(None), Transaction.category_id == uncategorized.id)
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


def calculate_health_score(db: Session) -> dict[str, Any]:
    end = date.today()
    start = end - timedelta(days=90)
    transactions = db.scalars(
        select(Transaction).where(Transaction.transaction_date >= start)
    ).all()
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
    for account in db.scalars(
        select(Account).where(
            Account.archived.is_(False),
            Account.nature == "asset",
            Account.is_liquid.is_(True),
        )
    ).all():
        liquid += Decimal(str(account_summary(db, account)["total_twd"]))

    current_month = end.strftime("%Y-%m")
    budget_total = db.scalar(
        select(func.sum(Budget.amount)).where(Budget.month == current_month)
    )
    current_start = end.replace(day=1)
    current_spend = sum(
        (
            abs(decimal_value(tx.base_amount))
            for tx in db.scalars(
                select(Transaction).where(Transaction.transaction_date >= current_start)
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
        add_component("budget", "預算遵守度", None, None, "尚未設定本月預算")

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


def import_csv(
    db: Session,
    content: bytes,
    account: Account,
    mapping: dict[str, str | None],
    commit: bool = True,
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

    imported = 0
    duplicates = 0
    failed: list[dict[str, Any]] = []
    preview: list[dict[str, Any]] = []
    latest_balance: tuple[date, Decimal] | None = None
    existing = set(db.scalars(select(Transaction.fingerprint)).all())

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
            is_duplicate = fingerprint in existing
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
                db.add(
                    Transaction(
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
                )
                existing.add(fingerprint)
                imported += 1
            if mapping.get("balance") and str(row[mapping["balance"]]).strip():
                balance = parse_number(row[mapping["balance"]])
                if latest_balance is None or tx_date >= latest_balance[0]:
                    latest_balance = (tx_date, balance)
        except Exception as exc:
            failed.append({"row": int(index) + 2, "error": str(exc)})

    if commit and latest_balance:
        create_balance_snapshot(
            db, account, latest_balance[1], latest_balance[0], source="csv"
        )
    if commit:
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
        result["warnings"].append(
            f"{label}：{reason}，已沿用 {latest.price_date.isoformat()} 的價格"
        )
        return
    result["errors"].append(f"{label}：{reason}，且目前沒有可沿用的價格")


def _refresh_crypto_from_binance(
    client: httpx.Client,
    db: Session,
    position: Position,
) -> bool:
    pair = BINANCE_SPOT_SYMBOLS.get(position.symbol.lower())
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


def refresh_market_prices(db: Session, force: bool = False) -> dict[str, Any]:
    positions = db.scalars(select(Position).where(Position.archived.is_(False))).all()
    result = {"updated": 0, "skipped": 0, "warnings": [], "errors": []}
    by_market: dict[str, list[Position]] = defaultdict(list)
    for position in positions:
        if position.manual_price is not None:
            result["skipped"] += 1
            continue
        latest = get_latest_price(db, position.market, position.symbol)
        cache_duration = timedelta(minutes=15) if position.market == "CRYPTO" else timedelta(hours=24)
        if (
            not force
            and latest
            and datetime.utcnow() - latest.updated_at < cache_duration
        ):
            result["skipped"] += 1
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
            except Exception as exc:
                result["errors"].append(f"上櫃行情：{exc}")

        if by_market.get("US"):
            setting = db.get(AppSetting, "alpha_vantage_api_key")
            api_key = os.getenv("ALPHA_VANTAGE_API_KEY") or (setting.value if setting else "")
            if not api_key:
                for position in by_market["US"]:
                    _reuse_cached_market_price(
                        db,
                        result,
                        position,
                        f"美股 {position.symbol}",
                        "尚未設定 Alpha Vantage API 金鑰",
                    )
            else:
                for position in by_market["US"]:
                    try:
                        payload = client.get(
                            "https://www.alphavantage.co/query",
                            params={
                                "function": "GLOBAL_QUOTE",
                                "symbol": position.symbol,
                                "apikey": api_key,
                            },
                        ).json()
                        quote = payload.get("Global Quote", {})
                        if not quote.get("05. price"):
                            provider_message = str(
                                payload.get("Note") or payload.get("Information") or ""
                            ).lower()
                            reason = (
                                "今日免費更新額度已用完"
                                if "rate limit" in provider_message
                                or "requests per day" in provider_message
                                else "暫時無法取得新報價"
                            )
                            _reuse_cached_market_price(
                                db, result, position, f"美股 {position.symbol}", reason
                            )
                            continue
                        price_date = date.fromisoformat(
                            quote.get("07. latest trading day", date.today().isoformat())
                        )
                        _upsert_price(
                            db,
                            "US",
                            position.symbol,
                            price_date,
                            decimal_value(quote["05. price"]),
                            "USD",
                            "Alpha Vantage",
                        )
                        result["updated"] += 1
                    except Exception:
                        _reuse_cached_market_price(
                            db,
                            result,
                            position,
                            f"美股 {position.symbol}",
                            "行情服務暫時無法連線",
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
            except Exception:
                for position in by_market["CRYPTO"]:
                    if _refresh_crypto_from_binance(client, db, position):
                        result["updated"] += 1
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
