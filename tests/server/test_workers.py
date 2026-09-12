import pytest
from fastapi.testclient import TestClient
from nacl.signing import VerifyKey

from comfyfed_server import app as app_module
from comfyfed_server import bootstrap, security


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
    r = client.post("/api/auth/login", json={"password": client.admin_password})
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
