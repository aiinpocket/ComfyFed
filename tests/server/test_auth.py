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
    assert r.json()["error"]["code"] == "auth.required"


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


def test_me_unauthenticated_without_session(client):
    r = client.get("/api/auth/me")
    assert r.status_code == 200
    body = r.json()
    assert body["authenticated"] is False
    assert body["lang"] == "en"
    assert "platform_url" in body


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


def _csrf(client):
    r = client.post("/api/auth/login", json={"password": client.admin_password})
    assert r.status_code == 200
    return r.json()["csrf"]


def test_verify_password_returns_false_for_a_corrupt_hash():
    """M6: a damaged hash must read as 'wrong password', not raise."""
    from comfyfed_server import security

    assert security.verify_password("anything", "not-an-argon2-hash") is False
    assert security.verify_password("anything", "$argon2id$v=19$m=1,t=1,p=1$AAAA") is False
    assert security.verify_password("anything", "") is False


def test_change_password_invalidates_the_existing_session(client):
    """M7: rotating the session secret logs every session out, including this one."""
    csrf = _csrf(client)

    r = client.post(
        "/api/auth/change-password",
        json={"old": client.admin_password, "new": "a-new-long-password"},
        headers={"X-CSRF": csrf},
    )
    assert r.status_code == 200

    me = client.get("/api/auth/me")
    assert me.json()["authenticated"] is False

    # The new password works; the old one does not.
    assert client.post("/api/auth/login", json={"password": client.admin_password}).status_code == 401
    assert client.post("/api/auth/login", json={"password": "a-new-long-password"}).status_code == 200


def test_validation_error_uses_the_standard_error_envelope(client):
    """M4: a malformed body must return {"error": {...}}, not FastAPI's detail list."""
    r = client.post("/api/auth/login", json={"not_password": 1})
    assert r.status_code == 422
    body = r.json()
    assert body["error"]["code"] == "validation_error"
    assert body["error"]["message"]


def test_update_settings_writes_platform_url_and_lang(client):
    csrf = _csrf(client)

    r = client.post(
        "/api/settings",
        json={"platform_url": "https://fed.example", "lang": "zh-TW"},
        headers={"X-CSRF": csrf},
    )
    assert r.status_code == 200
    assert r.json() == {"platform_url": "https://fed.example", "lang": "zh-TW"}

    me = client.get("/api/auth/me").json()
    assert me["platform_url"] == "https://fed.example"
    assert me["lang"] == "zh-TW"


def test_update_settings_accepts_a_partial_body(client):
    csrf = _csrf(client)
    client.post("/api/settings", json={"platform_url": "https://a.example"}, headers={"X-CSRF": csrf})

    r = client.post("/api/settings", json={"lang": "en"}, headers={"X-CSRF": csrf})
    assert r.status_code == 200
    assert r.json()["platform_url"] == "https://a.example"  # untouched


def test_update_settings_rejects_a_non_http_platform_url(client):
    csrf = _csrf(client)
    r = client.post("/api/settings", json={"platform_url": "fed.example"}, headers={"X-CSRF": csrf})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "settings.bad_platform_url"


def test_update_settings_rejects_an_unknown_language(client):
    csrf = _csrf(client)
    r = client.post("/api/settings", json={"lang": "fr"}, headers={"X-CSRF": csrf})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "settings.bad_lang"


def test_update_settings_requires_csrf(client):
    _csrf(client)
    r = client.post("/api/settings", json={"lang": "en"})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "auth.csrf"


def test_update_settings_requires_login(client):
    r = client.post("/api/settings", json={"lang": "en"}, headers={"X-CSRF": "x"})
    assert r.status_code == 401
