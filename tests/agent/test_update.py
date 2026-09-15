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
    # No wheel_url in the body: nothing can be fetched, so "blocked" is the
    # only honest answer. (With a wheel present this must be "update" -- see
    # the landmine test right below.)
    entry = _entry()
    client = _FakeClient(version_body={"latest": "0.3.0", "min_supported": "0.2.0"})
    decision = check(entry, "0.1.0", client)
    assert decision.action == "blocked"


def test_check_below_min_supported_with_a_wheel_is_a_mandatory_update_not_blocked():
    """The live landmine: the platform raises min_supported to latest on
    EVERY publish, so with "blocked" taking precedence every agent that merely
    restarted after a release exited 3 -- never reaching the self-update
    branch that had a signed wheel waiting. Below-min + fetchable wheel must
    be an UPDATE (auto-heal), so a reboot converges instead of dying."""
    entry = _entry()
    client = _FakeClient(
        version_body={
            "latest": "0.3.0",
            "min_supported": "0.3.0",  # == latest, exactly what publish does
            "wheel_url": "http://testplatform/api/agent/releases/agent-0.3.0.whl",
            "sha256": "deadbeef",
            "platform_sig": "abcd",
        }
    )
    decision = check(entry, "0.1.0", client)
    assert decision.action == "update"
    assert decision.wheel_url == "http://testplatform/api/agent/releases/agent-0.3.0.whl"
    assert decision.min_supported == "0.3.0"


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
    bad_sig = other_key.sign(f"0.2.0|{sha256}".encode()).signature.hex()

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
    good_sig = signing_key.sign(f"0.2.0|{sha256}".encode()).signature.hex()

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


def test_apply_update_joins_a_relative_wheel_url_onto_the_platform_url():
    """Live-caught: the cloud platform advertises the wheel as a path
    relative to itself ("/api/agent/releases/<file>"), and apply_update
    handed that bare path straight to the HTTP client -- an unfetchable URL,
    so every self-update silently failed with "Failed to download wheel"
    and the old build kept running. A relative wheel_url must be joined
    onto the entry's pinned platform_url; an absolute one passes through."""
    signing_key = SigningKey.generate()
    entry = _entry(platform_pubkey=bytes(signing_key.verify_key).hex())

    wheel_bytes = b"fake wheel contents"
    sha256 = hashlib.sha256(wheel_bytes).hexdigest()
    good_sig = signing_key.sign(f"0.2.0|{sha256}".encode()).signature.hex()

    decision = UpdateDecision(
        action="update",
        latest="0.2.0",
        min_supported="0.1.0",
        wheel_url="/api/agent/releases/agent-0.2.0.whl",  # RELATIVE, as the cloud serves it
        sha256=sha256,
        platform_sig=good_sig,
    )

    requested: list[str] = []

    class _RecordingClient:
        def get(self, url):
            requested.append(url)
            return _FakeResponse(content=wheel_bytes)

    ok = apply_update(
        entry,
        decision,
        _RecordingClient(),
        pip_install=lambda path: None,
        restart=lambda: None,
    )

    assert ok is True
    assert requested == [entry.platform_url.rstrip("/") + "/api/agent/releases/agent-0.2.0.whl"]
    assert requested[0].startswith("http")


def test_apply_update_pip_install_raises_returns_false_and_no_restart():
    import subprocess

    signing_key = SigningKey.generate()
    entry = _entry(platform_pubkey=bytes(signing_key.verify_key).hex())

    wheel_bytes = b"fake wheel contents"
    sha256 = hashlib.sha256(wheel_bytes).hexdigest()
    good_sig = signing_key.sign(f"0.2.0|{sha256}".encode()).signature.hex()

    decision = UpdateDecision(
        action="update",
        latest="0.2.0",
        min_supported="0.1.0",
        wheel_url="http://testplatform/api/agent/releases/agent-0.2.0.whl",
        sha256=sha256,
        platform_sig=good_sig,
    )
    client = _FakeClient(wheel_bytes=wheel_bytes)

    restart_calls = []

    def _failing_pip_install(path):
        raise subprocess.CalledProcessError(1, ["pip", "install", path])

    ok = apply_update(
        entry,
        decision,
        client,
        pip_install=_failing_pip_install,
        restart=lambda: restart_calls.append(True),
    )

    assert ok is False
    assert restart_calls == []


def test_apply_update_missing_wheel_info_rejected():
    entry = _entry()
    decision = UpdateDecision(action="ok", latest="0.1.0", min_supported="0.1.0")
    client = _FakeClient()

    pip_calls = []
    ok = apply_update(entry, decision, client, pip_install=lambda path: pip_calls.append(path))

    assert ok is False
    assert pip_calls == []


def test_parse_version_non_numeric_segment_returns_sentinel_instead_of_raising():
    assert parse_version("0.2.0rc1") == (0,)
    assert parse_version("") == (0,)
    assert parse_version("0.2.0rc1") < parse_version("0.1.0")


def test_check_with_unparseable_latest_is_ok_not_a_crash():
    entry = _entry()
    client = _FakeClient(
        version_body={
            "latest": "0.2.0rc1",
            "min_supported": "0.1.0",
            "wheel_url": "http://testplatform/api/agent/releases/agent-0.2.0rc1.whl",
            "sha256": "deadbeef",
            "platform_sig": "abcd",
        }
    )
    decision = check(entry, "0.1.0", client)
    assert decision.action == "ok"


def test_apply_update_rejects_a_signature_bound_to_another_version():
    """A (sha256, sig) pair from release 0.1.5 must not validate as 0.2.0.

    Without the version in the signed payload an attacker who controls the
    version endpoint could replay an old release's signature under a newer
    version number and force a downgrade.
    """
    signing_key = SigningKey.generate()
    entry = _entry(platform_pubkey=bytes(signing_key.verify_key).hex())

    wheel_bytes = b"old vulnerable wheel"
    sha256 = hashlib.sha256(wheel_bytes).hexdigest()
    sig_for_old_version = signing_key.sign(f"0.1.5|{sha256}".encode()).signature.hex()

    decision = UpdateDecision(
        action="update",
        latest="0.2.0",  # advertised as something newer
        min_supported="0.1.0",
        wheel_url="http://testplatform/api/agent/releases/agent-0.2.0.whl",
        sha256=sha256,
        platform_sig=sig_for_old_version,
    )

    pip_calls = []
    ok = apply_update(
        entry,
        decision,
        _FakeClient(wheel_bytes=wheel_bytes),
        pip_install=lambda path: pip_calls.append(path),
        restart=lambda: None,
    )

    assert ok is False
    assert pip_calls == []
