"""`comfyfed-server publish-agent`: the release-publishing path end to end.

Publishing writes the settings that GET /api/agent/version serves, and the
signature it produces must be the one the agent's updater verifies -- so this
runs the real publisher and then the real agent-side check + apply against it.
"""

import hashlib

import pytest
from fastapi.testclient import TestClient

from comfyfed_agent.config import PlatformEntry
from comfyfed_agent.update import apply_update, check
from comfyfed_server import app as app_module
from comfyfed_server import bootstrap, main, security


WHEEL_BYTES = b"PK\x03\x04 pretend this is a wheel"


@pytest.fixture()
def data_dir(tmp_path):
    d = str(tmp_path / "server-data")
    bootstrap.ensure_installed(d, lang="en", url="http://h", interactive=False)
    return d


@pytest.fixture()
def wheel(tmp_path):
    path = tmp_path / "dist" / "comfyfed_agent-0.2.0-py3-none-any.whl"
    path.parent.mkdir(parents=True)
    path.write_bytes(WHEEL_BYTES)
    return str(path)


def test_publish_agent_writes_settings_and_copies_the_wheel(data_dir, wheel):
    published = main.publish_agent(data_dir, wheel)

    assert published["agent_latest"] == "0.2.0"
    assert published["agent_min_supported"] == "0.2.0"
    assert published["agent_wheel_url"] == (
        "/api/agent/releases/comfyfed_agent-0.2.0-py3-none-any.whl"
    )
    assert published["agent_wheel_sha256"] == hashlib.sha256(WHEEL_BYTES).hexdigest()

    # The signature covers "{version}|{sha256}" (see M2), not the digest alone.
    _, verify_key = security.load_platform_keys(data_dir)
    payload = f"{published['agent_latest']}|{published['agent_wheel_sha256']}"
    verify_key.verify(payload.encode(), bytes.fromhex(published["agent_wheel_sig"]))


def test_publish_agent_honours_explicit_version_bounds(data_dir, wheel):
    published = main.publish_agent(data_dir, wheel, latest="0.3.0", min_supported="0.2.0")
    assert published["agent_latest"] == "0.3.0"
    assert published["agent_min_supported"] == "0.2.0"


def test_publish_agent_rejects_a_missing_wheel(data_dir, tmp_path):
    with pytest.raises(SystemExit):
        main.publish_agent(data_dir, str(tmp_path / "nope.whl"))


def test_publish_agent_rejects_a_non_wheel_file(data_dir, tmp_path):
    other = tmp_path / "notes.txt"
    other.write_text("hi", encoding="utf-8")
    with pytest.raises(SystemExit):
        main.publish_agent(data_dir, str(other))


def test_published_release_is_accepted_by_the_agent_updater(data_dir, wheel, monkeypatch):
    """The full loop: publish, then check + apply from the agent side."""
    published = main.publish_agent(data_dir, wheel, min_supported="0.1.0")

    app = app_module.create_app(data_dir)
    server = TestClient(app)

    _, verify_key = security.load_platform_keys(data_dir)
    entry = PlatformEntry(
        platform_url="",  # TestClient resolves relative URLs against the app
        platform_pubkey=bytes(verify_key).hex(),
        worker_id="w1",
        certificate="cert",
        signing_key_hex="11" * 32,
    )

    decision = check(entry, "0.1.0", server)
    assert decision.action == "update"
    assert decision.latest == "0.2.0"
    assert decision.sha256 == published["agent_wheel_sha256"]

    pip_calls = []
    restart_calls = []

    def fake_pip_install(path):
        with open(path, "rb") as f:
            assert f.read() == WHEEL_BYTES
        pip_calls.append(path)

    ok = apply_update(
        entry,
        decision,
        server,
        pip_install=fake_pip_install,
        restart=lambda: restart_calls.append(True),
    )

    assert ok is True
    assert len(pip_calls) == 1
    assert restart_calls == [True]


def test_agent_version_endpoint_serves_the_published_release(data_dir, wheel):
    published = main.publish_agent(data_dir, wheel)
    server = TestClient(app_module.create_app(data_dir))

    body = server.get("/api/agent/version").json()
    assert body["latest"] == "0.2.0"
    assert body["sha256"] == published["agent_wheel_sha256"]

    # And the wheel itself is downloadable from the advertised URL.
    download = server.get(published["agent_wheel_url"])
    assert download.status_code == 200
    assert download.content == WHEEL_BYTES
