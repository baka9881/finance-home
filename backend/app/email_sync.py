from __future__ import annotations

import base64
import io
import json
import os
import re
import secrets
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from email.utils import parsedate_to_datetime
from html import unescape
from typing import Any
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

import httpx
from pypdf import PdfReader
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .database import (
    Account,
    AppSetting,
    CreditCardBill,
    EmailCardRule,
    EmailImportRecord,
    Transaction,
    TransferLink,
)
from .services import (
    classify_transaction,
    create_balance_snapshot,
    decimal_value,
    decrypt_credential,
    encrypt_credential,
    get_latest_balance,
    latest_fx_rate,
    record_valuation,
    transaction_fingerprint,
)


TAIPEI = ZoneInfo("Asia/Taipei")
GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
GMAIL_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token"
GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1/users/me"
ZERO = Decimal("0")


def _setting(db: Session, key: str) -> str | None:
    row = db.get(AppSetting, key)
    return row.value if row else None


def _set_setting(db: Session, key: str, value: str) -> None:
    row = db.get(AppSetting, key)
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=key, value=value))


def _delete_setting(db: Session, key: str) -> None:
    row = db.get(AppSetting, key)
    if row:
        db.delete(row)


def gmail_configuration() -> tuple[str, str]:
    return (
        os.getenv("FINANCE_GOOGLE_CLIENT_ID", "").strip(),
        os.getenv("FINANCE_GOOGLE_CLIENT_SECRET", "").strip(),
    )


def gmail_callback_url(request_base_url: str) -> str:
    configured = os.getenv("FINANCE_GOOGLE_REDIRECT_URI", "").strip()
    return configured or f"{request_base_url.rstrip('/')}/api/email/gmail/callback"


def frontend_settings_url() -> str:
    configured = os.getenv("FINANCE_FRONTEND_URL", "").strip().rstrip("/")
    if not configured:
        return "/settings"
    return configured if configured.endswith("/settings") else f"{configured}/settings"


def gmail_status(db: Session) -> dict[str, Any]:
    client_id, client_secret = gmail_configuration()
    connected = bool(_setting(db, "gmail:refresh_token"))
    rules = db.scalars(
        select(EmailCardRule).where(EmailCardRule.active.is_(True)).order_by(EmailCardRule.id)
    ).all()
    pending_bills = int(
        db.scalar(
            select(func.count(CreditCardBill.id)).where(
                CreditCardBill.status.in_(["pending", "insufficient_funds", "needs_review"])
            )
        )
        or 0
    )
    raw_result = _setting(db, "gmail:last_result")
    try:
        last_result = json.loads(raw_result) if raw_result else None
    except json.JSONDecodeError:
        last_result = None
    return {
        "configured": bool(client_id and client_secret),
        "connected": connected,
        "email": _setting(db, "gmail:email"),
        "last_sync_at": _setting(db, "gmail:last_sync_at"),
        "last_error": _setting(db, "gmail:last_error"),
        "last_result": last_result,
        "active_rules": len(rules),
        "pending_bills": pending_bills,
    }


def gmail_authorization_url(db: Session, redirect_uri: str) -> str:
    client_id, client_secret = gmail_configuration()
    if not client_id or not client_secret:
        raise ValueError("伺服器尚未設定 Google OAuth Client ID 與 Client Secret")
    state = secrets.token_urlsafe(32)
    _set_setting(db, "gmail:oauth_state", state)
    _set_setting(
        db,
        "gmail:oauth_state_expires_at",
        (datetime.utcnow() + timedelta(minutes=15)).isoformat(timespec="seconds"),
    )
    db.commit()
    parameters = {
        'client_id': client_id,
        'redirect_uri': redirect_uri,
        'response_type': 'code',
        'scope': GMAIL_SCOPE,
        'access_type': 'offline',
        'prompt': 'consent',
        'include_granted_scopes': 'true',
        'state': state,
    }
    return f"{GMAIL_AUTHORIZE_URL}?{urlencode(parameters)}"


def complete_gmail_authorization(
    db: Session, code: str, state: str, redirect_uri: str
) -> dict[str, Any]:
    expected_state = _setting(db, "gmail:oauth_state")
    expires_at = _setting(db, "gmail:oauth_state_expires_at")
    if not expected_state or not secrets.compare_digest(expected_state, state):
        raise ValueError("Google 登入驗證狀態不一致，請重新連接")
    try:
        expired = not expires_at or datetime.utcnow() > datetime.fromisoformat(expires_at)
    except ValueError:
        expired = True
    if expired:
        raise ValueError("Google 登入驗證已逾時，請重新連接")

    client_id, client_secret = gmail_configuration()
    response = httpx.post(
        GMAIL_TOKEN_URL,
        data={
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        },
        timeout=20,
    )
    payload = response.json()
    if response.status_code >= 400:
        raise ValueError(payload.get("error_description") or "Google 授權失敗")
    refresh_token = str(payload.get("refresh_token") or "")
    if not refresh_token:
        raise ValueError("Google 未提供長期授權，請移除舊授權後重新連接")
    access_token = str(payload.get("access_token") or "")
    profile_response = httpx.get(
        f"{GMAIL_API_URL}/profile",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=20,
    )
    profile = profile_response.json() if profile_response.is_success else {}
    _set_setting(db, "gmail:refresh_token", encrypt_credential(refresh_token))
    _set_setting(db, "gmail:email", str(profile.get("emailAddress") or ""))
    _delete_setting(db, "gmail:oauth_state")
    _delete_setting(db, "gmail:oauth_state_expires_at")
    _set_setting(db, "gmail:last_error", "")
    db.commit()
    return gmail_status(db)


def disconnect_gmail(db: Session) -> None:
    for key in (
        "gmail:refresh_token",
        "gmail:email",
        "gmail:last_sync_at",
        "gmail:last_error",
        "gmail:last_result",
        "gmail:oauth_state",
        "gmail:oauth_state_expires_at",
    ):
        _delete_setting(db, key)
    db.commit()


def _gmail_access_token(db: Session) -> str:
    encrypted = _setting(db, "gmail:refresh_token")
    if not encrypted:
        raise ValueError("Gmail 尚未連接")
    client_id, client_secret = gmail_configuration()
    if not client_id or not client_secret:
        raise ValueError("伺服器尚未設定 Google OAuth")
    refresh_token = decrypt_credential(encrypted)
    response = httpx.post(
        GMAIL_TOKEN_URL,
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        },
        timeout=20,
    )
    payload = response.json()
    if response.status_code >= 400:
        raise ValueError(payload.get("error_description") or "Gmail 授權已失效，請重新連接")
    return str(payload["access_token"])


def _gmail_get(token: str, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    response = httpx.get(
        f"{GMAIL_API_URL}{path}",
        params=params,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    if response.status_code >= 400:
        detail = payload.get("error", {}).get("message") if isinstance(payload, dict) else None
        raise ValueError(detail or f"Gmail API 讀取失敗（{response.status_code}）")
    return payload


def _gmail_search_value(value: str) -> str:
    """Quote a user-entered Gmail search value without broadening the query."""
    return value.replace("\\", "\\\\").replace('"', '\\"').strip()


def _gmail_rule_search_query(rule: EmailCardRule) -> str:
    """Build a narrow Gmail query before downloading any message bodies."""
    terms = [f"newer_than:{rule.lookback_days}d"]
    if rule.sender_pattern:
        terms.append(f'from:"{_gmail_search_value(rule.sender_pattern)}"')
    if rule.subject_pattern:
        terms.append(f'subject:"{_gmail_search_value(rule.subject_pattern)}"')
    return " ".join(terms)


def _decode_gmail_data(value: str | None) -> bytes:
    if not value:
        return b""
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _plain_html(value: str) -> str:
    value = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", value)
    value = re.sub(r"(?i)</(?:td|th)>", "\t", value)
    value = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>", "\n", value)
    return re.sub(r" +", " ", unescape(re.sub(r"(?s)<[^>]+>", " ", value)))


def _pdf_text(content: bytes, password: str | None) -> str:
    try:
        reader = PdfReader(io.BytesIO(content))
        if reader.is_encrypted:
            if not password or reader.decrypt(password) == 0:
                raise ValueError("電子帳單 PDF 需要正確的開啟密碼")
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"電子帳單 PDF 無法解析：{exc}") from exc


def _message_content(
    token: str, message_id: str, payload: dict[str, Any], statement_password: str | None
) -> str:
    chunks: list[str] = []

    def visit(part: dict[str, Any]) -> None:
        mime_type = str(part.get("mimeType") or "")
        filename = str(part.get("filename") or "")
        body = part.get("body") or {}
        raw = _decode_gmail_data(body.get("data"))
        attachment_id = body.get("attachmentId")
        if attachment_id:
            attachment = _gmail_get(token, f"/messages/{message_id}/attachments/{attachment_id}")
            raw = _decode_gmail_data(attachment.get("data"))
        if mime_type == "text/plain" and raw:
            chunks.append(raw.decode("utf-8", errors="replace"))
        elif mime_type == "text/html" and raw:
            chunks.append(_plain_html(raw.decode("utf-8", errors="replace")))
        elif (mime_type == "application/pdf" or filename.lower().endswith(".pdf")) and raw:
            chunks.append(_pdf_text(raw, statement_password))
        for child in part.get("parts") or []:
            visit(child)

    visit(payload)
    return "\n".join(chunks)


def _headers(payload: dict[str, Any]) -> dict[str, str]:
    return {
        str(item.get("name") or "").lower(): str(item.get("value") or "")
        for item in payload.get("headers") or []
    }


def _parse_date(value: str, reference: date | None = None) -> date | None:
    normalized = value.strip().replace("年", "/").replace("月", "/").replace("日", "")
    numbers = [int(part) for part in re.findall(r"\d+", normalized)]
    if len(numbers) < 2:
        return None
    try:
        if len(numbers) >= 3:
            year, month, day = numbers[-3:]
            if year < 1911:
                year += 1911
        else:
            month, day = numbers
            year = (reference or date.today()).year
        return date(year, month, day)
    except ValueError:
        return None


def _money(value: str) -> Decimal | None:
    normalized = value.replace(",", "").replace(" ", "").strip()
    try:
        amount = Decimal(normalized)
        return abs(amount)
    except InvalidOperation:
        return None


DATE_VALUE = r"((?:\d{2,4}[年/.-])?\d{1,2}[月/.-]\d{1,2}日?)"
MONEY_VALUE = r"(?:NT\$|NTD|TWD|新臺幣|新台幣|US\$|USD|\$)?\s*([\d,]+(?:\.\d{1,2})?)"


def _cathay_digest_transactions(compact: str, message_date: date) -> list[dict[str, Any]]:
    """Parse Cathay's consumption digest, whose labels and values use separate table rows."""
    lines = [line.strip() for line in compact.splitlines() if line.strip()]
    transactions: list[dict[str, Any]] = []
    for index, line in enumerate(lines):
        if "消費金額" not in line:
            continue

        # Cathay's production HTML puts each <td> on its own source line, while
        # simpler emails keep a complete table row on one line.  Reconstruct the
        # header and value rows from either representation.
        header_end = index
        header_window: list[str] = []
        while header_end < min(len(lines), index + 6):
            header_window.extend(
                cell.strip() for cell in lines[header_end].split("\t") if cell.strip()
            )
            if "備註" in lines[header_end]:
                break
            header_end += 1
        if not any("商店名稱" in cell for cell in header_window):
            continue

        value_cells: list[str] = []
        value_index = header_end + 1
        while value_index < len(lines) and len(value_cells) < 4:
            value_cells.extend(
                cell.strip() for cell in lines[value_index].split("\t") if cell.strip()
            )
            value_index += 1
        if not value_cells:
            continue
        amount_match = re.match(
            r"^(?:NT\$|NTD|TWD|新臺幣|新台幣|\$)?\s*([\d,]+(?:\.\d{1,2})?)",
            value_cells[0],
            re.I,
        )
        if not amount_match:
            continue
        amount = _money(amount_match.group(1))
        if not amount or amount <= 0:
            continue
        description = value_cells[1] if len(value_cells) > 1 else "信用卡消費"
        transaction_date = message_date
        for previous in reversed(lines[max(0, index - 10):index]):
            date_match = re.search(r"\b\d{4}[/.-]\d{1,2}[/.-]\d{1,2}\b", previous)
            if date_match:
                transaction_date = _parse_date(date_match.group(0), message_date) or message_date
                break
        transactions.append(
            {
                "date": transaction_date,
                "description": description,
                "amount": -amount,
                "kind": "expense",
            }
        )
    return transactions


def parse_card_email(text: str, message_date: date) -> dict[str, Any]:
    cathay_transactions = _cathay_digest_transactions(text, message_date)
    compact = re.sub(r"[\u3000\t]+", " ", text)
    result: dict[str, Any] = {"transactions": [], "bill": None}
    result["transactions"].extend(cathay_transactions)
    bill_amount_match = re.search(
        rf"(?:應繳總金額|本期應繳金額|本期帳單金額|本期應繳款|total\s+amount\s+due|amount\s+due)\s*[:：]?\s*{MONEY_VALUE}",
        compact,
        re.I,
    )
    due_match = re.search(
        rf"(?:繳款截止日|繳款到期日|付款截止日|payment\s+due\s+date|due\s+date)\s*[:：]?\s*{DATE_VALUE}",
        compact,
        re.I,
    )
    if bill_amount_match and due_match:
        due_date = _parse_date(due_match.group(1), message_date)
        amount_due = _money(bill_amount_match.group(1))
        if due_date and amount_due and amount_due > 0:
            statement_match = re.search(
                rf"(?:帳單結帳日|結帳日|statement\s+date)\s*[:：]?\s*{DATE_VALUE}",
                compact,
                re.I,
            )
            result["bill"] = {
                "amount_due": amount_due,
                "due_date": due_date,
                "statement_date": _parse_date(statement_match.group(1), message_date)
                if statement_match
                else message_date,
            }

    transaction_amount_match = re.search(
        rf"(?:消費金額|交易金額|刷卡金額|授權金額|transaction\s+amount|purchase\s+amount)\s*[:：]?\s*{MONEY_VALUE}",
        compact,
        re.I,
    )
    if transaction_amount_match:
        amount = _money(transaction_amount_match.group(1))
        merchant_match = re.search(
            r"(?:特店名稱|商店名稱|消費店家|交易摘要|merchant)\s*[:：]?\s*([^\n\r]{2,100})",
            compact,
            re.I,
        )
        date_match = re.search(
            rf"(?:交易日期|消費日期|刷卡日期|transaction\s+date)\s*[:：]?\s*{DATE_VALUE}",
            compact,
            re.I,
        )
        if amount and amount > 0:
            is_refund = bool(re.search(r"退款|退刷|沖銷|refund|reversal", compact, re.I))
            result["transactions"].append(
                {
                    "date": _parse_date(date_match.group(1), message_date)
                    if date_match
                    else message_date,
                    "description": (merchant_match.group(1).strip() if merchant_match else "信用卡消費"),
                    "amount": amount if is_refund else -amount,
                    "kind": "refund" if is_refund else "expense",
                }
            )

    # Conservative statement-line parser: only accept lines beginning with a date and
    # ending with a TWD amount; summary and payment rows are deliberately ignored.
    statement_line = re.compile(
        r"^\s*((?:\d{2,4}[年/.-])?\d{1,2}[月/.-]\d{1,2}日?)\s+"
        r"(?:(?:\d{2,4}[年/.-])?\d{1,2}[月/.-]\d{1,2}日?\s+)?"
        r"(.{2,120}?)\s+(?:NT\$|NTD|TWD|新臺幣|新台幣)?\s*"
        r"([\d,]+(?:\.\d{1,2})?)\s*$",
        re.I,
    )
    for line in compact.splitlines():
        if re.search(r"應繳|總計|合計|最低|繳款|額度|利率|previous|total|payment", line, re.I):
            continue
        match = statement_line.match(line)
        if not match:
            continue
        transaction_date = _parse_date(match.group(1), message_date)
        description = match.group(2).strip(" -")
        amount_text = match.group(3)
        amount = _money(amount_text)
        if transaction_date and description and amount and amount > 0:
            result["transactions"].append(
                {
                    "date": transaction_date,
                    "description": description,
                    "amount": -amount,
                    "kind": "expense",
                }
            )
    return result


def _rule_matches(
    rule: EmailCardRule, sender: str, subject: str, text: str | None
) -> bool:
    sender_match = not rule.sender_pattern or rule.sender_pattern.casefold() in sender.casefold()
    subject_match = not rule.subject_pattern or rule.subject_pattern.casefold() in subject.casefold()
    last4_match = text is None or not rule.card_last4 or rule.card_last4 in text
    return sender_match and subject_match and last4_match


def _next_balance(account: Account, current: Decimal, transaction_amount: Decimal) -> Decimal:
    return current - transaction_amount if account.nature == "liability" else current + transaction_amount


def _message_date(message: dict[str, Any], headers: dict[str, str]) -> datetime:
    raw = headers.get("date")
    if raw:
        try:
            parsed = parsedate_to_datetime(raw)
            return (parsed if parsed.tzinfo else parsed.replace(tzinfo=TAIPEI)).astimezone(TAIPEI).replace(tzinfo=None)
        except (TypeError, ValueError, OverflowError):
            pass
    timestamp = int(message.get("internalDate") or 0) / 1000
    return datetime.fromtimestamp(timestamp, TAIPEI).replace(tzinfo=None) if timestamp else datetime.now(TAIPEI).replace(tzinfo=None)


def _create_card_transaction(
    db: Session, rule: EmailCardRule, item: dict[str, Any], source_message_id: str
) -> bool:
    account = rule.card_account
    amount = decimal_value(item["amount"])
    transaction_date = item["date"]
    description = str(item["description"]).strip()[:300]
    fingerprint = transaction_fingerprint(account.id, transaction_date, amount, description)
    if db.scalar(select(Transaction).where(Transaction.fingerprint == fingerprint)):
        return False
    category_id, classified_kind = classify_transaction(db, description, amount)
    kind = item.get("kind") or classified_kind
    rate, estimated = latest_fx_rate(db, account.currency, transaction_date)
    row = Transaction(
        account_id=account.id,
        transaction_date=transaction_date,
        description=description,
        amount=amount,
        currency=account.currency,
        fx_rate=rate,
        base_amount=amount * rate,
        fx_estimated=estimated,
        transaction_kind=kind,
        category_id=category_id,
        fingerprint=fingerprint,
        source="gmail",
        note=f"Gmail 訊息 {source_message_id}",
    )
    db.add(row)
    db.flush()
    return True


def _refresh_current_gmail_card_balance(
    db: Session, rule: EmailCardRule, as_of: date | None = None
) -> Decimal | None:
    """Rebuild the current card liability from this month's Gmail activity.

    Gmail synchronization may backfill several months of purchase notices.  Those
    historical transactions belong in cash-flow analysis, but adding every one of
    them to the latest balance makes already-paid statements become current debt.
    The balance shown for an email-managed card is therefore rebuilt from the
    current calendar month's Gmail purchases, refunds and recorded repayments.
    """
    as_of = as_of or date.today()
    month_start = as_of.replace(day=1)
    rows = db.scalars(
        select(Transaction).where(
            Transaction.account_id == rule.card_account_id,
            Transaction.transaction_date >= month_start,
            Transaction.transaction_date <= as_of,
            Transaction.source.in_(["gmail", "gmail_autopay"]),
        )
    ).all()
    if not rows:
        return None

    balance = max(
        ZERO,
        -sum((decimal_value(item.amount) for item in rows), ZERO),
    )
    latest = get_latest_balance(db, rule.card_account_id)
    if (
        latest
        and latest.snapshot_date == as_of
        and decimal_value(latest.amount) == balance
        and latest.source == "gmail_current_month"
    ):
        return balance

    create_balance_snapshot(
        db,
        rule.card_account,
        balance,
        as_of,
        source="gmail_current_month",
    )
    return balance


def _create_or_update_bill(
    db: Session,
    rule: EmailCardRule,
    parsed: dict[str, Any],
    source_message_id: str,
) -> bool:
    bill = db.scalar(
        select(CreditCardBill).where(
            CreditCardBill.rule_id == rule.id,
            CreditCardBill.due_date == parsed["due_date"],
            CreditCardBill.amount_due == parsed["amount_due"],
        )
    )
    created = bill is None
    if not bill:
        bill = CreditCardBill(
            rule_id=rule.id,
            card_account_id=rule.card_account_id,
            payment_account_id=rule.payment_account_id,
            statement_date=parsed.get("statement_date"),
            due_date=parsed["due_date"],
            amount_due=parsed["amount_due"],
            currency=rule.card_account.currency,
            status="pending",
            source_message_id=source_message_id,
        )
        db.add(bill)
    else:
        bill.statement_date = parsed.get("statement_date") or bill.statement_date
        bill.payment_account_id = rule.payment_account_id
        bill.source_message_id = source_message_id

    latest = get_latest_balance(db, rule.card_account_id)
    current = decimal_value(latest.amount) if latest else ZERO
    if current < decimal_value(parsed["amount_due"]):
        snapshot_date = max(date.today(), latest.snapshot_date) if latest else date.today()
        create_balance_snapshot(
            db,
            rule.card_account,
            decimal_value(parsed["amount_due"]),
            snapshot_date,
            source="gmail_statement",
        )
    return created


def process_due_card_bills(db: Session, today: date | None = None) -> dict[str, Any]:
    today = today or date.today()
    rows = db.scalars(
        select(CreditCardBill)
        .join(EmailCardRule)
        .where(
            EmailCardRule.active.is_(True),
            EmailCardRule.auto_pay.is_(True),
            CreditCardBill.due_date <= today,
            CreditCardBill.status.in_(["pending", "insufficient_funds"]),
        )
        .order_by(CreditCardBill.due_date, CreditCardBill.id)
    ).all()
    paid = 0
    needs_review = 0
    insufficient = 0
    for bill in rows:
        if bill.due_date < bill.rule.created_at.date():
            bill.status = "needs_review"
            bill.last_error = "這是啟用自動扣款前的舊帳單，請手動確認"
            needs_review += 1
            continue
        payment_account = bill.payment_account
        card_account = bill.card_account
        if payment_account.archived or card_account.archived:
            bill.status = "needs_review"
            bill.last_error = "付款或信用卡帳戶已停用"
            needs_review += 1
            continue
        if payment_account.currency != bill.currency or card_account.currency != bill.currency:
            bill.status = "needs_review"
            bill.last_error = "第一版只支援相同幣別的自動扣款"
            needs_review += 1
            continue
        payment_latest = get_latest_balance(db, payment_account.id)
        card_latest = get_latest_balance(db, card_account.id)
        payment_balance = decimal_value(payment_latest.amount) if payment_latest else ZERO
        card_balance = decimal_value(card_latest.amount) if card_latest else ZERO
        amount = decimal_value(bill.amount_due)
        if payment_balance < amount:
            bill.status = "insufficient_funds"
            bill.last_error = "付款帳戶餘額不足，尚未在財務居記帳"
            insufficient += 1
            continue
        if card_balance + Decimal("1") < amount:
            bill.status = "needs_review"
            bill.last_error = "信用卡負債低於帳單應繳金額，請確認資料是否完整"
            needs_review += 1
            continue

        description = f"信用卡自動繳款（{bill.rule.name}）"
        out_description = f"{description} → {card_account.name}"
        in_description = f"{description} ← {payment_account.name}"
        out_fingerprint = transaction_fingerprint(
            payment_account.id, bill.due_date, -amount, out_description
        )
        in_fingerprint = transaction_fingerprint(
            card_account.id, bill.due_date, amount, in_description
        )
        if db.scalar(
            select(Transaction).where(
                Transaction.fingerprint.in_([out_fingerprint, in_fingerprint])
            )
        ):
            bill.status = "needs_review"
            bill.last_error = "已存在相同扣款紀錄，未重複建立"
            needs_review += 1
            continue
        rate, estimated = latest_fx_rate(db, bill.currency, bill.due_date)
        out_row = Transaction(
            account_id=payment_account.id,
            transaction_date=bill.due_date,
            description=out_description,
            amount=-amount,
            currency=bill.currency,
            fx_rate=rate,
            base_amount=-amount * rate,
            fx_estimated=estimated,
            transaction_kind="transfer",
            fingerprint=out_fingerprint,
            source="gmail_autopay",
            note=f"帳單 #{bill.id}；僅為財務居記帳，不會向銀行發動付款",
        )
        in_row = Transaction(
            account_id=card_account.id,
            transaction_date=bill.due_date,
            description=in_description,
            amount=amount,
            currency=bill.currency,
            fx_rate=rate,
            base_amount=amount * rate,
            fx_estimated=estimated,
            transaction_kind="transfer",
            fingerprint=in_fingerprint,
            source="gmail_autopay",
            note=f"帳單 #{bill.id}；僅為財務居記帳，不會向銀行發動付款",
        )
        db.add_all([out_row, in_row])
        db.flush()
        link = TransferLink(
            from_transaction_id=out_row.id,
            to_transaction_id=in_row.id,
            confirmed=True,
        )
        db.add(link)
        db.flush()
        create_balance_snapshot(
            db,
            payment_account,
            payment_balance - amount,
            bill.due_date,
            rate,
            source="gmail_autopay",
        )
        create_balance_snapshot(
            db,
            card_account,
            max(ZERO, card_balance - amount),
            bill.due_date,
            rate,
            source="gmail_autopay",
        )
        bill.status = "paid"
        bill.transfer_link_id = link.id
        bill.last_error = None
        paid += 1
    record_valuation(db)
    db.commit()
    return {
        "checked": len(rows),
        "paid": paid,
        "needs_review": needs_review,
        "insufficient_funds": insufficient,
    }


def sync_gmail(db: Session) -> dict[str, Any]:
    rules = db.scalars(
        select(EmailCardRule).where(EmailCardRule.active.is_(True)).order_by(EmailCardRule.id)
    ).all()
    if not rules:
        result = {
            "messages_scanned": 0,
            "matched": 0,
            "transactions_imported": 0,
            "bills_found": 0,
            "payments_created": 0,
            "ignored": 0,
            "errors": [],
        }
        _set_setting(db, "gmail:last_result", json.dumps(result, ensure_ascii=False))
        _set_setting(db, "gmail:last_sync_at", datetime.utcnow().isoformat(timespec="seconds"))
        db.commit()
        return result

    token = _gmail_access_token(db)
    message_ids: list[str] = []
    seen_message_ids: set[str] = set()
    for rule in rules:
        page_token: str | None = None
        for _ in range(5):
            params: dict[str, Any] = {
                "q": _gmail_rule_search_query(rule),
                "maxResults": 100,
            }
            if page_token:
                params["pageToken"] = page_token
            listed = _gmail_get(token, "/messages", params)
            for item in listed.get("messages") or []:
                message_id = str(item["id"])
                if message_id not in seen_message_ids:
                    seen_message_ids.add(message_id)
                    message_ids.append(message_id)
            page_token = listed.get("nextPageToken")
            if not page_token:
                break

    result: dict[str, Any] = {
        "messages_scanned": len(message_ids),
        "matched": 0,
        "transactions_imported": 0,
        "bills_found": 0,
        "payments_created": 0,
        "ignored": 0,
        "errors": [],
    }
    for message_id in message_ids:
        existing_record = db.scalar(
            select(EmailImportRecord).where(
                EmailImportRecord.provider == "gmail",
                EmailImportRecord.provider_message_id == message_id,
            )
        )
        if existing_record and existing_record.status != "no_finance_data":
            result["ignored"] += 1
            continue
        message = _gmail_get(token, f"/messages/{message_id}", {"format": "full"})
        payload = message.get("payload") or {}
        headers = _headers(payload)
        sender = headers.get("from", "")
        subject = headers.get("subject", "")
        message_datetime = _message_date(message, headers)
        rule = next(
            (
                item
                for item in rules
                if message_datetime.date() >= date.today() - timedelta(days=item.lookback_days)
                and _rule_matches(item, sender, subject, None)
            ),
            None,
        )
        if not rule:
            result["ignored"] += 1
            continue
        password = decrypt_credential(rule.statement_password) if rule.statement_password else None
        try:
            content = _message_content(token, message_id, payload, password)
            if not _rule_matches(rule, sender, subject, content):
                result["ignored"] += 1
                continue
            parsed = parse_card_email(content, message_datetime.date())
            imported = sum(
                1 for item in parsed["transactions"] if _create_card_transaction(db, rule, item, message_id)
            )
            bill_created = bool(parsed["bill"] and _create_or_update_bill(db, rule, parsed["bill"], message_id))
            if existing_record:
                existing_record.rule_id = rule.id
                existing_record.message_date = message_datetime
                existing_record.sender = sender[:300]
                existing_record.subject = subject[:500]
                existing_record.status = "processed" if imported or parsed["bill"] else "no_finance_data"
                existing_record.imported_transactions = imported
                existing_record.error = None
            else:
                db.add(EmailImportRecord(
                    provider="gmail",
                    provider_message_id=message_id,
                    rule_id=rule.id,
                    message_date=message_datetime,
                    sender=sender[:300],
                    subject=subject[:500],
                    status="processed" if imported or parsed["bill"] else "no_finance_data",
                    imported_transactions=imported,
                ))
            db.commit()
            result["matched"] += 1
            result["transactions_imported"] += imported
            result["bills_found"] += int(bill_created)
        except Exception as exc:
            db.rollback()
            if existing_record:
                existing_record.rule_id = rule.id
                existing_record.message_date = message_datetime
                existing_record.sender = sender[:300]
                existing_record.subject = subject[:500]
                existing_record.status = "error"
                existing_record.error = str(exc)
            else:
                db.add(EmailImportRecord(
                    provider="gmail",
                    provider_message_id=message_id,
                    rule_id=rule.id,
                    message_date=message_datetime,
                    sender=sender[:300],
                    subject=subject[:500],
                    status="error",
                    error=str(exc),
                ))
            db.commit()
            result["errors"].append(f"{subject or message_id}：{exc}")

    payment_result = process_due_card_bills(db)
    result["payments_created"] = payment_result["paid"]
    adjusted_balances: dict[str, float] = {}
    for rule in rules:
        rebuilt = _refresh_current_gmail_card_balance(db, rule)
        if rebuilt is not None:
            adjusted_balances[rule.card_account.name] = float(rebuilt)
    result["adjusted_card_balances"] = adjusted_balances
    if adjusted_balances:
        record_valuation(db)
    _set_setting(db, "gmail:last_sync_at", datetime.utcnow().isoformat(timespec="seconds"))
    _set_setting(db, "gmail:last_error", "、".join(result["errors"]))
    _set_setting(db, "gmail:last_result", json.dumps(result, ensure_ascii=False, default=str))
    db.commit()
    return result


def serialize_email_rule(rule: EmailCardRule) -> dict[str, Any]:
    return {
        "id": rule.id,
        "name": rule.name,
        "owner": rule.owner,
        "card_account_id": rule.card_account_id,
        "card_account_name": rule.card_account.name,
        "payment_account_id": rule.payment_account_id,
        "payment_account_name": rule.payment_account.name,
        "sender_pattern": rule.sender_pattern,
        "subject_pattern": rule.subject_pattern,
        "card_last4": rule.card_last4,
        "lookback_days": rule.lookback_days,
        "auto_pay": rule.auto_pay,
        "active": rule.active,
        "statement_password_configured": bool(rule.statement_password),
    }


def serialize_card_bill(bill: CreditCardBill) -> dict[str, Any]:
    return {
        "id": bill.id,
        "rule_id": bill.rule_id,
        "rule_name": bill.rule.name,
        "card_account_name": bill.card_account.name,
        "payment_account_name": bill.payment_account.name,
        "statement_date": bill.statement_date,
        "due_date": bill.due_date,
        "amount_due": float(bill.amount_due),
        "currency": bill.currency,
        "status": bill.status,
        "last_error": bill.last_error,
    }
