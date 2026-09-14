"""Tests for `model_manifest`: server-learned model hashes (consensus +
conflict handling) and the platform-signed fetch manifest built from them.
"""

import hashlib
import json
import logging
import secrets
import time

import pytest
from fastapi.testclient import TestClient
from nacl.exceptions import BadSignatureError
from nacl.signing import SigningKey, VerifyKey

from comfyfed_server import app as app_module
from comfyfed_server import bootstrap, db, model_guide, model_manifest, security
from comfyfed_agent import fetcher as agent_fetcher


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


# --- Phase 3.1: peer-only manifest entries ---------------------------------


def _seeder_worker(
    data_dir,
    worker_id,
    *,
    model_name="checkpoints/model.safetensors",
    size_bytes=_bytes(1.0),
    sha256=None,
    protocol=4,
    peer_url="http://10.0.0.5:8850",
    status="online",
    disabled=False,
):
    """Insert a `db.Worker` row directly (no HTTP registration needed --
    `peer.online_seeders`, which `entries()` now consults, only ever queries
    the DB) shaped so it satisfies `peer.online_seeders`'s predicate: online,
    not disabled, protocol>=4, `peer_url` set, and an inventory entry for
    `model_name`/`size_bytes` at `sha256` -- mirrors `test_peer.py`'s
    `_make_online_seeder` fixture, minus the HTTP registration step that
    fixture needs a `client` for.
    """
    sha256 = sha256 or _sha(worker_id)
    with db.get_session() as session:
        session.add(
            db.Worker(
                id=worker_id,
                name=worker_id,
                pubkey="pk",
                status=status,
                disabled=disabled,
                protocol=protocol,
                peer_url=peer_url,
                model_inventory=json.dumps(
                    [{"name": model_name, "size_bytes": size_bytes, "sha256": sha256}]
                ),
            )
        )
        session.commit()
    model_manifest.record_hash(worker_id, model_name, size_bytes, sha256)
    return sha256


def test_entries_includes_peer_only_model_with_online_seeder(data_dir):
    """A model with NO known download source (not in `model_guide.SOURCES`/
    `harvest()`) but an agreed hash AND an online protocol>=4 seeder becomes
    a peer-only entry: `url`/`backup_url` None, `peer: True`, `name`/
    `directory` split from the seeder's inventory-relative path exactly the
    way the agent's `fetcher._inventory_name` reconstructs it (the inverse
    operation) -- see `model_manifest._split_inventory_name`.
    """
    sha = _seeder_worker(
        data_dir, "seeder-1", model_name="loras/wuxia/my_style.safetensors", size_bytes=_bytes(0.5)
    )

    entries = model_manifest.entries(data_dir)
    matches = [e for e in entries if e["name"] == "wuxia/my_style.safetensors"]
    assert len(matches) == 1
    entry = matches[0]

    assert entry["directory"] == "loras"
    assert entry["url"] is None
    assert entry["backup_url"] is None
    assert entry["peer"] is True
    assert entry["sha256"] == sha
    assert entry["size_bytes"] == _bytes(0.5)

    _, verify_key = security.load_platform_keys(data_dir)
    payload = f"{entry['name']}|{entry['directory']}|{entry['sha256']}|{entry['size_bytes']}"
    verify_key.verify(payload.encode(), bytes.fromhex(entry["sig"]))  # raises on mismatch


def test_entries_excludes_peer_only_candidate_with_no_online_seeder(data_dir):
    """An agreed hash alone is not enough -- without an online seeder
    (`peer.online_seeders` empty), a model with no download source never
    becomes a manifest entry at all, exactly like before Task 6."""
    model_manifest.record_hash(
        "reporter-only", "loras/no_seeder.safetensors", _bytes(0.2), _sha("x")
    )
    names = {e["name"] for e in model_manifest.entries(data_dir)}
    assert "no_seeder.safetensors" not in names


def test_entries_peer_only_entry_disappears_when_the_seeder_goes_offline(data_dir):
    """`entries()` re-derives seeder status from the live `workers` table on
    every call (no caching of who's a seeder) -- the same `verdict` flip the
    task brief calls for, observed directly on the manifest that feeds it."""
    _seeder_worker(data_dir, "seeder-1", model_name="loras/x.safetensors", size_bytes=_bytes(0.2))
    names_before = {e["name"] for e in model_manifest.entries(data_dir)}
    assert "x.safetensors" in names_before

    with db.get_session() as session:
        worker = session.get(db.Worker, "seeder-1")
        worker.status = "offline"
        session.commit()

    names_after = {e["name"] for e in model_manifest.entries(data_dir)}
    assert "x.safetensors" not in names_after


def test_entries_url_sourced_model_gets_peer_flag_when_also_seeded(data_dir):
    """A curated (URL-sourced) model that ALSO has an online seeder keeps its
    `url` untouched but gains `peer: True` -- informative only (the agent
    fetcher always tries a peer source first regardless of this flag, per
    Task 5), so downstream eligibility code never needs a second path to
    learn "this one also has a seeder"."""
    _seeder_worker(
        data_dir,
        "seeder-1",
        model_name="text_encoders/clip_l.safetensors",
        size_bytes=_bytes(0.23),
        sha256=_sha("clip"),
    )

    entry = next(e for e in model_manifest.entries(data_dir) if e["name"] == "clip_l.safetensors")
    assert entry["url"] == (
        "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors"
    )
    assert entry["peer"] is True


def test_entries_url_sourced_model_has_no_peer_flag_without_a_seeder(data_dir):
    model_manifest.record_hash("w1", "text_encoders/clip_l.safetensors", _bytes(0.23), _sha("clip"))
    entry = next(e for e in model_manifest.entries(data_dir) if e["name"] == "clip_l.safetensors")
    assert "peer" not in entry


def test_peer_only_names_returns_only_url_less_entries(data_dir):
    _seeder_worker(data_dir, "seeder-1", model_name="loras/x.safetensors", size_bytes=_bytes(0.2))
    model_manifest.record_hash("w1", "text_encoders/clip_l.safetensors", _bytes(0.23), _sha("clip"))

    entries = model_manifest.entries(data_dir)
    peer_only = model_manifest.peer_only_names(entries)
    assert peer_only == {"x.safetensors"}


def test_entries_peer_only_directory_empty_when_inventory_name_has_no_category(data_dir):
    """An inventory name with no `/` at all (no category folder) still
    produces a valid entry -- `directory` degrades to `""`, matching
    `_resolve_target_path`'s "models root" handling for an empty directory
    on the agent side."""
    _seeder_worker(data_dir, "seeder-1", model_name="rootfile.safetensors", size_bytes=_bytes(0.1))
    entry = next(e for e in model_manifest.entries(data_dir) if e["name"] == "rootfile.safetensors")
    assert entry["directory"] == ""


# --- Task 6 cross-test: a real peer-only entry through the agent fetcher ---


def test_peer_only_entry_passes_the_agent_fetchers_own_validation(data_dir):
    """Integration check (Task 5's "known gap" note): a REAL peer-only entry
    built by the server's `entries()` must satisfy the agent fetcher's own
    entry-shape/signature checks unmodified -- `_validate_entry_shape` (the
    sha256/size_bytes sanity gate) and `_verify_entry_signature` (byte-for-
    byte payload match against the pinned platform key), exactly as a real
    dispatch's `fetch_models` push would be checked agent-side. Also confirms
    `fetcher._inventory_name` reconstructs the SAME inventory-relative path
    `model_manifest._split_inventory_name` split it from -- the two must stay
    exact inverses of each other for peer-grant requests to name the right
    file.
    """
    _seeder_worker(
        data_dir, "seeder-1", model_name="loras/wuxia/my_style.safetensors", size_bytes=_bytes(0.5)
    )
    entry = next(
        e for e in model_manifest.entries(data_dir) if e["name"] == "wuxia/my_style.safetensors"
    )
    assert entry["peer"] is True and entry["url"] is None

    _, verify_key = security.load_platform_keys(data_dir)
    platform_pubkey_hex = bytes(verify_key).hex()

    # Raises on failure -- the assertion IS that these don't raise.
    agent_fetcher._validate_entry_shape(entry)
    agent_fetcher._verify_entry_signature(entry, platform_pubkey_hex)

    assert agent_fetcher._inventory_name(entry) == "loras/wuxia/my_style.safetensors"


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
