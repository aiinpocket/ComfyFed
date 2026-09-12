import secrets
import time

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey

from comfyfed_agent import signing
from comfyfed_agent.config import PlatformEntry
from comfyfed_server import app as app_module
from comfyfed_server import bootstrap


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


def _register_worker(client, name="worker-1") -> PlatformEntry:
    csrf = _login(client)
    r = client.post(
        "/api/workers/tokens",
        json={"name": name},
        headers={"X-CSRF": csrf},
    )
    token = r.json()["bundle"]["register_token"]

    signing_key = SigningKey.generate()
    pubkey_hex = bytes(signing_key.verify_key).hex()

    reg = client.post(
        "/api/agent/register",
        json={"token": token, "name": name, "pubkey": pubkey_hex},
    )
    assert reg.status_code == 200
    body = reg.json()

    return PlatformEntry(
        platform_url="http://h",
        platform_pubkey="",
        worker_id=body["worker_id"],
        certificate=body["certificate"],
        signing_key_hex=bytes(signing_key).hex(),
    )


def _ping(client, entry, body: bytes = b""):
    headers = signing.signed_headers(entry, "POST", "/api/agent/ping", body)
    return client.post("/api/agent/ping", headers=headers, content=body)


def test_correctly_signed_ping_returns_200(client):
    entry = _register_worker(client)
    r = _ping(client, entry)
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_tampered_body_401(client):
    entry = _register_worker(client)
    headers = signing.signed_headers(entry, "POST", "/api/agent/ping", b"")
    r = client.post("/api/agent/ping", headers=headers, content=b"tampered")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "agent.bad_signature"


def test_replayed_nonce_409(client):
    entry = _register_worker(client)
    headers = signing.signed_headers(entry, "POST", "/api/agent/ping", b"")

    first = client.post("/api/agent/ping", headers=headers, content=b"")
    assert first.status_code == 200

    second = client.post("/api/agent/ping", headers=headers, content=b"")
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "agent.replay"


def test_stale_timestamp_401(client):
    entry = _register_worker(client)

    # signed_headers always stamps the current time, so build a request with
    # an offset timestamp (and matching signature) manually.
    ts = str(int(time.time()) - 300)
    nonce = secrets.token_hex(16)
    message = f"POST\n/api/agent/ping\n{ts}\n{nonce}\n".encode() + b""
    sk = SigningKey(bytes.fromhex(entry.signing_key_hex))
    sig = sk.sign(message).signature.hex()

    r = client.post(
        "/api/agent/ping",
        headers={
            "X-Worker-Id": entry.worker_id,
            "X-Ts": ts,
            "X-Nonce": nonce,
            "X-Sig": sig,
        },
        content=b"",
    )
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "agent.bad_signature"


def test_disabled_worker_403(client):
    entry = _register_worker(client)
    csrf = _login(client)
    disable = client.post(f"/api/workers/{entry.worker_id}/disable", headers={"X-CSRF": csrf})
    assert disable.status_code == 200

    r = _ping(client, entry)
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "agent.worker_disabled"


def test_disabled_worker_with_invalid_signature_401_not_403(client):
    """A disabled worker with a bad signature must not leak disabled status.

    Signature validity is checked before the disabled check, so an
    unauthenticated caller who guesses a worker_id can't use the 401-vs-403
    distinction to learn whether that worker exists or is disabled.
    """
    entry = _register_worker(client)
    csrf = _login(client)
    disable = client.post(f"/api/workers/{entry.worker_id}/disable", headers={"X-CSRF": csrf})
    assert disable.status_code == 200

    headers = signing.signed_headers(entry, "POST", "/api/agent/ping", b"")
    r = client.post("/api/agent/ping", headers=headers, content=b"tampered")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "agent.bad_signature"


def test_query_string_is_covered_by_the_signature(client):
    """M14: a signature issued for one query must not validate for another.

    The agent signs `{METHOD}\n{path}?{query}\n...`; the server rebuilds the
    same string from the live request, so swapping the parameters after
    signing invalidates it.
    """
    entry = _register_worker(client)

    headers = signing.signed_headers(entry, "POST", "/api/agent/ping", b"", query="scope=read")
    ok = client.post("/api/agent/ping?scope=read", headers=headers, content=b"")
    assert ok.status_code == 200

    headers = signing.signed_headers(entry, "POST", "/api/agent/ping", b"", query="scope=read")
    swapped = client.post("/api/agent/ping?scope=admin", headers=headers, content=b"")
    assert swapped.status_code == 401
    assert swapped.json()["error"]["code"] == "agent.bad_signature"


def test_signature_without_a_query_is_unchanged(client):
    """A request with no query signs the bare path, exactly as before."""
    entry = _register_worker(client)

    headers = signing.signed_headers(entry, "POST", "/api/agent/ping", b"")
    assert client.post("/api/agent/ping", headers=headers, content=b"").status_code == 200

    # A signature omitting the query cannot be used on a request that has one.
    headers = signing.signed_headers(entry, "POST", "/api/agent/ping", b"")
    r = client.post("/api/agent/ping?x=1", headers=headers, content=b"")
    assert r.status_code == 401
