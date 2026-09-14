"""Tests for `model_manifest`: server-learned model hashes (consensus +
conflict handling) and the platform-signed fetch manifest built from them.
"""

import hashlib
import logging
import secrets
import time

import pytest
from fastapi.testclient import TestClient
from nacl.exceptions import BadSignatureError
from nacl.signing import SigningKey, VerifyKey

from comfyfed_server import app as app_module
from comfyfed_server import bootstrap, db, model_guide, model_manifest, security


@pytest.fixture()
def data_dir(tmp_path):
    d = str(tmp_path)
    bootstrap.ensure_installed(d, lang="en", url="http://h", interactive=False)
    yield d


def _sha(label: str) -> str:
    return hashlib.sha256(label.encode()).hexdigest()


def _bytes(gb: float) -> int:
    """Exact byte count for a GB figure, matching what an agent's
    `os.stat().st_size` would be for a file of exactly this size -- used to
    build test fixtures that call `record_hash` with an exact size_bytes,
    same as `agentws._record_model_hashes` does for a Task 1+ agent."""
    return round(gb * (1024 ** 3))


# --- record_hash: consensus + conflict -----------------------------------


def test_record_hash_first_report_inserts_row(data_dir):
    model_manifest.record_hash("w1", "text_encoders/clip_l.safetensors", _bytes(0.23), _sha("a"))

    with db.get_session() as session:
        row = session.get(db.ModelHash, ("text_encoders/clip_l.safetensors", _bytes(0.23)))
        assert row is not None
        assert row.sha256 == _sha("a")
        assert row.first_worker_id == "w1"


def test_record_hash_matching_repeat_is_a_noop(data_dir):
    model_manifest.record_hash("w1", "clip_l.safetensors", _bytes(0.23), _sha("a"))
    model_manifest.record_hash("w2", "clip_l.safetensors", _bytes(0.23), _sha("a"))

    with db.get_session() as session:
        row = session.get(db.ModelHash, ("clip_l.safetensors", _bytes(0.23)))
        assert row.first_worker_id == "w1"  # untouched, not overwritten
        assert row.sha256 == _sha("a")
        assert row.conflict is False


def test_record_hash_conflict_does_not_overwrite_the_hash_but_marks_the_row_conflicted(data_dir, caplog):
    model_manifest.record_hash("worker-first", "clip_l.safetensors", _bytes(0.23), _sha("a"))
    with caplog.at_level(logging.WARNING, logger="comfyfed_server.model_manifest"):
        model_manifest.record_hash("worker-second", "clip_l.safetensors", _bytes(0.23), _sha("b"))

    with db.get_session() as session:
        row = session.get(db.ModelHash, ("clip_l.safetensors", _bytes(0.23)))
        assert row.sha256 == _sha("a")  # first-seen hash kept
        assert row.conflict is True

    assert any(
        r.levelno == logging.WARNING
        and "worker-first" in r.message
        and "worker-second" in r.message
        for r in caplog.records
    )


def test_record_hash_different_sizes_are_independent_keys(data_dir):
    """Same name, different exact size -> different PK, no conflict."""
    model_manifest.record_hash("w1", "clip_l.safetensors", _bytes(0.23), _sha("a"))
    model_manifest.record_hash("w2", "clip_l.safetensors", _bytes(9.12), _sha("b"))

    with db.get_session() as session:
        row1 = session.get(db.ModelHash, ("clip_l.safetensors", _bytes(0.23)))
        row2 = session.get(db.ModelHash, ("clip_l.safetensors", _bytes(9.12)))
        assert row1.sha256 == _sha("a")
        assert row1.conflict is False
        assert row2.sha256 == _sha("b")
        assert row2.conflict is False


# --- entries(): the signed manifest ---------------------------------------


def test_entries_excludes_model_with_no_learned_hash(data_dir):
    names = {e["name"] for e in model_manifest.entries(data_dir)}
    assert "clip_l.safetensors" not in names


def test_entries_excludes_hash_with_no_matching_source(data_dir):
    model_manifest.record_hash("w1", "loras/totally_unknown_model.safetensors", _bytes(1.0), _sha("a"))
    names = {e["name"] for e in model_manifest.entries(data_dir)}
    assert "totally_unknown_model.safetensors" not in names


def test_entries_includes_curated_model_with_agreed_hash_and_valid_signature(data_dir):
    sha = _sha("clip")
    model_manifest.record_hash("w1", "text_encoders/clip_l.safetensors", _bytes(0.23), sha)

    entries = model_manifest.entries(data_dir)
    matches = [e for e in entries if e["name"] == "clip_l.safetensors"]
    assert len(matches) == 1
    entry = matches[0]

    assert entry["directory"] == "text_encoders"
    assert entry["url"] == (
        "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors"
    )
    assert entry["backup_url"] == (
        "https://storage.googleapis.com/comfyfed-models/models/text_encoders/clip_l.safetensors"
    )
    assert entry["sha256"] == sha
    assert entry["size_bytes"] == _bytes(0.23)
    assert isinstance(entry["size_bytes"], int)

    _, verify_key = security.load_platform_keys(data_dir)
    payload = f"{entry['name']}|{entry['directory']}|{entry['sha256']}|{entry['size_bytes']}"
    verify_key.verify(payload.encode(), bytes.fromhex(entry["sig"]))  # raises on mismatch


def test_entries_signature_does_not_verify_against_a_tampered_field(data_dir):
    sha = _sha("clip")
    model_manifest.record_hash("w1", "text_encoders/clip_l.safetensors", _bytes(0.23), sha)
    entry = next(e for e in model_manifest.entries(data_dir) if e["name"] == "clip_l.safetensors")

    _, verify_key = security.load_platform_keys(data_dir)
    tampered = f"{entry['name']}|{entry['directory']}|{entry['sha256']}|{entry['size_bytes'] + 1}"
    with pytest.raises(BadSignatureError):
        verify_key.verify(tampered.encode(), bytes.fromhex(entry["sig"]))


def test_entries_excludes_a_conflicted_name_even_with_an_agreed_first_row_present(data_dir):
    """A conflicted name's ORIGINAL (first-seen) row is still in
    model_hashes (never deleted, sha256/first_worker_id untouched), but the
    manifest must still exclude it -- `conflict=True` means "two workers
    disagree on this name", which the first-seen row surviving does not
    resolve.
    """
    model_manifest.record_hash("w1", "text_encoders/clip_l.safetensors", _bytes(0.23), _sha("a"))
    model_manifest.record_hash("w2", "text_encoders/clip_l.safetensors", _bytes(0.23), _sha("b"))

    names = {e["name"] for e in model_manifest.entries(data_dir)}
    assert "clip_l.safetensors" not in names


def test_conflict_exclusion_survives_a_restart_because_it_is_a_persisted_column(data_dir, caplog):
    """Fix round 1: `conflict` is a real, persisted `model_hashes` column
    (migration c9d0e1f2a3b4), not the old in-memory/per-process poisoned-name
    set -- so unlike that design, nothing needs to be "re-learned" after a
    restart. Simulate a restart by simply calling `entries()` again with a
    fresh `data_dir`-scoped session (there is no in-memory state left to
    clear) -- the exclusion holds immediately, before any new inventory
    report ever arrives.
    """
    model_manifest.record_hash("worker-first", "clip_l.safetensors", _bytes(0.23), _sha("a"))
    with caplog.at_level(logging.WARNING, logger="comfyfed_server.model_manifest"):
        model_manifest.record_hash("worker-second", "clip_l.safetensors", _bytes(0.23), _sha("b"))

    with db.get_session() as session:
        row = session.get(db.ModelHash, ("clip_l.safetensors", _bytes(0.23)))
        assert row.conflict is True

    # "Restart": nothing to reset (no module-level state exists to survive
    # or be forgotten) -- the exclusion is simply read straight from the row
    # every time, so it is correct on the very next call, immediately.
    names = {e["name"] for e in model_manifest.entries(data_dir)}
    assert "clip_l.safetensors" not in names


def test_entries_size_bytes_comes_from_the_learned_row_not_model_guide_size_gb(data_dir):
    """clip_l.safetensors' curated size_gb is 0.23; report a deliberately
    DIFFERENT learned size so the two can't be confused."""
    sha = _sha("clip")
    model_manifest.record_hash("w1", "text_encoders/clip_l.safetensors", _bytes(0.5), sha)

    entry = next(e for e in model_manifest.entries(data_dir) if e["name"] == "clip_l.safetensors")
    assert entry["size_bytes"] == _bytes(0.5)
    assert entry["size_bytes"] != _bytes(0.23)


def test_entries_skips_a_candidate_whose_name_contains_the_payload_delimiter(data_dir, monkeypatch):
    """`|` is the field delimiter in the signed payload
    (`name|directory|sha256|size_bytes`) -- a source whose name or directory
    contains one could shift which substring later gets parsed as which
    field, so it must never reach a signature. Simulate via a harvested-style
    source injected straight into `model_guide.SOURCES` (a harvested entry's
    name/directory come off a workflow JSON on disk -- untrusted relative to
    this process, exactly the case this guard exists for).
    """
    evil_name = "evil|1234|deadbeef|.safetensors"
    evil_source = model_guide.ModelSource(
        name=evil_name,
        directory="checkpoints",
        size_gb=1.0,
        official_page=None,
        official_url="https://example.invalid/evil.safetensors",
        backup_url=None,
        gated=False,
    )
    monkeypatch.setitem(model_guide.SOURCES, evil_name, evil_source)
    model_manifest.record_hash("w1", f"checkpoints/{evil_name}", _bytes(1.0), _sha("evil"))

    names = {e["name"] for e in model_manifest.entries(data_dir)}
    assert evil_name not in names


# --- routes: auth ----------------------------------------------------------


@pytest.fixture()
def client(tmp_path):
    d = str(tmp_path)
    result = bootstrap.ensure_installed(d, lang="en", url="http://h", interactive=False)
    app = app_module.create_app(d)
    c = TestClient(app)
    c.admin_password = result.admin_password
    yield c


def _login(client):
    r = client.post("/api/auth/login", json={"username": "admin", "password": client.admin_password})
    assert r.status_code == 200
    return r.json()["csrf"]


def _register_worker(client, csrf, name):
    sk = SigningKey.generate()
    pubkey_hex = bytes(sk.verify_key).hex()
    r = client.post("/api/workers/tokens", json={"name": name}, headers={"X-CSRF": csrf})
    token = r.json()["bundle"]["register_token"]
    reg = client.post("/api/agent/register", json={"token": token, "name": name, "pubkey": pubkey_hex})
    return reg.json()["worker_id"], sk


def _agent_get(client, worker_id, signing_key, path):
    ts = str(int(time.time()))
    nonce = secrets.token_hex(8)
    message = f"GET\n{path}\n{ts}\n{nonce}\n".encode()
    sig = signing_key.sign(message).signature.hex()
    return client.get(
        path,
        headers={"X-Worker-Id": worker_id, "X-Ts": ts, "X-Nonce": nonce, "X-Sig": sig},
    )


def test_agent_manifest_requires_a_valid_agent_signature(client):
    assert client.get("/api/agent/manifest").status_code == 401


def test_agent_manifest_returns_entries_for_a_verified_agent(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    sha = _sha("clip")
    model_manifest.record_hash("other-worker", "text_encoders/clip_l.safetensors", _bytes(0.23), sha)

    r = _agent_get(client, worker_id, sk, "/api/agent/manifest")
    assert r.status_code == 200
    body = r.json()
    assert "entries" in body
    assert any(e["name"] == "clip_l.safetensors" for e in body["entries"])


def test_models_manifest_requires_admin_session(client):
    assert client.get("/api/models/manifest").status_code == 401


def test_models_manifest_returns_entries_for_admin(client):
    csrf = _login(client)
    sha = _sha("clip")
    model_manifest.record_hash("w1", "text_encoders/clip_l.safetensors", _bytes(0.23), sha)

    r = client.get("/api/models/manifest", headers={"X-CSRF": csrf})
    assert r.status_code == 200
    body = r.json()
    assert any(e["name"] == "clip_l.safetensors" for e in body["entries"])
