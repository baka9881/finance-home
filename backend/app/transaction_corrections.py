"""User-reviewed corrections: immutable import identity, explicit impact and reversible history."""
from __future__ import annotations

import hashlib
import json
from datetime import date
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .database import Account, CreditCardBill, EmailCardRule, Transaction, TransactionRevision
from .schemas import TransactionCorrection
from .services import (
    _csv_balance_applied_ids, create_balance_snapshot, decimal_value, get_latest_balance,
    latest_fx_rate, linked_transfer_transaction_ids, record_valuation,
)


def fields(row: Transaction) -> dict:
    return {
        "transaction_date": row.transaction_date.isoformat(), "description": row.description,
        "amount": str(row.amount), "base_amount": str(row.base_amount),
        "fx_rate": str(row.fx_rate), "fx_estimated": row.fx_estimated, "excluded": row.excluded,
    }


def require_editable(db: Session, transaction_id: int, lock: bool = False) -> Transaction:
    query = select(Transaction).where(Transaction.id == transaction_id)
    row = db.scalar(query.with_for_update() if lock else query)
    if not row:
        raise HTTPException(404, "找不到交易")
    if row.source not in {"csv", "gmail", "manual"} or row.transaction_kind not in {"income", "expense", "interest"} or row.id in linked_transfer_transaction_ids(db):
        raise HTTPException(422, "帳戶互轉、投資及還款有連動帳務，不能只更正其中一筆")
    if lock:
        db.scalar(select(Account).where(Account.id == row.account_id).with_for_update())
    return row


def plan_correction(db: Session, row: Transaction, payload: TransactionCorrection) -> dict:
    before = fields(row)
    after = dict(before)
    if payload.action == "restore":
        last = db.scalar(select(TransactionRevision).where(TransactionRevision.transaction_id == row.id).order_by(TransactionRevision.id.desc()))
        if not last:
            raise HTTPException(422, "這筆交易沒有可以復原的更正")
        after = json.loads(last.before_json)
    elif payload.action == "exclude":
        after["excluded"] = True
    else:
        if row.excluded:
            raise HTTPException(422, "請先復原已排除的交易，再更正內容")
        if payload.description is not None:
            after["description"] = payload.description.strip()
            if not after["description"]:
                raise HTTPException(422, "請填寫交易摘要")
        if payload.transaction_date is not None:
            after["transaction_date"] = payload.transaction_date.isoformat()
        if payload.amount is not None:
            if payload.amount == 0 or (payload.amount > 0) != (row.amount > 0):
                raise HTTPException(422, "更正金額不能為零或改變原本的收入／支出方向")
            after["amount"] = str(payload.amount)
        if after["transaction_date"] != before["transaction_date"]:
            rate, estimated = latest_fx_rate(db, row.currency, date.fromisoformat(after["transaction_date"]))
            after.update(fx_rate=str(rate), fx_estimated=estimated)
        after["base_amount"] = str(decimal_value(after["amount"]) * decimal_value(after["fx_rate"]))
    # Normalize Decimal representations so 50 and 50.0000 are the same edit.
    for value in (before, after):
        for key in ("amount", "base_amount", "fx_rate"):
            value[key] = str(decimal_value(value[key]).normalize())
    if before == after:
        raise HTTPException(422, "內容沒有變更")

    account = row.account
    latest = get_latest_balance(db, row.account_id)
    old_balance = decimal_value(latest.amount) if latest else None
    new_balance = old_balance
    note = "只更正交易與收支統計；保留帳戶最近確認的餘額。"
    balance_source = latest.source if latest else None
    account_rate = decimal_value(latest.fx_rate) if latest else Decimal("1")
    bill_versions = []
    if row.source == "gmail":
        rule = db.scalar(select(EmailCardRule).where(EmailCardRule.card_account_id == account.id).order_by(EmailCardRule.active.desc(), EmailCardRule.id.desc()))
        if rule:
            from .email_sync import gmail_card_balance_value
            bill_versions = [(b.id, str(b.amount_due), b.status, str(b.statement_date)) for b in db.scalars(select(CreditCardBill).where(CreditCardBill.rule_id == rule.id)).all()]
            if latest and latest.source == "gmail_billing_cycle":
                new_balance = gmail_card_balance_value(db, rule, max(date.today(), latest.snapshot_date), (row.id, after))
                note = "同步重算未出帳負債；已收到的正式帳單與繳款紀錄不變。"
            else:
                note = "更新未出帳消費統計；保留你另外確認的帳戶餘額，正式帳單與繳款紀錄不變。"
    elif latest:
        applied = row.source == "csv" and row.id in _csv_balance_applied_ids(db, account.id)
        proof_sources = {"csv_transactions", "csv_dedup"} if applied else {"transaction", "transaction_delete"} if row.source == "manual" else set()
        if latest.source in proof_sources and row.created_at <= latest.created_at and row.transaction_date <= latest.snapshot_date:
            def effect(values):
                if values["excluded"]:
                    return Decimal("0")
                if row.currency == account.currency:
                    return decimal_value(values["amount"])
                rate, _ = latest_fx_rate(db, account.currency, date.fromisoformat(values["transaction_date"]))
                return decimal_value(values["base_amount"]) / rate
            delta = effect(after) - effect(before)
            new_balance = old_balance + (-delta if account.nature == "liability" else delta)
            note = "此筆已反映在記帳餘額，將依更正差額一併調整；不會向銀行發動扣款。"
    if new_balance is None:
        new_balance = old_balance
    state = {"before": before, "after": after, "revision": row.revision, "updated_at": str(row.updated_at),
             "latest": [latest.id, str(latest.amount), str(latest.updated_at)] if latest else None,
             "balance_after": str(new_balance), "bills": bill_versions, "action": payload.action}
    token = hashlib.sha256(json.dumps(state, sort_keys=True).encode()).hexdigest()
    return {"before": before, "after": after, "token": token, "currency": row.currency,
            "account_currency": account.currency, "account_name": account.name,
            "balance_before": float(old_balance) if old_balance is not None else None,
            "balance_after": float(new_balance) if new_balance is not None else None,
            "balance_note": note, "balance_source": balance_source,
            "_balance": new_balance, "_account_rate": account_rate,
            "cashflow_before": 0 if before["excluded"] else float(before["base_amount"]),
            "cashflow_after": 0 if after["excluded"] else float(after["base_amount"])}


def public_plan(plan: dict) -> dict:
    return {key: value for key, value in plan.items() if not key.startswith("_") and key != "balance_source"}


def commit_correction(db: Session, transaction_id: int, payload: TransactionCorrection) -> dict:
    row = require_editable(db, transaction_id, lock=True)
    plan = plan_correction(db, row, payload)
    if not payload.token or payload.token != plan["token"]:
        raise HTTPException(409, "交易或餘額已有更新，請重新預覽後再確認")
    if not row.revision:
        row.original_date, row.original_amount, row.original_description = row.transaction_date, row.amount, row.description
    for key, value in plan["after"].items():
        if key == "transaction_date":
            value = date.fromisoformat(value)
        elif key in {"amount", "base_amount", "fx_rate"}:
            value = decimal_value(value)
        setattr(row, key, value)
    row.revision += 1
    audit = TransactionRevision(transaction_id=row.id, action=payload.action,
        before_json=json.dumps(plan["before"], ensure_ascii=False), after_json=json.dumps(plan["after"], ensure_ascii=False), balance_note=plan["balance_note"])
    db.add(audit)
    if plan["balance_after"] != plan["balance_before"]:
        latest = get_latest_balance(db, row.account_id)
        create_balance_snapshot(db, row.account, plan["_balance"], max(date.today(), latest.snapshot_date),
                                plan["_account_rate"], source=plan["balance_source"])
    db.flush()
    record_valuation(db)
    db.commit()
    return {"ok": True, "revision": row.revision, **public_plan(plan)}
