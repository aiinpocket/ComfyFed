"""Agent-side peer HTTP server (Phase 3.1 P2P addendum, 種子端): grant
verification (signature, expiry, name, seeder-id), path sanitization/
inventory-index resolution, Range handling, bandwidth counting, and
lifecycle (start/stop), all exercised against a REAL HTTP server on an
ephemeral loopback port.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import time

import httpx
import pytest
from nacl.signing import SigningKey

from comfyfed_agent import peerserve
from comfyfed_agent.config import PlatformEntry


def _platform(worker_id="seeder-1", platform_url="http://platform.example"):
    signing_key = SigningKey.generate()
    pubkey_hex = signing_key.verify_key.encode().hex()
    entry = PlatformEntry(
        platform_url=platform_url,
        platform_pubkey=pubkey_hex,
        worker_id=worker_id,
        certificate="cert",
        signing_key_hex=signing_key.encode().hex(),
    )
    return signing_key, entry


def _sign_grant(signing_key, grant: dict) -> str:
    payload = "|".join(str(grant[f]) for f in peerserve._GRANT_FIELDS)
    return signing_key.sign(payload.encode()).signature.hex()


def _make_grant(*, name, size_bytes, seeder_id, puller_id="puller-1", expires_in=600, grant_id="g-1"):
    return {
        "grant_id": grant_id,
        "name": name,
        "size_bytes": size_bytes,
        "sha256": "a" * 64,
        "seeder_id": seeder_id,
        "puller_id": puller_id,
        "expires_at": int(time.time()) + expires_in,
    }


def _grant_header(signing_key, grant: dict, *, sig: str | None = None) -> str:
    sig = sig if sig is not None else _sign_grant(signing_key, grant)
    obj = {**grant, "sig": sig}
    return base64.b64encode(json.dumps(obj).encode()).decode()


@pytest.fixture
def server(tmp_path):
    signing_key, entry = _platform()
    content = os.urandom(5000)
    models_dir = tmp_path / "models"
    (models_dir / "diffusion_models").mkdir(parents=True)
    model_path = models_dir / "diffusion_models" / "model.bin"
    model_path.write_bytes(content)

    srv = peerserve.PeerHTTPServer(
        models_dir=str(models_dir), port=0, platforms=[entry], bind_host="127.0.0.1"
    )
    srv.start()
    try:
        yield srv, signing_key, entry, content
    finally:
        srv.stop()


def _url(srv, name="diffusion_models/model.bin"):
    return f"http://127.0.0.1:{srv.port}/peer/models/{name}"


# --- auth gate ---------------------------------------------------------


def test_no_grant_header_is_403(server):
    srv, _signing_key, _entry, _content = server
    resp = httpx.get(_url(srv))
    assert resp.status_code == 403


def test_tampered_signature_is_403(server):
    srv, signing_key, entry, content = server
    grant = _make_grant(name="diffusion_models/model.bin", size_bytes=len(content), seeder_id=entry.worker_id)
    good_sig = _sign_grant(signing_key, grant)
    tampered = ("0" if good_sig[0] != "0" else "1") + good_sig[1:]
    header = _grant_header(signing_key, grant, sig=tampered)

    resp = httpx.get(_url(srv), headers={"X-ComfyFed-Grant": header})
    assert resp.status_code == 403


def test_expired_grant_is_403(server):
    srv, signing_key, entry, content = server
    grant = _make_grant(
        name="diffusion_models/model.bin", size_bytes=len(content), seeder_id=entry.worker_id, expires_in=-10
    )
    header = _grant_header(signing_key, grant)

    resp = httpx.get(_url(srv), headers={"X-ComfyFed-Grant": header})
    assert resp.status_code == 403


def test_wrong_seeder_is_403(server):
    srv, signing_key, _entry, content = server
    grant = _make_grant(name="diffusion_models/model.bin", size_bytes=len(content), seeder_id="someone-else")
    header = _grant_header(signing_key, grant)

    resp = httpx.get(_url(srv), headers={"X-ComfyFed-Grant": header})
    assert resp.status_code == 403


def test_name_mismatch_is_403(server):
    srv, signing_key, entry, content = server
    grant = _make_grant(name="diffusion_models/other.bin", size_bytes=len(content), seeder_id=entry.worker_id)
    header = _grant_header(signing_key, grant)

    resp = httpx.get(_url(srv), headers={"X-ComfyFed-Grant": header})
    assert resp.status_code == 403


def test_grant_signed_by_unpinned_platform_is_403(server):
    srv, _signing_key, entry, content = server
    other_signing_key, _other_entry = _platform(worker_id=entry.worker_id)
    grant = _make_grant(name="diffusion_models/model.bin", size_bytes=len(content), seeder_id=entry.worker_id)
    header = _grant_header(other_signing_key, grant)

    resp = httpx.get(_url(srv), headers={"X-ComfyFed-Grant": header})
    assert resp.status_code == 403


def test_unauthenticated_request_for_unknown_name_is_403_not_404(server):
    """M5 final-review fix: an unauthenticated request must not be able to
    tell "no such model" apart from "auth failed" by distinguishing 404 from
    403 -- both a present and an absent name get 403 with no grant at all,
    closing the pre-auth model-inventory oracle."""
    srv, *_ = server

    resp = httpx.get(_url(srv, name="diffusion_models/this-name-does-not-exist.bin"))
    assert resp.status_code == 403


def test_unauthenticated_request_for_a_known_name_is_also_403(server):
    srv, *_ = server

    resp = httpx.get(_url(srv))  # the real "diffusion_models/model.bin", no grant header
    assert resp.status_code == 403


# --- path sanitization / inventory-index resolution ---------------------


def test_dotdot_traversal_is_rejected(server):
    srv, signing_key, entry, content = server
    grant = _make_grant(
        name="diffusion_models/../../etc/passwd", size_bytes=len(content), seeder_id=entry.worker_id
    )
    header = _grant_header(signing_key, grant)

    resp = httpx.get(
        f"http://127.0.0.1:{srv.port}/peer/models/diffusion_models%2f..%2f..%2fetc%2fpasswd",
        headers={"X-ComfyFed-Grant": header},
    )
    assert resp.status_code in (403, 404)


def test_ntfs_ads_colon_is_rejected(server):
    srv, signing_key, entry, content = server
    grant = _make_grant(name="model.bin:secret", size_bytes=len(content), seeder_id=entry.worker_id)
    header = _grant_header(signing_key, grant)

    resp = httpx.get(
        f"http://127.0.0.1:{srv.port}/peer/models/model.bin%3asecret",
        headers={"X-ComfyFed-Grant": header},
    )
    assert resp.status_code in (403, 404)


def test_uninventoried_name_is_404_even_with_a_valid_grant(server):
    srv, signing_key, entry, _content = server
    grant = _make_grant(name="diffusion_models/never-existed.bin", size_bytes=1, seeder_id=entry.worker_id)
    header = _grant_header(signing_key, grant)

    resp = httpx.get(_url(srv, name="diffusion_models/never-existed.bin"), headers={"X-ComfyFed-Grant": header})
    assert resp.status_code == 404


# --- successful transfer + Range -----------------------------------------


def test_full_file_download_200(server):
    srv, signing_key, entry, content = server
    grant = _make_grant(name="diffusion_models/model.bin", size_bytes=len(content), seeder_id=entry.worker_id)
    header = _grant_header(signing_key, grant)

    resp = httpx.get(_url(srv), headers={"X-ComfyFed-Grant": header})
    assert resp.status_code == 200
    assert resp.content == content


def test_range_request_returns_exact_bytes_206(server):
    srv, signing_key, entry, content = server
    grant = _make_grant(name="diffusion_models/model.bin", size_bytes=len(content), seeder_id=entry.worker_id)
    header = _grant_header(signing_key, grant)

    resp = httpx.get(
        _url(srv), headers={"X-ComfyFed-Grant": header, "Range": "bytes=100-199"}
    )
    assert resp.status_code == 206
    assert resp.content == content[100:200]
    assert resp.headers["Content-Range"] == f"bytes 100-199/{len(content)}"
    assert resp.headers["Content-Length"] == "100"


def test_open_ended_range_returns_rest_of_file_206(server):
    srv, signing_key, entry, content = server
    grant = _make_grant(name="diffusion_models/model.bin", size_bytes=len(content), seeder_id=entry.worker_id)
    header = _grant_header(signing_key, grant)

    resp = httpx.get(
        _url(srv), headers={"X-ComfyFed-Grant": header, "Range": f"bytes={len(content) - 50}-"}
    )
    assert resp.status_code == 206
    assert resp.content == content[-50:]


def test_multi_range_is_416(server):
    srv, signing_key, entry, content = server
    grant = _make_grant(name="diffusion_models/model.bin", size_bytes=len(content), seeder_id=entry.worker_id)
    header = _grant_header(signing_key, grant)

    resp = httpx.get(
        _url(srv), headers={"X-ComfyFed-Grant": header, "Range": "bytes=0-10,20-30"}
    )
    assert resp.status_code == 416


def test_out_of_bounds_range_is_416(server):
    srv, signing_key, entry, content = server
    grant = _make_grant(name="diffusion_models/model.bin", size_bytes=len(content), seeder_id=entry.worker_id)
    header = _grant_header(signing_key, grant)

    resp = httpx.get(
        _url(srv), headers={"X-ComfyFed-Grant": header, "Range": f"bytes={len(content) + 100}-{len(content) + 200}"}
    )
    assert resp.status_code == 416


# --- bandwidth accounting -------------------------------------------------


def test_bytes_served_counter_is_accurate(server):
    srv, signing_key, entry, content = server
    grant = _make_grant(name="diffusion_models/model.bin", size_bytes=len(content), seeder_id=entry.worker_id, grant_id="g-count")
    header = _grant_header(signing_key, grant)

    httpx.get(_url(srv), headers={"X-ComfyFed-Grant": header, "Range": "bytes=0-999"})
    httpx.get(_url(srv), headers={"X-ComfyFed-Grant": header, "Range": "bytes=1000-1999"})

    served = srv.pop_served()
    assert served["g-count"] == 2000
    # A second pop with nothing new served in between reads back to zero.
    assert srv.pop_served().get("g-count", 0) == 0


def test_grant_seen_once_is_logged_once(server, caplog):
    srv, signing_key, entry, content = server
    grant = _make_grant(name="diffusion_models/model.bin", size_bytes=len(content), seeder_id=entry.worker_id, grant_id="g-log")
    header = _grant_header(signing_key, grant)

    import logging

    with caplog.at_level(logging.INFO, logger="comfyfed_agent.peerserve"):
        httpx.get(_url(srv), headers={"X-ComfyFed-Grant": header, "Range": "bytes=0-9"})
        httpx.get(_url(srv), headers={"X-ComfyFed-Grant": header, "Range": "bytes=10-19"})

    matching = [r for r in caplog.records if "g-log" in r.getMessage()]
    assert len(matching) == 1


# --- lifecycle -------------------------------------------------------------


def test_stop_closes_the_listening_port(tmp_path):
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    _signing_key, entry = _platform()
    srv = peerserve.PeerHTTPServer(models_dir=str(models_dir), port=0, platforms=[entry], bind_host="127.0.0.1")
    srv.start()
    port = srv.port

    # Sanity: the port answers something while running.
    httpx.get(f"http://127.0.0.1:{port}/peer/models/nope", timeout=2.0)

    srv.stop()

    with pytest.raises((httpx.TransportError, ConnectionRefusedError, OSError)):
        httpx.get(f"http://127.0.0.1:{port}/peer/models/nope", timeout=2.0)


# --- config gating ---------------------------------------------------------


def test_is_enabled_requires_both_flag_and_port():
    from comfyfed_agent.config import AgentConfig

    assert peerserve.is_enabled(AgentConfig(peer_serve=False, peer_listen_port=8850)) is False
    assert peerserve.is_enabled(AgentConfig(peer_serve=True, peer_listen_port=None)) is False
    assert peerserve.is_enabled(AgentConfig(peer_serve=True, peer_listen_port=8850)) is True


def test_advertised_url_uses_explicit_host_when_set():
    from comfyfed_agent.config import AgentConfig

    cfg = AgentConfig(peer_serve=True, peer_listen_port=8850, peer_advertise_host="203.0.113.5")
    assert peerserve.advertised_url(cfg) == "http://203.0.113.5:8850"


def test_advertised_url_is_none_when_disabled():
    from comfyfed_agent.config import AgentConfig

    cfg = AgentConfig(peer_serve=False, peer_listen_port=None)
    assert peerserve.advertised_url(cfg) is None


# --- M4: bounded report retries ---------------------------------------------


def test_grant_tracker_record_failed_attempt_counts_up():
    tracker = peerserve._GrantTracker()
    assert tracker.record_failed_attempt("g1") == 1
    assert tracker.record_failed_attempt("g1") == 2
    assert tracker.record_failed_attempt("g2") == 1


def test_report_due_grants_gives_up_after_max_attempts(server, caplog, monkeypatch):
    """A grant that keeps failing to report (e.g. the platform has pruned it,
    or any other persistent rejection) must not retry forever --
    `_MAX_REPORT_ATTEMPTS` failures give up and mark it reported so the
    reporter loop drops it, logging once at WARNING."""
    import logging

    srv, signing_key, entry, _content = server
    # expires_in=-10: already expired, so due_for_report fires immediately
    # regardless of the idle-seconds default (a monkeypatched module
    # constant would NOT retroactively change due_for_report's bound default
    # parameter, since that's captured at function-definition time).
    grant = _make_grant(
        name="diffusion_models/model.bin", size_bytes=5000, seeder_id=entry.worker_id, expires_in=-10
    )
    srv._tracker.note_grant(grant, entry)
    srv._tracker.add_bytes(grant["grant_id"], 1234)

    monkeypatch.setattr(srv, "_post_peer_served", lambda *a, **k: False)

    with caplog.at_level(logging.WARNING, logger="comfyfed_agent.peerserve"):
        for _ in range(peerserve._MAX_REPORT_ATTEMPTS):
            srv._report_due_grants()

    assert grant["grant_id"] in srv._tracker._reported
    assert any("giving up reporting bandwidth" in r.message for r in caplog.records)


def test_report_due_grants_succeeds_before_hitting_the_cap(server, monkeypatch):
    srv, signing_key, entry, _content = server
    grant = _make_grant(
        name="diffusion_models/model.bin", size_bytes=5000, seeder_id=entry.worker_id, expires_in=-10
    )
    srv._tracker.note_grant(grant, entry)
    srv._tracker.add_bytes(grant["grant_id"], 1234)

    calls = {"n": 0}

    def _fake_post(*a, **k):
        calls["n"] += 1
        return calls["n"] >= 2  # fails once, then succeeds

    monkeypatch.setattr(srv, "_post_peer_served", _fake_post)

    srv._report_due_grants()
    assert grant["grant_id"] not in srv._tracker._reported
    srv._report_due_grants()
    assert grant["grant_id"] in srv._tracker._reported
    assert calls["n"] == 2


# --- M6: listener hardening -------------------------------------------------


def test_handler_class_has_a_socket_timeout(server):
    srv, *_ = server
    handler_cls = srv._httpd.RequestHandlerClass
    assert getattr(handler_cls, "timeout", None) == 30


def test_daemon_threads_enabled(server):
    srv, *_ = server
    assert srv._httpd.daemon_threads is True


def test_peer_bind_host_config_defaults_to_all_interfaces():
    from comfyfed_agent.config import AgentConfig

    cfg = AgentConfig(peer_serve=True, peer_listen_port=8850)
    assert cfg.peer_bind_host == "0.0.0.0"


def test_peer_bind_host_config_can_be_overridden():
    from comfyfed_agent.config import AgentConfig

    cfg = AgentConfig(peer_serve=True, peer_listen_port=8850, peer_bind_host="127.0.0.1")
    assert cfg.peer_bind_host == "127.0.0.1"
