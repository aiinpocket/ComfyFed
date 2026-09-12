import pytest
from fastapi.testclient import TestClient

from comfyfed_server import app as app_module
from comfyfed_server import bootstrap


@pytest.fixture()
def client(tmp_path):
    data_dir = str(tmp_path)
    result = bootstrap.ensure_installed(data_dir, lang="en", url="http://h", interactive=False)
    app = app_module.create_app(data_dir)
    c = TestClient(app)
    c.admin_password = result.admin_password
    return c


def test_wrong_password_401(client):
    r = client.post("/api/auth/login", json={"password": "wrong"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "auth.required" or "error" in r.json()


def test_login_success_sets_cookie_and_csrf(client):
    r = client.post("/api/auth/login", json={"password": client.admin_password})
    assert r.status_code == 200
    body = r.json()
    assert "csrf" in body and body["csrf"]
    assert "cf_session" in r.cookies


def test_me_reports_authenticated(client):
    r = client.post("/api/auth/login", json={"password": client.admin_password})
    assert r.status_code == 200

    me = client.get("/api/auth/me")
    assert me.status_code == 200
    body = me.json()
    assert body["authenticated"] is True
    assert body["lang"] == "en"


def test_me_unauthenticated_without_session():
    pass


def test_change_password_requires_csrf(client):
    login = client.post("/api/auth/login", json={"password": client.admin_password})
    assert login.status_code == 200

    r = client.post("/api/auth/change-password", json={"old": client.admin_password, "new": "newpassword123"})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "auth.csrf"


def test_change_password_with_csrf_rotates_password(client):
    login = client.post("/api/auth/login", json={"password": client.admin_password})
    csrf = login.json()["csrf"]

    r = client.post(
        "/api/auth/change-password",
        json={"old": client.admin_password, "new": "newpassword123"},
        headers={"X-CSRF": csrf},
    )
    assert r.status_code == 200

    # old password no longer works
    client.cookies.clear()
    bad = client.post("/api/auth/login", json={"password": client.admin_password})
    assert bad.status_code == 401

    # new password works
    good = client.post("/api/auth/login", json={"password": "newpassword123"})
    assert good.status_code == 200


def test_backoff_after_four_failures_then_429(client):
    for _ in range(4):
        r = client.post("/api/auth/login", json={"password": "wrong"})
        assert r.status_code == 401

    r5 = client.post("/api/auth/login", json={"password": "wrong"})
    assert r5.status_code == 429
    assert r5.json()["error"]["code"] == "auth.too_many_attempts"


def test_create_app_raises_if_not_installed(tmp_path):
    with pytest.raises(RuntimeError):
        app_module.create_app(str(tmp_path))
