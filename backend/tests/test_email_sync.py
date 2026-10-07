import base64
from datetime import date, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.database import (
    Account,
    AppSetting,
    BalanceSnapshot,
    Base,
    CreditCardBill,
    CreditCardPayment,
    CreditCardPaymentAllocation,
    EmailCardRule,
    EmailImportRecord,
    Transaction,
    TransferLink,
)
from app.email_sync import (
    _create_card_transaction,
    _create_or_update_bill,
    _refresh_current_gmail_card_balance,
    _gmail_rule_search_query,
    _plain_html,
    card_payment_allocations,
    discover_gmail_card_candidates,
    parse_card_email,
    process_due_card_bills,
    repair_linked_card_payments,
    repair_duplicate_card_bills,
    serialize_card_cycle,
    serialize_email_rule,
    sync_gmail,
    taipei_today,
)
from app.main import card_payment_candidates, confirm_transfer, create_account_transfer, create_loan_payment
from app.schemas import AccountTransferCreate, LoanPaymentCreate, TransferCreate
from app import email_sync as email_sync_module
from app.services import (
    calculate_dashboard,
    create_balance_snapshot,
    export_backup,
    get_latest_balance,
    import_csv,
    repair_cross_source_card_duplicates,
    repair_linked_transfer_kinds,
    restore_backup,
    seed_defaults,
)


def make_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = Session(engine)
    seed_defaults(session)
    return session


def test_parse_purchase_notification_and_statement() -> None:
    purchase = parse_card_email(
        """
        國泰世華信用卡消費通知
        交易日期：2026/08/22
        特店名稱：星巴克台北店
        消費金額：NT$ 185
        """,
        date(2026, 8, 22),
    )
    assert purchase["transactions"] == [
        {
            "date": date(2026, 8, 22),
            "description": "星巴克台北店",
            "amount": Decimal("-185"),
            "kind": "expense",
        }
    ]

    statement = parse_card_email(
        """
        信用卡電子帳單
        本期應繳金額：NT$13,797
        繳款截止日：2026/09/09
        帳單結帳日：2026/08/23
        """,
        date(2026, 8, 24),
    )
    assert statement["bill"] == {
        "amount_due": Decimal("13797"),
        "due_date": date(2026, 9, 9),
        "statement_date": date(2026, 8, 23),
    }


def test_statement_without_due_date_uses_configured_payment_day() -> None:
    parsed = parse_card_email(
        """
        國泰世華信用卡電子帳單
        結帳日：2026/08/02
        本期應繳金額：NT$ 13,797
        """,
        date(2026, 8, 3),
        default_due_day=23,
    )

    assert parsed["bill"]["statement_date"] == date(2026, 8, 2)
    assert parsed["bill"]["due_date"] == date(2026, 8, 23)


def test_statement_without_closing_date_keeps_cycle_boundary_unset() -> None:
    parsed = parse_card_email(
        """
        國泰世華信用卡電子帳單
        本期應繳金額：NT$ 13,797
        """,
        date(2026, 8, 24),
        default_due_day=23,
    )

    assert parsed["bill"]["statement_date"] is None
    assert parsed["bill"]["due_date"] == date(2026, 9, 23)


def test_parse_cathay_consumption_digest_table() -> None:
    text = _plain_html(
        """
        <table>
          <tr>
            <td>正卡</td>
            <td>6196</td>
            <td>2026/08/21</td>
            <td>16:05</td>
            <td>TW</td>
          </tr>
          <tr>
            <td colspan="2">消費金額</td>
            <td>商店名稱</td>
            <td>消費類別</td>
            <td>備註</td>
          </tr>
          <tr>
            <td colspan="2">NT$50</td>
            <td>統一超商－鑽寶</td>
            <td>超市∕量販</td>
            <td>&nbsp;</td>
          </tr>
        </table>
        """
    )

    parsed = parse_card_email(text, date(2026, 8, 22))

    assert parsed["transactions"] == [
        {
            "date": date(2026, 8, 21),
            "description": "統一超商－鑽寶",
            "amount": Decimal("-50"),
            "kind": "expense",
        }
    ]


def test_sync_gmail_retries_failed_cathay_email_and_backfills_transactions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = make_session()
    payment = Account(
        name="生活費帳戶",
        account_type="bank",
        nature="asset",
        currency="TWD",
        owner="me",
    )
    card = Account(
        name="國泰世華銀行 信用卡",
        account_type="credit_card",
        nature="liability",
        currency="TWD",
        owner="me",
    )
    db.add_all([payment, card])
    db.flush()
    rule = EmailCardRule(
        name="國泰世華銀行 信用卡",
        owner="me",
        card_account_id=card.id,
        payment_account_id=payment.id,
        sender_pattern="cathaybk.com.tw",
        lookback_days=90,
        payment_due_day=23,
        auto_pay=True,
        active=True,
    )
    db.add(rule)
    db.flush()
    failed_record = EmailImportRecord(
        provider="gmail",
        provider_message_id="cathay-retry-1",
        rule_id=rule.id,
        message_date=datetime(2026, 8, 31, 8, 0),
        sender="國泰世華銀行 <service@cathaybk.com.tw>",
        subject="國泰世華銀行消費彙整通知",
        status="error",
        imported_transactions=0,
        error="舊版解析器無法處理",
    )
    db.add(failed_record)
    db.commit()

    html = """
    <table>
      <tr>
        <td>正卡</td><td>6196</td><td>2026/08/30</td><td>21:41</td><td>TW</td>
      </tr>
      <tr>
        <td colspan="2">消費金額</td><td>商店名稱</td><td>消費類別</td><td>備註</td>
      </tr>
      <tr>
        <td colspan="2">NT$50</td><td>統一超商－鑽寶</td><td>超市∕量販</td><td>&nbsp;</td>
      </tr>
    </table>
    """
    encoded_html = base64.urlsafe_b64encode(html.encode("utf-8")).decode("ascii").rstrip("=")

    monkeypatch.setattr(email_sync_module, "_gmail_access_token", lambda _db: "token")

    def fake_get(_token: str, path: str, params: dict | None = None):
        if path == "/messages":
            return {"messages": [{"id": "cathay-retry-1"}]}
        if path == "/messages/cathay-retry-1":
            return {
                "internalDate": "1788134400000",
                "payload": {
                    "headers": [
                        {
                            "name": "From",
                            "value": "國泰世華銀行 <service@cathaybk.com.tw>",
                        },
                        {"name": "Subject", "value": "國泰世華銀行消費彙整通知"},
                        {"name": "Date", "value": "Mon, 31 Aug 2026 08:00:00 +0800"},
                    ],
                    "mimeType": "multipart/alternative",
                    "parts": [
                        {
                            "mimeType": "text/html",
                            "filename": "",
                            "body": {"data": encoded_html},
                        }
                    ],
                },
            }
        raise AssertionError(f"unexpected Gmail request: {path} {params}")

    monkeypatch.setattr(email_sync_module, "_gmail_get", fake_get)

    result = sync_gmail(db)
    imported = db.scalars(
        select(Transaction).where(Transaction.source == "gmail")
    ).all()
    db.refresh(failed_record)

    assert result["messages_scanned"] == 1
    assert result["retries_attempted"] == 1
    assert result["retries_recovered"] == 1
    assert result["transactions_recognized"] == 1
    assert result["transactions_imported"] == 1
    assert result["errors"] == []
    assert failed_record.status == "processed"
    assert failed_record.error is None
    assert len(imported) == 1
    assert imported[0].transaction_date == date(2026, 8, 30)
    assert imported[0].description == "統一超商－鑽寶"
    assert Decimal(str(imported[0].amount)) == Decimal("-50")

    second_result = sync_gmail(db)
    second_imported = db.scalars(
        select(Transaction).where(Transaction.source == "gmail")
    ).all()
    assert second_result["already_processed"] == 1
    assert second_result["transactions_imported"] == 0
    assert len(second_imported) == 1
    db.close()


def test_expired_gmail_refresh_token_requires_reconnection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = make_session()
    db.add(AppSetting(key="gmail:refresh_token", value="encrypted-refresh-token"))
    db.add(AppSetting(key="gmail:email", value="owner@example.com"))
    db.commit()
    monkeypatch.setenv("FINANCE_GOOGLE_CLIENT_ID", "client-id")
    monkeypatch.setenv("FINANCE_GOOGLE_CLIENT_SECRET", "client-secret")
    monkeypatch.setattr(email_sync_module, "decrypt_credential", lambda _value: "refresh-token")
    monkeypatch.setattr(
        email_sync_module.httpx,
        "post",
        lambda *args, **kwargs: SimpleNamespace(
            status_code=400,
            json=lambda: {
                "error": "invalid_grant",
                "error_description": "Token has been expired or revoked.",
            },
        ),
    )

    with pytest.raises(email_sync_module.GmailReconnectRequired, match="重新連接 Gmail"):
        email_sync_module._gmail_access_token(db)

    status = email_sync_module.gmail_status(db)
    assert status["connected"] is False
    assert status["reconnect_required"] is True
    assert status["email"] == "owner@example.com"
    assert status["last_error"] == "Gmail 授權已過期，請重新連接 Gmail"

    with pytest.raises(email_sync_module.GmailReconnectRequired, match="重新連接 Gmail"):
        email_sync_module._gmail_access_token(db)
    db.close()


def test_gmail_card_balance_uses_current_month_without_old_statements() -> None:
    db = make_session()
    payment = Account(
        name="生活費帳戶",
        account_type="bank",
        nature="asset",
        currency="TWD",
        owner="me",
    )
    card = Account(
        name="國泰信用卡",
        account_type="credit_card",
        nature="liability",
        currency="TWD",
        owner="me",
    )
    db.add_all([payment, card])
    db.flush()
    create_balance_snapshot(db, card, Decimal("27806"), date(2026, 8, 21))
    rule = EmailCardRule(
        name="國泰信用卡",
        owner="me",
        card_account_id=card.id,
        payment_account_id=payment.id,
        sender_pattern="cathaybk.com.tw",
        closing_day=1,
        auto_pay=True,
        active=True,
    )
    db.add(rule)
    db.flush()
    db.add_all(
        [
            Transaction(
                account_id=card.id,
                transaction_date=date(2026, 7, 30),
                description="舊月份消費",
                amount=Decimal("-20000"),
                currency="TWD",
                fx_rate=Decimal("1"),
                base_amount=Decimal("-20000"),
                transaction_kind="expense",
                fingerprint="gmail-old",
                source="gmail",
            ),
            Transaction(
                account_id=card.id,
                transaction_date=date(2026, 8, 10),
                description="本月消費",
                amount=Decimal("-6458"),
                currency="TWD",
                fx_rate=Decimal("1"),
                base_amount=Decimal("-6458"),
                transaction_kind="expense",
                fingerprint="gmail-current",
                source="gmail",
            ),
        ]
    )
    db.flush()

    rebuilt = _refresh_current_gmail_card_balance(db, rule, date(2026, 8, 23))

    assert rebuilt == Decimal("6458")
    latest = get_latest_balance(db, card.id)
    assert decimal_amount(latest) == Decimal("6458")
    assert latest.source == "gmail_billing_cycle"
    db.close()


def test_missing_closing_day_does_not_invent_a_payment_day_cycle() -> None:
    db = make_session()
    payment = Account(name="生活費帳戶", account_type="bank", nature="asset", currency="TWD")
    card = Account(name="信用卡", account_type="credit_card", nature="liability", currency="TWD")
    db.add_all([payment, card])
    db.flush()
    rule = EmailCardRule(
        name="信用卡",
        card_account_id=card.id,
        payment_account_id=payment.id,
        payment_due_day=23,
        active=True,
    )
    db.add(rule)
    db.add_all([
        Transaction(
            account_id=card.id,
            transaction_date=date(2026, 8, 23),
            description="上一期最後一天",
            amount=Decimal("-100"),
            currency="TWD",
            fx_rate=Decimal("1"),
            base_amount=Decimal("-100"),
            transaction_kind="expense",
            fingerprint="cycle-before-boundary",
            source="gmail",
        ),
        Transaction(
            account_id=card.id,
            transaction_date=date(2026, 8, 24),
            description="本期第一天",
            amount=Decimal("-200"),
            currency="TWD",
            fx_rate=Decimal("1"),
            base_amount=Decimal("-200"),
            transaction_kind="expense",
            fingerprint="cycle-after-boundary",
            source="gmail",
        ),
    ])
    db.commit()

    cycle = serialize_card_cycle(db, rule, date(2026, 9, 19))
    balance = _refresh_current_gmail_card_balance(db, rule, date(2026, 9, 19))

    assert serialize_email_rule(rule)["closing_day"] is None
    assert cycle["closing_day"] is None
    assert cycle["cycle_boundary_known"] is False
    assert cycle["current_cycle"] is None
    assert cycle["unbilled"] == {
        "amount": 300.0,
        "payments_total": 0.0,
        "period_start": None,
        "period_end": None,
        "transaction_count": 2,
    }
    assert balance == Decimal("300")
    db.close()


def test_unknown_closing_day_uses_formal_bill_plus_confirmed_post_bill_spending() -> None:
    db = make_session()
    payment = Account(name="生活費帳戶", account_type="bank", nature="asset", currency="TWD")
    card = Account(name="信用卡", account_type="credit_card", nature="liability", currency="TWD")
    db.add_all([payment, card])
    db.flush()
    rule = EmailCardRule(
        name="信用卡",
        card_account_id=card.id,
        payment_account_id=payment.id,
        payment_due_day=23,
        active=True,
    )
    db.add(rule)
    db.flush()
    db.add(
        EmailImportRecord(
            provider="gmail",
            provider_message_id="statement-without-closing-date",
            rule_id=rule.id,
            message_date=datetime(2026, 8, 24, 8, 0),
            status="processed",
        )
    )
    db.add(
        CreditCardBill(
            rule_id=rule.id,
            card_account_id=card.id,
            payment_account_id=payment.id,
            statement_date=None,
            due_date=date(2026, 9, 23),
            amount_due=Decimal("1000"),
            currency="TWD",
            status="pending",
            source_message_id="statement-without-closing-date",
        )
    )
    db.add_all(
        [
            Transaction(
                account_id=card.id,
                transaction_date=date(2026, 8, 23),
                description="帳單寄達前消費",
                amount=Decimal("-100"),
                currency="TWD",
                fx_rate=Decimal("1"),
                base_amount=Decimal("-100"),
                transaction_kind="expense",
                fingerprint="before-statement-received",
                source="gmail",
            ),
            Transaction(
                account_id=card.id,
                transaction_date=date(2026, 8, 25),
                description="帳單寄達後消費",
                amount=Decimal("-200"),
                currency="TWD",
                fx_rate=Decimal("1"),
                base_amount=Decimal("-200"),
                transaction_kind="expense",
                fingerprint="after-statement-received",
                source="gmail",
            ),
        ]
    )
    db.commit()

    cycle = serialize_card_cycle(db, rule, date(2026, 9, 19))
    balance = _refresh_current_gmail_card_balance(db, rule, date(2026, 9, 19))

    assert balance == Decimal("1200")
    assert cycle["closing_day"] is None
    assert cycle["cycle_boundary_known"] is False
    assert cycle["current_bill"]["amount_due"] == 1000.0
    assert cycle["current_bill"]["period_start"] is None
    assert cycle["current_bill"]["period_end"] is None
    assert cycle["unbilled"] == {
        "amount": 200.0,
        "payments_total": 0.0,
        "period_start": date(2026, 8, 25),
        "period_end": None,
        "transaction_count": 1,
    }
    db.close()


def test_card_payment_without_statement_survives_gmail_rebuild_and_late_statement() -> None:
    db = make_session()
    today = taipei_today()
    payment = Account(name="生活費帳戶", account_type="bank", nature="asset", currency="TWD")
    card = Account(name="國泰信用卡", account_type="credit_card", nature="liability", currency="TWD")
    db.add_all([payment, card])
    db.flush()
    create_balance_snapshot(db, payment, Decimal("30000"), today)
    rule = EmailCardRule(
        name="國泰信用卡", card_account_id=card.id, payment_account_id=payment.id,
        payment_due_day=23, active=True, auto_pay=False,
    )
    db.add(rule)
    db.add(Transaction(
        account_id=card.id, transaction_date=today - timedelta(days=3),
        description="已收到消費通知", amount=Decimal("-16188"), currency="TWD",
        fx_rate=Decimal("1"), base_amount=Decimal("-16188"),
        transaction_kind="expense", fingerprint="card-payment-no-bill-purchase", source="gmail",
    ))
    db.commit()
    assert _refresh_current_gmail_card_balance(db, rule, today) == Decimal("16188")

    response = create_loan_payment(LoanPaymentCreate(
        payment_account_id=payment.id, loan_account_id=card.id,
        payment_date=today - timedelta(days=1), principal=Decimal("16188"), interest=Decimal("0"),
    ), db)
    assert len(response["transaction_ids"]) == 2
    assert Decimal(str(response["loan_account"]["balance"])) == Decimal("0")
    assert decimal_amount(get_latest_balance(db, payment.id)) == Decimal("13812")
    assert decimal_amount(get_latest_balance(db, card.id)) == Decimal("0")
    assert db.query(CreditCardPayment).count() == 1
    cycle = serialize_card_cycle(db, rule, today)
    assert cycle["current_bill"] is None
    assert cycle["unbilled"]["amount"] == 0
    assert cycle["unbilled"]["payments_total"] == 16188
    assert _refresh_current_gmail_card_balance(db, rule, today) == Decimal("0")
    backup = export_backup(db)
    assert len(backup["data"]["credit_card_payments"]) == 1
    restore_backup(db, backup)
    rule = db.get(EmailCardRule, rule.id)
    assert _refresh_current_gmail_card_balance(db, rule, today) == Decimal("0")

    _create_or_update_bill(db, rule, {
        "statement_date": today - timedelta(days=2),
        "due_date": today + timedelta(days=20),
        "amount_due": Decimal("16188"),
    }, "late-statement")
    db.commit()
    bill = db.query(CreditCardBill).one()
    assert bill.status == "paid"
    assert db.query(CreditCardPayment).one().bill_id == bill.id
    assert _refresh_current_gmail_card_balance(db, rule, today) == Decimal("0")
    db.add(Transaction(
        account_id=card.id, transaction_date=today,
        description="帳單後的新消費", amount=Decimal("-500"), currency="TWD",
        fx_rate=Decimal("1"), base_amount=Decimal("-500"),
        transaction_kind="expense", fingerprint="card-payment-after-late-bill", source="gmail",
    ))
    db.commit()
    assert _refresh_current_gmail_card_balance(db, rule, today) == Decimal("500")
    db.close()


def test_one_card_payment_keeps_both_bill_allocations_after_restore_and_new_debt() -> None:
    db = make_session()
    today = taipei_today()
    bank = Account(name="付款銀行", account_type="bank", nature="asset", currency="TWD")
    card = Account(name="信用卡", account_type="credit_card", nature="liability", currency="TWD")
    db.add_all([bank, card])
    db.flush()
    create_balance_snapshot(db, bank, Decimal("2000"), today)
    rule = EmailCardRule(
        name="信用卡", card_account_id=card.id, payment_account_id=bank.id,
        active=True, auto_pay=False,
    )
    db.add(rule)
    db.flush()
    first_bill = CreditCardBill(
        rule_id=rule.id, card_account_id=card.id, payment_account_id=bank.id,
        statement_date=today - timedelta(days=40), due_date=today - timedelta(days=5),
        amount_due=Decimal("600"), currency="TWD", status="pending",
    )
    second_bill = CreditCardBill(
        rule_id=rule.id, card_account_id=card.id, payment_account_id=bank.id,
        statement_date=today - timedelta(days=10), due_date=today + timedelta(days=5),
        amount_due=Decimal("400"), currency="TWD", status="pending",
    )
    db.add_all([first_bill, second_bill])
    db.commit()
    assert _refresh_current_gmail_card_balance(db, rule, today) == Decimal("1000")

    create_loan_payment(LoanPaymentCreate(
        payment_account_id=bank.id, loan_account_id=card.id,
        payment_date=today - timedelta(days=1), principal=Decimal("1000"),
        interest=Decimal("0"),
    ), db)

    payment = db.query(CreditCardPayment).one()
    assert first_bill.status == second_bill.status == "paid"
    expected_allocations = {
        (payment.id, first_bill.id): Decimal("600"),
        (payment.id, second_bill.id): Decimal("400"),
    }
    assert {
        (row.payment_id, row.bill_id): Decimal(str(row.amount))
        for row in db.scalars(select(CreditCardPaymentAllocation)).all()
    } == expected_allocations
    allocated, open_payments = card_payment_allocations(
        db, rule, [first_bill, second_bill], today, None,
    )
    assert allocated == {first_bill.id: Decimal("600"), second_bill.id: Decimal("400")}
    assert open_payments == Decimal("0")
    assert _refresh_current_gmail_card_balance(db, rule, today) == Decimal("0")

    db.add(Transaction(
        account_id=card.id, transaction_date=today,
        description="繳清兩份帳單後的新消費", amount=Decimal("-500"), currency="TWD",
        fx_rate=Decimal("1"), base_amount=Decimal("-500"),
        transaction_kind="expense", fingerprint="two-bills-new-gmail-purchase", source="gmail",
    ))
    db.commit()
    assert _refresh_current_gmail_card_balance(db, rule, today) == Decimal("500")
    assert serialize_card_cycle(db, rule, today)["unbilled"]["amount"] == 500.0

    backup = export_backup(db)
    assert len(backup["data"]["credit_card_payment_allocations"]) == 2
    rule_id = rule.id
    db.close()
    db = make_session()
    restored = restore_backup(db, backup)
    rule = db.get(EmailCardRule, rule_id)
    assert rule is not None
    assert restored["credit_card_payments"] == 1
    assert restored["credit_card_payment_allocations"] == 2
    assert {
        (row.payment_id, row.bill_id): Decimal(str(row.amount))
        for row in db.scalars(select(CreditCardPaymentAllocation)).all()
    } == expected_allocations
    assert _refresh_current_gmail_card_balance(db, rule, today) == Decimal("500")

    _create_or_update_bill(db, rule, {
        "statement_date": today,
        "due_date": today + timedelta(days=20),
        "amount_due": Decimal("900"),
    }, "third-bill-after-full-payment")
    db.commit()
    bills = db.scalars(select(CreditCardBill).where(
        CreditCardBill.rule_id == rule.id,
    ).order_by(CreditCardBill.id)).all()
    third_bill = bills[-1]
    allocated, open_payments = card_payment_allocations(db, rule, bills, today, None)
    assert third_bill.status == "pending"
    assert allocated[third_bill.id] == Decimal("0")
    assert open_payments == Decimal("0")
    assert db.query(CreditCardPayment).count() == 1
    assert db.query(CreditCardPaymentAllocation).count() == 2
    assert _refresh_current_gmail_card_balance(db, rule, today) == Decimal("900")
    assert serialize_card_cycle(db, rule, today)["current_bill"]["remaining_due"] == 900.0
    db.close()


def test_future_generic_transfer_into_card_creates_no_ledger_or_snapshot() -> None:
    db = make_session()
    today = taipei_today()
    bank = Account(name="付款銀行", account_type="bank", nature="asset", currency="TWD")
    card = Account(name="信用卡", account_type="credit_card", nature="liability", currency="TWD")
    db.add_all([bank, card])
    db.commit()

    with pytest.raises(HTTPException) as invalid:
        create_account_transfer(AccountTransferCreate(
            from_account_id=bank.id, to_account_id=card.id,
            amount=Decimal("500"), transfer_date=today + timedelta(days=1),
        ), db)

    assert invalid.value.status_code == 422
    assert not db.scalars(select(Transaction)).all()
    assert not db.scalars(select(BalanceSnapshot)).all()
    assert not db.scalars(select(TransferLink)).all()
    assert not db.scalars(select(CreditCardPayment)).all()
    db.close()


def test_payment_for_one_rule_bill_does_not_pay_another_rule_on_same_card() -> None:
    db = make_session()
    today = taipei_today()
    bank = Account(name="付款銀行", account_type="bank", nature="asset", currency="TWD")
    card = Account(name="信用卡", account_type="credit_card", nature="liability", currency="TWD")
    db.add_all([bank, card])
    db.flush()
    create_balance_snapshot(db, bank, Decimal("2000"), today)
    rule_a = EmailCardRule(name="規則 A", card_account_id=card.id,
                           payment_account_id=bank.id, auto_pay=False, active=True)
    rule_b = EmailCardRule(name="規則 B", card_account_id=card.id,
                           payment_account_id=bank.id, auto_pay=False, active=True)
    db.add_all([rule_a, rule_b])
    db.flush()
    bill_a = CreditCardBill(
        rule_id=rule_a.id, card_account_id=card.id, payment_account_id=bank.id,
        statement_date=today - timedelta(days=10), due_date=today + timedelta(days=5),
        amount_due=Decimal("600"), currency="TWD", status="pending",
    )
    bill_b = CreditCardBill(
        rule_id=rule_b.id, card_account_id=card.id, payment_account_id=bank.id,
        statement_date=today - timedelta(days=10), due_date=today + timedelta(days=5),
        amount_due=Decimal("400"), currency="TWD", status="pending",
    )
    db.add_all([bill_a, bill_b])
    db.commit()
    assert _refresh_current_gmail_card_balance(db, rule_a, today) == Decimal("600")

    create_loan_payment(LoanPaymentCreate(
        payment_account_id=bank.id, loan_account_id=card.id, bill_id=bill_a.id,
        payment_date=today, principal=Decimal("600"), interest=Decimal("0"),
    ), db)

    assert db.query(CreditCardPayment).one().bill_id == bill_a.id
    assert bill_a.status == "paid"
    assert bill_b.status == "pending"
    allocated_b, _ = card_payment_allocations(db, rule_b, [bill_b], today, None)
    assert allocated_b[bill_b.id] == Decimal("0")
    assert serialize_card_cycle(db, rule_b, today)["current_bill"]["remaining_due"] == 400.0
    db.close()


def test_partial_card_payment_only_auto_records_remaining_statement_once() -> None:
    db = make_session()
    today = taipei_today()
    payment = Account(name="生活費帳戶", account_type="bank", nature="asset", currency="TWD")
    card = Account(name="國泰信用卡", account_type="credit_card", nature="liability", currency="TWD")
    db.add_all([payment, card])
    db.flush()
    create_balance_snapshot(db, payment, Decimal("30000"), today)
    rule = EmailCardRule(
        name="國泰信用卡", card_account_id=card.id, payment_account_id=payment.id,
        payment_due_day=today.day, active=True, auto_pay=True,
    )
    db.add(rule)
    db.flush()
    bill = CreditCardBill(
        rule_id=rule.id, card_account_id=card.id, payment_account_id=payment.id,
        statement_date=today - timedelta(days=10), due_date=today,
        amount_due=Decimal("12000"), currency="TWD", status="pending",
    )
    db.add(bill)
    db.commit()
    assert _refresh_current_gmail_card_balance(db, rule, today) == Decimal("12000")

    create_loan_payment(LoanPaymentCreate(
        payment_account_id=payment.id, loan_account_id=card.id, bill_id=bill.id,
        payment_date=today, principal=Decimal("5000"), interest=Decimal("0"),
    ), db)
    assert decimal_amount(get_latest_balance(db, card.id)) == Decimal("7000")
    cycle = serialize_card_cycle(db, rule, today)
    assert cycle["current_bill"]["amount_due"] == 12000
    assert cycle["current_bill"]["payments_total"] == 5000
    assert cycle["current_bill"]["remaining_due"] == 7000

    first = process_due_card_bills(db, today)
    second = process_due_card_bills(db, today)
    assert first["paid"] == 1
    assert second["paid"] == 0
    assert bill.status == "paid"
    assert decimal_amount(get_latest_balance(db, payment.id)) == Decimal("18000")
    assert _refresh_current_gmail_card_balance(db, rule, today) == Decimal("0")
    assert db.query(CreditCardPayment).count() == 2
    db.close()


def test_existing_card_transfer_is_recognized_without_second_bank_debit() -> None:
    db = make_session()
    today = taipei_today()
    payment = Account(name="生活費帳戶", account_type="bank", nature="asset", currency="TWD")
    card = Account(name="國泰信用卡", account_type="credit_card", nature="liability", currency="TWD")
    db.add_all([payment, card])
    db.flush()
    create_balance_snapshot(db, payment, Decimal("13812"), today)
    rule = EmailCardRule(name="國泰信用卡", card_account_id=card.id,
                         payment_account_id=payment.id, active=True, auto_pay=False)
    db.add(rule)
    purchase = Transaction(
        account_id=card.id, transaction_date=today - timedelta(days=2),
        description="消費", amount=Decimal("-16188"), currency="TWD",
        fx_rate=Decimal("1"), base_amount=Decimal("-16188"),
        transaction_kind="expense", fingerprint="preexisting-card-purchase", source="gmail",
    )
    outgoing = Transaction(
        account_id=payment.id, transaction_date=today - timedelta(days=1),
        description="既有付款", amount=Decimal("-16188"), currency="TWD",
        fx_rate=Decimal("1"), base_amount=Decimal("-16188"),
        transaction_kind="transfer", fingerprint="preexisting-card-payment-out", source="manual",
    )
    incoming = Transaction(
        account_id=card.id, transaction_date=today - timedelta(days=1),
        description="既有付款", amount=Decimal("16188"), currency="TWD",
        fx_rate=Decimal("1"), base_amount=Decimal("16188"),
        transaction_kind="transfer", fingerprint="preexisting-card-payment-in", source="manual",
    )
    db.add_all([purchase, outgoing, incoming])
    db.flush()
    db.add(TransferLink(from_transaction_id=outgoing.id, to_transaction_id=incoming.id, confirmed=True))
    db.commit()

    assert repair_linked_card_payments(db) == 1
    assert repair_linked_card_payments(db) == 0
    assert _refresh_current_gmail_card_balance(db, rule, today) == Decimal("0")
    assert decimal_amount(get_latest_balance(db, payment.id)) == Decimal("13812")
    assert db.query(CreditCardPayment).count() == 1
    with pytest.raises(HTTPException) as duplicate:
        confirm_transfer(TransferCreate(from_transaction_id=outgoing.id,
                                         to_transaction_id=incoming.id), db)
    assert duplicate.value.status_code == 409
    db.close()


def test_legacy_backup_restores_linked_card_payment_and_clears_liability() -> None:
    db = make_session()
    today = taipei_today()
    bank = Account(name="付款銀行", account_type="bank", nature="asset", currency="TWD")
    card = Account(name="信用卡", account_type="credit_card", nature="liability", currency="TWD")
    db.add_all([bank, card])
    db.flush()
    rule = EmailCardRule(name="信用卡", card_account_id=card.id,
                         payment_account_id=bank.id, auto_pay=False, active=True)
    db.add(rule)
    purchase = Transaction(
        account_id=card.id, transaction_date=today - timedelta(days=2),
        description="消費", amount=Decimal("-500"), currency="TWD",
        fx_rate=Decimal("1"), base_amount=Decimal("-500"),
        transaction_kind="expense", fingerprint="legacy-backup-card-purchase", source="gmail",
    )
    outgoing = Transaction(
        account_id=bank.id, transaction_date=today - timedelta(days=1),
        description="已繳款", amount=Decimal("-500"), currency="TWD",
        fx_rate=Decimal("1"), base_amount=Decimal("-500"),
        transaction_kind="transfer", fingerprint="legacy-backup-bank-debit", source="manual",
    )
    incoming = Transaction(
        account_id=card.id, transaction_date=today - timedelta(days=1),
        description="已繳款", amount=Decimal("500"), currency="TWD",
        fx_rate=Decimal("1"), base_amount=Decimal("500"),
        transaction_kind="transfer", fingerprint="legacy-backup-card-credit", source="manual",
    )
    db.add_all([purchase, outgoing, incoming])
    db.flush()
    db.add(TransferLink(from_transaction_id=outgoing.id,
                        to_transaction_id=incoming.id, confirmed=True))
    db.commit()
    assert _refresh_current_gmail_card_balance(db, rule, today) == Decimal("500")
    backup = export_backup(db)
    assert backup["data"].pop("credit_card_payments") == []

    restore_backup(db, backup)

    assert db.query(CreditCardPayment).count() == 1
    restored_rule = db.get(EmailCardRule, rule.id)
    assert decimal_amount(get_latest_balance(db, card.id)) == Decimal("0")
    assert _refresh_current_gmail_card_balance(db, restored_rule, today) == Decimal("0")
    db.close()


def test_confirming_existing_card_transfer_updates_balance_immediately() -> None:
    db = make_session()
    today = taipei_today()
    payment = Account(name="生活費帳戶", account_type="bank", nature="asset", currency="TWD")
    card = Account(name="國泰信用卡", account_type="credit_card", nature="liability", currency="TWD")
    db.add_all([payment, card])
    db.flush()
    create_balance_snapshot(db, payment, Decimal("13812"), today)
    rule = EmailCardRule(name="國泰信用卡", card_account_id=card.id,
                         payment_account_id=payment.id, active=True, auto_pay=False)
    db.add(rule)
    purchase = Transaction(
        account_id=card.id, transaction_date=today - timedelta(days=2),
        description="消費", amount=Decimal("-16188"), currency="TWD",
        fx_rate=Decimal("1"), base_amount=Decimal("-16188"),
        transaction_kind="expense", fingerprint="confirm-card-purchase", source="gmail",
    )
    outgoing = Transaction(
        account_id=payment.id, transaction_date=today - timedelta(days=1),
        description="銀行扣款", amount=Decimal("-16188"), currency="TWD",
        fx_rate=Decimal("1"), base_amount=Decimal("-16188"),
        transaction_kind="expense", fingerprint="confirm-card-out", source="csv",
    )
    incoming = Transaction(
        account_id=card.id, transaction_date=today - timedelta(days=1),
        description="信用卡入款", amount=Decimal("16188"), currency="TWD",
        fx_rate=Decimal("1"), base_amount=Decimal("16188"),
        transaction_kind="income", fingerprint="confirm-card-in", source="manual",
    )
    db.add_all([purchase, outgoing, incoming])
    db.commit()
    assert _refresh_current_gmail_card_balance(db, rule, today) == Decimal("16188")

    confirm_transfer(TransferCreate(from_transaction_id=outgoing.id,
                                     to_transaction_id=incoming.id), db)
    assert decimal_amount(get_latest_balance(db, card.id)) == Decimal("0")
    assert decimal_amount(get_latest_balance(db, payment.id)) == Decimal("13812")
    assert db.query(CreditCardPayment).count() == 1
    db.close()


def test_card_payment_reuses_imported_bank_debit_without_reducing_bank_again() -> None:
    db = make_session()
    today = taipei_today()
    payment_date = today - timedelta(days=1)
    bank = Account(name="付款銀行", account_type="bank", nature="asset", currency="TWD")
    card = Account(name="信用卡", account_type="credit_card", nature="liability", currency="TWD")
    db.add_all([bank, card])
    db.flush()
    create_balance_snapshot(db, bank, Decimal("13812"), today)
    rule = EmailCardRule(name="信用卡", card_account_id=card.id,
                         payment_account_id=bank.id, auto_pay=False, active=True)
    db.add(rule)
    db.flush()
    bill = CreditCardBill(
        rule_id=rule.id, card_account_id=card.id, payment_account_id=bank.id,
        statement_date=today - timedelta(days=10), due_date=today + timedelta(days=5),
        amount_due=Decimal("16188"), currency="TWD", status="pending",
    )
    debit = Transaction(
        account_id=bank.id, transaction_date=payment_date, description="信用卡帳單扣款",
        amount=Decimal("-16188"), currency="TWD", fx_rate=Decimal("1"),
        base_amount=Decimal("-16188"), transaction_kind="expense",
        fingerprint="reused-card-bank-debit", source="csv",
    )
    db.add_all([bill, debit])
    db.commit()
    assert _refresh_current_gmail_card_balance(db, rule, today) == Decimal("16188")

    candidates = card_payment_candidates(card.id, bank.id, db)
    assert [item["id"] for item in candidates] == [debit.id]
    assert candidates[0]["amount"] == -16188.0
    bank_snapshot_ids = db.scalars(select(BalanceSnapshot.id).where(
        BalanceSnapshot.account_id == bank.id
    )).all()

    result = create_loan_payment(LoanPaymentCreate(
        payment_account_id=bank.id, loan_account_id=card.id, bill_id=bill.id,
        payment_date=payment_date, principal=Decimal("16188"), interest=Decimal("0"),
        existing_payment_transaction_id=debit.id,
    ), db)

    assert result["transaction_ids"][0] == debit.id
    assert len(result["transaction_ids"]) == 2
    assert [row.id for row in db.scalars(select(Transaction).where(
        Transaction.account_id == bank.id
    )).all()] == [debit.id]
    assert db.scalars(select(BalanceSnapshot.id).where(
        BalanceSnapshot.account_id == bank.id
    )).all() == bank_snapshot_ids
    assert decimal_amount(get_latest_balance(db, bank.id)) == Decimal("13812")
    assert decimal_amount(get_latest_balance(db, card.id)) == Decimal("0")
    assert db.get(CreditCardBill, bill.id).status == "paid"
    payment = db.query(CreditCardPayment).one()
    link = db.get(TransferLink, payment.transfer_link_id)
    assert link.from_transaction_id == debit.id
    assert debit.source == "csv"
    assert debit.transaction_kind == "transfer"
    assert card_payment_candidates(card.id, bank.id, db) == []
    db.close()


def test_reused_debit_for_unknown_bill_period_requires_explicit_bill_selection() -> None:
    db = make_session()
    today = taipei_today()
    payment_date = today - timedelta(days=1)
    bank = Account(name="付款銀行", account_type="bank", nature="asset", currency="TWD")
    card = Account(name="信用卡", account_type="credit_card", nature="liability", currency="TWD")
    db.add_all([bank, card])
    db.flush()
    create_balance_snapshot(db, bank, Decimal("1600"), today)
    rule = EmailCardRule(
        name="信用卡", card_account_id=card.id, payment_account_id=bank.id,
        active=True, auto_pay=False,
    )
    db.add(rule)
    db.flush()
    bill = CreditCardBill(
        rule_id=rule.id, card_account_id=card.id, payment_account_id=bank.id,
        statement_date=None, due_date=today + timedelta(days=5),
        amount_due=Decimal("600"), currency="TWD", status="pending",
    )
    debit = Transaction(
        account_id=bank.id, transaction_date=payment_date, description="匯入信用卡扣款",
        amount=Decimal("-400"), currency="TWD", fx_rate=Decimal("1"),
        base_amount=Decimal("-400"), transaction_kind="expense",
        fingerprint="no-anchor-bill-bank-debit", source="csv",
    )
    db.add_all([bill, debit])
    db.commit()
    assert _refresh_current_gmail_card_balance(db, rule, today) == Decimal("600")
    bank_snapshot_ids = db.scalars(select(BalanceSnapshot.id).where(
        BalanceSnapshot.account_id == bank.id,
    )).all()
    payload = LoanPaymentCreate(
        payment_account_id=bank.id, loan_account_id=card.id,
        payment_date=payment_date, principal=Decimal("400"), interest=Decimal("0"),
        existing_payment_transaction_id=debit.id,
    )

    with pytest.raises(HTTPException) as invalid:
        create_loan_payment(payload, db)

    assert invalid.value.status_code == 422
    assert "帳單帳期未知" in invalid.value.detail
    assert db.query(TransferLink).count() == 0
    assert db.query(CreditCardPayment).count() == 0
    assert db.query(CreditCardPaymentAllocation).count() == 0
    assert db.scalars(select(Transaction.id)).all() == [debit.id]
    assert debit.transaction_kind == "expense"
    assert decimal_amount(get_latest_balance(db, card.id)) == Decimal("600")

    result = create_loan_payment(payload.model_copy(update={"bill_id": bill.id}), db)

    assert result["transaction_ids"][0] == debit.id
    assert len(result["transaction_ids"]) == 2
    assert db.scalars(select(Transaction.id).where(
        Transaction.account_id == bank.id,
    )).all() == [debit.id]
    assert db.scalars(select(BalanceSnapshot.id).where(
        BalanceSnapshot.account_id == bank.id,
    )).all() == bank_snapshot_ids
    assert decimal_amount(get_latest_balance(db, bank.id)) == Decimal("1600")
    assert decimal_amount(get_latest_balance(db, card.id)) == Decimal("200")
    assert bill.status == "pending"
    assert db.query(CreditCardPayment).one().bill_id == bill.id
    allocation = db.query(CreditCardPaymentAllocation).one()
    assert allocation.bill_id == bill.id
    assert Decimal(str(allocation.amount)) == Decimal("400")
    cycle = serialize_card_cycle(db, rule, today)
    assert cycle["current_bill"]["payments_total"] == 400.0
    assert cycle["current_bill"]["remaining_due"] == 200.0
    assert _refresh_current_gmail_card_balance(db, rule, today) == Decimal("200")
    db.close()


def test_card_payment_cannot_reuse_a_linked_debit_or_mismatched_amount() -> None:
    db = make_session()
    today = taipei_today()
    payment_date = today - timedelta(days=1)
    bank = Account(name="付款銀行", account_type="bank", nature="asset", currency="TWD")
    card = Account(name="信用卡", account_type="credit_card", nature="liability", currency="TWD")
    db.add_all([bank, card])
    db.flush()
    create_balance_snapshot(db, bank, Decimal("20000"), today)
    rule = EmailCardRule(name="信用卡", card_account_id=card.id,
                         payment_account_id=bank.id, auto_pay=False, active=True)
    db.add(rule)
    db.add(Transaction(
        account_id=card.id, transaction_date=today - timedelta(days=2),
        description="已入帳消費", amount=Decimal("-32376"), currency="TWD",
        fx_rate=Decimal("1"), base_amount=Decimal("-32376"),
        transaction_kind="expense", fingerprint="reuse-duplicate-card-purchase", source="gmail",
    ))
    debit = Transaction(
        account_id=bank.id, transaction_date=payment_date, description="信用卡扣款",
        amount=Decimal("-16188"), currency="TWD", fx_rate=Decimal("1"),
        base_amount=Decimal("-16188"), transaction_kind="expense",
        fingerprint="reuse-duplicate-bank-debit", source="csv",
    )
    db.add(debit)
    db.commit()
    assert _refresh_current_gmail_card_balance(db, rule, today) == Decimal("32376")

    def payload(principal: str) -> LoanPaymentCreate:
        return LoanPaymentCreate(
            payment_account_id=bank.id, loan_account_id=card.id,
            payment_date=payment_date, principal=Decimal(principal), interest=Decimal("0"),
            existing_payment_transaction_id=debit.id,
        )

    with pytest.raises(HTTPException) as mismatch:
        create_loan_payment(payload("16000"), db)
    assert mismatch.value.status_code == 422
    assert not db.scalars(select(TransferLink)).all()
    assert db.query(CreditCardPayment).count() == 0

    create_loan_payment(payload("16188"), db)
    with pytest.raises(HTTPException) as duplicate:
        create_loan_payment(payload("16188"), db)
    assert duplicate.value.status_code == 409
    assert db.query(CreditCardPayment).count() == 1
    assert len(db.scalars(select(Transaction).where(
        Transaction.account_id == bank.id
    )).all()) == 1
    db.close()


def test_card_payment_rejects_debit_before_the_card_purchase() -> None:
    db = make_session()
    today = taipei_today()
    payment_date = today - timedelta(days=3)
    bank = Account(name="付款銀行", account_type="bank", nature="asset", currency="TWD")
    card = Account(name="信用卡", account_type="credit_card", nature="liability", currency="TWD")
    db.add_all([bank, card])
    db.flush()
    rule = EmailCardRule(name="信用卡", card_account_id=card.id,
                         payment_account_id=bank.id, auto_pay=False, active=True)
    db.add(rule)
    debit = Transaction(
        account_id=bank.id, transaction_date=payment_date, description="較早銀行扣款",
        amount=Decimal("-16188"), currency="TWD", fx_rate=Decimal("1"),
        base_amount=Decimal("-16188"), transaction_kind="expense",
        fingerprint="reuse-old-bank-debit", source="csv",
    )
    purchase = Transaction(
        account_id=card.id, transaction_date=today - timedelta(days=1),
        description="較晚信用卡消費", amount=Decimal("-16188"), currency="TWD",
        fx_rate=Decimal("1"), base_amount=Decimal("-16188"),
        transaction_kind="expense", fingerprint="reuse-later-card-purchase", source="gmail",
    )
    db.add_all([debit, purchase])
    db.commit()
    assert _refresh_current_gmail_card_balance(db, rule, today) == Decimal("16188")

    with pytest.raises(HTTPException) as invalid:
        create_loan_payment(LoanPaymentCreate(
            payment_account_id=bank.id, loan_account_id=card.id,
            payment_date=payment_date, principal=Decimal("16188"), interest=Decimal("0"),
            existing_payment_transaction_id=debit.id,
        ), db)
    assert invalid.value.status_code == 422
    assert db.query(CreditCardPayment).count() == 0
    assert not db.scalars(select(TransferLink)).all()
    db.close()


def test_auto_pay_marks_lone_imported_bank_debit_for_review_without_second_debit() -> None:
    db = make_session()
    today = taipei_today()
    bank = Account(name="付款銀行", account_type="bank", nature="asset", currency="TWD")
    card = Account(name="信用卡", account_type="credit_card", nature="liability", currency="TWD")
    db.add_all([bank, card])
    db.flush()
    create_balance_snapshot(db, bank, Decimal("13812"), today)
    create_balance_snapshot(db, card, Decimal("16188"), today)
    rule = EmailCardRule(
        name="信用卡", card_account_id=card.id, payment_account_id=bank.id,
        auto_pay=True, active=True, created_at=datetime.combine(today - timedelta(days=1), datetime.min.time()),
    )
    db.add(rule)
    db.flush()
    bill = CreditCardBill(
        rule_id=rule.id, card_account_id=card.id, payment_account_id=bank.id,
        statement_date=today - timedelta(days=10), due_date=today,
        amount_due=Decimal("16188"), currency="TWD", status="pending",
    )
    debit = Transaction(
        account_id=bank.id, transaction_date=today, description="已匯入信用卡扣款",
        amount=Decimal("-16188"), currency="TWD", fx_rate=Decimal("1"),
        base_amount=Decimal("-16188"), transaction_kind="expense",
        fingerprint="auto-pay-existing-bank-debit", source="csv",
    )
    db.add_all([bill, debit])
    db.commit()
    bank_snapshot_ids = db.scalars(select(BalanceSnapshot.id).where(
        BalanceSnapshot.account_id == bank.id
    )).all()

    first = process_due_card_bills(db, today)
    second = process_due_card_bills(db, today)

    assert first["paid"] == 0
    assert first["needs_review"] == 1
    assert second["checked"] == 0
    assert bill.status == "needs_review"
    assert "扣款" in bill.last_error
    assert [row.id for row in db.scalars(select(Transaction).where(
        Transaction.account_id == bank.id
    )).all()] == [debit.id]
    assert not db.scalars(select(Transaction).where(
        Transaction.source == "gmail_autopay"
    )).all()
    assert db.scalars(select(BalanceSnapshot.id).where(
        BalanceSnapshot.account_id == bank.id
    )).all() == bank_snapshot_ids
    assert decimal_amount(get_latest_balance(db, bank.id)) == Decimal("13812")
    assert db.query(CreditCardPayment).count() == 0
    db.close()


def test_csv_import_skips_purchase_already_recorded_by_linked_gmail_card() -> None:
    db = make_session()
    payment = Account(
        name="生活費帳戶",
        account_type="bank",
        nature="asset",
        currency="TWD",
        owner="me",
    )
    card = Account(
        name="國泰信用卡",
        account_type="credit_card",
        nature="liability",
        currency="TWD",
        owner="me",
    )
    db.add_all([payment, card])
    db.flush()
    create_balance_snapshot(db, payment, Decimal("10000"), date(2026, 7, 1))
    db.add(
        EmailCardRule(
            name="國泰信用卡",
            owner="me",
            card_account_id=card.id,
            payment_account_id=payment.id,
            active=True,
        )
    )
    db.add(
        Transaction(
            account_id=card.id,
            transaction_date=date(2026, 7, 19),
            description="APPLE.COM/BILL",
            amount=Decimal("-208"),
            currency="TWD",
            fx_rate=Decimal("1"),
            base_amount=Decimal("-208"),
            transaction_kind="expense",
            fingerprint="gmail-apple",
            source="gmail",
        )
    )
    db.commit()

    result = import_csv(
        db,
        b"date,description,amount,currency\n2026-07-19,APPLE.COM/BILL,-208,TWD\n",
        payment,
        {
            "date": "date",
            "description": "description",
            "amount": "amount",
            "currency": "currency",
        },
    )

    assert result["imported"] == 0
    assert result["duplicates"] == 1
    assert decimal_amount(get_latest_balance(db, payment.id)) == Decimal("10000")
    assert len(db.scalars(select(Transaction)).all()) == 1
    db.close()


def test_gmail_purchase_claims_csv_copy_and_reverses_active_csv_balance() -> None:
    db = make_session()
    payment = Account(
        name="生活費帳戶",
        account_type="bank",
        nature="asset",
        currency="TWD",
        owner="me",
    )
    card = Account(
        name="國泰信用卡",
        account_type="credit_card",
        nature="liability",
        currency="TWD",
        owner="me",
    )
    db.add_all([payment, card])
    db.flush()
    rule = EmailCardRule(
        name="國泰信用卡",
        owner="me",
        card_account_id=card.id,
        payment_account_id=payment.id,
        active=True,
    )
    db.add(rule)
    db.flush()
    create_balance_snapshot(db, payment, Decimal("10000"), date(2026, 7, 1))
    csv_row = Transaction(
        account_id=payment.id,
        transaction_date=date(2026, 7, 19),
        description="APPLE.COM/BILL",
        amount=Decimal("-208"),
        currency="TWD",
        fx_rate=Decimal("1"),
        base_amount=Decimal("-208"),
        transaction_kind="expense",
        fingerprint="csv-apple",
        source="csv",
    )
    db.add(csv_row)
    db.flush()
    create_balance_snapshot(
        db, payment, Decimal("9792"), date(2026, 7, 19), source="csv_transactions"
    )
    db.add(
        AppSetting(
            key=f"csv_balance_applied:{payment.id}",
            value=f"[{csv_row.id}]",
        )
    )
    db.commit()

    created = _create_card_transaction(
        db,
        rule,
        {
            "date": date(2026, 7, 19),
            "description": "APPLE.COM/BILL",
            "amount": Decimal("-208"),
            "kind": "expense",
        },
        "message-apple",
    )
    db.commit()

    rows = db.scalars(select(Transaction)).all()
    assert created is True
    assert len(rows) == 1
    assert rows[0].account_id == card.id
    assert rows[0].source == "gmail"
    assert decimal_amount(get_latest_balance(db, payment.id)) == Decimal("10000")
    db.close()


def test_existing_cross_source_repair_preserves_newer_manual_balance() -> None:
    db = make_session()
    payment = Account(
        name="生活費帳戶",
        account_type="bank",
        nature="asset",
        currency="TWD",
        owner="me",
    )
    card = Account(
        name="國泰信用卡",
        account_type="credit_card",
        nature="liability",
        currency="TWD",
        owner="me",
    )
    db.add_all([payment, card])
    db.flush()
    db.add(
        EmailCardRule(
            name="國泰信用卡",
            owner="me",
            card_account_id=card.id,
            payment_account_id=payment.id,
            active=True,
        )
    )
    db.flush()
    csv_rows: list[Transaction] = []
    for index, (tx_date, amount, description) in enumerate(
        [
            (date(2026, 6, 30), Decimal("-119"), "GOOGLE YOUTUBE"),
            (date(2026, 7, 19), Decimal("-208"), "APPLE.COM/BILL"),
            (date(2026, 7, 20), Decimal("-42"), "全聯福利中心 A"),
            (date(2026, 7, 20), Decimal("-42"), "全聯福利中心 B"),
        ]
    ):
        csv_row = Transaction(
            account_id=payment.id,
            transaction_date=tx_date,
            description=description,
            amount=amount,
            currency="TWD",
            fx_rate=Decimal("1"),
            base_amount=amount,
            transaction_kind="expense",
            fingerprint=f"csv-{index}",
            source="csv",
        )
        gmail_description = {
            0: "YOUTUBE PREMIUM",
            2: "福利中心甲",
            3: "福利中心乙",
        }.get(index, description)
        gmail_row = Transaction(
            account_id=card.id,
            transaction_date=tx_date,
            description=gmail_description,
            amount=amount,
            currency="TWD",
            fx_rate=Decimal("1"),
            base_amount=amount,
            transaction_kind="expense",
            fingerprint=f"gmail-{index}",
            source="gmail",
        )
        db.add_all([csv_row, gmail_row])
        csv_rows.append(csv_row)
    db.flush()
    db.add(
        AppSetting(
            key=f"csv_balance_applied:{payment.id}",
            value="[" + ",".join(str(row.id) for row in csv_rows) + "]",
        )
    )
    create_balance_snapshot(db, payment, Decimal("61403"), date(2026, 7, 31), source="csv_transactions")
    create_balance_snapshot(db, payment, Decimal("61730"), date(2026, 8, 18), source="manual")
    db.commit()

    result = repair_cross_source_card_duplicates(db)

    assert result["removed"] == 4
    assert result["duplicate_amount_twd"] == 411
    assert result["balance_corrected_accounts"] == 0
    assert result["newer_balance_preserved_accounts"] == 1
    assert decimal_amount(get_latest_balance(db, payment.id)) == Decimal("61730")
    remaining = db.scalars(select(Transaction).order_by(Transaction.id)).all()
    assert len(remaining) == 4
    assert all(row.account_id == card.id and row.source == "gmail" for row in remaining)
    db.close()


def test_cross_source_repair_works_after_email_rule_is_removed() -> None:
    db = make_session()
    payment = Account(
        name="生活費帳戶",
        account_type="bank",
        nature="asset",
        currency="TWD",
        owner="me",
    )
    card = Account(
        name="國泰信用卡",
        account_type="credit_card",
        nature="liability",
        currency="TWD",
        owner="me",
    )
    db.add_all([payment, card])
    db.flush()
    for index, (transaction_date, amount) in enumerate(
        [
            (date(2026, 7, 19), Decimal("-148")),
            (date(2026, 7, 20), Decimal("-208")),
            (date(2026, 7, 21), Decimal("-42")),
        ]
    ):
        db.add_all(
            [
                Transaction(
                    account_id=payment.id,
                    transaction_date=transaction_date,
                    description=f"銀行摘要 {index}",
                    amount=amount,
                    currency="TWD",
                    fx_rate=Decimal("1"),
                    base_amount=amount,
                    transaction_kind="expense",
                    fingerprint=f"csv-without-rule-{index}",
                    source="csv",
                ),
                Transaction(
                    account_id=card.id,
                    transaction_date=transaction_date,
                    description=f"信用卡商店 {index}",
                    amount=amount,
                    currency="TWD",
                    fx_rate=Decimal("1"),
                    base_amount=amount,
                    transaction_kind="expense",
                    fingerprint=f"gmail-without-rule-{index}",
                    source="gmail",
                ),
            ]
        )
    db.commit()

    result = repair_cross_source_card_duplicates(db)

    assert result["removed"] == 3
    remaining = db.scalars(select(Transaction)).all()
    assert len(remaining) == 3
    assert all(row.source == "gmail" for row in remaining)
    db.close()


def test_ruleless_cross_source_repair_keeps_a_single_coincidental_match() -> None:
    db = make_session()
    payment = Account(
        name="生活費帳戶",
        account_type="bank",
        nature="asset",
        currency="TWD",
        owner="me",
    )
    card = Account(
        name="信用卡",
        account_type="credit_card",
        nature="liability",
        currency="TWD",
        owner="me",
    )
    db.add_all([payment, card])
    db.flush()
    for account, source, fingerprint in [
        (payment, "csv", "coincidental-csv"),
        (card, "gmail", "coincidental-gmail"),
    ]:
        db.add(
            Transaction(
                account_id=account.id,
                transaction_date=date(2026, 7, 19),
                description="不同的消費",
                amount=Decimal("-100"),
                currency="TWD",
                fx_rate=Decimal("1"),
                base_amount=Decimal("-100"),
                transaction_kind="expense",
                fingerprint=fingerprint,
                source=source,
            )
        )
    db.commit()

    result = repair_cross_source_card_duplicates(db)

    assert result["removed"] == 0
    assert len(db.scalars(select(Transaction)).all()) == 2
    db.close()


def test_linked_transfer_relationship_overrides_corrupted_income_kind() -> None:
    db = make_session()
    source = Account(
        name="家中現金",
        account_type="cash",
        nature="asset",
        currency="TWD",
        owner="me",
    )
    target = Account(
        name="生活費帳戶",
        account_type="bank",
        nature="asset",
        currency="TWD",
        owner="me",
    )
    db.add_all([source, target])
    db.flush()
    outgoing = Transaction(
        account_id=source.id,
        transaction_date=date.today(),
        description="帳戶轉帳 → 生活費帳戶",
        amount=Decimal("-79000"),
        currency="TWD",
        fx_rate=Decimal("1"),
        base_amount=Decimal("-79000"),
        transaction_kind="transfer",
        fingerprint="transfer-out",
        source="manual",
    )
    incoming = Transaction(
        account_id=target.id,
        transaction_date=date.today(),
        description="帳戶轉帳 ← 家中現金",
        amount=Decimal("79000"),
        currency="TWD",
        fx_rate=Decimal("1"),
        base_amount=Decimal("79000"),
        transaction_kind="income",
        fingerprint="transfer-in-corrupted",
        source="manual",
    )
    db.add_all([outgoing, incoming])
    db.flush()
    db.add(
        TransferLink(
            from_transaction_id=outgoing.id,
            to_transaction_id=incoming.id,
            confirmed=True,
        )
    )
    db.commit()

    dashboard = calculate_dashboard(db, owner="me")
    assert dashboard["month_income"] == 0
    assert dashboard["month_expense"] == 0

    result = repair_linked_transfer_kinds(db)
    assert result == {"updated": 1}
    assert incoming.transaction_kind == "transfer"
    db.close()


def test_due_bill_creates_internal_transfer_and_updates_balances() -> None:
    db = make_session()
    payment = Account(
        name="生活費帳戶",
        institution="國泰世華",
        account_type="bank",
        nature="asset",
        currency="TWD",
        owner="me",
    )
    card = Account(
        name="國泰信用卡",
        institution="國泰世華",
        account_type="credit_card",
        nature="liability",
        currency="TWD",
        owner="me",
    )
    db.add_all([payment, card])
    db.flush()
    create_balance_snapshot(db, payment, Decimal("50000"), date.today())
    create_balance_snapshot(db, card, Decimal("13797"), date.today())
    rule = EmailCardRule(
        name="國泰信用卡",
        owner="me",
        card_account_id=card.id,
        payment_account_id=payment.id,
        sender_pattern="cathaybk.com.tw",
        auto_pay=True,
        active=True,
    )
    db.add(rule)
    db.flush()
    bill = CreditCardBill(
        rule_id=rule.id,
        card_account_id=card.id,
        payment_account_id=payment.id,
        statement_date=date.today(),
        due_date=date.today(),
        amount_due=Decimal("13797"),
        currency="TWD",
        status="pending",
    )
    db.add(bill)
    db.commit()

    result = process_due_card_bills(db, date.today())

    assert result["paid"] == 1
    assert decimal_amount(get_latest_balance(db, payment.id)) == Decimal("36203")
    assert decimal_amount(get_latest_balance(db, card.id)) == Decimal("0")
    rows = db.scalars(
        select(Transaction).where(Transaction.source == "gmail_autopay")
    ).all()
    assert len(rows) == 2
    assert all(row.transaction_kind == "transfer" for row in rows)
    assert db.get(CreditCardBill, bill.id).status == "paid"
    db.close()


def test_due_bill_stops_when_payment_balance_is_insufficient() -> None:
    db = make_session()
    payment = Account(
        name="生活費帳戶",
        account_type="bank",
        nature="asset",
        currency="TWD",
        owner="me",
    )
    card = Account(
        name="國泰信用卡",
        account_type="credit_card",
        nature="liability",
        currency="TWD",
        owner="me",
    )
    db.add_all([payment, card])
    db.flush()
    create_balance_snapshot(db, payment, Decimal("1000"), date.today())
    create_balance_snapshot(db, card, Decimal("13797"), date.today())
    rule = EmailCardRule(
        name="國泰信用卡",
        owner="me",
        card_account_id=card.id,
        payment_account_id=payment.id,
        sender_pattern="cathaybk.com.tw",
        auto_pay=True,
        active=True,
    )
    db.add(rule)
    db.flush()
    bill = CreditCardBill(
        rule_id=rule.id,
        card_account_id=card.id,
        payment_account_id=payment.id,
        due_date=date.today(),
        amount_due=Decimal("13797"),
        currency="TWD",
        status="pending",
    )
    db.add(bill)
    db.commit()

    result = process_due_card_bills(db, date.today())

    assert result["paid"] == 0
    assert result["insufficient_funds"] == 1
    assert decimal_amount(get_latest_balance(db, payment.id)) == Decimal("1000")
    assert db.get(CreditCardBill, bill.id).status == "insufficient_funds"
    assert not db.scalars(select(Transaction).where(Transaction.source == "gmail_autopay")).all()
    db.close()


def test_due_bill_does_not_create_the_same_payment_twice() -> None:
    db = make_session()
    payment = Account(
        name="生活費帳戶",
        account_type="bank",
        nature="asset",
        currency="TWD",
        owner="me",
    )
    card = Account(
        name="國泰信用卡",
        account_type="credit_card",
        nature="liability",
        currency="TWD",
        owner="me",
    )
    db.add_all([payment, card])
    db.flush()
    create_balance_snapshot(db, payment, Decimal("50000"), date.today())
    create_balance_snapshot(db, card, Decimal("13797"), date.today())
    rule = EmailCardRule(
        name="國泰信用卡",
        owner="me",
        card_account_id=card.id,
        payment_account_id=payment.id,
        sender_pattern="cathaybk.com.tw",
        auto_pay=True,
        active=True,
    )
    db.add(rule)
    db.flush()
    bill = CreditCardBill(
        rule_id=rule.id,
        card_account_id=card.id,
        payment_account_id=payment.id,
        due_date=date.today(),
        amount_due=Decimal("13797"),
        currency="TWD",
        status="pending",
    )
    db.add(bill)
    db.commit()

    first = process_due_card_bills(db, date.today())
    bill.status = "pending"
    bill.transfer_link_id = None
    db.commit()
    second = process_due_card_bills(db, date.today())

    assert first["paid"] == 1
    assert second["paid"] == 0
    assert second["needs_review"] == 0
    assert db.get(CreditCardBill, bill.id).status == "paid"
    rows = db.scalars(
        select(Transaction).where(Transaction.source == "gmail_autopay")
    ).all()
    assert len(rows) == 2
    db.close()


def test_card_cycle_separates_current_bill_next_cycle_and_paid_history() -> None:
    db = make_session()
    payment = Account(
        name="生活費帳戶", account_type="bank", nature="asset", currency="TWD", owner="me"
    )
    card = Account(
        name="國泰信用卡",
        account_type="credit_card",
        nature="liability",
        currency="TWD",
        owner="me",
    )
    db.add_all([payment, card])
    db.flush()
    rule = EmailCardRule(
        name="國泰信用卡",
        owner="me",
        card_account_id=card.id,
        payment_account_id=payment.id,
        sender_pattern="cathaybk.com.tw",
        closing_day=2,
        payment_due_day=23,
        auto_pay=True,
        active=True,
    )
    db.add(rule)
    db.flush()
    paid_bill = CreditCardBill(
        rule_id=rule.id,
        card_account_id=card.id,
        payment_account_id=payment.id,
        statement_date=date(2026, 7, 2),
        due_date=date(2026, 7, 23),
        amount_due=Decimal("800"),
        currency="TWD",
        status="paid",
    )
    current_bill = CreditCardBill(
        rule_id=rule.id,
        card_account_id=card.id,
        payment_account_id=payment.id,
        statement_date=date(2026, 8, 2),
        due_date=date(2026, 8, 23),
        amount_due=Decimal("1000"),
        currency="TWD",
        status="pending",
    )
    db.add_all([paid_bill, current_bill])
    db.add_all(
        [
            Transaction(
                account_id=card.id,
                transaction_date=date(2026, 7, 15),
                description="已出帳消費",
                amount=Decimal("-300"),
                currency="TWD",
                fx_rate=Decimal("1"),
                base_amount=Decimal("-300"),
                transaction_kind="expense",
                fingerprint="cycle-old",
                source="gmail",
            ),
            Transaction(
                account_id=card.id,
                transaction_date=date(2026, 8, 10),
                description="下期消費",
                amount=Decimal("-200"),
                currency="TWD",
                fx_rate=Decimal("1"),
                base_amount=Decimal("-200"),
                transaction_kind="expense",
                fingerprint="cycle-next",
                source="gmail",
            ),
        ]
    )
    db.commit()

    balance = _refresh_current_gmail_card_balance(db, rule, date(2026, 8, 20))
    cycle = serialize_card_cycle(db, rule, date(2026, 8, 20))

    assert balance == Decimal("1200")
    assert cycle["current_bill"]["amount_due"] == 1000.0
    assert cycle["last_paid_bill"]["amount_due"] == 800.0
    assert cycle["unbilled"]["amount"] == 200.0
    assert cycle["next_cycle"]["amount"] == 200.0
    assert cycle["current_bill"]["period_start"] == date(2026, 7, 3)
    assert cycle["current_bill"]["period_end"] == date(2026, 8, 2)
    db.close()


def test_same_due_date_updates_unpaid_bill_instead_of_creating_duplicate() -> None:
    db = make_session()
    payment = Account(name="生活費", account_type="bank", nature="asset", currency="TWD")
    card = Account(
        name="信用卡", account_type="credit_card", nature="liability", currency="TWD"
    )
    db.add_all([payment, card])
    db.flush()
    rule = EmailCardRule(
        name="信用卡",
        owner="me",
        card_account_id=card.id,
        payment_account_id=payment.id,
        sender_pattern="bank.example",
        payment_due_day=23,
    )
    db.add(rule)
    db.flush()

    first = _create_or_update_bill(
        db,
        rule,
        {
            "statement_date": date(2026, 8, 2),
            "due_date": date(2026, 8, 23),
            "amount_due": Decimal("1000"),
        },
        "message-1",
    )
    second = _create_or_update_bill(
        db,
        rule,
        {
            "statement_date": date(2026, 8, 2),
            "due_date": date(2026, 8, 23),
            "amount_due": Decimal("1200"),
        },
        "message-2",
    )
    db.commit()

    bills = db.scalars(select(CreditCardBill)).all()
    assert first is True
    assert second is False
    assert len(bills) == 1
    assert Decimal(str(bills[0].amount_due)) == Decimal("1200")
    db.close()


def test_existing_duplicate_bills_are_merged_before_processing() -> None:
    db = make_session()
    payment = Account(name="生活費", account_type="bank", nature="asset", currency="TWD")
    card = Account(
        name="信用卡", account_type="credit_card", nature="liability", currency="TWD"
    )
    db.add_all([payment, card])
    db.flush()
    rule = EmailCardRule(
        name="信用卡",
        owner="me",
        card_account_id=card.id,
        payment_account_id=payment.id,
        sender_pattern="bank.example",
    )
    db.add(rule)
    db.flush()
    db.add_all(
        [
            CreditCardBill(
                rule_id=rule.id,
                card_account_id=card.id,
                payment_account_id=payment.id,
                due_date=date(2026, 8, 23),
                amount_due=Decimal("1000"),
                currency="TWD",
                status="paid",
            ),
            CreditCardBill(
                rule_id=rule.id,
                card_account_id=card.id,
                payment_account_id=payment.id,
                due_date=date(2026, 8, 23),
                amount_due=Decimal("1200"),
                currency="TWD",
                status="pending",
            ),
        ]
    )
    db.commit()

    result = repair_duplicate_card_bills(db)
    rows = db.scalars(select(CreditCardBill).order_by(CreditCardBill.id)).all()

    assert result == {"merged": 1}
    assert [item.status for item in rows] == ["paid", "duplicate"]
    db.close()


def test_gmail_rule_search_query_uses_sender_and_subject_filters() -> None:
    rule = SimpleNamespace(
        lookback_days=90,
        sender_pattern="cathaybk.com.tw",
        subject_pattern="信用卡",
    )

    assert _gmail_rule_search_query(rule) == (
        'newer_than:90d from:"cathaybk.com.tw" subject:"信用卡"'
    )


def test_gmail_rule_search_query_escapes_quotes_and_supports_one_filter() -> None:
    rule = SimpleNamespace(
        lookback_days=30,
        sender_pattern=None,
        subject_pattern='電子「帳單"通知',
    )

    assert _gmail_rule_search_query(rule) == (
        'newer_than:30d subject:"電子「帳單\\"通知"'
    )


def test_gmail_card_discovery_reads_metadata_only(monkeypatch: pytest.MonkeyPatch) -> None:
    db = make_session()
    requests: list[tuple[str, dict | None]] = []
    monkeypatch.setattr(email_sync_module, "_gmail_access_token", lambda _db: "token")

    def fake_get(_token: str, path: str, params: dict | None = None):
        requests.append((path, params))
        if path == "/messages":
            return {"messages": [{"id": "cathay-1"}]} if "cathaybk.com.tw" in str(params) else {}
        return {
            "internalDate": "1787760000000",
            "payload": {
                "headers": [
                    {"name": "From", "value": "Cathay <notice@cathaybk.com.tw>"},
                    {"name": "Subject", "value": "信用卡消費彙整通知"},
                    {"name": "Date", "value": "Thu, 27 Aug 2026 01:00:00 +0800"},
                ]
            },
        }

    monkeypatch.setattr(email_sync_module, "_gmail_get", fake_get)
    result = discover_gmail_card_candidates(db)

    assert result["metadata_only"] is True
    assert result["candidates"][0]["key"] == "cathay"
    assert result["candidates"][0]["sample_subject"] == "信用卡消費彙整通知"
    message_reads = [params for path, params in requests if path.startswith("/messages/")]
    assert message_reads
    assert all(params and params.get("format") == "metadata" for params in message_reads)
    db.close()


def decimal_amount(snapshot: BalanceSnapshot | None) -> Decimal:
    assert snapshot is not None
    return Decimal(str(snapshot.amount))


@pytest.mark.parametrize("subject", ["【國泰世華銀行】電子存摺", "電子 存摺通知", "电子存折"])
def test_deposit_passbook_is_not_card_mail(subject):
    rule = SimpleNamespace(sender_pattern="cathaybk.com.tw", subject_pattern=None, card_last4=None)
    assert not email_sync_module._rule_matches(rule, "service@cathaybk.com.tw", subject, None)
    assert email_sync_module._rule_matches(rule, "service@cathaybk.com.tw", "信用卡電子帳單", None)
    assert email_sync_module._rule_matches(rule, "service@cathaybk.com.tw", "消費彙整通知", None)


def test_old_passbook_errors_do_not_hide_real_card_password_issues():
    db = make_session()
    # More than 20 irrelevant failures must not crowd out actionable card mail.
    for index in range(25):
        db.add(EmailImportRecord(provider="gmail", provider_message_id=f"passbook-{index}",
            subject="【國泰世華銀行】電子存摺", status="error", error="PDF password required",
            updated_at=datetime(2026, 9, 9)))
    db.add(EmailImportRecord(provider="gmail", provider_message_id="real-card",
        subject="信用卡電子帳單", status="error", error="PDF password required",
        updated_at=datetime(2026, 9, 8)))
    db.commit()
    issues = email_sync_module.gmail_status(db)["issues"]
    assert len(issues) == 1
    assert issues[0]["subject"] == "信用卡電子帳單"
    assert issues[0]["action"] == "password"
    assert len(db.scalars(select(EmailImportRecord)).all()) == 26
    db.close()


def test_sync_skips_passbook_before_reading_pdf(monkeypatch):
    db = make_session()
    payment = Account(name="測試銀行", account_type="bank", nature="asset", currency="TWD", owner="me")
    card = Account(name="測試卡", account_type="credit_card", nature="liability", currency="TWD", owner="me")
    db.add_all([payment, card])
    db.flush()
    db.add(EmailCardRule(name="測試", card_account_id=card.id, payment_account_id=payment.id, sender_pattern="cathaybk.com.tw", active=True, lookback_days=90))
    db.commit()
    monkeypatch.setattr(email_sync_module, "_gmail_access_token", lambda _: "test")
    def fake_get(token, path, params=None):
        if path == "/messages":
            return {"messages": [{"id": "passbook"}]}
        assert path == "/messages/passbook"
        return {"internalDate": str(int(datetime.now().timestamp() * 1000)), "payload": {"headers": [
            {"name": "From", "value": "service@cathaybk.com.tw"},
            {"name": "Subject", "value": "【國泰世華銀行】電子存摺"}]}}
    monkeypatch.setattr(email_sync_module, "_gmail_get", fake_get)
    def forbidden(*args, **kwargs):
        pytest.fail("Passbook PDF must not be downloaded or decrypted")
    monkeypatch.setattr(email_sync_module, "_message_content", forbidden)
    result = sync_gmail(db)
    assert result["errors"] == []
    assert result["transactions_imported"] == 0
    assert result["ignored"] == 1
    assert not db.scalars(select(EmailImportRecord)).all()
    assert not db.scalars(select(Transaction)).all()
    db.close()


@pytest.mark.parametrize("as_of,start,end,amount", [
    (date(2026, 9, 22), date(2026, 8, 24), date(2026, 9, 23), 100.0),
    (date(2026, 9, 23), date(2026, 8, 24), date(2026, 9, 23), 300.0),
    (date(2026, 9, 24), date(2026, 9, 24), date(2026, 10, 23), 400.0),
    (date(2026, 10, 1), date(2026, 9, 24), date(2026, 10, 23), 400.0),
])
def test_current_cycle_switches_after_closing_day(as_of, start, end, amount):
    db = make_session()
    payment = Account(name="Bank", account_type="bank", nature="asset", currency="TWD")
    card = Account(name="Card", account_type="credit_card", nature="liability", currency="TWD")
    db.add_all([payment, card])
    db.flush()
    rule = EmailCardRule(name="Card", card_account_id=card.id, payment_account_id=payment.id,
                         closing_day=23, payment_due_day=23, active=True)
    db.add(rule)
    db.flush()
    bill = CreditCardBill(rule_id=rule.id, card_account_id=card.id, payment_account_id=payment.id,
                          statement_date=date(2026, 8, 23), due_date=date(2026, 9, 23),
                          amount_due=Decimal("900"), currency="TWD", status="pending")
    db.add(bill)
    for day, value in [(22, 100), (23, 200), (24, 400)]:
        db.add(Transaction(account_id=card.id, transaction_date=date(2026, 9, day),
                           description="Purchase", amount=Decimal(-value), currency="TWD",
                           fx_rate=Decimal("1"), base_amount=Decimal(-value),
                           transaction_kind="expense", fingerprint=f"boundary-{day}", source="gmail"))
    db.commit()
    result = serialize_card_cycle(db, rule, as_of)
    assert result["current_cycle"] == {"amount": amount, "period_start": start,
                                       "period_end": end, "transaction_count": 2 if amount == 300 else 1}
    assert result["current_bill"]["amount_due"] == 900.0
    assert bill.status == "pending"
    db.close()
