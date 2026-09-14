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
    r = client.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "auth.required"


def test_login_success_sets_cookie_and_csrf(client):
    r = client.post("/api/auth/login", json={"username": "admin", "password": client.admin_password})
    assert r.status_code == 200
    body = r.json()
    assert "csrf" in body and body["csrf"]
    assert "cf_session" in r.cookies


def test_me_reports_authenticated(client):
    r = client.post("/api/auth/login", json={"username": "admin", "password": client.admin_password})
    assert r.status_code == 200

    me = client.get("/api/auth/me")
    assert me.status_code == 200
    body = me.json()
    assert body["authenticated"] is True
    assert body["username"] == "admin"
    assert body["role"] == "admin"
    assert body["lang"] == "en"


def test_me_unauthenticated_without_session(client):
    r = client.get("/api/auth/me")
    assert r.status_code == 200
    body = r.json()
    assert body["authenticated"] is False
    assert body["lang"] == "en"
    assert "platform_url" in body


def test_change_password_requires_csrf(client):
    login = client.post("/api/auth/login", json={"username": "admin", "password": client.admin_password})
    assert login.status_code == 200

    r = client.post("/api/auth/change-password", json={"old": client.admin_password, "new": "newpassword123"})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "auth.csrf"


def test_change_password_with_csrf_rotates_password(client):
    login = client.post("/api/auth/login", json={"username": "admin", "password": client.admin_password})
    csrf = login.json()["csrf"]

    r = client.post(
        "/api/auth/change-password",
        json={"old": client.admin_password, "new": "newpassword123"},
        headers={"X-CSRF": csrf},
    )
    assert r.status_code == 200

    # old password no longer works
    client.cookies.clear()
    bad = client.post("/api/auth/login", json={"username": "admin", "password": client.admin_password})
    assert bad.status_code == 401

    # new password works
    good = client.post("/api/auth/login", json={"username": "admin", "password": "newpassword123"})
    assert good.status_code == 200


def test_backoff_after_four_failures_then_429(client):
    for _ in range(4):
        r = client.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
        assert r.status_code == 401

    r5 = client.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
    assert r5.status_code == 429
    assert r5.json()["error"]["code"] == "auth.too_many_attempts"


def test_create_app_raises_if_not_installed(tmp_path):
    with pytest.raises(RuntimeError):
        app_module.create_app(str(tmp_path))


def _csrf(client):
    r = client.post("/api/auth/login", json={"username": "admin", "password": client.admin_password})
    assert r.status_code == 200
    return r.json()["csrf"]


def test_verify_password_returns_false_for_a_corrupt_hash():
    """M6: a damaged hash must read as 'wrong password', not raise."""
    from comfyfed_server import security

    assert security.verify_password("anything", "not-an-argon2-hash") is False
    assert security.verify_password("anything", "$argon2id$v=19$m=1,t=1,p=1$AAAA") is False
    assert security.verify_password("anything", "") is False


def test_change_password_keeps_self_logged_in_but_kills_other_sessions(client):
    """Phase 3.0: per-user `session_epoch` replaces the old global
    session-secret rotation. Changing your own password re-issues your own
    cookie at the new epoch (you stay logged in), but any OTHER cookie issued
    before the change (a second browser/tab) stops validating."""
    old_cookie = None
    csrf = _csrf(client)
    old_cookie = client.cookies.get("cf_session")

    r = client.post(
        "/api/auth/change-password",
        json={"old": client.admin_password, "new": "a-new-long-password"},
        headers={"X-CSRF": csrf},
    )
    assert r.status_code == 200
    assert r.json()["csrf"]

    # The caller's own session (its cookie jar was updated by the response's
    # Set-Cookie) is still authenticated.
    me = client.get("/api/auth/me")
    assert me.json()["authenticated"] is True

    # A second session holding the pre-change cookie is now stale-epoch.
    from comfyfed_server import auth

    assert auth.read_session_payload(old_cookie) is not None  # signature still valid
    with TestClient(client.app) as other:
        other.cookies.set("cf_session", old_cookie)
        assert other.get("/api/auth/me").json()["authenticated"] is False

    # The new password works; the old one does not.
    assert client.post("/api/auth/login", json={"username": "admin", "password": client.admin_password}).status_code == 401
    assert client.post("/api/auth/login", json={"username": "admin", "password": "a-new-long-password"}).status_code == 200


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
    assert r.json() == {
        "platform_url": "https://fed.example",
        "lang": "zh-TW",
        "object_info_mode": "union",
    }

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


def test_get_settings_reports_defaults_before_any_write(client):
    _csrf(client)
    r = client.get("/api/settings")
    assert r.status_code == 200
    assert r.json() == {"platform_url": "http://h", "lang": "en", "object_info_mode": "union"}


def test_get_settings_requires_login(client):
    r = client.get("/api/settings")
    assert r.status_code == 401


def test_update_settings_writes_object_info_mode(client):
    csrf = _csrf(client)
    r = client.post("/api/settings", json={"object_info_mode": "intersection"}, headers={"X-CSRF": csrf})
    assert r.status_code == 200
    assert r.json()["object_info_mode"] == "intersection"

    assert client.get("/api/settings").json()["object_info_mode"] == "intersection"


def test_update_settings_rejects_an_unknown_object_info_mode(client):
    csrf = _csrf(client)
    r = client.post("/api/settings", json={"object_info_mode": "bogus"}, headers={"X-CSRF": csrf})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "settings.bad_object_info_mode"


# --- the public session-reading surface (M4) -----------------------------------


def test_session_cookie_name_and_reader_are_public_and_agree(client):
    """M4: the three callers that cannot use `Depends(require_admin)` -- the
    conditionally-public `/metrics` route, the `/comfy` static gate, and
    comfyapi's panel WebSocket -- must read the session through auth's own
    public surface rather than reaching into a private helper with the cookie
    name hard-coded in three places.
    """
    from comfyfed_server import auth

    assert auth.SESSION_COOKIE_NAME == "cf_session"
    assert callable(auth.read_session_payload)

    csrf = _csrf(client)
    cookie = client.cookies.get(auth.SESSION_COOKIE_NAME)
    assert cookie

    payload = auth.read_session_payload(cookie)
    assert payload["uid"]
    assert payload["role"] == "admin"
    assert "epoch" in payload
    assert payload["csrf"] == csrf


def test_read_session_payload_rejects_absent_and_tampered_cookies(client):
    """Root cause of the former flake (Phase 1.9 Task 8): the tamper mutation
    used to flip the *last* character of the token. That character is the
    last of the signature's final base64 group, and for a 20-byte sha1 HMAC
    digest (20 % 3 == 2) that final base64 character encodes only 4 real bits
    plus 2 always-zero padding bits. 'A' (base64 index 0) and 'B' (index 1)
    differ only in those discarded padding bits, so ~1/16 of randomly-keyed
    sessions produced a "tampered" string that decodes to the exact same
    signature bytes as the original -- the mutation was a silent no-op and
    the assertion flaked (~6% failure rate, reproduced 20000x in-process).
    Fixing at the root: mutate the second-to-last character instead, which
    sits in a fully-populated base64 group and therefore always changes the
    decoded signature bytes (reproduced 20000x in-process with zero flakes).
    """
    from comfyfed_server import auth

    _csrf(client)
    good = client.cookies.get(auth.SESSION_COOKIE_NAME)

    assert auth.read_session_payload(None) is None
    assert auth.read_session_payload("") is None
    assert auth.read_session_payload("not-a-token") is None
    # Flip the second-to-last character of the signed value (not the last --
    # see docstring): the signature must stop matching.
    pos = -2
    replacement = "A" if good[pos] != "A" else "Z"
    tampered = good[:pos] + replacement + good[pos + 1 :]
    assert auth.read_session_payload(tampered) is None


def test_no_module_hard_codes_the_session_cookie_name(client):
    """The cookie name lives in auth.py and nowhere else."""
    import pathlib

    import comfyfed_server

    package_dir = pathlib.Path(comfyfed_server.__file__).parent
    offenders = [
        path.name
        for path in package_dir.glob("*.py")
        if path.name != "auth.py" and '"cf_session"' in path.read_text(encoding="utf-8")
    ]
    assert offenders == []


# --- Phase 3.0 multi-user ---------------------------------------------------


def test_login_requires_username(client):
    r = client.post("/api/auth/login", json={"password": client.admin_password})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"


def test_unknown_username_reports_the_same_error_as_wrong_password(client):
    unknown = client.post("/api/auth/login", json={"username": "nobody", "password": "whatever"})
    wrong = client.post("/api/auth/login", json={"username": "admin", "password": "whatever"})
    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json()["error"]["code"] == wrong.json()["error"]["code"] == "auth.required"
    assert unknown.json()["error"]["message"] == wrong.json()["error"]["message"]


def test_disabled_user_rejected_with_the_same_message(client):
    from comfyfed_server import db

    with db.get_session() as s:
        user = s.query(db.User).filter(db.User.username == "admin").one()
        user.disabled = True
        s.commit()

    r = client.post("/api/auth/login", json={"username": "admin", "password": client.admin_password})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "auth.required"


def test_username_is_lowercased(client):
    r = client.post("/api/auth/login", json={"username": "ADMIN", "password": client.admin_password})
    assert r.status_code == 200


def test_per_username_backoff_does_not_lock_out_a_different_username(client):
    for _ in range(4):
        r = client.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
        assert r.status_code == 401

    # "admin" is now backed off...
    locked = client.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
    assert locked.status_code == 429

    # ...but a different (even nonexistent) username is unaffected.
    other = client.post("/api/auth/login", json={"username": "someone-else", "password": "wrong"})
    assert other.status_code == 401


def test_old_format_cookie_is_rejected(client):
    """A pre-Phase-3.0 cookie -- `{authenticated, csrf}`, no `uid` -- must be
    treated as not logged in rather than mapped onto any account. Everyone
    re-authenticates once after this upgrade; there is no compatibility
    mapping."""
    from itsdangerous import URLSafeTimedSerializer

    from comfyfed_server import auth, db

    with db.get_session() as db_session:
        secret = auth._get_or_create_session_secret(db_session)
    serializer = URLSafeTimedSerializer(secret_key=secret, salt=auth._SESSION_SALT)
    old_style = serializer.dumps({"authenticated": True, "csrf": "whatever"})

    client.cookies.set("cf_session", old_style)
    me = client.get("/api/auth/me")
    assert me.json()["authenticated"] is False

    r = client.post("/api/settings", json={"lang": "en"}, headers={"X-CSRF": "whatever"})
    assert r.status_code == 401


def test_migration_backfills_admin_user_from_settings_hash():
    """Programmatic alembic upgrade: seed a pre-Phase-3.0 DB at revision
    c9d0e1f2a3b4 (settings.admin_password_hash + one job row), upgrade to
    head, and assert the data migration in d0e1f2a3b4c5 did its job."""
    import os
    import tempfile
    import uuid

    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine, text

    from comfyfed_server import db as db_module
    from comfyfed_server import security

    with tempfile.TemporaryDirectory() as tmp:
        db_path = os.path.join(tmp, "pre_migration.db")
        url = f"sqlite+pysqlite:///{db_path}"

        alembic_cfg = Config()
        alembic_cfg.set_main_option("script_location", db_module._alembic_dir())
        alembic_cfg.set_main_option("sqlalchemy.url", url)
        command.upgrade(alembic_cfg, "c9d0e1f2a3b4")

        password_hash = security.hash_password("old-admin-password")
        job_id = uuid.uuid4().hex
        engine = create_engine(url)
        with engine.begin() as conn:
            conn.execute(
                text("INSERT INTO settings (key, value) VALUES ('admin_password_hash', :h)"),
                {"h": password_hash},
            )
            conn.execute(
                text(
                    "INSERT INTO jobs (id, workflow_json, status, progress, created_at, "
                    "result_files, requirements, required_nodes, required_models, "
                    "input_assets, result_hashes, origin, panel_hidden) VALUES "
                    "(:id, '{}', 'queued', 0, '2026-01-01 00:00:00', '[]', '{}', '[]', "
                    "'[]', '[]', '{}', 'console', 0)"
                ),
                {"id": job_id},
            )
        engine.dispose()

        command.upgrade(alembic_cfg, "head")

        engine = create_engine(url)
        with engine.begin() as conn:
            user_row = conn.execute(
                text("SELECT id, username, password_hash, role FROM users")
            ).fetchone()
            assert user_row is not None
            assert user_row[1] == "admin"
            assert user_row[2] == password_hash
            assert user_row[3] == "admin"

            job_row = conn.execute(text("SELECT user_id FROM jobs WHERE id = :id"), {"id": job_id}).fetchone()
            assert job_row[0] == user_row[0]

            setting_row = conn.execute(
                text("SELECT value FROM settings WHERE key = 'admin_password_hash'")
            ).fetchone()
            assert setting_row is None
        engine.dispose()
