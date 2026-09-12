"""Local UX sandbox. In-memory data only; no bank, Gmail, or market network requests.

Run from backend: .venv\Scripts\python.exe tests/serve_ux_demo.py
"""
import os
import sys
from pathlib import Path
from datetime import date, timedelta
from decimal import Decimal

os.environ["FINANCE_DB_URL"] = "sqlite://"
os.environ["APP_MODE"] = "personal"
os.environ["FINANCE_APP_PASSWORD"] = ""
os.environ["FINANCE_AUTOMATION_TOKEN"] = ""
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from app import main
from app.database import Base, Account, Transaction, EmailCardRule, RecurringExpense, Category, FxRate, Position, PriceSnapshot, get_db
from app.services import seed_defaults, create_balance_snapshot, transaction_fingerprint

qa_engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
sessions = sessionmaker(bind=qa_engine, expire_on_commit=False)
Base.metadata.create_all(qa_engine)
with sessions() as db:
    seed_defaults(db)
    bank = Account(name="測試生活費帳戶", account_type="bank", nature="asset", currency="TWD", owner="me", is_liquid=True)
    card = Account(name="測試信用卡", account_type="credit_card", nature="liability", currency="TWD", owner="me")
    crypto = Account(name="測試幣安帳戶", institution="Binance", account_type="crypto", nature="asset", currency="TWD", owner="me", balance_includes_positions=True)
    archived = Account(name="測試已封存信用卡", account_type="credit_card", nature="liability", currency="TWD", owner="me", archived=True)
    db.add_all([bank, card, crypto, archived]); db.flush()
    create_balance_snapshot(db, bank, 80000, date.today() - timedelta(days=35))
    create_balance_snapshot(db, card, 3000, date.today(), source="gmail_billing_cycle")
    create_balance_snapshot(db, archived, 1000, date.today())
    create_balance_snapshot(db, crypto, 12500, date.today(), source="binance_sync")
    btc_contract = Position(account_id=crypto.id, market="BINANCE_FUTURES", symbol="BTCUSDT", name="BTC 永續合約", quantity=Decimal("0.02"), average_cost=Decimal("55000"), currency="USD")
    db.add(btc_contract)
    db.add(PriceSnapshot(market="BINANCE_FUTURES", symbol="BTCUSDT", price_date=date.today(), price=Decimal("60000"), currency="USD", source="Binance Futures"))
    db.add(FxRate(currency="USD", rate_date=date.today(), rate_to_twd=Decimal("32"), source="QA", manual=True))
    db.add(EmailCardRule(name="測試信用卡郵件", card_account_id=card.id, payment_account_id=bank.id, sender_pattern="bank.example.test", owner="me", payment_due_day=23, closing_day=5))
    db.add(EmailCardRule(name="測試封存暫停規則", card_account_id=archived.id, payment_account_id=bank.id, sender_pattern="bank.example.test", owner="me", payment_due_day=23))
    for index in range(237):
        day = date.today() - timedelta(days=index % 25)
        desc = "OPENAI *CHATGPT SUBSCRIPTION 超長訂閱名稱測試" if index == 0 else f"測試商店 {index:03d}"
        db.add(Transaction(account_id=card.id, transaction_date=day, description=desc, amount=-100, base_amount=-100,
            currency="TWD", transaction_kind="expense", source="gmail", fingerprint=transaction_fingerprint(card.id, day, Decimal("-100"), desc)))
    db.add(RecurringExpense(name="健身房", match_name="休閒用品", amount=1088, due_day=15, account_id=card.id, owner="me"))
    db.add(RecurringExpense(name="OPENAI *CHATGPT SUBSCRIPTION 超長訂閱名称測試", match_name="OPENAI *CHATGPT SUBSCRIPTION 超長訂閱名稱測試", amount=539, account_id=card.id, owner="me"))
    db.commit()

def qa_db():
    with sessions() as db:
        yield db
main.app.dependency_overrides[get_db] = qa_db
main.refresh_market_prices = lambda *args, **kwargs: {"updated": 0, "skipped": 0, "errors": [], "details": []}
main.refresh_fx_rates = lambda *args, **kwargs: {"saved": 0}
def qa_sync(*args, **kwargs):
    import time
    time.sleep(2)
    return {"messages_scanned": 1, "transactions_recognized": 0, "transactions_imported": 0, "bills_created": 0, "payments_recorded": 0, "errors": ["測試：帳單需要密碼"]}
main.sync_gmail = qa_sync
main.gmail_status = lambda db: {"configured": True, "connected": True, "email": "demo@example.test", "reconnect_required": False,
    "active_rules": 1, "paused_rules": 1, "last_sync_at": None, "latest_transaction_date": str(date.today()),
    "issues": [{"id": 1, "rule_id": 1, "subject": "測試電子帳單", "reason": "帳單需要密碼才能讀取", "action": "password"}], "pending_bills": 0}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(main.app, host="127.0.0.1", port=8077)
