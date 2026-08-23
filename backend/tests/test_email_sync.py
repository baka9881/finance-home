from datetime import date
from decimal import Decimal
from types import SimpleNamespace

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.database import (
    Account,
    AppSetting,
    BalanceSnapshot,
    Base,
    CreditCardBill,
    EmailCardRule,
    Transaction,
)
from app.email_sync import (
    _create_card_transaction,
    _refresh_current_gmail_card_balance,
    _gmail_rule_search_query,
    _plain_html,
    parse_card_email,
    process_due_card_bills,
)
from app.services import (
    create_balance_snapshot,
    get_latest_balance,
    import_csv,
    repair_cross_source_card_duplicates,
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
    assert latest.source == "gmail_current_month"
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
