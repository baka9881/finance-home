from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Annotated, Any

from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .database import (
    APP_MODE,
    ROOT_DIR,
    Account,
    AppSetting,
    BalanceSnapshot,
    Base,
    Budget,
    Category,
    ClassificationRule,
    CreditCardBill,
    EmailCardRule,
    FxRate,
    Goal,
    IgnoredRecurringExpense,
    Position,
    RecurringExpense,
    Transaction,
    TransferLink,
    SessionLocal,
    engine,
    get_db,
)
from .schemas import (
    AccountTransferCreate,
    AccountCreate,
    AccountUpdate,
    AuthLogin,
    BalanceCreate,
    BinanceConnectionCreate,
    BudgetCreate,
    FxRateCreate,
    GoalCreate,
    GoalUpdate,
    InvestmentTradeCreate,
    LoanPaymentCreate,
    PositionCreate,
    PositionUpdate,
    RecurringExpenseCreate,
    RecurringExpenseUpdate,
    DetectedRecurringIgnoreCreate,
    RuleCreate,
    RuleUpdate,
    SettingsUpdate,
    EmailCardRuleCreate,
    EmailCardRuleUpdate,
    TransactionCreate,
    TransactionUpdate,
    TransferCreate,
)
from .services import (
    apply_pending_csv_balance,
    account_summary,
    binance_connection_statuses,
    calculate_dashboard,
    calculate_health_score,
    calculate_spending_analysis,
    classify_transaction,
    create_balance_snapshot,
    decimal_value,
    disconnect_binance_account,
    encrypt_credential,
    export_backup,
    get_latest_balance,
    import_csv,
    inspect_csv,
    latest_fx_rate,
    pending_csv_balance_status,
    position_summary,
    reclassify_uncategorized_transactions,
    record_valuation,
    refresh_fx_rates,
    refresh_market_prices,
    recurring_expense_signature,
    restore_backup,
    seed_defaults,
    seed_demo,
    set_position_cost_status,
    sync_binance_account,
    transaction_fingerprint,
    OWNER_LABELS,
    DEFAULT_RULES,
)
from .email_sync import (
    _refresh_current_gmail_card_balance,
    complete_gmail_authorization,
    disconnect_gmail,
    frontend_settings_url,
    gmail_authorization_url,
    gmail_callback_url,
    gmail_status,
    process_due_card_bills,
    serialize_card_bill,
    serialize_email_rule,
    sync_gmail,
)


def ensure_schema() -> None:
    if engine.url.get_backend_name() != "sqlite":
        return
    with engine.begin() as conn:
        columns = {row[1] for row in conn.execute(text("PRAGMA table_info(accounts)"))}
        if "balance_includes_positions" not in columns:
            conn.execute(
                text(
                    "ALTER TABLE accounts "
                    "ADD COLUMN balance_includes_positions BOOLEAN NOT NULL DEFAULT 0"
                )
            )
        if "auto_balance_base_twd" not in columns:
            conn.execute(
                text("ALTER TABLE accounts ADD COLUMN auto_balance_base_twd NUMERIC(18, 4)")
            )
        if "owner" not in columns:
            conn.execute(
                text("ALTER TABLE accounts ADD COLUMN owner VARCHAR(20) NOT NULL DEFAULT 'me'")
            )
        goal_columns = {row[1] for row in conn.execute(text("PRAGMA table_info(goals)"))}
        if goal_columns and "owner" not in goal_columns:
            conn.execute(
                text("ALTER TABLE goals ADD COLUMN owner VARCHAR(20) NOT NULL DEFAULT 'me'")
            )
        if goal_columns and "goal_type" not in goal_columns:
            conn.execute(
                text("ALTER TABLE goals ADD COLUMN goal_type VARCHAR(30) NOT NULL DEFAULT 'net_worth'")
            )
        if goal_columns and "account_id" not in goal_columns:
            conn.execute(text("ALTER TABLE goals ADD COLUMN account_id INTEGER"))
        valuation_columns = {
            row[1] for row in conn.execute(text("PRAGMA table_info(valuation_snapshots)"))
        }
        if valuation_columns and "owner" not in valuation_columns:
            conn.execute(
                text(
                    "ALTER TABLE valuation_snapshots "
                    "ADD COLUMN owner VARCHAR(20) NOT NULL DEFAULT 'all'"
                )
            )


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    ensure_schema()
    with Session(engine) as db:
        seed_defaults(db)
        seed_demo(db)
        adjusted_email_balances = False
        for rule in db.scalars(
            select(EmailCardRule)
            .where(EmailCardRule.active.is_(True))
            .order_by(EmailCardRule.id)
        ).all():
            if _refresh_current_gmail_card_balance(db, rule) is not None:
                adjusted_email_balances = True
        if adjusted_email_balances:
            record_valuation(db)
        db.commit()
    yield


FINANCE_APP_PASSWORD = os.getenv("FINANCE_APP_PASSWORD", "").strip()
FINANCE_AUTH_SECRET = os.getenv("FINANCE_AUTH_SECRET", "").strip() or FINANCE_APP_PASSWORD
AUTOMATION_SYNC_PATH = "/api/automation/sync"
_automation_lock = threading.Lock()
AUTH_TOKEN_TTL_SECONDS = int(os.getenv("FINANCE_AUTH_TTL_SECONDS", str(30 * 24 * 60 * 60)))
DEFAULT_ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]
configured_origins = [
    item.strip().rstrip("/")
    for item in os.getenv("FINANCE_ALLOWED_ORIGINS", "").split(",")
    if item.strip()
]


def _encode_part(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decode_part(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def create_auth_token() -> str:
    payload = json.dumps(
        {"exp": int(time.time()) + AUTH_TOKEN_TTL_SECONDS},
        separators=(",", ":"),
    ).encode("utf-8")
    encoded_payload = _encode_part(payload)
    signature = hmac.new(
        FINANCE_AUTH_SECRET.encode("utf-8"),
        encoded_payload.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return f"{encoded_payload}.{_encode_part(signature)}"


def valid_auth_token(token: str) -> bool:
    if not FINANCE_APP_PASSWORD or not FINANCE_AUTH_SECRET:
        return True
    try:
        encoded_payload, encoded_signature = token.split(".", 1)
        expected = hmac.new(
            FINANCE_AUTH_SECRET.encode("utf-8"),
            encoded_payload.encode("ascii"),
            hashlib.sha256,
        ).digest()
        supplied = _decode_part(encoded_signature)
        payload = json.loads(_decode_part(encoded_payload))
        return secrets.compare_digest(expected, supplied) and int(payload["exp"]) > int(time.time())
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        return False


app = FastAPI(
    title="個人財務分析工具",
    version="1.0.0",
    description="本機單人使用的資產與現金流分析 API",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=DEFAULT_ALLOWED_ORIGINS + configured_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def protect_cloud_api(request: Request, call_next):
    public_paths = {
        "/api/health",
        "/api/auth/login",
        "/api/auth/status",
        AUTOMATION_SYNC_PATH,
        "/api/email/gmail/callback",
    }
    if (
        FINANCE_APP_PASSWORD
        and request.method != "OPTIONS"
        and request.url.path.startswith("/api/")
        and request.url.path not in public_paths
    ):
        authorization = request.headers.get("Authorization", "")
        token = authorization.removeprefix("Bearer ").strip() if authorization.startswith("Bearer ") else ""
        if not valid_auth_token(token):
            return JSONResponse({"detail": "登入已失效，請重新登入"}, status_code=401)
    return await call_next(request)

DB = Annotated[Session, Depends(get_db)]


def _automation_token() -> str:
    return os.getenv("FINANCE_AUTOMATION_TOKEN", "").strip()


def _set_app_setting(db: Session, key: str, value: str) -> None:
    row = db.get(AppSetting, key)
    if not row:
        row = AppSetting(key=key, value=value)
        db.add(row)
    else:
        row.value = value


def _app_setting_value(db: Session, key: str) -> str | None:
    row = db.get(AppSetting, key)
    return row.value if row else None


def _automation_status_payload(db: Session) -> dict[str, Any]:
    connected = sum(
        1 for item in binance_connection_statuses(db) if item.get("connected")
    )
    raw_result = _app_setting_value(db, "automation:last_result")
    try:
        last_result = json.loads(raw_result) if raw_result else None
    except json.JSONDecodeError:
        last_result = None
    return {
        "enabled": bool(_automation_token()),
        "schedule": "hourly",
        "running": _automation_lock.locked(),
        "connected_exchanges": connected,
        "email_connected": gmail_status(db)["connected"],
        "last_status": _app_setting_value(db, "automation:last_status") or "idle",
        "last_started_at": _app_setting_value(db, "automation:last_started_at"),
        "last_run_at": _app_setting_value(db, "automation:last_run_at"),
        "last_error": _app_setting_value(db, "automation:last_error"),
        "last_result": last_result,
    }


def _should_refresh_fx(db: Session, now: datetime) -> bool:
    last_attempt = _app_setting_value(db, "automation:last_fx_attempt_at")
    if not last_attempt:
        return True
    try:
        return now - datetime.fromisoformat(last_attempt) >= timedelta(hours=24)
    except ValueError:
        return True


def run_automatic_updates() -> None:
    if not _automation_lock.acquire(blocking=False):
        return

    started_at = datetime.utcnow()
    db = SessionLocal()
    try:
        _set_app_setting(db, "automation:last_status", "running")
        _set_app_setting(
            db,
            "automation:last_started_at",
            started_at.isoformat(timespec="seconds"),
        )
        _set_app_setting(db, "automation:last_error", "")
        db.commit()

        exchange_results: list[dict[str, Any]] = []
        errors: list[str] = []
        connections = binance_connection_statuses(db)
        for connection in connections:
            if not connection.get("connected"):
                continue
            account = db.get(Account, connection["account_id"])
            if not account:
                continue
            try:
                # The scheduler itself runs hourly, so it may bypass the manual
                # one-hour cooldown. Cost history still keeps its own daily limit.
                exchange_results.append(sync_binance_account(db, account, force=True))
            except Exception as exc:
                db.rollback()
                errors.append(f"{account.name}：{exc}")

        fx_result: dict[str, Any] | None = None
        if _should_refresh_fx(db, started_at):
            _set_app_setting(
                db,
                "automation:last_fx_attempt_at",
                started_at.isoformat(timespec="seconds"),
            )
            db.commit()
            try:
                fx_result = refresh_fx_rates(db)
            except Exception as exc:
                db.rollback()
                errors.append(f"匯率：{exc}")

        try:
            market_result = refresh_market_prices(db)
        except Exception as exc:
            db.rollback()
            market_result = {"updated": 0, "skipped": 0, "warnings": [], "errors": []}
            errors.append(f"行情：{exc}")

        email_result: dict[str, Any] | None = None
        if gmail_status(db)["connected"]:
            try:
                email_result = sync_gmail(db)
            except Exception as exc:
                db.rollback()
                errors.append(f"信用卡郵件：{exc}")
                try:
                    process_due_card_bills(db)
                except Exception:
                    db.rollback()

        errors.extend(str(item) for item in market_result.get("errors", []))
        record_valuation(db)
        finished_at = datetime.utcnow().isoformat(timespec="seconds")
        summary = {
            "exchanges_updated": sum(
                1 for item in exchange_results if item.get("updated")
            ),
            "exchanges_skipped": sum(
                1 for item in exchange_results if item.get("skipped")
            ),
            "market_updated": int(market_result.get("updated", 0)),
            "market_skipped": int(market_result.get("skipped", 0)),
            "fx_saved": int((fx_result or {}).get("saved", 0)),
            "email_transactions_imported": int(
                (email_result or {}).get("transactions_imported", 0)
            ),
            "email_bills_found": int((email_result or {}).get("bills_found", 0)),
            "email_payments_created": int(
                (email_result or {}).get("payments_created", 0)
            ),
            "warnings": [
                *[
                    warning
                    for item in exchange_results
                    for warning in item.get("warnings", [])
                ],
                *[str(item) for item in market_result.get("warnings", [])],
            ],
            "errors": errors,
        }
        _set_app_setting(db, "automation:last_status", "warning" if errors else "success")
        _set_app_setting(db, "automation:last_run_at", finished_at)
        _set_app_setting(db, "automation:last_error", "、".join(errors))
        _set_app_setting(
            db,
            "automation:last_result",
            json.dumps(summary, ensure_ascii=False, separators=(",", ":")),
        )
        db.commit()
    except Exception as exc:
        db.rollback()
        try:
            _set_app_setting(db, "automation:last_status", "failed")
            _set_app_setting(
                db,
                "automation:last_run_at",
                datetime.utcnow().isoformat(timespec="seconds"),
            )
            _set_app_setting(db, "automation:last_error", str(exc))
            db.commit()
        except Exception:
            db.rollback()
    finally:
        db.close()
        _automation_lock.release()


@app.get("/api/auth/status")
def auth_status(request: Request):
    authorization = request.headers.get("Authorization", "")
    token = authorization.removeprefix("Bearer ").strip() if authorization.startswith("Bearer ") else ""
    return {
        "required": bool(FINANCE_APP_PASSWORD),
        "authenticated": not FINANCE_APP_PASSWORD or valid_auth_token(token),
    }


@app.post("/api/auth/login")
def auth_login(payload: AuthLogin):
    if not FINANCE_APP_PASSWORD:
        return {"token": "local-mode"}
    if not secrets.compare_digest(payload.password, FINANCE_APP_PASSWORD):
        raise HTTPException(401, "密碼錯誤")
    return {"token": create_auth_token()}


@app.get("/api/automation/status")
def automation_status(db: DB):
    return _automation_status_payload(db)


@app.post(AUTOMATION_SYNC_PATH, status_code=202)
def schedule_automatic_sync(request: Request, background_tasks: BackgroundTasks):
    expected_token = _automation_token()
    supplied_token = request.headers.get("X-Automation-Token", "").strip()
    if not expected_token:
        raise HTTPException(503, "伺服器尚未設定自動更新密鑰")
    if not supplied_token or not secrets.compare_digest(supplied_token, expected_token):
        raise HTTPException(401, "自動更新驗證失敗")
    if _automation_lock.locked():
        return {"accepted": False, "status": "already_running"}
    background_tasks.add_task(run_automatic_updates)
    return {"accepted": True, "status": "scheduled"}


def require_account(db: Session, account_id: int) -> Account:
    account = db.get(Account, account_id)
    if not account:
        raise HTTPException(404, "找不到帳戶")
    return account


def recalibrate_auto_base_if_needed(db: Session, account: Account) -> None:
    if account.auto_balance_base_twd is None:
        return
    summary = account_summary(db, account)
    account.auto_balance_base_twd = Decimal(str(summary["balance_twd"])) - Decimal(
        str(summary["investments_twd"])
    )


def next_balance_amount(account: Account, current_amount: Decimal, transaction_amount: Decimal) -> Decimal:
    if account.nature == "liability":
        return current_amount - transaction_amount
    return current_amount + transaction_amount


def validate_owner_filter(owner: str) -> str:
    if owner not in {"all", "me", "partner", "shared"}:
        raise HTTPException(422, "所有人必須是 all、me、partner 或 shared")
    return owner


GOAL_TYPES = {"net_worth", "liquid_assets", "account_balance", "investment_cost", "debt_payoff"}


def validate_goal_type(goal_type: str) -> str:
    if goal_type not in GOAL_TYPES:
        raise HTTPException(422, "不支援的目標類型")
    return goal_type


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "mode": APP_MODE, "base_currency": "TWD"}


@app.get("/api/accounts")
def list_accounts(db: DB, include_archived: bool = False, owner: str = "all"):
    owner = validate_owner_filter(owner)
    query = select(Account).order_by(Account.archived, Account.id)
    if not include_archived:
        query = query.where(Account.archived.is_(False))
    if owner != "all":
        query = query.where(Account.owner == owner)
    return [account_summary(db, item) for item in db.scalars(query).all()]


@app.post("/api/accounts", status_code=201)
def create_account(payload: AccountCreate, db: DB):
    if payload.nature not in {"asset", "liability"}:
        raise HTTPException(422, "帳戶性質必須是 asset 或 liability")
    if payload.owner not in {"me", "partner", "shared"}:
        raise HTTPException(422, "所有人必須是 me、partner 或 shared")
    account = Account(
        name=payload.name.strip(),
        institution=payload.institution,
        account_type=payload.account_type,
        nature=payload.nature,
        currency=payload.currency.upper(),
        owner=payload.owner,
        is_liquid=payload.is_liquid,
        balance_includes_positions=payload.balance_includes_positions,
        note=payload.note,
    )
    db.add(account)
    db.flush()
    if payload.opening_balance is not None:
        create_balance_snapshot(
            db,
            account,
            payload.opening_balance,
            payload.opening_date or date.today(),
        )
    db.flush()
    recalibrate_auto_base_if_needed(db, account)
    record_valuation(db)
    db.commit()
    return account_summary(db, account)


@app.patch("/api/accounts/{account_id}")
def update_account(account_id: int, payload: AccountUpdate, db: DB):
    account = require_account(db, account_id)
    for key, value in payload.model_dump(exclude_unset=True).items():
        if key == "currency" and value:
            value = value.upper()
        if key == "owner" and value not in {"me", "partner", "shared"}:
            raise HTTPException(422, "所有人必須是 me、partner 或 shared")
        setattr(account, key, value)
    db.flush()
    record_valuation(db)
    db.commit()
    return account_summary(db, account)


@app.post("/api/accounts/{account_id}/auto-estimate")
def calibrate_auto_estimate(account_id: int, db: DB):
    account = require_account(db, account_id)
    summary = account_summary(db, account)
    if summary["positions_count"] <= 0:
        raise HTTPException(422, "此帳戶沒有投資持倉，無法啟用自動估算")
    account.balance_includes_positions = True
    account.auto_balance_base_twd = Decimal(str(summary["balance_twd"])) - Decimal(
        str(summary["investments_twd"])
    )
    db.flush()
    record_valuation(db)
    db.commit()
    return account_summary(db, account)


@app.delete("/api/accounts/{account_id}/auto-estimate")
def disable_auto_estimate(account_id: int, db: DB):
    account = require_account(db, account_id)
    account.auto_balance_base_twd = None
    account.balance_includes_positions = True
    db.flush()
    record_valuation(db)
    db.commit()
    return account_summary(db, account)


@app.post("/api/accounts/{account_id}/balance", status_code=201)
def add_balance(account_id: int, payload: BalanceCreate, db: DB):
    account = require_account(db, account_id)
    snapshot = create_balance_snapshot(
        db, account, payload.amount, payload.snapshot_date, payload.fx_rate
    )
    db.flush()
    recalibrate_auto_base_if_needed(db, account)
    record_valuation(db)
    db.commit()
    return {
        "id": snapshot.id,
        "snapshot_date": snapshot.snapshot_date,
        "amount": float(snapshot.amount),
        "currency": snapshot.currency,
        "base_amount": float(snapshot.base_amount),
    }


@app.get("/api/accounts/{account_id}/balances")
def list_balances(account_id: int, db: DB):
    require_account(db, account_id)
    rows = db.scalars(
        select(BalanceSnapshot)
        .where(BalanceSnapshot.account_id == account_id)
        .order_by(BalanceSnapshot.snapshot_date.desc())
        .limit(100)
    ).all()
    return [
        {
            "id": row.id,
            "snapshot_date": row.snapshot_date,
            "amount": float(row.amount),
            "currency": row.currency,
            "fx_rate": float(row.fx_rate),
            "base_amount": float(row.base_amount),
            "source": row.source,
        }
        for row in rows
    ]


@app.post("/api/accounts/{account_id}/archive")
def archive_account(account_id: int, db: DB):
    account = require_account(db, account_id)
    account.archived = True
    record_valuation(db)
    db.commit()
    return {"ok": True}


@app.delete("/api/accounts/{account_id}")
def delete_account(account_id: int, db: DB):
    account = require_account(db, account_id)
    account.archived = True
    record_valuation(db)
    db.commit()
    return {"ok": True}


@app.post("/api/accounts/{account_id}/restore")
def restore_account(account_id: int, db: DB):
    account = require_account(db, account_id)
    account.archived = False
    record_valuation(db)
    db.commit()
    return {"ok": True}


@app.get("/api/categories")
def list_categories(db: DB):
    return [
        {
            "id": item.id,
            "name": item.name,
            "kind": item.kind,
            "essential": item.essential,
            "color": item.color,
            "icon": item.icon,
        }
        for item in db.scalars(select(Category).order_by(Category.kind.desc(), Category.id)).all()
    ]


@app.get("/api/transactions")
def list_transactions(
    db: DB,
    account_id: int | None = None,
    month: str | None = None,
    owner: str = "all",
    limit: int = Query(200, ge=1, le=1000),
):
    owner = validate_owner_filter(owner)
    query = select(Transaction).order_by(
        Transaction.transaction_date.desc(), Transaction.id.desc()
    )
    if owner != "all":
        query = query.join(Account).where(Account.owner == owner)
    if account_id:
        query = query.where(Transaction.account_id == account_id)
    if month:
        try:
            year, month_number = map(int, month.split("-"))
            start = date(year, month_number, 1)
            end = (
                date(year + 1, 1, 1)
                if month_number == 12
                else date(year, month_number + 1, 1)
            )
            query = query.where(
                Transaction.transaction_date >= start, Transaction.transaction_date < end
            )
        except ValueError as exc:
            raise HTTPException(422, "月份格式必須是 YYYY-MM") from exc
    rows = db.scalars(query.limit(limit)).all()
    return [
        {
            "id": item.id,
            "account_id": item.account_id,
            "account_name": item.account.name,
            "transaction_date": item.transaction_date,
            "description": item.description,
            "amount": float(item.amount),
            "currency": item.currency,
            "base_amount": float(item.base_amount),
            "fx_rate": float(item.fx_rate),
            "fx_estimated": item.fx_estimated,
            "transaction_kind": item.transaction_kind,
            "category_id": item.category_id,
            "category_name": item.category.name if item.category else "未分類",
            "category_color": item.category.color if item.category else "#94a3b8",
            "source": item.source,
            "note": item.note,
        }
        for item in rows
    ]


@app.post("/api/transactions/reclassify")
def reclassify_transactions(db: DB, owner: str = "all"):
    owner = validate_owner_filter(owner)
    seed_defaults(db)
    return reclassify_uncategorized_transactions(db, owner)


@app.post("/api/transactions", status_code=201)
def create_transaction(payload: TransactionCreate, db: DB):
    account = require_account(db, payload.account_id)
    currency = (payload.currency or account.currency).upper()
    rate, estimated = latest_fx_rate(db, currency, payload.transaction_date)
    if payload.fx_rate is not None:
        rate, estimated = payload.fx_rate, False
    category_id, kind = classify_transaction(db, payload.description, payload.amount)
    if payload.category_id is not None:
        category_id = payload.category_id
    if payload.transaction_kind:
        kind = payload.transaction_kind
    if kind == "transfer":
        raise HTTPException(422, "手動轉帳請使用帳戶轉帳功能")
    fingerprint = transaction_fingerprint(
        account.id, payload.transaction_date, payload.amount, payload.description
    )
    row = Transaction(
        account_id=account.id,
        transaction_date=payload.transaction_date,
        description=payload.description,
        amount=payload.amount,
        currency=currency,
        fx_rate=rate,
        base_amount=payload.amount * rate,
        fx_estimated=estimated,
        transaction_kind=kind,
        category_id=category_id,
        fingerprint=fingerprint,
        source="manual",
        note=payload.note,
    )
    db.add(row)
    try:
        db.flush()
        latest = get_latest_balance(db, account.id)
        current_amount = decimal_value(latest.amount) if latest else Decimal("0")
        if currency == account.currency:
            balance_delta = decimal_value(payload.amount)
            account_rate = rate
        else:
            base_delta = decimal_value(payload.amount) * decimal_value(rate)
            account_rate, _ = latest_fx_rate(db, account.currency, payload.transaction_date)
            balance_delta = base_delta / account_rate
        create_balance_snapshot(
            db,
            account,
            next_balance_amount(account, current_amount, balance_delta),
            payload.transaction_date,
            account_rate,
            source="transaction",
        )
        recalibrate_auto_base_if_needed(db, account)
        record_valuation(db)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "這筆交易已經存在") from exc
    return {"id": row.id}


@app.patch("/api/transactions/{transaction_id}")
def update_transaction(transaction_id: int, payload: TransactionUpdate, db: DB):
    row = db.get(Transaction, transaction_id)
    if not row:
        raise HTTPException(404, "找不到交易")
    values = payload.model_dump(
        exclude_unset=True, exclude={"create_rule", "rule_keyword"}
    )
    for key, value in values.items():
        setattr(row, key, value)
    if payload.create_rule and payload.category_id:
        keyword = (payload.rule_keyword or payload.description or row.description).strip()
        if keyword:
            rule = db.scalar(
                select(ClassificationRule).where(
                    func.lower(ClassificationRule.keyword) == keyword.lower()
                )
            )
            if not rule:
                rule = ClassificationRule(keyword=keyword, category_id=payload.category_id)
                db.add(rule)
            rule.category_id = payload.category_id
            rule.transaction_kind = payload.transaction_kind or row.transaction_kind
            uncategorized = db.scalar(select(Category).where(Category.name == "未分類"))
            matching_rows = db.scalars(
                select(Transaction).where(
                    func.lower(Transaction.description).contains(keyword.lower())
                )
            ).all()
            for matching_row in matching_rows:
                if matching_row.category_id is None or (
                    uncategorized and matching_row.category_id == uncategorized.id
                ):
                    matching_row.category_id = payload.category_id
                    matching_row.transaction_kind = payload.transaction_kind or row.transaction_kind
    db.commit()
    return {"ok": True}


@app.delete("/api/transactions/{transaction_id}")
def delete_transaction(transaction_id: int, db: DB):
    row = db.get(Transaction, transaction_id)
    if not row:
        raise HTTPException(404, "找不到交易")
    if row.source != "manual":
        raise HTTPException(422, "目前只支援刪除手動新增的交易")
    linked = db.scalar(
        select(TransferLink).where(TransferLink.from_transaction_id == transaction_id)
    ) or db.scalar(
        select(TransferLink).where(TransferLink.to_transaction_id == transaction_id)
    )
    if linked:
        raise HTTPException(422, "這筆交易已和另一筆交易配對，請先保留避免帳務不平")

    account = row.account
    latest = get_latest_balance(db, account.id)
    current_amount = decimal_value(latest.amount) if latest else Decimal("0")
    if row.currency == account.currency:
        balance_delta = decimal_value(row.amount)
        account_rate = decimal_value(row.fx_rate)
    else:
        base_delta = decimal_value(row.base_amount)
        account_rate, _ = latest_fx_rate(db, account.currency, row.transaction_date)
        balance_delta = base_delta / account_rate

    create_balance_snapshot(
        db,
        account,
        next_balance_amount(account, current_amount, -balance_delta),
        row.transaction_date,
        account_rate,
        source="transaction_delete",
    )
    db.delete(row)
    db.flush()
    recalibrate_auto_base_if_needed(db, account)
    record_valuation(db)
    db.commit()
    return {"ok": True}


@app.post("/api/transactions/import/inspect")
async def inspect_transaction_csv(file: UploadFile = File(...)):
    content = await file.read()
    try:
        return inspect_csv(content)
    except Exception as exc:
        raise HTTPException(422, f"無法讀取 CSV：{exc}") from exc


@app.post("/api/transactions/import")
async def import_transactions(
    db: DB,
    file: UploadFile = File(...),
    account_id: int = Form(...),
    mapping_json: str = Form(...),
    commit: bool = Form(True),
    adjust_balance: bool = Form(True),
):
    account = require_account(db, account_id)
    content = await file.read()
    try:
        mapping = json.loads(mapping_json)
        return import_csv(
            db,
            content,
            account,
            mapping,
            commit=commit,
            adjust_balance=adjust_balance,
        )
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/api/transactions/import-balance/pending")
def pending_imported_transaction_balances(db: DB, owner: str = "all"):
    owner = validate_owner_filter(owner)
    query = select(Account).where(Account.archived.is_(False)).order_by(Account.id)
    if owner != "all":
        query = query.where(Account.owner == owner)
    statuses = [pending_csv_balance_status(db, account) for account in db.scalars(query).all()]
    return [status for status in statuses if status["count"] > 0]


@app.post("/api/transactions/import-balance/apply/{account_id}")
def apply_imported_transaction_balance(account_id: int, db: DB):
    account = require_account(db, account_id)
    return apply_pending_csv_balance(db, account)


@app.get("/api/transfers/suggestions")
def transfer_suggestions(db: DB):
    linked = set(
        db.scalars(select(TransferLink.from_transaction_id)).all()
        + db.scalars(select(TransferLink.to_transaction_id)).all()
    )
    cutoff = date.today() - timedelta(days=120)
    rows = db.scalars(
        select(Transaction)
        .where(Transaction.transaction_date >= cutoff)
        .order_by(Transaction.transaction_date)
    ).all()
    suggestions = []
    for index, left in enumerate(rows):
        if left.id in linked:
            continue
        for right in rows[index + 1 :]:
            if right.id in linked or left.account_id == right.account_id:
                continue
            if abs((right.transaction_date - left.transaction_date).days) > 3:
                continue
            if abs(decimal_value(left.base_amount) + decimal_value(right.base_amount)) <= Decimal("2"):
                suggestions.append(
                    {
                        "from": {
                            "id": left.id,
                            "account": left.account.name,
                            "date": left.transaction_date,
                            "description": left.description,
                            "amount": float(left.base_amount),
                        },
                        "to": {
                            "id": right.id,
                            "account": right.account.name,
                            "date": right.transaction_date,
                            "description": right.description,
                            "amount": float(right.base_amount),
                        },
                    }
                )
                break
    return suggestions[:30]


@app.post("/api/transfers")
def confirm_transfer(payload: TransferCreate, db: DB):
    left = db.get(Transaction, payload.from_transaction_id)
    right = db.get(Transaction, payload.to_transaction_id)
    if not left or not right:
        raise HTTPException(404, "找不到要配對的交易")
    if left.account_id == right.account_id:
        raise HTTPException(422, "轉帳必須發生在不同帳戶")
    if abs(decimal_value(left.base_amount) + decimal_value(right.base_amount)) > Decimal("2"):
        raise HTTPException(422, "兩筆交易的換算金額不相符")
    link = TransferLink(
        from_transaction_id=left.id, to_transaction_id=right.id, confirmed=True
    )
    left.transaction_kind = "transfer"
    right.transaction_kind = "transfer"
    db.add(link)
    db.commit()
    return {"id": link.id}


@app.post("/api/loan-payments", status_code=201)
def create_loan_payment(payload: LoanPaymentCreate, db: DB):
    payment_account = require_account(db, payload.payment_account_id)
    loan_account = require_account(db, payload.loan_account_id)
    if payment_account.id == loan_account.id:
        raise HTTPException(422, "付款帳戶與貸款帳戶不能相同")
    if payment_account.archived or loan_account.archived:
        raise HTTPException(422, "封存帳戶不能建立貸款還款")
    if payment_account.nature != "asset":
        raise HTTPException(422, "付款帳戶必須是資產帳戶")
    if loan_account.nature != "liability":
        raise HTTPException(422, "貸款帳戶必須是負債帳戶")
    if payment_account.currency != loan_account.currency:
        raise HTTPException(422, "目前貸款還款先支援同幣別帳戶")

    principal = decimal_value(payload.principal)
    interest = decimal_value(payload.interest)
    total = principal + interest
    if total <= 0:
        raise HTTPException(422, "本金或利息至少要填一項")

    payment_date = payload.payment_date
    rate, estimated = latest_fx_rate(db, payment_account.currency, payment_date)
    description = (payload.description or "貸款還款").strip()
    created_ids: list[int] = []

    try:
        payment_latest = get_latest_balance(db, payment_account.id)
        loan_latest = get_latest_balance(db, loan_account.id)
        payment_current = (
            decimal_value(payment_latest.amount) if payment_latest else Decimal("0")
        )
        loan_current = decimal_value(loan_latest.amount) if loan_latest else Decimal("0")

        principal_out = None
        principal_in = None
        if principal > 0:
            principal_out_description = f"{description}（本金）"
            principal_out = Transaction(
                account_id=payment_account.id,
                transaction_date=payment_date,
                description=principal_out_description,
                amount=-principal,
                currency=payment_account.currency,
                fx_rate=rate,
                base_amount=-principal * rate,
                fx_estimated=estimated,
                transaction_kind="debt_principal",
                fingerprint=transaction_fingerprint(
                    payment_account.id,
                    payment_date,
                    -principal,
                    principal_out_description,
                ),
                source="manual",
                note=payload.note,
            )
            principal_in_description = f"{description}（沖抵本金）"
            principal_in = Transaction(
                account_id=loan_account.id,
                transaction_date=payment_date,
                description=principal_in_description,
                amount=principal,
                currency=loan_account.currency,
                fx_rate=rate,
                base_amount=principal * rate,
                fx_estimated=estimated,
                transaction_kind="transfer",
                fingerprint=transaction_fingerprint(
                    loan_account.id,
                    payment_date,
                    principal,
                    principal_in_description,
                ),
                source="manual",
                note=payload.note,
            )
            db.add(principal_out)
            db.add(principal_in)

        if interest > 0:
            interest_description = f"{description}（利息）"
            interest_row = Transaction(
                account_id=payment_account.id,
                transaction_date=payment_date,
                description=interest_description,
                amount=-interest,
                currency=payment_account.currency,
                fx_rate=rate,
                base_amount=-interest * rate,
                fx_estimated=estimated,
                transaction_kind="interest",
                fingerprint=transaction_fingerprint(
                    payment_account.id,
                    payment_date,
                    -interest,
                    interest_description,
                ),
                source="manual",
                note=payload.note,
            )
            db.add(interest_row)

        db.flush()

        if principal_out is not None and principal_in is not None:
            db.add(
                TransferLink(
                    from_transaction_id=principal_out.id,
                    to_transaction_id=principal_in.id,
                    confirmed=True,
                )
            )
            created_ids.extend([principal_out.id, principal_in.id])
        if interest > 0:
            created_ids.append(interest_row.id)

        create_balance_snapshot(
            db,
            payment_account,
            next_balance_amount(payment_account, payment_current, -total),
            payment_date,
            rate,
            source="loan_payment",
        )
        if principal > 0:
            create_balance_snapshot(
                db,
                loan_account,
                next_balance_amount(loan_account, loan_current, principal),
                payment_date,
                rate,
                source="loan_payment",
            )
        db.flush()
        recalibrate_auto_base_if_needed(db, payment_account)
        recalibrate_auto_base_if_needed(db, loan_account)
        record_valuation(db)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "這筆貸款還款可能已經存在，請調整日期或說明後再試") from exc

    return {
        "transaction_ids": created_ids,
        "payment_account": account_summary(db, payment_account),
        "loan_account": account_summary(db, loan_account),
    }


@app.post("/api/account-transfers", status_code=201)
def create_account_transfer(payload: AccountTransferCreate, db: DB):
    from_account = require_account(db, payload.from_account_id)
    to_account = require_account(db, payload.to_account_id)
    if from_account.id == to_account.id:
        raise HTTPException(422, "轉出與轉入帳戶不能相同")
    if from_account.archived or to_account.archived:
        raise HTTPException(422, "封存帳戶不能建立轉帳")

    transfer_date = payload.transfer_date
    amount = decimal_value(payload.amount)
    from_rate, from_estimated = latest_fx_rate(db, from_account.currency, transfer_date)
    to_rate, to_estimated = latest_fx_rate(db, to_account.currency, transfer_date)
    from_base_amount = amount * from_rate
    if payload.to_amount is not None:
        to_amount = decimal_value(payload.to_amount)
    elif from_account.currency == to_account.currency:
        to_amount = amount
    else:
        to_amount = from_base_amount / to_rate
    to_base_amount = to_amount * to_rate

    description = (payload.description or "帳戶轉帳").strip()
    from_description = f"{description} → {to_account.name}"
    to_description = f"{description} ← {from_account.name}"

    from_transaction = Transaction(
        account_id=from_account.id,
        transaction_date=transfer_date,
        description=from_description,
        amount=-amount,
        currency=from_account.currency,
        fx_rate=from_rate,
        base_amount=-from_base_amount,
        fx_estimated=from_estimated,
        transaction_kind="transfer",
        fingerprint=transaction_fingerprint(
            from_account.id, transfer_date, -amount, from_description
        ),
        source="manual",
        note=payload.note,
    )
    to_transaction = Transaction(
        account_id=to_account.id,
        transaction_date=transfer_date,
        description=to_description,
        amount=to_amount,
        currency=to_account.currency,
        fx_rate=to_rate,
        base_amount=to_base_amount,
        fx_estimated=to_estimated,
        transaction_kind="transfer",
        fingerprint=transaction_fingerprint(
            to_account.id, transfer_date, to_amount, to_description
        ),
        source="manual",
        note=payload.note,
    )

    try:
        db.add(from_transaction)
        db.add(to_transaction)
        db.flush()

        from_latest = get_latest_balance(db, from_account.id)
        to_latest = get_latest_balance(db, to_account.id)
        from_current = decimal_value(from_latest.amount) if from_latest else Decimal("0")
        to_current = decimal_value(to_latest.amount) if to_latest else Decimal("0")

        create_balance_snapshot(
            db,
            from_account,
            next_balance_amount(from_account, from_current, -amount),
            transfer_date,
            from_rate,
            source="transfer",
        )
        create_balance_snapshot(
            db,
            to_account,
            next_balance_amount(to_account, to_current, to_amount),
            transfer_date,
            to_rate,
            source="transfer",
        )
        link = TransferLink(
            from_transaction_id=from_transaction.id,
            to_transaction_id=to_transaction.id,
            confirmed=True,
        )
        db.add(link)
        db.flush()
        recalibrate_auto_base_if_needed(db, from_account)
        recalibrate_auto_base_if_needed(db, to_account)
        record_valuation(db)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "這筆轉帳可能已經存在，請調整日期或說明後再試") from exc

    return {
        "id": link.id,
        "from_transaction_id": from_transaction.id,
        "to_transaction_id": to_transaction.id,
        "from_account": account_summary(db, from_account),
        "to_account": account_summary(db, to_account),
    }


def apply_investment_cash_change(
    db: Session,
    cash_account: Account,
    position_account: Account,
    trade_date: date,
    balance_delta: Decimal,
    base_delta: Decimal,
    account_rate: Decimal,
) -> None:
    if cash_account.auto_balance_base_twd is not None:
        cash_account.auto_balance_base_twd = (
            decimal_value(cash_account.auto_balance_base_twd) + base_delta
        )
        return

    if cash_account.id == position_account.id and cash_account.balance_includes_positions:
        return

    latest = get_latest_balance(db, cash_account.id)
    current_amount = decimal_value(latest.amount) if latest else Decimal("0")
    create_balance_snapshot(
        db,
        cash_account,
        next_balance_amount(cash_account, current_amount, balance_delta),
        trade_date,
        account_rate,
        source="investment_trade",
    )


@app.post("/api/investment-trades", status_code=201)
def create_investment_trade(payload: InvestmentTradeCreate, db: DB):
    side = payload.side.lower()
    if side not in {"buy", "sell"}:
        raise HTTPException(422, "買賣方向必須是 buy 或 sell")

    position_account = require_account(db, payload.account_id)
    cash_account = require_account(db, payload.cash_account_id or payload.account_id)
    if position_account.archived or cash_account.archived:
        raise HTTPException(422, "封存帳戶不能建立投資交易")
    if position_account.nature != "asset":
        raise HTTPException(422, "持倉只能建立在資產帳戶")
    if position_account.account_type not in {"brokerage", "crypto"}:
        raise HTTPException(422, "持倉帳戶必須是證券戶或交易所帳戶")
    if cash_account.nature != "asset":
        raise HTTPException(422, "扣款或入帳帳戶必須是資產帳戶")

    market = payload.market.upper()
    symbol = payload.symbol.strip().lower() if market == "CRYPTO" else payload.symbol.strip().upper()
    if not symbol:
        raise HTTPException(422, "請輸入投資標的")

    quantity = decimal_value(payload.quantity)
    total_amount = decimal_value(payload.total_amount)
    currency = payload.currency.upper()
    unit_cost = total_amount / quantity
    rate, estimated = latest_fx_rate(db, currency, payload.trade_date)
    base_total = total_amount * decimal_value(rate)
    cash_rate, _ = latest_fx_rate(db, cash_account.currency, payload.trade_date)
    cash_total = base_total / decimal_value(cash_rate)

    position = db.scalar(
        select(Position).where(
            Position.account_id == position_account.id,
            Position.market == market,
            Position.symbol == symbol,
            Position.archived.is_(False),
        )
    )

    if side == "buy":
        created_position = position is None
        if position:
            old_quantity = decimal_value(position.quantity)
            new_quantity = old_quantity + quantity
            old_cost = old_quantity * decimal_value(position.average_cost)
            added_cost = quantity * unit_cost
            position.quantity = new_quantity
            position.average_cost = (old_cost + added_cost) / new_quantity
            position.currency = currency
            if payload.name:
                position.name = payload.name
            if payload.manual_price is not None:
                position.manual_price = payload.manual_price
        else:
            position = Position(
                account_id=position_account.id,
                market=market,
                symbol=symbol,
                name=payload.name,
                quantity=quantity,
                average_cost=unit_cost,
                currency=currency,
                manual_price=payload.manual_price,
            )
            db.add(position)
        signed_amount = -total_amount
        signed_base = -base_total
        balance_delta = -cash_total
        action_label = "買入"
    else:
        if not position:
            raise HTTPException(422, "找不到可賣出的持倉")
        old_quantity = decimal_value(position.quantity)
        if quantity > old_quantity:
            raise HTTPException(422, "賣出數量不能大於目前持有數量")
        position.quantity = old_quantity - quantity
        if payload.name:
            position.name = payload.name
        if payload.manual_price is not None:
            position.manual_price = payload.manual_price
        if decimal_value(position.quantity) <= 0:
            position.archived = True
        signed_amount = total_amount
        signed_base = base_total
        balance_delta = cash_total
        action_label = "賣出"

    description = f"{action_label} {symbol}（{quantity}）"
    transaction = Transaction(
        account_id=cash_account.id,
        transaction_date=payload.trade_date,
        description=description,
        amount=signed_amount,
        currency=currency,
        fx_rate=rate,
        base_amount=signed_base,
        fx_estimated=estimated,
        transaction_kind="investment",
        category_id=None,
        fingerprint=transaction_fingerprint(
            cash_account.id,
            payload.trade_date,
            signed_amount,
            description,
        ),
        source="investment_trade",
        note=payload.note,
    )
    db.add(transaction)

    try:
        db.flush()
        if side == "buy" and created_position:
            set_position_cost_status(db, position, "calculated")
        apply_investment_cash_change(
            db,
            cash_account,
            position_account,
            payload.trade_date,
            balance_delta,
            signed_base,
            cash_rate,
        )
        record_valuation(db)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "這筆投資交易可能已經存在") from exc

    return {
        "transaction_id": transaction.id,
        "position": None if position.archived else position_summary(db, position),
        "position_account": account_summary(db, position_account),
        "cash_account": account_summary(db, cash_account),
    }


@app.get("/api/positions")
def list_positions(db: DB, include_archived: bool = False, owner: str = "all"):
    owner = validate_owner_filter(owner)
    query = select(Position).join(Account).order_by(Position.archived, Position.market, Position.symbol)
    if not include_archived:
        query = query.where(Position.archived.is_(False))
    if owner != "all":
        query = query.where(Account.owner == owner)
    return [position_summary(db, item) for item in db.scalars(query).all()]


@app.post("/api/positions", status_code=201)
def create_position(payload: PositionCreate, db: DB):
    account = require_account(db, payload.account_id)
    if account.nature != "asset":
        raise HTTPException(422, "持倉只能建立在資產帳戶")
    market = payload.market.upper()
    symbol = payload.symbol.lower() if market == "CRYPTO" else payload.symbol.upper()
    existing = db.scalar(
        select(Position).where(
            Position.account_id == payload.account_id,
            Position.market == market,
            Position.symbol == symbol,
            Position.archived.is_(False),
        )
    )
    if existing:
        old_quantity = decimal_value(existing.quantity)
        added_quantity = decimal_value(payload.quantity)
        new_quantity = old_quantity + added_quantity
        if new_quantity <= 0:
            raise HTTPException(422, "加倉後數量必須大於 0")

        old_cost = old_quantity * decimal_value(existing.average_cost)
        added_cost = added_quantity * decimal_value(payload.average_cost)
        existing.quantity = new_quantity
        existing.average_cost = (old_cost + added_cost) / new_quantity
        existing.currency = payload.currency.upper()
        if payload.name:
            existing.name = payload.name
        if payload.manual_price is not None:
            existing.manual_price = payload.manual_price
        db.flush()
        set_position_cost_status(db, existing, "confirmed")
        recalibrate_auto_base_if_needed(db, account)
        record_valuation(db)
        db.commit()
        return position_summary(db, existing)

    row = Position(
        account_id=payload.account_id,
        market=market,
        symbol=symbol,
        name=payload.name,
        quantity=payload.quantity,
        average_cost=payload.average_cost,
        currency=payload.currency.upper(),
        manual_price=payload.manual_price,
    )
    db.add(row)
    db.flush()
    set_position_cost_status(db, row, "confirmed")
    recalibrate_auto_base_if_needed(db, account)
    record_valuation(db)
    db.commit()
    return position_summary(db, row)


@app.patch("/api/positions/{position_id}")
def update_position(position_id: int, payload: PositionUpdate, db: DB):
    row = db.get(Position, position_id)
    if not row:
        raise HTTPException(404, "找不到持倉")
    changes = payload.model_dump(exclude_unset=True)
    for key, value in changes.items():
        setattr(row, key, value)
    db.flush()
    if "average_cost" in changes:
        set_position_cost_status(db, row, "confirmed")
    recalibrate_auto_base_if_needed(db, row.account)
    record_valuation(db)
    db.commit()
    return position_summary(db, row)


@app.post("/api/positions/{position_id}/archive")
def archive_position(position_id: int, db: DB):
    row = db.get(Position, position_id)
    if not row:
        raise HTTPException(404, "找不到持倉")
    row.archived = True
    db.flush()
    recalibrate_auto_base_if_needed(db, row.account)
    record_valuation(db)
    db.commit()
    return {"ok": True}


@app.delete("/api/positions/{position_id}")
def delete_position(position_id: int, db: DB):
    row = db.get(Position, position_id)
    if not row:
        raise HTTPException(404, "找不到持倉")
    account = row.account
    db.delete(row)
    db.flush()
    recalibrate_auto_base_if_needed(db, account)
    record_valuation(db)
    db.commit()
    return {"ok": True}


@app.post("/api/market/refresh")
def update_market_prices(db: DB, force: bool = False):
    fx_error = None
    foreign_currencies = db.scalars(
        select(Position.currency)
        .where(Position.archived.is_(False), Position.currency != "TWD")
        .distinct()
    ).all()
    missing_fx = [
        currency
        for currency in foreign_currencies
        if not db.scalar(select(FxRate.id).where(FxRate.currency == currency).limit(1))
    ]
    if missing_fx:
        try:
            refresh_fx_rates(db)
        except Exception as exc:
            fx_error = f"匯率更新失敗：{exc}"

    result = refresh_market_prices(db, force=force)
    if fx_error:
        result["errors"].append(fx_error)
    return result


@app.get("/api/fx")
def list_fx(db: DB):
    currencies = db.scalars(select(FxRate.currency).distinct().order_by(FxRate.currency)).all()
    result = []
    for currency in currencies:
        latest = db.scalar(
            select(FxRate)
            .where(FxRate.currency == currency)
            .order_by(FxRate.rate_date.desc(), FxRate.manual.desc())
        )
        if latest:
            result.append(
                {
                    "currency": currency,
                    "rate_date": latest.rate_date,
                    "rate_to_twd": float(latest.rate_to_twd),
                    "source": latest.source,
                    "manual": latest.manual,
                }
            )
    return result


@app.post("/api/fx/refresh")
def update_fx(db: DB):
    try:
        return refresh_fx_rates(db)
    except Exception as exc:
        raise HTTPException(502, f"無法更新央行匯率：{exc}") from exc


@app.post("/api/fx/manual")
def create_manual_fx(payload: FxRateCreate, db: DB):
    currency = payload.currency.upper()
    row = db.scalar(
        select(FxRate).where(
            FxRate.currency == currency, FxRate.rate_date == payload.rate_date
        )
    )
    if not row:
        row = FxRate(currency=currency, rate_date=payload.rate_date)
        db.add(row)
    row.rate_to_twd = payload.rate_to_twd
    row.source = "manual"
    row.manual = True
    db.commit()
    return {"ok": True}


@app.get("/api/budgets")
def list_budgets(db: DB, month: str | None = None):
    month = month or date.today().strftime("%Y-%m")
    rows = db.scalars(
        select(Budget).where(Budget.month == month).order_by(Budget.id)
    ).all()
    start = date.fromisoformat(f"{month}-01")
    end = (
        date(start.year + 1, 1, 1)
        if start.month == 12
        else date(start.year, start.month + 1, 1)
    )
    result = []
    for row in rows:
        spent = db.scalar(
            select(func.sum(func.abs(Transaction.base_amount))).where(
                Transaction.category_id == row.category_id,
                Transaction.transaction_kind.in_(["expense", "interest"]),
                Transaction.transaction_date >= start,
                Transaction.transaction_date < end,
            )
        ) or 0
        result.append(
            {
                "id": row.id,
                "month": row.month,
                "category_id": row.category_id,
                "category_name": row.category.name,
                "category_color": row.category.color,
                "amount": float(row.amount),
                "spent": float(spent),
                "percentage": float(Decimal(str(spent)) / row.amount * 100),
            }
        )
    return result


@app.post("/api/budgets")
def upsert_budget(payload: BudgetCreate, db: DB):
    if not db.get(Category, payload.category_id):
        raise HTTPException(404, "找不到分類")
    row = db.scalar(
        select(Budget).where(
            Budget.month == payload.month, Budget.category_id == payload.category_id
        )
    )
    if not row:
        row = Budget(
            month=payload.month, category_id=payload.category_id, amount=payload.amount
        )
        db.add(row)
    else:
        row.amount = payload.amount
    db.commit()
    return {"id": row.id}


@app.delete("/api/budgets/{budget_id}")
def delete_budget(budget_id: int, db: DB):
    row = db.get(Budget, budget_id)
    if not row:
        raise HTTPException(404, "找不到預算")
    db.delete(row)
    db.commit()
    return {"ok": True}


@app.get("/api/goals")
def list_goals(db: DB, owner: str = "all"):
    owner = validate_owner_filter(owner)
    query = select(Goal).order_by(Goal.completed, Goal.target_date)
    if owner != "all":
        query = query.where(Goal.owner == owner)
    rows = db.scalars(query).all()
    return [
        {
            "id": row.id,
            "name": row.name,
            "owner": row.owner,
            "owner_label": OWNER_LABELS.get(row.owner, row.owner),
            "goal_type": row.goal_type,
            "account_id": row.account_id,
            "account_name": row.account.name if row.account else None,
            "target_amount": float(row.target_amount),
            "current_amount": float(row.current_amount),
            "target_date": row.target_date,
            "currency": row.currency,
            "completed": row.completed,
            "note": row.note,
            "progress": min(float(row.current_amount / row.target_amount * 100), 100),
        }
        for row in rows
    ]


@app.post("/api/goals", status_code=201)
def create_goal(payload: GoalCreate, db: DB):
    if payload.owner not in {"me", "partner", "shared"}:
        raise HTTPException(422, "目標所有人必須是 me、partner 或 shared")
    validate_goal_type(payload.goal_type)
    if payload.account_id is not None and not db.get(Account, payload.account_id):
        raise HTTPException(404, "找不到目標連結帳戶")
    row = Goal(**payload.model_dump())
    db.add(row)
    db.commit()
    return {"id": row.id}


@app.patch("/api/goals/{goal_id}")
def update_goal(goal_id: int, payload: GoalUpdate, db: DB):
    row = db.get(Goal, goal_id)
    if not row:
        raise HTTPException(404, "找不到目標")
    for key, value in payload.model_dump(exclude_unset=True).items():
        if key == "owner" and value not in {"me", "partner", "shared"}:
            raise HTTPException(422, "目標所有人必須是 me、partner 或 shared")
        if key == "goal_type" and value is not None:
            validate_goal_type(value)
        if key == "account_id" and value is not None and not db.get(Account, value):
            raise HTTPException(404, "找不到目標連結帳戶")
        setattr(row, key, value)
    db.commit()
    return {"ok": True}


@app.get("/api/rules")
def list_rules(db: DB):
    default_keywords = {keyword.casefold() for keyword, _, _ in DEFAULT_RULES}
    return [
        {
            "id": row.id,
            "keyword": row.keyword,
            "category_id": row.category_id,
            "category_name": row.category.name,
            "transaction_kind": row.transaction_kind,
            "priority": row.priority,
            "enabled": row.enabled,
            "is_default": row.keyword.casefold() in default_keywords,
        }
        for row in db.scalars(
            select(ClassificationRule).order_by(
                ClassificationRule.priority, ClassificationRule.id
            )
        ).all()
    ]


@app.post("/api/rules")
def create_rule(payload: RuleCreate, db: DB):
    if not db.get(Category, payload.category_id):
        raise HTTPException(404, "找不到分類")
    existing = db.scalar(
        select(ClassificationRule).where(
            func.lower(ClassificationRule.keyword) == payload.keyword.lower()
        )
    )
    if existing:
        existing.category_id = payload.category_id
        existing.transaction_kind = payload.transaction_kind
        existing.priority = payload.priority
        row = existing
    else:
        row = ClassificationRule(**payload.model_dump())
        db.add(row)
    db.commit()
    return {"id": row.id}


@app.patch("/api/rules/{rule_id}")
def update_rule(rule_id: int, payload: RuleUpdate, db: DB):
    row = db.get(ClassificationRule, rule_id)
    if not row:
        raise HTTPException(404, "找不到規則")
    changes = payload.model_dump(exclude_unset=True)
    if "category_id" in changes and not db.get(Category, changes["category_id"]):
        raise HTTPException(404, "找不到分類")
    if "keyword" in changes:
        keyword = str(changes["keyword"]).strip()
        if not keyword:
            raise HTTPException(422, "關鍵字不可空白")
        duplicate = db.scalar(
            select(ClassificationRule).where(
                func.lower(ClassificationRule.keyword) == keyword.lower(),
                ClassificationRule.id != rule_id,
            )
        )
        if duplicate:
            raise HTTPException(409, "已有相同關鍵字的規則")
        changes["keyword"] = keyword
    for key, value in changes.items():
        setattr(row, key, value)
    db.commit()
    return {"ok": True}


@app.delete("/api/rules/{rule_id}")
def delete_rule(rule_id: int, db: DB):
    row = db.get(ClassificationRule, rule_id)
    if not row:
        raise HTTPException(404, "找不到規則")
    db.delete(row)
    db.commit()
    return {"ok": True}


@app.get("/api/dashboard")
def dashboard(db: DB, owner: str = "all"):
    owner = validate_owner_filter(owner)
    return calculate_dashboard(db, owner=owner)


@app.get("/api/analysis/health")
def financial_health(db: DB, owner: str = "all"):
    owner = validate_owner_filter(owner)
    return calculate_health_score(db, owner=owner)


@app.get("/api/analysis/spending")
def spending_analysis(db: DB, month: str | None = None, owner: str = "all"):
    owner = validate_owner_filter(owner)
    selected_month = month or date.today().strftime("%Y-%m")
    try:
        return calculate_spending_analysis(db, selected_month, owner=owner)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def recurring_expense_payload(row: RecurringExpense) -> dict[str, Any]:
    return {
        "id": row.id,
        "name": row.name,
        "owner": row.owner,
        "amount": float(row.amount),
        "due_day": row.due_day,
        "account_id": row.account_id,
        "account_name": row.account.name if row.account else None,
        "category_id": row.category_id,
        "category_name": row.category.name if row.category else None,
        "active": row.active,
        "note": row.note,
    }


def validate_recurring_expense_links(
    db: Session, account_id: int | None, category_id: int | None
) -> None:
    if account_id is not None and not db.get(Account, account_id):
        raise HTTPException(404, "找不到固定花費連結帳戶")
    if category_id is not None and not db.get(Category, category_id):
        raise HTTPException(404, "找不到固定花費分類")


@app.get("/api/recurring-expenses")
def list_recurring_expenses(
    db: DB, owner: str = "all", include_inactive: bool = False
):
    owner = validate_owner_filter(owner)
    query = select(RecurringExpense).order_by(
        RecurringExpense.active.desc(), RecurringExpense.due_day, RecurringExpense.id
    )
    if owner != "all":
        query = query.where(RecurringExpense.owner == owner)
    if not include_inactive:
        query = query.where(RecurringExpense.active.is_(True))
    return [recurring_expense_payload(row) for row in db.scalars(query).all()]


@app.post("/api/recurring-expenses", status_code=201)
def create_recurring_expense(payload: RecurringExpenseCreate, db: DB):
    if payload.owner not in {"me", "partner", "shared"}:
        raise HTTPException(422, "固定花費所有人必須是 me、partner 或 shared")
    validate_recurring_expense_links(db, payload.account_id, payload.category_id)
    row = RecurringExpense(**payload.model_dump())
    row.name = row.name.strip()
    db.add(row)
    db.commit()
    return recurring_expense_payload(row)


@app.patch("/api/recurring-expenses/{expense_id}")
def update_recurring_expense(
    expense_id: int, payload: RecurringExpenseUpdate, db: DB
):
    row = db.get(RecurringExpense, expense_id)
    if not row:
        raise HTTPException(404, "找不到自訂固定花費")
    values = payload.model_dump(exclude_unset=True)
    if values.get("owner") is not None and values["owner"] not in {
        "me",
        "partner",
        "shared",
    }:
        raise HTTPException(422, "固定花費所有人必須是 me、partner 或 shared")
    validate_recurring_expense_links(
        db,
        values.get("account_id", row.account_id),
        values.get("category_id", row.category_id),
    )
    for key, value in values.items():
        if key == "name" and value is not None:
            value = value.strip()
        setattr(row, key, value)
    db.commit()
    return recurring_expense_payload(row)


@app.delete("/api/recurring-expenses/{expense_id}")
def delete_recurring_expense(expense_id: int, db: DB):
    row = db.get(RecurringExpense, expense_id)
    if not row:
        raise HTTPException(404, "找不到自訂固定花費")
    db.delete(row)
    db.commit()
    return {"ok": True}


@app.post("/api/recurring-expenses/ignore-detected", status_code=201)
def ignore_detected_recurring_expense(
    payload: DetectedRecurringIgnoreCreate, db: DB
):
    account = require_account(db, payload.account_id)
    display_name = payload.name.strip()
    normalized_name = recurring_expense_signature(display_name)
    if not normalized_name:
        raise HTTPException(422, "固定花費名稱不能為空")
    existing = db.scalar(
        select(IgnoredRecurringExpense).where(
            IgnoredRecurringExpense.account_id == account.id,
            IgnoredRecurringExpense.normalized_name == normalized_name,
        )
    )
    if existing:
        return {"ok": True, "id": existing.id}
    row = IgnoredRecurringExpense(
        owner=account.owner,
        account_id=account.id,
        normalized_name=normalized_name,
        display_name=display_name,
    )
    db.add(row)
    db.commit()
    return {"ok": True, "id": row.id}


@app.get("/api/exchanges/binance")
def get_binance_connections(db: DB):
    return binance_connection_statuses(db)


@app.post("/api/exchanges/binance/connect")
def connect_binance(payload: BinanceConnectionCreate, db: DB):
    account = require_account(db, payload.account_id)
    try:
        result = sync_binance_account(
            db,
            account,
            force=True,
            api_key=payload.api_key.strip(),
            api_secret=payload.api_secret.strip(),
            save_credentials=True,
        )
    except ValueError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc
    return {"connected": True, **result}


@app.delete("/api/exchanges/binance/{account_id}")
def disconnect_binance(account_id: int, db: DB):
    account = require_account(db, account_id)
    disconnect_binance_account(db, account.id)
    return {"ok": True}


@app.post("/api/exchanges/sync")
def sync_exchanges(db: DB, account_id: int | None = None, force: bool = False):
    connections = binance_connection_statuses(db)
    connected_ids = {
        item["account_id"] for item in connections if item["connected"]
    }
    if account_id is not None:
        if account_id not in connected_ids:
            raise HTTPException(422, "這個交易所帳戶尚未連接幣安")
        connected_ids = {account_id}

    results: list[dict[str, Any]] = []
    errors: list[str] = []
    for connected_id in sorted(connected_ids):
        account = require_account(db, connected_id)
        try:
            results.append(sync_binance_account(db, account, force=force))
        except ValueError as exc:
            db.rollback()
            errors.append(f"{account.name}：{exc}")
    return {
        "connected": len(connected_ids),
        "updated": sum(1 for item in results if item.get("updated")),
        "skipped": sum(1 for item in results if item.get("skipped")),
        "results": results,
        "errors": errors,
    }


def _validate_email_rule_accounts(
    db: Session, card_account_id: int, payment_account_id: int
) -> tuple[Account, Account]:
    card_account = require_account(db, card_account_id)
    payment_account = require_account(db, payment_account_id)
    if card_account.archived or payment_account.archived:
        raise HTTPException(422, "不能使用已停用的帳戶")
    if card_account.nature != "liability" or card_account.account_type != "credit_card":
        raise HTTPException(422, "信用卡帳戶必須是負債性質的信用卡帳戶")
    if payment_account.nature != "asset":
        raise HTTPException(422, "扣款帳戶必須是資產帳戶")
    if card_account.currency != payment_account.currency:
        raise HTTPException(422, "第一版只支援信用卡與扣款帳戶使用相同幣別")
    return card_account, payment_account


def _validate_email_patterns(sender_pattern: str | None, subject_pattern: str | None) -> None:
    if not (sender_pattern or "").strip() and not (subject_pattern or "").strip():
        raise HTTPException(422, "寄件者或主旨關鍵字至少要填一項，避免讀取不相關郵件")


@app.get("/api/email/gmail/status")
def get_gmail_status(db: DB):
    return gmail_status(db)


@app.post("/api/email/gmail/authorize")
def authorize_gmail(request: Request, db: DB):
    try:
        redirect_uri = gmail_callback_url(str(request.base_url))
        return {
            "authorization_url": gmail_authorization_url(db, redirect_uri),
            "redirect_uri": redirect_uri,
        }
    except ValueError as exc:
        raise HTTPException(503, str(exc)) from exc


@app.get("/api/email/gmail/callback", include_in_schema=False)
def gmail_callback(
    request: Request,
    db: DB,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
):
    destination = frontend_settings_url()
    if error or not code or not state:
        return RedirectResponse(f"{destination}?gmail=error")
    try:
        complete_gmail_authorization(
            db,
            code,
            state,
            gmail_callback_url(str(request.base_url)),
        )
        return RedirectResponse(f"{destination}?gmail=connected")
    except ValueError:
        db.rollback()
        return RedirectResponse(f"{destination}?gmail=error")


@app.delete("/api/email/gmail")
def remove_gmail_connection(db: DB):
    disconnect_gmail(db)
    return {"ok": True}


@app.post("/api/email/gmail/sync")
def synchronize_gmail(db: DB):
    try:
        return sync_gmail(db)
    except ValueError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc


@app.get("/api/email/card-rules")
def list_email_card_rules(db: DB):
    return [
        serialize_email_rule(item)
        for item in db.scalars(select(EmailCardRule).order_by(EmailCardRule.id)).all()
    ]


@app.post("/api/email/card-rules", status_code=201)
def create_email_card_rule(payload: EmailCardRuleCreate, db: DB):
    _validate_email_patterns(payload.sender_pattern, payload.subject_pattern)
    card_account, _ = _validate_email_rule_accounts(
        db, payload.card_account_id, payload.payment_account_id
    )
    row = EmailCardRule(
        **payload.model_dump(
            exclude={"owner", "statement_password", "sender_pattern", "subject_pattern"}
        ),
        owner=card_account.owner,
        sender_pattern=(payload.sender_pattern or "").strip() or None,
        subject_pattern=(payload.subject_pattern or "").strip() or None,
        statement_password=encrypt_credential(payload.statement_password)
        if payload.statement_password
        else None,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return serialize_email_rule(row)


@app.patch("/api/email/card-rules/{rule_id}")
def update_email_card_rule(rule_id: int, payload: EmailCardRuleUpdate, db: DB):
    row = db.get(EmailCardRule, rule_id)
    if not row:
        raise HTTPException(404, "找不到信用卡郵件規則")
    values = payload.model_dump(exclude_unset=True)
    sender_pattern = values.get("sender_pattern", row.sender_pattern)
    subject_pattern = values.get("subject_pattern", row.subject_pattern)
    _validate_email_patterns(sender_pattern, subject_pattern)
    card_id = int(values.get("card_account_id", row.card_account_id))
    payment_id = int(values.get("payment_account_id", row.payment_account_id))
    card_account, _ = _validate_email_rule_accounts(db, card_id, payment_id)
    password_supplied = "statement_password" in values
    statement_password = values.pop("statement_password", None)
    for key, value in values.items():
        if key == "owner":
            continue
        if key in {"sender_pattern", "subject_pattern"}:
            value = (value or "").strip() or None
        setattr(row, key, value)
    row.owner = card_account.owner
    if password_supplied:
        row.statement_password = (
            encrypt_credential(statement_password) if statement_password else None
        )
    db.commit()
    return serialize_email_rule(row)


@app.delete("/api/email/card-rules/{rule_id}")
def deactivate_email_card_rule(rule_id: int, db: DB):
    row = db.get(EmailCardRule, rule_id)
    if not row:
        raise HTTPException(404, "找不到信用卡郵件規則")
    row.active = False
    db.commit()
    return {"ok": True}


@app.get("/api/email/card-bills")
def list_credit_card_bills(db: DB, limit: int = Query(12, ge=1, le=100)):
    return [
        serialize_card_bill(item)
        for item in db.scalars(
            select(CreditCardBill)
            .order_by(CreditCardBill.due_date.desc(), CreditCardBill.id.desc())
            .limit(limit)
        ).all()
    ]


@app.post("/api/email/card-bills/process")
def process_credit_card_bills(db: DB):
    return process_due_card_bills(db)


@app.get("/api/settings")
def get_settings(db: DB):
    key = db.get(AppSetting, "alpha_vantage_api_key")
    return {
        "mode": APP_MODE,
        "base_currency": "TWD",
        "alpha_vantage_configured": bool(key and key.value),
    }


@app.put("/api/settings")
def update_settings(payload: SettingsUpdate, db: DB):
    if payload.alpha_vantage_api_key is not None:
        row = db.get(AppSetting, "alpha_vantage_api_key")
        if not row:
            row = AppSetting(key="alpha_vantage_api_key", value="")
            db.add(row)
        row.value = payload.alpha_vantage_api_key.strip()
    db.commit()
    return get_settings(db)


@app.get("/api/backup/export")
def backup_export(db: DB):
    payload = export_backup(db)
    headers = {
        "Content-Disposition": f'attachment; filename="finance-backup-{date.today()}.json"'
    }
    return JSONResponse(payload, headers=headers)


@app.post("/api/backup/restore")
async def backup_restore(db: DB, file: UploadFile = File(...)):
    try:
        payload = json.loads((await file.read()).decode("utf-8-sig"))
        restored = restore_backup(db, payload)
        return {"ok": True, "restored": restored}
    except Exception as exc:
        db.rollback()
        raise HTTPException(422, f"無法還原備份：{exc}") from exc


FRONTEND_DIST = ROOT_DIR / "frontend" / "dist"
if FRONTEND_DIST.exists():
    assets = FRONTEND_DIST / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def serve_spa(full_path: str):
        requested = (FRONTEND_DIST / full_path).resolve()
        if (
            full_path
            and requested.is_relative_to(FRONTEND_DIST.resolve())
            and requested.is_file()
        ):
            return FileResponse(requested)
        return FileResponse(FRONTEND_DIST / "index.html")
