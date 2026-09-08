from datetime import date, timedelta
import json
from decimal import Decimal

from sqlalchemy import select

from test_api import client, create_account
from app.database import Account, EmailCardRule, Transaction, get_db
from app.main import app
from app.email_sync import gmail_status, sync_gmail


def import_sample(client, account_id, amount=-100, description="匯入商店"):
    content = f"date,description,amount\n{date.today().isoformat()},{description},{amount}\n".encode()
    response = client.post("/api/transactions/import", files={"file": ("sample.csv", content, "text/csv")},
        data={"account_id": account_id, "mapping_json": json.dumps({"date": "date", "description": "description", "amount": "amount"}), "commit": "true", "adjust_balance": "true"})
    assert response.status_code == 200, response.text
    return response.json()


def correct(client, row_id, **payload):
    preview = client.post(f"/api/transactions/{row_id}/correction/preview", json=payload)
    assert preview.status_code == 200, preview.text
    response = client.post(f"/api/transactions/{row_id}/correction", json={**payload, "token": preview.json()["token"]})
    assert response.status_code == 200, response.text
    return response.json()


def test_import_correction_exclusion_restore_and_dedup(client):
    account = create_account(client, "更正測試")
    import_sample(client, account)
    row = client.get("/api/transactions").json()[0]
    edited = correct(client, row["id"], action="edit", amount=-60, description="正確商店")
    assert edited["balance_before"] == 99900 and edited["balance_after"] == 99940
    assert client.get("/api/dashboard").json()["month_expense"] == 60
    assert import_sample(client, account)["duplicates"] == 1
    excluded = correct(client, row["id"], action="exclude")
    assert excluded["balance_after"] == 100000
    assert client.get("/api/transactions/page").json()["total"] == 0
    assert client.get("/api/dashboard").json()["month_expense"] == 0
    assert client.get("/api/transactions/page?excluded=true").json()["items"][0]["description"] == "正確商店"
    assert import_sample(client, account)["imported"] == 0
    assert client.get("/api/transactions/import-balance/pending").json() == []
    restored = correct(client, row["id"], action="restore")
    assert restored["balance_after"] == 99940
    assert client.get("/api/transactions/page").json()["total"] == 1
    history = client.get(f"/api/transactions/{row['id']}/history").json()
    assert len(history) == 3 and history[-1]["before"]["description"] == "匯入商店"
    assert client.get("/api/transactions").json()[0]["source"] == "csv"


def test_uncategorized_totals_and_correction_history_survive_backup(client):
    account = create_account(client, "分類合計")
    import_sample(client, account, -123, "尚未分類項目")
    row = client.get("/api/transactions").json()[0]
    with next(app.dependency_overrides[get_db]()) as db:
        db.get(Transaction, row["id"]).category_id = None
        db.commit()
    dashboard = client.get("/api/dashboard").json()
    assert dashboard["month_expense"] == 123
    assert sum(item["value"] for item in dashboard["category_expenses"]) == 123
    assert dashboard["category_expenses"][0]["name"] == "未分類"
    correct(client, row["id"], action="edit", amount=-100, description="修正名稱")
    backup = client.get("/api/backup/export")
    assert backup.status_code == 200
    restored = client.post("/api/backup/restore", files={"file": ("backup.json", backup.content, "application/json")})
    assert restored.status_code == 200, restored.text
    assert len(client.get(f"/api/transactions/{row['id']}/history").json()) == 1
    assert import_sample(client, account, -123, "尚未分類項目")["duplicates"] == 1
    correct(client, row["id"], action="restore")
    assert client.get("/api/dashboard").json()["month_expense"] == 123


def test_schema_upgrade_is_idempotent_and_preserves_old_rows(monkeypatch):
    from sqlalchemy import create_engine, text, inspect
    import app.main as main
    old_engine = create_engine("sqlite://")
    tables = ["transactions", "accounts", "goals", "valuation_snapshots", "email_card_rules", "credit_card_bills", "recurring_expenses"]
    with old_engine.begin() as conn:
        for table in tables:
            conn.execute(text(f"CREATE TABLE {table} (id INTEGER PRIMARY KEY)"))
            conn.execute(text(f"INSERT INTO {table} (id) VALUES (1)"))
    monkeypatch.setattr(main, "engine", old_engine)
    main.ensure_schema()
    main.ensure_schema()
    with old_engine.connect() as conn:
        assert conn.execute(text("SELECT excluded, revision FROM transactions WHERE id=1")).one() == (0, 0)
        assert "match_name" in {column["name"] for column in inspect(conn).get_columns("recurring_expenses")}
    old_engine.dispose()


def test_correction_preview_rejects_stale_balance_and_preserves_new_manual_balance(client):
    account = create_account(client, "人工對帳")
    import_sample(client, account)
    row = client.get("/api/transactions").json()[0]
    payload = {"action": "exclude"}
    preview = client.post(f"/api/transactions/{row['id']}/correction/preview", json=payload).json()
    assert client.post(f"/api/accounts/{account}/balance", json={"amount": 5000, "snapshot_date": date.today().isoformat()}).status_code == 201
    stale = client.post(f"/api/transactions/{row['id']}/correction", json={**payload, "token": preview["token"]})
    assert stale.status_code == 409
    assert client.get("/api/transactions").json()[0]["excluded"] is False
    saved = correct(client, row["id"], **payload)
    assert saved["balance_before"] == saved["balance_after"] == 5000
    assert correct(client, row["id"], action="restore")["balance_after"] == 5000


def test_gmail_correction_keeps_official_bill_and_cross_source_identity(client):
    from app.database import CreditCardBill
    from app.email_sync import _create_card_transaction, _refresh_current_gmail_card_balance
    from app.services import find_linked_gmail_transaction_for_csv
    payment = create_account(client, "付款")
    card = create_account(client, "帳期卡", "liability")
    rule_id = client.post("/api/email/card-rules", json={"name": "帳期卡", "card_account_id": card, "payment_account_id": payment, "sender_pattern": "example.test"}).json()["id"]
    with next(app.dependency_overrides[get_db]()) as db:
        rule = db.get(EmailCardRule, rule_id)
        db.add(CreditCardBill(rule_id=rule_id, card_account_id=card, payment_account_id=payment,
            statement_date=date.today() - timedelta(days=1), due_date=date.today() + timedelta(days=10), amount_due=1000, status="pending", currency="TWD"))
        assert _create_card_transaction(db, rule, {"date": date.today(), "amount": -100, "description": "郵件商店"}, "test-message")
        _refresh_current_gmail_card_balance(db, rule)
        db.commit()
    row = client.get("/api/transactions").json()[0]
    assert correct(client, row["id"], action="edit", amount=-60, description="更正商店")["balance_after"] == 1060
    assert correct(client, row["id"], action="exclude")["balance_after"] == 1000
    with next(app.dependency_overrides[get_db]()) as db:
        rule = db.get(EmailCardRule, rule_id)
        assert not _create_card_transaction(db, rule, {"date": date.today(), "amount": -100, "description": "郵件商店"}, "new-message-same-purchase")
        match = find_linked_gmail_transaction_for_csv(db, payment, date.today(), Decimal("-100"), "TWD", "郵件商店")
        assert match.id == row["id"] and match.excluded
        assert db.scalar(select(CreditCardBill)).amount_due == 1000
        assert _refresh_current_gmail_card_balance(db, rule) == 1000
        db.commit()


def test_batch_classification_is_explicit_atomic_and_reversible(client):
    account = create_account(client, "批次")
    import_sample(client, account, -10, "甲")
    import_sample(client, account, -20, "乙")
    rows = client.get("/api/transactions").json()
    food = next(item["id"] for item in client.get("/api/categories").json() if item["name"] == "餐飲")
    payload = {"ids": [row["id"] for row in rows], "category_id": food}
    result = client.post("/api/transactions/classify-batch", json=payload)
    assert result.status_code == 200 and result.json()["updated"] == 2
    assert all(row["category_name"] == "餐飲" for row in client.get("/api/transactions").json())
    assert client.post("/api/transactions/classify-batch/undo", json={"items": result.json()["undo"]}).status_code == 200
    assert all(row["category_name"] == "未分類" for row in client.get("/api/transactions").json())
    assert client.post("/api/transactions/classify-batch", json={"ids": [rows[0]["id"], 99999], "category_id": food}).status_code == 422
    assert all(row["category_name"] == "未分類" for row in client.get("/api/transactions").json())


def test_confirmed_recurring_name_survives_gaps_and_disable_restore(client):
    from app.services import calculate_spending_analysis
    account = create_account(client, "健身卡", "liability")
    payload = {"name": "健身房", "match_name": "休閒用品", "account_id": account, "owner": "me", "amount": 1088, "due_day": 15}
    created = client.post("/api/recurring-expenses", json=payload)
    assert created.status_code == 201, created.text
    key = created.json()["id"]
    duplicate = client.post("/api/recurring-expenses", json={**payload, "name": "我的健身房"})
    assert duplicate.json()["id"] == key
    with next(app.dependency_overrides[get_db]()) as db:
        # Even well beyond the automatic detection window, confirmation persists.
        rows = calculate_spending_analysis(db, "2027-05", "me")["recurring_expenses"]
        assert len(rows) == 1 and rows[0]["name"] == "我的健身房" and rows[0]["confirmed"]
    client.delete(f"/api/recurring-expenses/{key}")
    assert client.get("/api/recurring-expenses").json() == []
    assert client.get("/api/recurring-expenses?include_inactive=true").json()[0]["active"] is False
    assert client.patch(f"/api/recurring-expenses/{key}", json={"active": True}).status_code == 200
    assert len(client.get("/api/recurring-expenses").json()) == 1
    assert client.get("/api/transactions").json() == []


def test_archive_preserves_history_and_pauses_automation_until_restore(client):
    payment_id = create_account(client, "生活費")
    card_id = create_account(client, "信用卡", "liability")
    rule_response = client.post("/api/email/card-rules", json={
        "name": "國泰信用卡", "card_account_id": card_id, "payment_account_id": payment_id,
        "sender_pattern": "cathaybk.com.tw", "auto_pay": True,
    })
    assert rule_response.status_code == 201, rule_response.text
    assert client.post(f"/api/accounts/{card_id}/archive").status_code == 200
    archived = next(row for row in client.get("/api/accounts?include_archived=true").json() if row["id"] == card_id)
    assert archived["archived"] and archived["linked_email_rules"] == ["國泰信用卡"]
    assert all(row["id"] != card_id for row in client.get("/api/accounts").json())
    rules = client.get("/api/email/card-rules").json()
    assert rules[0]["paused_reason"]
    generator = app.dependency_overrides[get_db]()
    with next(generator) as db:
        assert gmail_status(db)["active_rules"] == 0
        assert gmail_status(db)["paused_rules"] == 1
        # No access token/network request is needed when all rules are paused.
        assert sync_gmail(db)["messages_scanned"] == 0
    assert client.post("/api/transactions", json={"account_id": card_id, "transaction_date": date.today().isoformat(), "description": "已封存", "amount": -5}).status_code == 422
    assert client.post(f"/api/accounts/{card_id}/restore").status_code == 200
    assert client.get("/api/dashboard").json()["liabilities"] == 12000
    assert client.get("/api/email/card-rules").json()[0]["paused_reason"] is None


def test_pagination_and_search_cover_more_than_two_hundred_transactions(client):
    account_id = create_account(client, "大量明細")
    generator = app.dependency_overrides[get_db]()
    with next(generator) as db:
        for index in range(237):
            db.add(Transaction(account_id=account_id, transaction_date=date.today(),
                description=f"商店{index:03d}", amount=-10, base_amount=-10, currency="TWD",
                fingerprint=f"ux-pagination-{index}", source="gmail", transaction_kind="expense"))
        db.commit()
    first = client.get("/api/transactions/page").json()
    assert first["total"] == 237 and len(first["items"]) == 50
    last = client.get("/api/transactions/page?page=5").json()
    assert last["total"] == 237 and len(last["items"]) == 37
    search = client.get("/api/transactions/page?search=商店000").json()
    assert search["total"] == 1 and search["items"][0]["description"] == "商店000"
    assert client.get("/api/transactions/page?search=不存在").json()["total"] == 0
    assert client.get("/api/transactions/page?search=%25").json()["total"] == 0
    assert client.get("/api/transactions/page?month=2026-13").status_code == 422
    # Historical filters include archived accounts too.
    client.post(f"/api/accounts/{account_id}/archive")
    assert client.get(f"/api/transactions/page?account_id={account_id}").json()["total"] == 237


def test_reclassification_only_touches_requested_month_account_and_search(client):
    account_id = create_account(client, "範圍測試")
    other_id = create_account(client, "其他帳戶")
    subscription = next(row["id"] for row in client.get("/api/categories").json() if row["name"] == "訂閱")
    rule = client.post("/api/rules", json={"keyword": "OPENAI *CHATGPT", "category_id": subscription, "transaction_kind": "expense"})
    assert rule.status_code in (200, 201), rule.text
    with next(app.dependency_overrides[get_db]()) as db:
        for index, (account, day, description, kind) in enumerate([
            (account_id, date(2026, 8, 1), "OPENAI *CHATGPT", "expense"),
            (account_id, date(2026, 7, 1), "OPENAI *CHATGPT", "expense"),
            (other_id, date(2026, 8, 1), "OPENAI *CHATGPT", "expense"),
            (account_id, date(2026, 8, 1), "投資記錄", "investment"),
        ]):
            db.add(Transaction(account_id=account, transaction_date=day, description=description,
                amount=-100, base_amount=-100, currency="TWD", source="gmail",
                transaction_kind=kind, fingerprint=f"scope-{index}"))
        db.commit()
    response = client.post(f"/api/transactions/reclassify?month=2026-08&account_id={account_id}&search=OPENAI")
    assert response.status_code == 200, response.text
    rows = client.get("/api/transactions").json()
    selected = [row for row in rows if row["account_id"] == account_id and row["transaction_date"] == "2026-08-01" and row["transaction_kind"] == "expense"]
    assert selected[0]["category_name"] == "訂閱"
    assert all(row["category_name"] == "未分類" for row in rows if row["id"] != selected[0]["id"])
    assert client.get("/api/transactions/page?month=2026-08").json()["unclassified_count"] == 1


def test_category_learning_is_explicit_account_scoped_and_future_only(client):
    account_id = create_account(client, "我的卡", "liability")
    other_id = create_account(client, "另一張卡", "liability")
    categories = client.get("/api/categories").json()
    food = next(row["id"] for row in categories if row["name"] == "餐飲")
    salary = next(row["id"] for row in categories if row["name"] == "薪資")
    def add(account, day):
        response = client.post("/api/transactions", json={"account_id": account,
            "transaction_date": (date.today() - timedelta(days=day)).isoformat(),
            "description": "尚未辨識商家", "amount": -50})
        assert response.status_code == 201, response.text
        return response.json()["id"]
    first, earlier, other = add(account_id, 1), add(account_id, 2), add(other_id, 1)
    assert client.patch(f"/api/transactions/{first}", json={"category_id": salary}).status_code == 422
    assert client.patch(f"/api/transactions/{first}", json={"category_id": food}).status_code == 200
    assert not any(row["keyword"] == "尚未辨識商家" for row in client.get("/api/rules").json())
    assert client.patch(f"/api/transactions/{first}", json={"category_id": food, "create_rule": True}).status_code == 200
    rows = {row["id"]: row for row in client.get("/api/transactions").json()}
    assert rows[earlier]["category_name"] == "未分類"
    assert rows[other]["category_name"] == "未分類"
    future, other_future = add(account_id, 0), add(other_id, 0)
    rows = {row["id"]: row for row in client.get("/api/transactions").json()}
    assert rows[future]["category_name"] == "餐飲"
    assert rows[other_future]["category_name"] == "未分類"
    learned = next(row for row in client.get("/api/rules").json() if row["id"] < 0)
    assert learned["account_name"] == "我的卡"
    assert client.delete(f"/api/rules/{learned['id']}").status_code == 200
