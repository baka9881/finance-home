from __future__ import annotations

import io
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app import main as main_module
from app.database import Base, get_db
from app.main import app
from app.services import seed_defaults


@pytest.fixture()
def client():
    test_engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSession = sessionmaker(bind=test_engine, expire_on_commit=False)
    Base.metadata.create_all(test_engine)
    with TestingSession() as db:
        seed_defaults(db)

    def override_db():
        db = TestingSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
    Base.metadata.drop_all(test_engine)


def create_account(client: TestClient, name: str, nature: str = "asset") -> int:
    response = client.post(
        "/api/accounts",
        json={
            "name": name,
            "account_type": "bank" if nature == "asset" else "credit_card",
            "nature": nature,
            "currency": "TWD",
            "is_liquid": nature == "asset",
            "opening_balance": 100000 if nature == "asset" else 12000,
            "opening_date": date.today().isoformat(),
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def test_cloud_password_protects_financial_api(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(main_module, "FINANCE_APP_PASSWORD", "test-password")
    monkeypatch.setattr(main_module, "FINANCE_AUTH_SECRET", "test-secret")

    assert client.get("/api/health").status_code == 200
    assert client.get("/api/dashboard").status_code == 401
    assert client.post("/api/auth/login", json={"password": "wrong"}).status_code == 401

    login = client.post("/api/auth/login", json={"password": "test-password"})
    assert login.status_code == 200
    token = login.json()["token"]
    authorized = client.get("/api/dashboard", headers={"Authorization": f"Bearer {token}"})
    assert authorized.status_code == 200


def test_account_balance_and_dashboard(client: TestClient):
    create_account(client, "薪轉帳戶")
    create_account(client, "信用卡", "liability")

    dashboard = client.get("/api/dashboard")
    assert dashboard.status_code == 200
    payload = dashboard.json()
    assert payload["assets"] == 100000
    assert payload["liabilities"] == 12000
    assert payload["net_worth"] == 88000


def test_transfer_does_not_pollute_cashflow(client: TestClient):
    source = create_account(client, "來源帳戶")
    target = create_account(client, "目標帳戶")
    today = date.today().isoformat()
    outgoing = client.post(
        "/api/transactions",
        json={
            "account_id": source,
            "transaction_date": today,
            "description": "轉至投資帳戶",
            "amount": -5000,
            "transaction_kind": "expense",
        },
    ).json()["id"]
    incoming = client.post(
        "/api/transactions",
        json={
            "account_id": target,
            "transaction_date": today,
            "description": "銀行轉入",
            "amount": 5000,
            "transaction_kind": "income",
        },
    ).json()["id"]

    response = client.post(
        "/api/transfers",
        json={"from_transaction_id": outgoing, "to_transaction_id": incoming},
    )
    assert response.status_code == 200
    dashboard = client.get("/api/dashboard").json()
    assert dashboard["month_income"] == 0
    assert dashboard["month_expense"] == 0


def test_csv_import_big5_and_duplicate_detection(client: TestClient):
    account_id = create_account(client, "CSV 帳戶")
    csv_text = "日期,摘要,支出,收入,餘額\n115/07/01,早餐,80,,99920\n115/07/02,薪資,,30000,129920\n"
    content = csv_text.encode("big5")
    mapping = {
        "date": "日期",
        "description": "摘要",
        "debit": "支出",
        "credit": "收入",
        "balance": "餘額",
    }

    files = {"file": ("transactions.csv", io.BytesIO(content), "text/csv")}
    data = {"account_id": str(account_id), "mapping_json": __import__("json").dumps(mapping), "commit": "true"}
    first = client.post("/api/transactions/import", files=files, data=data)
    assert first.status_code == 200, first.text
    assert first.json()["imported"] == 2

    files = {"file": ("transactions.csv", io.BytesIO(content), "text/csv")}
    second = client.post("/api/transactions/import", files=files, data=data)
    assert second.status_code == 200
    assert second.json()["duplicates"] == 2
    assert second.json()["imported"] == 0

    rows = client.get("/api/transactions").json()
    assert len(rows) == 2
    assert sorted(item["base_amount"] for item in rows) == [-80, 30000]


def test_budget_goal_and_health_score(client: TestClient):
    account = create_account(client, "生活帳戶")
    categories = client.get("/api/categories").json()
    salary = next(item for item in categories if item["name"] == "薪資")
    food = next(item for item in categories if item["name"] == "餐飲")
    today = date.today()
    for offset in (0, 30, 60):
        tx_date = (today - timedelta(days=offset)).isoformat()
        client.post(
            "/api/transactions",
            json={
                "account_id": account,
                "transaction_date": tx_date,
                "description": f"薪資 {offset}",
                "amount": 40000,
                "transaction_kind": "income",
                "category_id": salary["id"],
            },
        )
        client.post(
            "/api/transactions",
            json={
                "account_id": account,
                "transaction_date": tx_date,
                "description": f"餐費 {offset}",
                "amount": -10000,
                "transaction_kind": "expense",
                "category_id": food["id"],
            },
        )

    budget = client.post(
        "/api/budgets",
        json={
            "month": today.strftime("%Y-%m"),
            "category_id": food["id"],
            "amount": 15000,
        },
    )
    assert budget.status_code == 200
    goal = client.post(
        "/api/goals",
        json={"name": "旅遊", "target_amount": 50000, "current_amount": 10000},
    )
    assert goal.status_code == 201

    health = client.get("/api/analysis/health")
    assert health.status_code == 200
    payload = health.json()
    assert payload["completeness"] >= 3
    assert payload["score"] is not None
