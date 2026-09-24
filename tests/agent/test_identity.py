"""`identity.register` against a fake platform.

The platform side is an `httpx.MockTransport` that behaves like
`POST /api/agent/register` on the real (TypeScript) server: it mints a
worker id and signs `f"{worker_id}|{pubkey_hex}"` with the platform key --
the same payload `cloud/src/lib/signing.ts`'s `signRegistration` produces.
"""

import json
import uuid

import httpx
import pytest
from nacl.signing import SigningKey, VerifyKey

from comfyfed_agent.identity import CertificateInvalid, register

PLATFORM_URL = "http://platform.test"


class FakePlatform:
    """Signs registrations with `key`; `forge_with` swaps in a wrong key."""

    def __init__(self, forge_with: SigningKey | None = None) -> None:
        self.key = SigningKey.generate()
        self.forge_with = forge_with
        self.tokens_seen: list[str] = []

    @property
    def pubkey_hex(self) -> str:
        return self.key.verify_key.encode().hex()

    def bundle(self, token: str = "tok-1") -> dict:
        return {"platform_url": PLATFORM_URL, "platform_pubkey": self.pubkey_hex, "register_token": token}

    def handle(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/agent/register"
        body = json.loads(request.content)
        self.tokens_seen.append(body["token"])
        worker_id = str(uuid.uuid4())
        signer = self.forge_with or self.key
        certificate = signer.sign(f"{worker_id}|{body['pubkey']}".encode()).signature.hex()
        return httpx.Response(200, json={"worker_id": worker_id, "certificate": certificate})

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handle))


@pytest.fixture()
def platform() -> FakePlatform:
    return FakePlatform()


def _saved_platforms(cfg_path: str) -> list[dict]:
    with open(cfg_path, "r", encoding="utf-8") as f:
        return json.load(f)["platforms"]


def test_register_writes_config_with_worker_id_and_signing_key(platform, tmp_path):
    cfg_path = str(tmp_path / "agent" / "config.json")
    bundle = platform.bundle()

    with platform.client() as client:
        entry = register(bundle, "worker-1", cfg_path, client)

    assert entry.worker_id
    assert entry.signing_key_hex
    assert platform.tokens_seen == ["tok-1"]

    (saved,) = _saved_platforms(cfg_path)
    assert saved["worker_id"] == entry.worker_id
    assert saved["signing_key_hex"] == entry.signing_key_hex
    assert saved["platform_url"] == bundle["platform_url"]
    assert saved["platform_pubkey"] == bundle["platform_pubkey"]
    assert saved["certificate"] == entry.certificate


def test_register_twice_to_same_platform_replaces_the_prior_entry(platform, tmp_path):
    """Re-installing to the same platform must replace, not append: two
    entries for one URL made the agent open two sockets and get 4401 on the
    stale one forever (live incident)."""
    cfg_path = str(tmp_path / "agent" / "config.json")

    with platform.client() as client:
        first = register(platform.bundle("tok-1"), "worker-1", cfg_path, client)
        second = register(platform.bundle("tok-2"), "worker-1", cfg_path, client)

    (saved,) = _saved_platforms(cfg_path)
    assert saved["worker_id"] == second.worker_id
    assert saved["worker_id"] != first.worker_id


def test_register_leaves_an_entry_for_a_different_platform_alone(platform, tmp_path):
    cfg_path = str(tmp_path / "agent" / "config.json")
    other = FakePlatform()
    other_bundle = {**other.bundle(), "platform_url": "http://other.test"}

    with platform.client() as client:
        register(platform.bundle(), "worker-1", cfg_path, client)
    with other.client() as client:
        register(other_bundle, "worker-1", cfg_path, client)

    urls = sorted(p["platform_url"] for p in _saved_platforms(cfg_path))
    assert urls == ["http://other.test", PLATFORM_URL]


def test_register_certificate_verifies_against_platform_pubkey(platform, tmp_path):
    cfg_path = str(tmp_path / "agent" / "config.json")
    with platform.client() as client:
        entry = register(platform.bundle(), "worker-1", cfg_path, client)

    pubkey = SigningKey(bytes.fromhex(entry.signing_key_hex)).verify_key.encode().hex()
    VerifyKey(bytes.fromhex(platform.pubkey_hex)).verify(
        f"{entry.worker_id}|{pubkey}".encode(), bytes.fromhex(entry.certificate)
    )


def test_register_with_forged_platform_signature_raises_certificate_invalid(tmp_path):
    forged = FakePlatform(forge_with=SigningKey.generate())
    cfg_path = str(tmp_path / "agent" / "config.json")

    with forged.client() as client, pytest.raises(CertificateInvalid):
        register(forged.bundle(), "worker-1", cfg_path, client)
