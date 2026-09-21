from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import main as main_module


def configure_hosted_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main_module, "FINANCE_REQUIRE_AUTH", True)
    monkeypatch.setattr(main_module, "IS_RENDER_DEPLOYMENT", False)
    monkeypatch.setattr(main_module, "FINANCE_APP_PASSWORD", "test-password")
    monkeypatch.setattr(main_module, "FINANCE_AUTH_SECRET_CONFIGURED", "test-signing-secret")
    monkeypatch.setattr(main_module, "FINANCE_AUTH_SECRET", "test-signing-secret")


def test_hosted_runtime_requires_password_and_separate_signing_secret(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(main_module, "FINANCE_REQUIRE_AUTH", True)
    monkeypatch.setattr(main_module, "IS_RENDER_DEPLOYMENT", False)
    monkeypatch.setattr(main_module, "FINANCE_APP_PASSWORD", "")
    monkeypatch.setattr(main_module, "FINANCE_AUTH_SECRET_CONFIGURED", "")

    with pytest.raises(RuntimeError, match="FINANCE_APP_PASSWORD, FINANCE_AUTH_SECRET"):
        main_module.validate_runtime_config()
    with pytest.raises(RuntimeError, match="FINANCE_APP_PASSWORD, FINANCE_AUTH_SECRET"):
        with TestClient(main_module.app):
            pass

    monkeypatch.setattr(main_module, "FINANCE_APP_PASSWORD", "configured-password")
    with pytest.raises(RuntimeError, match="FINANCE_AUTH_SECRET"):
        main_module.validate_runtime_config()


def test_hosted_api_is_fail_closed_and_reports_session_expiry(
    monkeypatch: pytest.MonkeyPatch,
):
    configure_hosted_auth(monkeypatch)
    client = TestClient(main_module.app)

    assert main_module.PUBLIC_API_PATHS == {
        "/api/health",
        "/api/auth/login",
        "/api/auth/status",
        "/api/automation/sync",
        "/api/email/gmail/callback",
    }

    assert client.get("/api/health").status_code == 200
    anonymous_status = client.get("/api/auth/status")
    assert anonymous_status.status_code == 200
    assert anonymous_status.json() == {
        "required": True,
        "authenticated": False,
        "session_expires_at": None,
        "data_location": "cloud",
    }
    assert client.get("/api/not-a-public-route").status_code == 401

    assert client.post("/api/auth/login", json={"password": "wrong"}).status_code == 401
    login = client.post("/api/auth/login", json={"password": "test-password"})
    assert login.status_code == 200
    assert login.json()["session_expires_at"]

    token = login.json()["token"]
    authenticated_status = client.get(
        "/api/auth/status",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert authenticated_status.status_code == 200
    assert authenticated_status.json()["authenticated"] is True
    assert authenticated_status.json()["session_expires_at"] == login.json()["session_expires_at"]


def test_missing_hosted_auth_config_never_opens_private_api(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(main_module, "FINANCE_REQUIRE_AUTH", True)
    monkeypatch.setattr(main_module, "IS_RENDER_DEPLOYMENT", False)
    monkeypatch.setattr(main_module, "FINANCE_APP_PASSWORD", "")
    monkeypatch.setattr(main_module, "FINANCE_AUTH_SECRET_CONFIGURED", "")
    monkeypatch.setattr(main_module, "FINANCE_AUTH_SECRET", "")
    client = TestClient(main_module.app)

    response = client.get("/api/not-a-public-route")
    assert response.status_code == 503
    assert response.json() == {"detail": "伺服器登入保護尚未完成設定"}


def test_local_mode_remains_available_without_login(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(main_module, "FINANCE_REQUIRE_AUTH", False)
    monkeypatch.setattr(main_module, "IS_RENDER_DEPLOYMENT", False)
    monkeypatch.setattr(main_module, "FINANCE_APP_PASSWORD", "")
    monkeypatch.setattr(main_module, "FINANCE_AUTH_SECRET_CONFIGURED", "")
    monkeypatch.setattr(main_module, "FINANCE_AUTH_SECRET", "")
    client = TestClient(main_module.app)

    status = client.get("/api/auth/status")
    assert status.status_code == 200
    assert status.json() == {
        "required": False,
        "authenticated": True,
        "session_expires_at": None,
        "data_location": "local",
    }
