import json

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey, VerifyKey

from comfyfed_agent.config import AgentConfig
from comfyfed_agent.identity import CertificateInvalid, register
from comfyfed_server import app as app_module
from comfyfed_server import bootstrap, security


@pytest.fixture()
def server(tmp_path):
    data_dir = str(tmp_path / "server")
    result = bootstrap.ensure_installed(data_dir, lang="en", url="http://testserver", interactive=False)
    app = app_module.create_app(data_dir)
    client = TestClient(app)
    client.admin_password = result.admin_password
    client.data_dir = data_dir
    return client


def _issue_bundle(server) -> dict:
    login = server.post("/api/auth/login", json={"username": "admin", "password": server.admin_password})
    assert login.status_code == 200
    csrf = login.json()["csrf"]

    r = server.post(
        "/api/workers/tokens",
        json={"name": "worker-1"},
        headers={"X-CSRF": csrf},
    )
    assert r.status_code == 200
    return r.json()["bundle"]


def test_register_writes_config_with_worker_id_and_signing_key(server, tmp_path):
    bundle = _issue_bundle(server)
    cfg_path = str(tmp_path / "agent" / "config.json")

    entry = register(bundle, "worker-1", cfg_path, server)

    assert entry.worker_id
    assert entry.signing_key_hex

    with open(cfg_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    assert len(data["platforms"]) == 1
    saved = data["platforms"][0]
    assert saved["worker_id"] == entry.worker_id
    assert saved["signing_key_hex"] == entry.signing_key_hex
    assert saved["platform_url"] == bundle["platform_url"]
    assert saved["platform_pubkey"] == bundle["platform_pubkey"]
    assert saved["certificate"] == entry.certificate


def test_register_certificate_verifies_against_platform_pubkey(server, tmp_path):
    bundle = _issue_bundle(server)
    cfg_path = str(tmp_path / "agent" / "config.json")

    entry = register(bundle, "worker-1", cfg_path, server)

    _, verify_key = security.load_platform_keys(server.data_dir)
    assert bundle["platform_pubkey"] == bytes(verify_key).hex()

    signing_key_hex = entry.signing_key_hex
    signing_key = SigningKey(bytes.fromhex(signing_key_hex))
    pubkey_hex = bytes(signing_key.verify_key).hex()
    message = f"{entry.worker_id}|{pubkey_hex}".encode()

    # Should not raise.
    VerifyKey(bytes.fromhex(bundle["platform_pubkey"])).verify(
        message, bytes.fromhex(entry.certificate)
    )


def test_register_with_forged_platform_signature_raises_certificate_invalid(server, tmp_path, monkeypatch):
    bundle = _issue_bundle(server)
    cfg_path = str(tmp_path / "agent" / "config.json")

    # Forge the certificate by signing with an unrelated key, then patch the
    # server's registration response to return it instead of the real one.
    forger = SigningKey.generate()

    orig_post = server.post

    def fake_post(url, *args, **kwargs):
        resp = orig_post(url, *args, **kwargs)
        if url.endswith("/api/agent/register") and resp.status_code == 200:
            body = resp.json()
            pubkey_hex = kwargs["json"]["pubkey"]
            forged_msg = f"{body['worker_id']}|{pubkey_hex}".encode()
            body["certificate"] = forger.sign(forged_msg).signature.hex()
            resp._content = json.dumps(body).encode()
        return resp

    monkeypatch.setattr(server, "post", fake_post)

    with pytest.raises(CertificateInvalid):
        register(bundle, "worker-1", cfg_path, server)

    # Config must not have been written on verification failure.
    cfg = AgentConfig.load(cfg_path)
    assert cfg.platforms == []
