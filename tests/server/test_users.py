import pytest
from fastapi.testclient import TestClient

from comfyfed_server import app as app_module
from comfyfed_server import bootstrap, db


@pytest.fixture()
def client(tmp_path):
    data_dir = str(tmp_path)
    result = bootstrap.ensure_installed(data_dir, lang="en", url="http://h", interactive=False)
    app = app_module.create_app(data_dir)
    c = TestClient(app)
    c.admin_password = result.admin_password
    return c


def _login(client, username="admin", password=None):
    r = client.post(
        "/api/auth/login",
        json={"username": username, "password": password or client.admin_password},
    )
    assert r.status_code == 200, r.text
    return r.json()["csrf"]


def _create_user(client, csrf, username, role="user", password=None):
    body = {"username": username, "role": role}
    if password is not None:
        body["password"] = password
    return client.post("/api/users", json=body, headers={"X-CSRF": csrf})


def test_list_users_requires_admin(client):
    r = client.get("/api/users")
    assert r.status_code == 401


def test_create_and_list_user(client):
    csrf = _login(client)
    r = _create_user(client, csrf, "alice", role="user")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["username"] == "alice"
    assert body["role"] == "user"
    assert "password" in body and body["password"]
    assert "id" in body

    listed = client.get("/api/users", headers={"X-CSRF": csrf})
    assert listed.status_code == 200
    users = listed.json()["users"]
    usernames = [u["username"] for u in users]
    assert "admin" in usernames
    assert "alice" in usernames
    alice = next(u for u in users if u["username"] == "alice")
    assert alice["disabled"] is False
    assert alice["jobs"] == 0
    assert "created_at" in alice
    assert "password" not in alice
    assert "password_hash" not in alice


def test_create_user_generates_password_when_absent(client):
    csrf = _login(client)
    r = _create_user(client, csrf, "bob")
    assert r.status_code == 200
    generated = r.json()["password"]
    assert len(generated) >= 8

    login = client.post("/api/auth/login", json={"username": "bob", "password": generated})
    assert login.status_code == 200


def test_create_user_with_explicit_password_can_login(client):
    csrf = _login(client)
    r = _create_user(client, csrf, "carol", password="s3cret-password")
    assert r.status_code == 200
    assert r.json()["password"] == "s3cret-password"

    login = client.post("/api/auth/login", json={"username": "carol", "password": "s3cret-password"})
    assert login.status_code == 200


def test_create_user_rejects_a_too_short_explicit_password(client):
    """Final review finding #8: an admin-supplied password must meet the
    same 8-char minimum self-service change-password enforces -- an admin
    could otherwise create an account with password `a`."""
    csrf = _login(client)
    r = _create_user(client, csrf, "shortpw", password="a")
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "auth.password_too_short"

    login = client.post("/api/auth/login", json={"username": "shortpw", "password": "a"})
    assert login.status_code == 401


def test_create_user_duplicate_username_case_insensitive(client):
    csrf = _login(client)
    r1 = _create_user(client, csrf, "dave")
    assert r1.status_code == 200

    r2 = _create_user(client, csrf, "DAVE")
    assert r2.status_code == 400
    assert r2.json()["error"]["code"] == "username_taken"


def test_create_user_invalid_username_rejected(client):
    csrf = _login(client)
    r = _create_user(client, csrf, "ab")  # too short
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "invalid_username"

    r2 = _create_user(client, csrf, "bad user!")
    assert r2.status_code == 400
    assert r2.json()["error"]["code"] == "invalid_username"


def test_create_user_username_is_lowercased(client):
    csrf = _login(client)
    r = _create_user(client, csrf, "EVE", password="password123")
    assert r.status_code == 200
    assert r.json()["username"] == "eve"


def test_create_user_invalid_role_rejected(client):
    csrf = _login(client)
    r = client.post(
        "/api/users",
        json={"username": "frank", "role": "superuser"},
        headers={"X-CSRF": csrf},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "invalid_role"


def test_reset_password_invalidates_session(client):
    csrf = _login(client)
    _create_user(client, csrf, "grace", password="original-pw12")

    other = TestClient(client.app)
    other_csrf = _login(other, "grace", "original-pw12")
    assert other.get("/api/auth/me").json()["authenticated"] is True

    with db.get_session() as session:
        grace = session.query(db.User).filter(db.User.username == "grace").one()
        grace_id = grace.id

    r = client.post(f"/api/users/{grace_id}/reset-password", headers={"X-CSRF": csrf})
    assert r.status_code == 200
    new_password = r.json()["password"]
    assert new_password and new_password != "original-pw12"

    # old session is dead
    me = other.get("/api/auth/me")
    assert me.json()["authenticated"] is False

    # new password works
    login = client.post("/api/auth/login", json={"username": "grace", "password": new_password})
    assert login.status_code == 200


def test_disable_blocks_login_and_kills_session(client):
    csrf = _login(client)
    _create_user(client, csrf, "heidi", password="password123")

    other = TestClient(client.app)
    other_csrf = _login(other, "heidi", "password123")
    assert other.get("/api/auth/me").json()["authenticated"] is True

    with db.get_session() as session:
        heidi = session.query(db.User).filter(db.User.username == "heidi").one()
        heidi_id = heidi.id

    r = client.patch(f"/api/users/{heidi_id}", json={"disabled": True}, headers={"X-CSRF": csrf})
    assert r.status_code == 200
    assert r.json()["disabled"] is True

    # existing session dead
    me = other.get("/api/auth/me")
    assert me.json()["authenticated"] is False

    # can no longer log in
    login = client.post("/api/auth/login", json={"username": "heidi", "password": "password123"})
    assert login.status_code == 401


def test_last_admin_cannot_be_disabled(client):
    csrf = _login(client)
    with db.get_session() as session:
        admin = session.query(db.User).filter(db.User.username == "admin").one()
        admin_id = admin.id

    r = client.patch(f"/api/users/{admin_id}", json={"disabled": True}, headers={"X-CSRF": csrf})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "last_admin"


def test_last_admin_cannot_be_demoted(client):
    csrf = _login(client)
    with db.get_session() as session:
        admin = session.query(db.User).filter(db.User.username == "admin").one()
        admin_id = admin.id

    r = client.patch(f"/api/users/{admin_id}", json={"role": "user"}, headers={"X-CSRF": csrf})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "last_admin"


def test_second_admin_allows_disabling_first(client):
    csrf = _login(client)
    _create_user(client, csrf, "ivan", role="admin", password="password123")

    with db.get_session() as session:
        admin = session.query(db.User).filter(db.User.username == "admin").one()
        admin_id = admin.id

    r = client.patch(f"/api/users/{admin_id}", json={"disabled": True}, headers={"X-CSRF": csrf})
    assert r.status_code == 200
    assert r.json()["disabled"] is True


def test_non_admin_gets_403(client):
    csrf = _login(client)
    _create_user(client, csrf, "judy", role="user", password="password123")
    judy_client = TestClient(client.app)
    judy_csrf = _login(judy_client, "judy", "password123")

    r = judy_client.get("/api/users", headers={"X-CSRF": judy_csrf})
    assert r.status_code == 403

    r2 = judy_client.post(
        "/api/users", json={"username": "karl", "role": "user"}, headers={"X-CSRF": judy_csrf}
    )
    assert r2.status_code == 403


def test_no_delete_endpoint(client):
    csrf = _login(client)
    _create_user(client, csrf, "leo", password="password123")
    with db.get_session() as session:
        leo = session.query(db.User).filter(db.User.username == "leo").one()
        leo_id = leo.id

    r = client.delete(f"/api/users/{leo_id}", headers={"X-CSRF": csrf})
    assert r.status_code in (404, 405)


def test_patch_unknown_user_404(client):
    csrf = _login(client)
    r = client.patch("/api/users/does-not-exist", json={"disabled": True}, headers={"X-CSRF": csrf})
    assert r.status_code == 404


def test_reset_password_unknown_user_404(client):
    csrf = _login(client)
    r = client.post("/api/users/does-not-exist/reset-password", headers={"X-CSRF": csrf})
    assert r.status_code == 404


def test_create_user_requires_csrf(client):
    _login(client)
    r = client.post("/api/users", json={"username": "mike", "role": "user"})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "auth.csrf"
