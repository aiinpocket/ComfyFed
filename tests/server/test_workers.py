import os

import pytest
from fastapi.testclient import TestClient
from nacl.signing import VerifyKey

from comfyfed_server import app as app_module
from comfyfed_server import bootstrap, db, security


@pytest.fixture()
def client(tmp_path):
    data_dir = str(tmp_path)
    result = bootstrap.ensure_installed(data_dir, lang="en", url="http://h", interactive=False)
    app = app_module.create_app(data_dir)
    c = TestClient(app)
    c.admin_password = result.admin_password
    c.data_dir = data_dir
    return c


def _login(client):
    r = client.post("/api/auth/login", json={"username": "admin", "password": client.admin_password})
    assert r.status_code == 200
    return r.json()["csrf"]


def test_issue_token_requires_admin(client):
    r = client.post("/api/workers/tokens", json={"name": "worker-1"})
    assert r.status_code == 401


def test_issue_token_requires_csrf(client):
    _login(client)
    r = client.post("/api/workers/tokens", json={"name": "worker-1"})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "auth.csrf"


def test_issue_token_and_register_success_with_verifiable_certificate(client):
    csrf = _login(client)
    r = client.post(
        "/api/workers/tokens",
        json={"name": "worker-1"},
        headers={"X-CSRF": csrf},
    )
    assert r.status_code == 200
    bundle = r.json()["bundle"]
    assert bundle["platform_url"] == "http://h"
    assert bundle["platform_pubkey"]
    token = bundle["register_token"]
    assert token

    _, verify_key = security.load_platform_keys(client.data_dir)
    assert bundle["platform_pubkey"] == bytes(verify_key).hex()

    pubkey_hex = "ab" * 32
    reg = client.post(
        "/api/agent/register",
        json={"token": token, "name": "worker-1", "pubkey": pubkey_hex},
    )
    assert reg.status_code == 200
    body = reg.json()
    worker_id = body["worker_id"]
    certificate = body["certificate"]
    assert worker_id

    msg = f"{worker_id}|{pubkey_hex}".encode()
    VerifyKey(bytes(verify_key)).verify(msg, bytes.fromhex(certificate))


def test_register_with_unknown_token_401(client):
    r = client.post(
        "/api/agent/register",
        json={"token": "does-not-exist", "name": "worker-x", "pubkey": "cd" * 32},
    )
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "register.token_invalid"


def test_register_twice_with_same_token_409(client):
    csrf = _login(client)
    r = client.post(
        "/api/workers/tokens",
        json={"name": "worker-2"},
        headers={"X-CSRF": csrf},
    )
    token = r.json()["bundle"]["register_token"]

    first = client.post(
        "/api/agent/register",
        json={"token": token, "name": "worker-2", "pubkey": "ef" * 32},
    )
    assert first.status_code == 200

    second = client.post(
        "/api/agent/register",
        json={"token": token, "name": "worker-2", "pubkey": "ef" * 32},
    )
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "register.token_used"


def test_list_workers_shows_registered_worker(client):
    csrf = _login(client)
    r = client.post(
        "/api/workers/tokens",
        json={"name": "worker-3"},
        headers={"X-CSRF": csrf},
    )
    token = r.json()["bundle"]["register_token"]

    client.post(
        "/api/agent/register",
        json={"token": token, "name": "worker-3", "pubkey": "12" * 32},
    )

    listed = client.get("/api/workers", headers={"X-CSRF": csrf})
    assert listed.status_code == 200
    names = [w["name"] for w in listed.json()]
    assert "worker-3" in names
    worker = next(w for w in listed.json() if w["name"] == "worker-3")
    assert worker["disabled"] is False
    assert "status" in worker and "last_seen" in worker and "id" in worker


def test_list_workers_exposes_peer_url(client):
    """Task 7: `/api/workers` serialization gains `peer_url` (null until the
    agent's `hello.peer_url` sets it -- see agentws._parse_peer_url). Readable
    by any logged-in user now (require_user); workers are shared infrastructure,
    so a peer address is fleet metadata, not per-user private data."""
    csrf = _login(client)
    r = client.post(
        "/api/workers/tokens",
        json={"name": "worker-peer"},
        headers={"X-CSRF": csrf},
    )
    token = r.json()["bundle"]["register_token"]
    reg = client.post(
        "/api/agent/register",
        json={"token": token, "name": "worker-peer", "pubkey": "56" * 32},
    )
    worker_id = reg.json()["worker_id"]

    listed = client.get("/api/workers", headers={"X-CSRF": csrf}).json()
    worker = next(w for w in listed if w["id"] == worker_id)
    assert worker["peer_url"] is None

    with db.get_session() as session:
        w = session.get(db.Worker, worker_id)
        w.peer_url = "http://192.168.1.5:8850"
        session.commit()

    listed_after = client.get("/api/workers", headers={"X-CSRF": csrf}).json()
    worker_after = next(w for w in listed_after if w["id"] == worker_id)
    assert worker_after["peer_url"] == "http://192.168.1.5:8850"


def _login_as_new_user(client, admin_csrf, username):
    """Create a non-admin `user` (as the current admin) then log in as them.

    The TestClient shares one cookie jar, so this REPLACES the admin session
    with the new user's -- do any admin-only setup (worker registration) BEFORE
    calling this."""
    created = client.post(
        "/api/users",
        json={"username": username, "role": "user", "password": "s3cret-password"},
        headers={"X-CSRF": admin_csrf},
    )
    assert created.status_code == 200
    client.post("/api/auth/logout", headers={"X-CSRF": admin_csrf})
    login = client.post(
        "/api/auth/login", json={"username": username, "password": "s3cret-password"}
    )
    assert login.status_code == 200
    return login.json()["csrf"]


def test_list_workers_allows_non_admin_user(client):
    """`GET /api/workers` is a read-only fleet listing any logged-in user may
    load (workers are shared infrastructure) -- changed from require_admin to
    require_user. Register a worker as admin, then read the list as a plain
    user: 200 with the worker present. The mutation routes stay admin-only
    (see the 403 tests below)."""
    csrf = _login(client)
    worker_id = _register(client, csrf, "shared-box", "11" * 32)
    _login_as_new_user(client, csrf, "reader")

    listed = client.get("/api/workers")
    assert listed.status_code == 200
    assert any(w["id"] == worker_id for w in listed.json())


def test_issue_token_requires_admin_role(client):
    """Token issuance stays admin-only: a logged-in non-admin with a valid CSRF
    still gets 403 (route hangs off require_csrf -> require_admin)."""
    csrf = _login(client)
    user_csrf = _login_as_new_user(client, csrf, "reader-token")
    r = client.post("/api/workers/tokens", json={"name": "x"}, headers={"X-CSRF": user_csrf})
    assert r.status_code == 403


def test_disable_worker_requires_admin_role(client):
    """Disable stays admin-only for a logged-in non-admin with a valid CSRF."""
    csrf = _login(client)
    worker_id = _register(client, csrf, "worker-dis-role", "22" * 32)
    user_csrf = _login_as_new_user(client, csrf, "reader-disable")
    r = client.post(f"/api/workers/{worker_id}/disable", headers={"X-CSRF": user_csrf})
    assert r.status_code == 403


def test_disable_worker(client):
    csrf = _login(client)
    r = client.post(
        "/api/workers/tokens",
        json={"name": "worker-4"},
        headers={"X-CSRF": csrf},
    )
    token = r.json()["bundle"]["register_token"]
    reg = client.post(
        "/api/agent/register",
        json={"token": token, "name": "worker-4", "pubkey": "34" * 32},
    )
    worker_id = reg.json()["worker_id"]

    disable = client.post(f"/api/workers/{worker_id}/disable", headers={"X-CSRF": csrf})
    assert disable.status_code == 200

    listed = client.get("/api/workers").json()
    worker = next(w for w in listed if w["id"] == worker_id)
    assert worker["disabled"] is True


def test_disable_unknown_worker_404(client):
    csrf = _login(client)
    r = client.post("/api/workers/does-not-exist/disable", headers={"X-CSRF": csrf})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "workers.not_found"


def test_agent_version_defaults_when_no_settings(client):
    r = client.get("/api/agent/version")
    assert r.status_code == 200
    body = r.json()
    assert body == {
        "latest": "0.1.0",
        "min_supported": "0.1.0",
        "wheel_url": None,
        "sha256": None,
        "platform_sig": None,
    }


def test_agent_version_reads_settings(client):
    with db.get_session() as session:
        session.add(db.Setting(key="agent_latest", value="0.2.0"))
        session.add(db.Setting(key="agent_min_supported", value="0.2.0"))
        session.add(db.Setting(key="agent_wheel_url", value="http://h/api/agent/releases/agent-0.2.0.whl"))
        session.add(db.Setting(key="agent_wheel_sha256", value="deadbeef"))
        session.add(db.Setting(key="agent_wheel_sig", value="abcd"))
        session.commit()

    r = client.get("/api/agent/version")
    assert r.status_code == 200
    body = r.json()
    assert body["latest"] == "0.2.0"
    assert body["min_supported"] == "0.2.0"
    assert body["wheel_url"] == "http://h/api/agent/releases/agent-0.2.0.whl"
    assert body["sha256"] == "deadbeef"
    assert body["platform_sig"] == "abcd"


def test_agent_release_serves_file(client):
    releases_dir = os.path.join(client.data_dir, "releases")
    os.makedirs(releases_dir, exist_ok=True)
    with open(os.path.join(releases_dir, "agent-0.2.0.whl"), "wb") as f:
        f.write(b"fake wheel bytes")

    r = client.get("/api/agent/releases/agent-0.2.0.whl")
    assert r.status_code == 200
    assert r.content == b"fake wheel bytes"


def test_agent_release_missing_404(client):
    r = client.get("/api/agent/releases/does-not-exist.whl")
    assert r.status_code == 404


def test_agent_release_sanitizes_path_traversal(client):
    r = client.get("/api/agent/releases/..%2F..%2Fsecrets.txt")
    assert r.status_code in (404, 400)


# --------------------------------------------------------------- soft delete


def _register(client, csrf, name, pubkey):
    """Issue a register token for `name` and claim it, returning the worker id."""
    r = client.post("/api/workers/tokens", json={"name": name}, headers={"X-CSRF": csrf})
    token = r.json()["bundle"]["register_token"]
    reg = client.post(
        "/api/agent/register",
        json={"token": token, "name": name, "pubkey": pubkey},
    )
    assert reg.status_code == 200
    return reg.json()["worker_id"]


def test_delete_worker_requires_login(client):
    r = client.delete("/api/workers/does-not-exist")
    assert r.status_code == 401


def test_delete_worker_requires_csrf(client):
    _login(client)
    r = client.delete("/api/workers/does-not-exist")
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "auth.csrf"


def test_delete_worker_requires_admin_role(client):
    """A logged-in non-admin gets 403 even with a valid CSRF token -- the
    route hangs off `auth.require_csrf`, which is admin-only."""
    csrf = _login(client)
    worker_id = _register(client, csrf, "worker-del-role", "78" * 32)
    created = client.post(
        "/api/users",
        json={"username": "plainuser", "role": "user", "password": "s3cret-password"},
        headers={"X-CSRF": csrf},
    )
    assert created.status_code == 200

    client.post("/api/auth/logout", headers={"X-CSRF": csrf})
    login = client.post(
        "/api/auth/login", json={"username": "plainuser", "password": "s3cret-password"}
    )
    assert login.status_code == 200
    user_csrf = login.json()["csrf"]

    r = client.delete(f"/api/workers/{worker_id}", headers={"X-CSRF": user_csrf})
    assert r.status_code == 403


def test_delete_worker_soft_deletes_and_hides_from_list(client):
    csrf = _login(client)
    worker_id = _register(client, csrf, "worker-del", "9a" * 32)

    r = client.delete(f"/api/workers/{worker_id}", headers={"X-CSRF": csrf})
    assert r.status_code == 200
    assert r.json() == {"ok": True}

    listed = client.get("/api/workers").json()
    assert all(w["id"] != worker_id for w in listed)

    # The row itself survives -- the billing ledger's receipts/jobs still
    # reference it (see db.Worker.deleted).
    with db.get_session() as session:
        row = session.get(db.Worker, worker_id)
        assert row is not None
        assert row.deleted is True
        assert row.disabled is True


def test_delete_unknown_worker_404(client):
    csrf = _login(client)
    r = client.delete("/api/workers/does-not-exist", headers={"X-CSRF": csrf})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "workers.not_found"


def test_delete_worker_twice_404(client):
    csrf = _login(client)
    worker_id = _register(client, csrf, "worker-del-twice", "bc" * 32)

    first = client.delete(f"/api/workers/{worker_id}", headers={"X-CSRF": csrf})
    assert first.status_code == 200

    second = client.delete(f"/api/workers/{worker_id}", headers={"X-CSRF": csrf})
    assert second.status_code == 404
    assert second.json()["error"]["code"] == "workers.not_found"
