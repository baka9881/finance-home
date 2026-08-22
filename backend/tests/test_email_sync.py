from datetime import date
from decimal import Decimal
from types import SimpleNamespace

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.database import (
    Account,
    BalanceSnapshot,
    Base,
    CreditCardBill,
    EmailCardRule,
    Transaction,
)
from app.email_sync import (
    _gmail_rule_search_query,
    parse_card_email,
    process_due_card_bills,
)
from app.services import create_balance_snapshot, get_latest_balance, seed_defaults


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
    assert second["needs_review"] == 1
    rows = db.scalars(
        select(Transaction).where(Transaction.source == "gmail_autopay")
    ).all()
    assert len(rows) == 2
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


def decimal_amount(snapshot: BalanceSnapshot | None) -> Decimal:
    assert snapshot is not None
    return Decimal(str(snapshot.amount))
