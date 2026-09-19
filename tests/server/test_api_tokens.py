"""2026-09-19 API token（spec §4）：建立／列出／撤銷，以及 bearer 認證。

client fixture 與 `_login` 沿用 `test_auth.py`／`test_jobs.py` 的寫法。
"""

import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from comfyfed_server import app as app_module
from comfyfed_server import api_tokens, bootstrap, db


@pytest.fixture()
def client(tmp_path):
    data_dir = str(tmp_path)
    result = bootstrap.ensure_installed(data_dir, lang="en", url="http://h", interactive=False)
    app = app_module.create_app(data_dir)
    c = TestClient(app)
    c.admin_password = result.admin_password
    return c


def _login(client):
    r = client.post("/api/auth/login", json={"username": "admin", "password": client.admin_password})
    assert r.status_code == 200
    return r.json()["csrf"]


def _create_token(client, csrf, name="ai"):
    return client.post("/api/auth/tokens", json={"name": name}, headers={"X-CSRF": csrf})


def _bearer(token):
    return {"Authorization": f"Bearer {token}"}


SIMPLE_WORKFLOW = {"1": {"class_type": "KSampler", "inputs": {"seed": 1}}}


def _submit(client, headers):
    return client.post(
        "/api/jobs",
        data={"workflow_json": json.dumps(SIMPLE_WORKFLOW)},
        files=[],
        headers=headers,
    )


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _token_row(token_id):
    with db.get_session() as session:
        return session.get(db.ApiToken, token_id)


# --- 建立 ---------------------------------------------------------------


def test_create_token_returns_plaintext_once(client):
    csrf = _login(client)
    r = _create_token(client, csrf, name="my ai")
    assert r.status_code == 201
    body = r.json()

    assert body["name"] == "my ai"
    assert body["token"].startswith("cft_")
    assert len(body["token"]) == 47
    assert body["prefix"] == body["token"][:12]
    assert body["created_at"] and body["expires_at"]
    assert body["id"]


def test_create_token_expires_in_30_days(client):
    csrf = _login(client)
    body = _create_token(client, csrf).json()
    row = _token_row(body["id"])
    assert (row.expires_at - row.created_at).days == api_tokens.API_TOKEN_TTL_DAYS


def test_plaintext_never_appears_again_in_the_listing(client):
    csrf = _login(client)
    plaintext = _create_token(client, csrf).json()["token"]

    listed = client.get("/api/auth/tokens")
    assert listed.status_code == 200
    rows = listed.json()
    assert len(rows) == 1
    assert "token" not in rows[0]
    assert plaintext not in json.dumps(rows)
    assert rows[0]["prefix"] == plaintext[:12]
    assert rows[0]["active"] is True
    assert rows[0]["last_used_at"] is None
    assert rows[0]["revoked_at"] is None


def test_create_token_rejects_a_name_over_64_chars(client):
    csrf = _login(client)
    r = _create_token(client, csrf, name="x" * 65)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "auth.bad_token_name"
    assert _create_token(client, csrf, name="x" * 64).status_code == 201


def test_eleventh_active_token_is_rejected_until_one_is_revoked(client):
    csrf = _login(client)
    ids = [_create_token(client, csrf, name=f"t{i}").json()["id"] for i in range(10)]

    over = _create_token(client, csrf, name="t10")
    assert over.status_code == 409
    assert over.json()["error"]["code"] == "auth.too_many_tokens"

    revoked = client.delete(f"/api/auth/tokens/{ids[0]}", headers={"X-CSRF": csrf})
    assert revoked.status_code == 200
    assert revoked.json() == {"revoked": True}

    assert _create_token(client, csrf, name="t10").status_code == 201


# --- 撤銷 ---------------------------------------------------------------


def test_state_changing_token_routes_require_the_csrf_header(client):
    """建與撤是改狀態的，要 `X-CSRF`。"""
    csrf = _login(client)
    token_id = _create_token(client, csrf).json()["id"]

    assert client.post("/api/auth/tokens", json={"name": "x"}).status_code == 403
    assert client.delete(f"/api/auth/tokens/{token_id}").status_code == 403


def test_listing_is_cookie_only_without_csrf(client):
    """清單是只讀的：cookie 就夠，**不**要 `X-CSRF`（console 的 fetch
    包裝只在非 GET 上帶那個 header）—— 但 bearer 還是 401。"""
    csrf = _login(client)
    token = _create_token(client, csrf).json()["token"]

    assert client.get("/api/auth/tokens").status_code == 200

    client.cookies.clear()
    assert client.get("/api/auth/tokens", headers=_bearer(token)).status_code == 401
    assert client.get("/api/auth/tokens").status_code == 401


def test_revoke_unknown_token_is_404(client):
    csrf = _login(client)
    r = client.delete("/api/auth/tokens/nope", headers={"X-CSRF": csrf})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "auth.token_not_found"


def test_revoke_is_idempotent_and_flips_active(client):
    csrf = _login(client)
    token_id = _create_token(client, csrf).json()["id"]

    assert client.delete(f"/api/auth/tokens/{token_id}", headers={"X-CSRF": csrf}).status_code == 200
    again = client.delete(f"/api/auth/tokens/{token_id}", headers={"X-CSRF": csrf})
    assert again.status_code == 200
    assert again.json() == {"revoked": True}

    row = client.get("/api/auth/tokens").json()[0]
    assert row["active"] is False
    assert row["revoked_at"] is not None


def test_listing_only_shows_your_own_tokens(client):
    csrf = _login(client)
    created = client.post(
        "/api/users",
        json={"username": "someone", "role": "user", "password": "s3cret-password"},
        headers={"X-CSRF": csrf},
    )
    assert created.status_code == 200
    mine = _create_token(client, csrf, name="admin-token").json()["id"]

    client.post("/api/auth/logout", headers={"X-CSRF": csrf})
    other_csrf = _login_as(client, "someone", "s3cret-password")
    theirs = _create_token(client, other_csrf, name="their-token").json()["id"]

    rows = client.get("/api/auth/tokens").json()
    assert [r["id"] for r in rows] == [theirs]

    # 也不能撤銷別人的
    assert client.delete(f"/api/auth/tokens/{mine}", headers={"X-CSRF": other_csrf}).status_code == 404


def _login_as(client, username, password):
    r = client.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200
    return r.json()["csrf"]


# --- bearer 認證 --------------------------------------------------------


def test_bearer_can_read_jobs(client):
    csrf = _login(client)
    token = _create_token(client, csrf).json()["token"]
    client.cookies.clear()

    r = client.get("/api/jobs", headers=_bearer(token))
    assert r.status_code == 200
    assert r.json() == []


def test_bearer_submits_a_job_without_csrf(client):
    csrf = _login(client)
    token = _create_token(client, csrf).json()["token"]
    client.cookies.clear()

    r = _submit(client, _bearer(token))
    assert r.status_code == 200, r.text
    assert r.json()["job_id"]


def test_bearer_me_reports_token_auth(client):
    csrf = _login(client)
    token = _create_token(client, csrf).json()["token"]
    client.cookies.clear()

    r = client.get("/api/auth/me", headers=_bearer(token))
    assert r.status_code == 200
    body = r.json()
    assert body["authenticated"] is True
    assert body["username"] == "admin"
    assert body["role"] == "admin"
    assert body["auth"] == "token"
    assert body["csrf"] is None
    assert body["token_expires_at"]


def test_invalid_bearer_on_me_is_401_not_an_anonymous_200(client):
    """控制者裁示：`/me` 帶了 `Authorization` 但無效 -> 401。

    §6.3 的 `platform_status` 靠這條路徑分辨「token 死了」與「平台好好
    的」；`/me` 的 401 走的是跟 `require_user` 不同的分支（route 自己呼叫
    `_bearer_user`），所以要獨立釘住。完全沒有憑證的匿名呼叫則照舊 200。
    """
    r = client.get("/api/auth/me", headers={"Authorization": "Bearer cft_bogus"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "auth.required"

    anon = client.get("/api/auth/me")
    assert anon.status_code == 200
    assert anon.json()["authenticated"] is False


def test_revoked_token_on_me_is_401(client):
    csrf = _login(client)
    created = _create_token(client, csrf).json()
    client.delete(f"/api/auth/tokens/{created['id']}", headers={"X-CSRF": csrf})
    client.cookies.clear()

    r = client.get("/api/auth/me", headers=_bearer(created["token"]))
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "auth.required"


def test_cookie_me_reports_session_auth(client):
    _login(client)
    body = client.get("/api/auth/me").json()
    assert body["auth"] == "session"
    assert body["csrf"]
    assert body["token_expires_at"] is None


@pytest.mark.parametrize(
    "path,method,kwargs",
    [
        ("/api/auth/tokens", "post", {"json": {"name": "x"}}),
        ("/api/auth/tokens", "get", {}),
        ("/api/auth/tokens/anything", "delete", {}),
        ("/api/auth/change-password", "post", {"json": {"old": "a", "new": "bbbbbbbbbb"}}),
        ("/api/auth/logout", "post", {}),
    ],
)
def test_bearer_cannot_manage_tokens_or_session(client, path, method, kwargs):
    csrf = _login(client)
    token = _create_token(client, csrf).json()["token"]
    client.cookies.clear()

    r = getattr(client, method)(path, headers=_bearer(token), **kwargs)
    assert r.status_code == 401
    # 這個碼是控制者的裁示（spec 寫的 `auth.unauthorized` 作廢），cloud 孿生
    # 要跟著用同一個 —— 釘住它，免得兩棧各自漂移還都是綠的。
    assert r.json()["error"]["code"] == "auth.required"


def test_revoked_token_is_rejected(client):
    csrf = _login(client)
    created = _create_token(client, csrf).json()
    client.delete(f"/api/auth/tokens/{created['id']}", headers={"X-CSRF": csrf})
    client.cookies.clear()

    assert client.get("/api/jobs", headers=_bearer(created["token"])).status_code == 401


def test_expired_token_is_rejected(client):
    csrf = _login(client)
    created = _create_token(client, csrf).json()
    with db.get_session() as session:
        row = session.get(db.ApiToken, created["id"])
        row.expires_at = _utcnow() - timedelta(seconds=1)
        session.commit()
    client.cookies.clear()

    assert client.get("/api/jobs", headers=_bearer(created["token"])).status_code == 401


def test_password_change_invalidates_existing_tokens(client):
    csrf = _login(client)
    token = _create_token(client, csrf).json()["token"]

    changed = client.post(
        "/api/auth/change-password",
        json={"old": client.admin_password, "new": "newpassword123"},
        headers={"X-CSRF": csrf},
    )
    assert changed.status_code == 200
    client.cookies.clear()

    assert client.get("/api/jobs", headers=_bearer(token)).status_code == 401


def test_disabled_user_token_is_rejected(client):
    csrf = _login(client)
    token = _create_token(client, csrf).json()["token"]
    with db.get_session() as session:
        user = session.query(db.User).filter(db.User.username == "admin").one()
        user.disabled = True
        session.commit()
    client.cookies.clear()

    assert client.get("/api/jobs", headers=_bearer(token)).status_code == 401


@pytest.mark.parametrize(
    "header",
    ["Bearer x", "Basic abcdef", "", "cft_whatever", "Bearer ", "Bearer cft_" + "a" * 43],
)
def test_bad_authorization_header_never_falls_back_to_the_cookie(client, header):
    """有 `Authorization` 就只看 header：同一個請求即使帶著有效 cookie 也 401。"""
    _login(client)
    assert client.get("/api/jobs").status_code == 200  # cookie 本身是有效的

    r = client.get("/api/jobs", headers={"Authorization": header})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "auth.required"


# --- last_used_at 節流 --------------------------------------------------


def test_last_used_at_is_stamped_then_throttled_for_five_minutes(client):
    csrf = _login(client)
    created = _create_token(client, csrf).json()
    client.cookies.clear()

    assert _token_row(created["id"]).last_used_at is None

    assert client.get("/api/jobs", headers=_bearer(created["token"])).status_code == 200
    first = _token_row(created["id"]).last_used_at
    assert first is not None

    assert client.get("/api/jobs", headers=_bearer(created["token"])).status_code == 200
    assert _token_row(created["id"]).last_used_at == first

    # 把上次使用時間往回推超過節流視窗 -> 下一次命中才會再寫回
    with db.get_session() as session:
        row = session.get(db.ApiToken, created["id"])
        row.last_used_at = _utcnow() - timedelta(seconds=api_tokens.API_TOKEN_TOUCH_SECONDS + 60)
        session.commit()
        stale = row.last_used_at

    assert client.get("/api/jobs", headers=_bearer(created["token"])).status_code == 200
    assert _token_row(created["id"]).last_used_at > stale


def test_listing_surfaces_last_used_at(client):
    csrf = _login(client)
    token = _create_token(client, csrf).json()["token"]
    assert client.get("/api/jobs", headers=_bearer(token)).status_code == 200

    row = client.get("/api/auth/tokens").json()[0]
    assert row["last_used_at"] is not None


def test_create_token_without_a_body_uses_an_empty_name(client):
    """spec §4.2：body 與 `name` 都可以省。"""
    csrf = _login(client)
    r = client.post("/api/auth/tokens", headers={"X-CSRF": csrf})
    assert r.status_code == 201
    assert r.json()["name"] == ""


def test_resolve_bearer_returns_the_user_or_none(client):
    """`resolve_bearer` 是 brief 宣告的介面，但 `auth.py` 用的是回傳列的
    `resolve_bearer_token`；直接測它，免得這個包裝爛掉沒人發現。"""
    csrf = _login(client)
    plaintext = _create_token(client, csrf).json()["token"]

    with db.get_session() as session:
        now = _utcnow()
        user = api_tokens.resolve_bearer(session, f"Bearer {plaintext}", now)
        assert user is not None and user.username == "admin"

        assert api_tokens.resolve_bearer(session, None, now) is None
        assert api_tokens.resolve_bearer(session, "Basic x", now) is None
        assert api_tokens.resolve_bearer(session, "Bearer cft_nope", now) is None


def test_logout_with_a_stale_session_is_401(client):
    """logout 現在要 cookie＋CSRF（spec §4.3 的例外清單），所以 session 失效
    之後按登出會拿到 401 —— 釘住它是 401，而不是 500 或默默成功。"""
    csrf = _login(client)
    with db.get_session() as session:
        user = session.query(db.User).filter(db.User.username == "admin").one()
        user.session_epoch += 1
        session.commit()

    r = client.post("/api/auth/logout", headers={"X-CSRF": csrf})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "auth.required"
