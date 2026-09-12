import hashlib

import httpx
import pytest
from nacl.signing import SigningKey

from comfyfed_agent.config import PlatformEntry
from comfyfed_agent.update import UpdateDecision, apply_update, check, parse_version


def _entry(platform_pubkey: str = "00" * 32) -> PlatformEntry:
    return PlatformEntry(
        platform_url="http://testplatform",
        platform_pubkey=platform_pubkey,
        worker_id="worker-1",
        certificate="ab",
        signing_key_hex=bytes(SigningKey.generate()).hex(),
    )


class _FakeResponse:
    def __init__(self, json_body=None, content=b"", status_code=200):
        self._json_body = json_body
        self.content = content
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("error", request=None, response=self)

    def json(self):
        return self._json_body


class _FakeClient:
    def __init__(self, version_body=None, wheel_bytes=b"", raise_on_version=False):
        self.version_body = version_body
        self.wheel_bytes = wheel_bytes
        self.raise_on_version = raise_on_version
        self.get_calls = []

    def get(self, url):
        self.get_calls.append(url)
        if url.endswith("/api/agent/version"):
            if self.raise_on_version:
                raise httpx.ConnectError("boom")
            return _FakeResponse(json_body=self.version_body)
        return _FakeResponse(content=self.wheel_bytes)


def test_parse_version():
    assert parse_version("0.1.0") == (0, 1, 0)
    assert parse_version("1.2.10") < parse_version("1.2.11")


def test_check_ok_when_current_is_latest():
    entry = _entry()
    client = _FakeClient(version_body={"latest": "0.1.0", "min_supported": "0.1.0"})
    decision = check(entry, "0.1.0", client)
    assert decision.action == "ok"


def test_check_update_when_newer_version_and_wheel_available():
    entry = _entry()
    client = _FakeClient(
        version_body={
            "latest": "0.2.0",
            "min_supported": "0.1.0",
            "wheel_url": "http://testplatform/api/agent/releases/agent-0.2.0.whl",
            "sha256": "deadbeef",
            "platform_sig": "abcd",
        }
    )
    decision = check(entry, "0.1.0", client)
    assert decision.action == "update"
    assert decision.wheel_url == "http://testplatform/api/agent/releases/agent-0.2.0.whl"


def test_check_blocked_when_current_below_min_supported():
    entry = _entry()
    client = _FakeClient(version_body={"latest": "0.3.0", "min_supported": "0.2.0"})
    decision = check(entry, "0.1.0", client)
    assert decision.action == "blocked"


def test_check_network_error_is_ok_not_blocking():
    entry = _entry()
    client = _FakeClient(raise_on_version=True)
    decision = check(entry, "0.1.0", client)
    assert decision.action == "ok"


def test_apply_update_bad_signature_rejected_and_pip_not_called():
    signing_key = SigningKey.generate()
    other_key = SigningKey.generate()  # wrong key signs -> signature won't verify
    entry = _entry(platform_pubkey=bytes(signing_key.verify_key).hex())

    wheel_bytes = b"fake wheel contents"
    sha256 = hashlib.sha256(wheel_bytes).hexdigest()
    bad_sig = other_key.sign(sha256.encode()).signature.hex()

    decision = UpdateDecision(
        action="update",
        latest="0.2.0",
        min_supported="0.1.0",
        wheel_url="http://testplatform/api/agent/releases/agent-0.2.0.whl",
        sha256=sha256,
        platform_sig=bad_sig,
    )
    client = _FakeClient(wheel_bytes=wheel_bytes)

    pip_calls = []
    restart_calls = []
    ok = apply_update(
        entry,
        decision,
        client,
        pip_install=lambda path: pip_calls.append(path),
        restart=lambda: restart_calls.append(True),
    )

    assert ok is False
    assert pip_calls == []
    assert restart_calls == []


def test_apply_update_good_signature_installs_and_restarts():
    signing_key = SigningKey.generate()
    entry = _entry(platform_pubkey=bytes(signing_key.verify_key).hex())

    wheel_bytes = b"fake wheel contents"
    sha256 = hashlib.sha256(wheel_bytes).hexdigest()
    good_sig = signing_key.sign(sha256.encode()).signature.hex()

    decision = UpdateDecision(
        action="update",
        latest="0.2.0",
        min_supported="0.1.0",
        wheel_url="http://testplatform/api/agent/releases/agent-0.2.0.whl",
        sha256=sha256,
        platform_sig=good_sig,
    )
    client = _FakeClient(wheel_bytes=wheel_bytes)

    pip_calls = []
    restart_calls = []

    def _fake_pip_install(path):
        with open(path, "rb") as f:
            data = f.read()
        assert hashlib.sha256(data).hexdigest() == sha256
        pip_calls.append(path)

    ok = apply_update(
        entry,
        decision,
        client,
        pip_install=_fake_pip_install,
        restart=lambda: restart_calls.append(True),
    )

    assert ok is True
    assert len(pip_calls) == 1
    assert restart_calls == [True]


def test_apply_update_missing_wheel_info_rejected():
    entry = _entry()
    decision = UpdateDecision(action="ok", latest="0.1.0", min_supported="0.1.0")
    client = _FakeClient()

    pip_calls = []
    ok = apply_update(entry, decision, client, pip_install=lambda path: pip_calls.append(path))

    assert ok is False
    assert pip_calls == []
