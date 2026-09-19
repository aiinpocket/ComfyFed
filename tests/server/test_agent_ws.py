import asyncio
import hashlib
import json
import logging
import math
import secrets
import time
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey
from starlette.websockets import WebSocketDisconnect

from comfyfed_server import agentws, app as app_module
from comfyfed_server import bootstrap, db, dispatch, model_manifest, peerhealth


@pytest.fixture()
def client(tmp_path):
    data_dir = str(tmp_path)
    result = bootstrap.ensure_installed(data_dir, lang="en", url="http://h", interactive=False)
    app = app_module.create_app(data_dir)
    c = TestClient(app)
    c.admin_password = result.admin_password
    c.data_dir = data_dir
    yield c
    # Module-level, in-memory, per-process (see agentws._fetch_progress) --
    # reset between tests. Hash-conflict state is persisted on the
    # model_hashes row itself now (migration c9d0e1f2a3b4) and each test
    # gets a fresh tmp_path database, so there's nothing to reset for that.
    agentws._fetch_progress.clear()


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


def _submit(client, csrf, workflow=None):
    workflow = workflow if workflow is not None else {"1": {"class_type": "KSampler", "inputs": {"seed": 1}}}
    r = client.post(
        "/api/jobs",
        data={"workflow_json": json.dumps(workflow)},
        files=[],
        headers={"X-CSRF": csrf},
    )
    assert r.status_code == 200
    return r.json()["job_id"]


def _submit_panel(client, workflow=None):
    """Submit a job as the panel would, via `/comfy/api/prompt`.

    `origin="panel"` is what `/comfy/api/interrupt` and `/comfy/api/queue`
    require to act on a job (see comfyapi.py) -- a job submitted through
    the console's `_submit` above is invisible to both.
    """
    workflow = workflow if workflow is not None else {"1": {"class_type": "KSampler", "inputs": {"seed": 1}}}
    r = client.post("/comfy/api/prompt", json={"prompt": workflow, "client_id": "panel-test"})
    assert r.status_code == 200
    return r.json()["prompt_id"]


def test_handshake_with_bad_signature_closes_4401(client):
    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        assert challenge["type"] == "challenge"

        ws.send_json({"type": "auth", "worker_id": "unknown-worker", "sig": "00" * 64})

        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()
        assert exc_info.value.code == 4401


def test_handshake_with_unregistered_signature_closes_4401(client):
    csrf = _login(client)
    worker_id, _real_key = _register_worker(client, csrf, "w1")
    forged_key = SigningKey.generate()  # correct worker_id, wrong key -> bad sig

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        nonce = challenge["nonce"]
        sig = forged_key.sign(nonce.encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})

        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()
        assert exc_info.value.code == 4401


def test_handshake_of_a_soft_deleted_worker_closes_4401(client):
    """A soft-deleted worker has BOTH `deleted` and `disabled` set, and
    `deleted` is the authoritative one: it must get the PERMANENT 4401 (which
    the agent may eventually prune on), never the reversible 4403."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.deleted = True
        worker.disabled = True
        session.commit()

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})

        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()
        assert exc_info.value.code == 4401


def test_handshake_of_a_disabled_worker_closes_4403(client):
    """Merely DISABLED (not deleted) is reversible -- an admin can re-enable
    it -- so the agent must be told 4403 and keep its registration."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.disabled = True
        assert not worker.deleted
        session.commit()

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})

        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()
        assert exc_info.value.code == 4403


def test_handshake_timeout_closes_4408_not_4401(client, monkeypatch):
    """A handshake that never answers is TRANSIENT (slow box, sleeping
    laptop). Before the split this closed 4401, which made the agent treat a
    busy machine as a deleted worker -- it must be 4408."""
    monkeypatch.setattr(agentws, "_AUTH_TIMEOUT_SECONDS", 0.05)

    with client.websocket_connect("/api/agent/ws") as ws:
        assert ws.receive_json()["type"] == "challenge"
        # ...and deliberately never send the auth frame.
        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()
        assert exc_info.value.code == 4408


def test_malformed_auth_frame_closes_4408(client):
    """A frame that isn't an auth message at all is also not an auth
    DECISION: transient/protocol noise, never a permanent rejection."""
    with client.websocket_connect("/api/agent/ws") as ws:
        assert ws.receive_json()["type"] == "challenge"
        ws.send_json({"type": "hello"})

        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()
        assert exc_info.value.code == 4408


def test_good_handshake_gets_ready(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        nonce = challenge["nonce"]
        sig = sk.sign(nonce.encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})

        ready = ws.receive_json()
        assert ready["type"] == "ready"


def test_heartbeat_updates_last_seen_and_status(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            assert worker.last_seen is None

        ws.send_json(
            {
                "type": "heartbeat",
                "state": "idle",
                "progress": 0.0,
                "job_id": None,
                "dynamic": {"free_vram_gb": 10.0},
            }
        )

        agentws.dispatch_once(worker_id)  # round-trips through the same loop; ensures heartbeat processed

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            assert worker.last_seen is not None
            assert worker.status == "online"
            assert json.loads(worker.dynamic)["free_vram_gb"] == 10.0


def test_paused_heartbeat_sets_worker_status_and_connection_state(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json(
            {"type": "heartbeat", "state": "paused", "progress": 0.0, "job_id": None, "dynamic": {}}
        )
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            assert worker.last_seen is not None
            assert worker.status == "paused"

        assert agentws._connections[worker_id].state == "paused"


def test_paused_worker_excluded_from_dispatch_idle_worker_still_gets_the_job(client):
    """Two connected workers, one paused: the queued job must go only to the
    idle one, never to the paused one -- dispatch stays idle-only (Task 4
    leaves `idle_worker_ids` untouched)."""
    csrf = _login(client)
    worker_paused, key_paused = _register_worker(client, csrf, "w-paused")
    worker_idle, key_idle = _register_worker(client, csrf, "w-idle")
    job_id = _submit(client, csrf)

    ws_paused = _connect(client, worker_paused, key_paused)
    try:
        ws_paused.send_json(
            {"type": "heartbeat", "state": "paused", "progress": 0.0, "job_id": None, "dynamic": {}}
        )
        agentws.dispatch_once(worker_paused)

        ws_idle = _connect(client, worker_idle, key_idle)
        try:
            ws_idle.send_json(
                {"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}}
            )
            agentws.dispatch_once(worker_idle)

            job_msg = ws_idle.receive_json()
            assert job_msg["type"] == "job"
            assert job_msg["job_id"] == job_id

            with db.get_session() as session:
                job = session.get(db.Job, job_id)
                assert job.worker_id == worker_idle
        finally:
            ws_idle.close()
    finally:
        ws_paused.close()


def test_enqueued_job_pushed_to_idle_worker_and_job_done_marks_complete(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})

        agentws.dispatch_once(worker_id)

        job_msg = ws.receive_json()
        assert job_msg["type"] == "job"
        assert job_msg["job_id"] == job_id
        assert job_msg["input_assets"] == []
        assert "workflow_json" in job_msg

        ws.send_json({"type": "job_done", "job_id": job_id, "result_files": ["out.png"]})
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            assert job.status == "done"
            assert json.loads(job.result_files) == ["out.png"]


def test_job_push_omits_fetch_models_for_a_directly_eligible_worker(client):
    """The ordinary push shape (no model gap at all) must carry no
    `fetch_models` key -- Task 4 is purely additive."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        job_msg = ws.receive_json()
        assert job_msg["type"] == "job"
        assert job_msg["job_id"] == job_id
        assert "fetch_models" not in job_msg


def _bytes(gb: float) -> int:
    return round(gb * (1024 ** 3))


def _sha(label: str) -> str:
    return hashlib.sha256(label.encode()).hexdigest()


def test_job_push_includes_fetch_models_for_an_eligible_after_fetch_worker(client):
    """The winning eligible_after_fetch worker's push carries `fetch_models`:
    the full manifest entries for exactly its missing models."""
    csrf = _login(client)
    model_manifest.record_hash(
        "some-worker", "diffusion_models/flux1-dev.safetensors", _bytes(22.17), _sha("flux")
    )
    worker_id, sk = _register_worker(client, csrf, "w1")
    # The console submit predicate (jobs.py) needs an ONLINE, opted-in worker
    # to accept a fetchable-missing model at submission time -- set that up
    # before submitting, then re-declare it for real over the WS hello below
    # (which is what actually matters for dispatch ranking).
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.status = "online"
        worker.protocol = 3
        worker.auto_fetch = True
        worker.dynamic = json.dumps({"free_disk_gb": 100.0})
        worker.hardware = json.dumps({"max_fetch_gb": 100})
        session.commit()

    workflow = {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-dev.safetensors"}}}
    job_id = _submit(client, csrf, workflow=workflow)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json(
            {
                "type": "hello",
                "hardware": {"max_fetch_gb": 100},
                "backend": "cuda",
                "torch_version": "",
                "node_classes": [],
                "protocol": 3,
                "auto_fetch": True,
            }
        )
        ws.send_json(
            {
                "type": "heartbeat",
                "state": "idle",
                "progress": 0.0,
                "job_id": None,
                "dynamic": {"free_disk_gb": 100.0},
            }
        )
        agentws.dispatch_once(worker_id)

        job_msg = ws.receive_json()
        assert job_msg["type"] == "job"
        assert job_msg["job_id"] == job_id
        assert "fetch_models" in job_msg
        entries = job_msg["fetch_models"]
        assert len(entries) == 1
        assert entries[0]["name"] == "flux1-dev.safetensors"
        assert entries[0]["size_bytes"] == _bytes(22.17)
        assert entries[0]["sha256"] == _sha("flux")

    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "assigned"


def test_job_push_includes_peer_only_entry_for_a_protocol_4_worker(client):
    """Phase 3.1 P2P: a model with NO download source but an online seeder
    becomes a peer-only `fetch_models` entry (`url`/`backup_url` None,
    `peer: True`) in the push to a protocol>=4 puller -- the dispatch-time
    re-verdict (`agentws._fetch_models_for_push`) embeds exactly what
    `model_manifest.entries()` built, peer-only shape included."""
    csrf = _login(client)
    seeder_id, _seeder_sk = _register_worker(client, csrf, "seeder")
    with db.get_session() as session:
        seeder = session.get(db.Worker, seeder_id)
        seeder.status = "online"
        seeder.protocol = 4
        seeder.peer_url = "http://10.0.0.9:8850"
        # Phase 3.4 §4.2：種子條件多了「平台驗證過連得到」（peerhealth）。
        seeder.peer_reachable = 1
        seeder.model_inventory = json.dumps(
            [{
                "name": "loras/wuxia/my_style.safetensors",
                "size_bytes": _bytes(0.5),
                "sha256": _sha("style"),
            }]
        )
        session.commit()
    model_manifest.record_hash(
        seeder_id, "loras/wuxia/my_style.safetensors", _bytes(0.5), _sha("style")
    )

    puller_id, sk = _register_worker(client, csrf, "puller")

    workflow = {"1": {"class_type": "LoraLoader", "inputs": {"lora_name": "wuxia/my_style.safetensors"}}}
    job_id = _submit(client, csrf, workflow=workflow)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": puller_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json(
            {
                "type": "hello",
                "hardware": {},
                "backend": "cuda",
                "torch_version": "",
                "node_classes": [],
                "protocol": 4,
                "auto_fetch": True,
            }
        )
        ws.send_json(
            {
                "type": "heartbeat",
                "state": "idle",
                "progress": 0.0,
                "job_id": None,
                "dynamic": {"free_disk_gb": 100.0},
            }
        )
        agentws.dispatch_once(puller_id)

        job_msg = ws.receive_json()
        assert job_msg["job_id"] == job_id
        assert "fetch_models" in job_msg
        entries = job_msg["fetch_models"]
        assert len(entries) == 1
        entry = entries[0]
        assert entry["name"] == "wuxia/my_style.safetensors"
        assert entry["directory"] == "loras"
        assert entry["url"] is None
        assert entry["backup_url"] is None
        assert entry["peer"] is True

    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "assigned"


def test_job_push_omits_peer_only_model_job_from_a_protocol_3_worker(client):
    """A protocol-3 worker is not peer-pull capable -- a job needing a
    peer-only model must never be pushed to it (it stays queued, not
    assigned, since no other worker is idle/eligible either)."""
    csrf = _login(client)
    seeder_id, _seeder_sk = _register_worker(client, csrf, "seeder")
    with db.get_session() as session:
        seeder = session.get(db.Worker, seeder_id)
        seeder.status = "online"
        seeder.protocol = 4
        seeder.peer_url = "http://10.0.0.9:8850"
        # Phase 3.4 §4.2：種子條件多了「平台驗證過連得到」（peerhealth）。
        seeder.peer_reachable = 1
        seeder.model_inventory = json.dumps(
            [{"name": "loras/x.safetensors", "size_bytes": _bytes(0.2), "sha256": _sha("x")}]
        )
        session.commit()
    model_manifest.record_hash(seeder_id, "loras/x.safetensors", _bytes(0.2), _sha("x"))

    puller_id, sk = _register_worker(client, csrf, "puller-old")

    workflow = {"1": {"class_type": "LoraLoader", "inputs": {"lora_name": "x.safetensors"}}}
    job_id = _submit(client, csrf, workflow=workflow)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": puller_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json(
            {
                "type": "hello",
                "hardware": {},
                "backend": "cuda",
                "torch_version": "",
                "node_classes": [],
                "protocol": 3,
                "auto_fetch": True,
            }
        )
        ws.send_json(
            {
                "type": "heartbeat",
                "state": "idle",
                "progress": 0.0,
                "job_id": None,
                "dynamic": {"free_disk_gb": 100.0},
            }
        )
        agentws.dispatch_once(puller_id)
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})

    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "queued"


def test_job_push_never_sent_to_a_protocol_2_worker_even_when_manifest_covers_it(client):
    """Defensive gate: a protocol<3 agent can never be dispatched an
    eligible_after_fetch job at all (assess._eligible_after_fetch already
    excludes it), so the job simply stays queued rather than being pushed
    without fetch_models."""
    csrf = _login(client)
    model_manifest.record_hash(
        "some-worker", "diffusion_models/flux1-dev.safetensors", _bytes(22.17), _sha("flux")
    )
    worker_id, sk = _register_worker(client, csrf, "w1")

    workflow = {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-dev.safetensors"}}}

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        _send_hello_v2(ws)  # protocol 2
        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            worker.auto_fetch = True
            worker.dynamic = json.dumps({"free_disk_gb": 100.0})
            session.commit()

        # Registering this worker (w1) makes the model missing-everywhere but
        # the manifest entry above still requires an ONLINE, protocol>=3,
        # opted-in worker to be considered fetchable at submission time --
        # a bare-registered second worker at protocol 3 supplies that so the
        # console predicate accepts the submission (Task 4's own concern is
        # dispatch, not submission, for this test).
        other_id = _register_worker(client, csrf, "w2")[0]
        with db.get_session() as session:
            other = session.get(db.Worker, other_id)
            other.status = "online"
            other.protocol = 3
            other.auto_fetch = True
            other.dynamic = json.dumps({"free_disk_gb": 100.0})
            other.hardware = json.dumps({"max_fetch_gb": 100})
            session.commit()

        job_id = _submit(client, csrf, workflow=workflow)

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {"free_disk_gb": 100.0}})
        agentws.dispatch_once(worker_id)

    # w1 (protocol 2) must never win this job even though it's otherwise the
    # only idle connection dispatch_tick sees -- it stays queued.
    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "queued"


def test_job_failed_marks_job_failed(client):
    """2026-09-19 job-retry：`job_failed` 只有在「再重試也沒有意義」時才終局。
    這裡先把 `attempts` 撐到上限，所以這一次失敗走的是既有的 `mark_failed`
    路徑 -- `error` 換成彙整訊息（非終局的那一次留原始錯誤，見
    test_job_failed_requeues_instead_of_failing）。"""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)
    _exhaust_attempts(job_id)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        ws.receive_json()  # the pushed job message

        ws.send_json({"type": "job_failed", "job_id": job_id, "error": "boom"})
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            assert job.status == "failed"
            assert "w1: boom" in job.error


def _connect(client, worker_id, sk):
    """Open an authenticated agent WS and return it (as a context manager)."""
    ws = client.websocket_connect("/api/agent/ws").__enter__()
    challenge = ws.receive_json()
    sig = sk.sign(challenge["nonce"].encode()).signature.hex()
    ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
    assert ws.receive_json()["type"] == "ready"
    return ws


def _send_hello_v2(ws):
    """Declare protocol 2 on an already-connected `ws` -- what a current
    comfyfed-agent does right after handshake (see runner.send_hello).
    Sends no reply frame (unlike a protocol-1-defaulting hello, which earns
    a one-time deprecation notice -- see test_hello_without_protocol_...),
    so it's safe to call without an immediate matching receive_json."""
    ws.send_json(
        {
            "type": "hello",
            "hardware": {},
            "backend": "cuda",
            "torch_version": "",
            "node_classes": [],
            "protocol": 2,
        }
    )


def test_busy_heartbeat_marks_the_assigned_job_running(client):
    """C2: the agent's busy broadcast is what starts the job clock.

    Without it a job stayed "assigned" forever, started_at was never set, and
    every receipt recorded gpu_seconds == 0.
    """
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        # This is exactly what the agent runner broadcasts on job pickup.
        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            assert job.status == "running"
            assert job.started_at is not None

        ws.send_json({"type": "job_done", "job_id": job_id, "result_files": ["out.png"]})
        agentws.dispatch_once(worker_id)

        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"

        with db.get_session() as session:
            receipt = session.get(db.Receipt, receipt_msg["receipt_id"])
            assert receipt.gpu_seconds > 0


def test_fetch_stage_heartbeat_does_not_start_the_job_running(client):
    """M1: a busy heartbeat carrying stage="fetching_models" is the agent
    downloading a prerequisite model, not billable execution -- it must NOT
    flip the job to "running" or stamp started_at. Only the first busy
    heartbeat WITHOUT that stage (the actual run starting) does."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json(
            {
                "type": "heartbeat",
                "state": "busy",
                "progress": 0.0,
                "job_id": job_id,
                "dynamic": {},
                "stage": "fetching_models",
                "fetch_pct": 42.0,
                "fetch_model": "model.safetensors",
            }
        )
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            assert job.status == "assigned"
            assert job.started_at is None

        # The download finishes and the run actually starts: a busy
        # heartbeat with no stage field now sets started_at.
        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            assert job.status == "running"
            assert job.started_at is not None


def test_fetch_fail_receipt_is_zero_gpu_seconds_with_no_protocol_violation_log(client, caplog):
    """M1: a fetch-phase failure must bill gpu_seconds 0.0 (nothing ran) and
    must NOT trip the "protocol violation: ... despite having started" ERROR
    -- that branch is (correctly) guarded on started_at is not None, and
    started_at was never set for a job that failed during the fetch phase."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_id, sk)
    try:
        _send_hello_v2(ws)  # protocol 2 -- the branch this guards against
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json(
            {
                "type": "heartbeat",
                "state": "busy",
                "progress": 0.0,
                "job_id": job_id,
                "dynamic": {},
                "stage": "fetching_models",
                "fetch_pct": 10.0,
                "fetch_model": "model.safetensors",
            }
        )
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            assert session.get(db.Job, job_id).started_at is None

        with caplog.at_level(logging.ERROR, logger="comfyfed_server.agentws"):
            ws.send_json(
                {"type": "job_failed", "job_id": job_id, "error": "模型下載失敗 / model fetch failed"}
            )
            agentws.dispatch_once(worker_id)
            receipt_msg = ws.receive_json()

        errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
        assert not errors, f"unexpected ERROR log(s) on fetch-phase failure: {errors}"

        assert receipt_msg["type"] == "receipt"
        assert receipt_msg["kind"] == "failed"
        assert receipt_msg["basis"] == "wall"

        with db.get_session() as session:
            receipt = session.get(db.Receipt, receipt_msg["receipt_id"])
            assert receipt.gpu_seconds == 0.0
    finally:
        ws.close()


def test_cancel_mid_fetch_mints_no_receipt(client):
    """M1: cancelling a job while it is still in the fetch phase (started_at
    unset) must mint NO cancelled receipt at all -- parity with cancelling a
    still-queued/merely-assigned job. Download time is never billed."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_id, sk)
    try:
        _send_hello_v2(ws)
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json(
            {
                "type": "heartbeat",
                "state": "busy",
                "progress": 0.0,
                "job_id": job_id,
                "dynamic": {},
                "stage": "fetching_models",
                "fetch_pct": 5.0,
                "fetch_model": "model.safetensors",
            }
        )
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            assert session.get(db.Job, job_id).started_at is None

        res = client.post(f"/api/jobs/{job_id}/cancel", headers={"X-CSRF": csrf})
        assert res.status_code == 200

        with db.get_session() as session:
            assert session.query(db.Receipt).filter(db.Receipt.job_id == job_id).count() == 0
    finally:
        ws.close()


def _backdate_started_at(job_id, hours):
    """Push a job's `started_at` into the past, so `finished_at - started_at`
    (the wall clock) is large by the time `job_done` is sent -- used to prove
    billing prefers `exec_seconds` over the wall clock rather than merely
    happening to agree with it on a normal, fast test run."""
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        job.started_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=hours)
        session.commit()


def test_job_done_bills_exec_seconds_when_present_even_if_wall_clock_is_large(client):
    """Deliverable 3: `gpu_seconds = min(exec_seconds, wall)`. A worker that
    sat queued for an hour (large wall clock) before actually running for 2
    real seconds must only be billed those 2 seconds."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        _backdate_started_at(job_id, hours=1)

        ws.send_json(
            {"type": "job_done", "job_id": job_id, "result_files": ["out.png"], "exec_seconds": 2.0}
        )
        agentws.dispatch_once(worker_id)

        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"

        with db.get_session() as session:
            receipt = session.get(db.Receipt, receipt_msg["receipt_id"])
            assert receipt.gpu_seconds == 2.0
        assert receipt_msg["payload"] == f"{job_id}|{worker_id}|2.0"


def _job_signature(job_id):
    with db.get_session() as session:
        return session.get(db.Job, job_id).signature


def test_job_done_records_worker_job_stats(client):
    """Phase 3.3 §2.3: job_done 帶有效 exec_seconds 時，`worker_job_stats`
    要長出一列（第一筆樣本的 EWMA 就是 exec_seconds 本身）。"""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        ws.send_json(
            {"type": "job_done", "job_id": job_id, "result_files": ["out.png"], "exec_seconds": 42.0}
        )
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "receipt"

    with db.get_session() as session:
        row = session.get(db.WorkerJobStats, (worker_id, _job_signature(job_id)))
        assert row is not None
        assert row.ewma_seconds == pytest.approx(42.0)
        assert row.samples == 1


def test_dispatch_tick_does_not_build_the_manifest_for_a_parent_only_queue(
    client, monkeypatch
):
    """Final-review M2：`has_queued_work` 要跟 `assign_jobs` 的 queued 查詢同條件
    （`split_count == 0`）。已拆的父 job 永遠不會被派工，拿它當「有活可
    做」會讓每一個 tick 白白跑一次 manifest 建置（worker 查詢 + 每台 seeder
    的 inventory 解析 + `model_guide.harvest` 的目錄掃描）。
    """
    from comfyfed_server import model_manifest

    calls: list[str] = []
    original = model_manifest.entries
    monkeypatch.setattr(
        model_manifest,
        "entries",
        lambda data_dir: (calls.append(data_dir), original(data_dir))[1],
    )

    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"
        ws.send_json(
            {"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}}
        )

        # 只有一件已拆的父 job 在排隊 -- 沒有任何真的派工對象。
        with db.get_session() as session:
            session.add(
                db.Job(id="parent", workflow_json="{}", status="queued", split_count=2)
            )
            session.commit()
        agentws.dispatch_once(worker_id)
        assert calls == []

        # 對照組：一件普通的 queued job 就會建 manifest。
        with db.get_session() as session:
            session.add(db.Job(id="plain", workflow_json="{}", status="queued"))
            session.commit()
        agentws.dispatch_once(worker_id)
        assert calls


def test_record_job_stats_skips_a_split_child(client):
    """Final-review I1：子 job 不進統計。子 job 繼承父 job 的 signature 卻只跑
    1/k 批，收它的 exec_seconds 會把這個簽章的 EWMA 拉到實際全批的 1/k。"""
    _login(client)
    with db.get_session() as session:
        session.add(db.Worker(id="w1", name="w1", pubkey="pk"))
        session.add(
            db.Job(id="p", workflow_json="{}", status="running", signature="sig", split_count=2)
        )
        session.add(
            db.Job(
                id="c0",
                workflow_json="{}",
                status="running",
                signature="sig",
                parent_id="p",
                split_index=0,
            )
        )
        session.commit()

    agentws._record_job_stats("w1", "c0", 42.0)

    with db.get_session() as session:
        assert session.query(db.WorkerJobStats).count() == 0
        assert session.get(db.Worker, "w1").speed_index == 1.0


def test_record_job_stats_still_records_a_plain_job(client):
    """對照組：`parent_id` 為空的普通 job 一如既往進統計。"""
    _login(client)
    with db.get_session() as session:
        session.add(db.Worker(id="w1", name="w1", pubkey="pk"))
        session.add(db.Job(id="plain", workflow_json="{}", status="running", signature="sig"))
        session.commit()

    agentws._record_job_stats("w1", "plain", 42.0)

    with db.get_session() as session:
        row = session.get(db.WorkerJobStats, ("w1", "sig"))
        assert row is not None
        assert row.ewma_seconds == pytest.approx(42.0)
        assert row.samples == 1


def test_job_failed_does_not_record_stats(client):
    """只有真的完成才進統計 -- 一次失敗的執行不是這個簽章的速度樣本。"""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        ws.send_json(
            {"type": "job_failed", "job_id": job_id, "error": "boom", "exec_seconds": 42.0}
        )
        agentws.dispatch_once(worker_id)

    with db.get_session() as session:
        assert session.query(db.WorkerJobStats).count() == 0


def test_job_done_without_exec_seconds_falls_back_to_wall_clock(client, caplog):
    """Deliverable 3: a missing/invalid `exec_seconds` (older agent, or a
    ComfyUI whose /queue was unreachable) must fall back to the wall clock,
    with an info-level log noting the fallback."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        _backdate_started_at(job_id, hours=1)

        with caplog.at_level(logging.INFO, logger="comfyfed_server.agentws"):
            ws.send_json({"type": "job_done", "job_id": job_id, "result_files": ["out.png"]})
            agentws.dispatch_once(worker_id)

        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"

        with db.get_session() as session:
            receipt = session.get(db.Receipt, receipt_msg["receipt_id"])
            # ~1 hour (3600s), allowing a little slack for real elapsed time.
            assert 3595 <= receipt.gpu_seconds <= 3605
        assert any("wall-clock" in rec.getMessage() for rec in caplog.records)


def test_job_done_with_nan_exec_seconds_falls_back_to_wall_clock(client):
    """A NaN literal survives `json.loads` as a real Python float, so it
    passes a naive `isinstance(..., (int, float))` check and a naive
    `< 0` comparison alike (NaN compares False to everything) -- it must be
    rejected explicitly via `math.isfinite`, or "nan" would end up baked into
    the signed receipt payload."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        _backdate_started_at(job_id, hours=1)

        ws.send_json(
            {
                "type": "job_done",
                "job_id": job_id,
                "result_files": ["out.png"],
                "exec_seconds": float("nan"),
            }
        )
        agentws.dispatch_once(worker_id)

        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"

        with db.get_session() as session:
            receipt = session.get(db.Receipt, receipt_msg["receipt_id"])
            assert math.isfinite(receipt.gpu_seconds)
            assert receipt.gpu_seconds >= 0
            # ~1 hour wall-clock fallback, not NaN.
            assert 3595 <= receipt.gpu_seconds <= 3605
        assert "nan" not in receipt_msg["payload"].lower()


def test_job_done_with_negative_wall_clock_clamps_gpu_seconds_to_zero(client):
    """Clock skew between `started_at` and `finished_at` (or any other bug
    producing a negative wall clock) must never reach a signed receipt as a
    negative number -- it's clamped to 0.0."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        # started_at pushed an hour into the *future* relative to `now` -- by
        # the time job_done sets finished_at, wall_seconds is negative.
        _backdate_started_at(job_id, hours=-1)

        ws.send_json({"type": "job_done", "job_id": job_id, "result_files": ["out.png"]})
        agentws.dispatch_once(worker_id)

        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"

        with db.get_session() as session:
            receipt = session.get(db.Receipt, receipt_msg["receipt_id"])
            assert receipt.gpu_seconds == 0.0
        assert receipt_msg["payload"] == f"{job_id}|{worker_id}|0.0"


def test_job_done_caps_absurd_exec_seconds_at_the_wall_clock(client):
    """Deliverable 3: `exec_seconds` far exceeding the wall clock (a buggy or
    hostile agent) must be capped at the wall clock, never inflate billing
    past what actually elapsed."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        # Wall clock stays small (no backdating) -- just the real time
        # elapsed by the test itself, well under a second.
        ws.send_json(
            {"type": "job_done", "job_id": job_id, "result_files": ["out.png"], "exec_seconds": 999999.0}
        )
        agentws.dispatch_once(worker_id)

        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"

        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            wall = (job.finished_at - job.started_at).total_seconds()
            receipt = session.get(db.Receipt, receipt_msg["receipt_id"])
            assert receipt.gpu_seconds == wall
            assert receipt.gpu_seconds < 999999.0


def test_job_done_from_a_foreign_worker_changes_nothing(client):
    """C3: worker B must not be able to complete worker A's job."""
    csrf = _login(client)
    worker_a, key_a = _register_worker(client, csrf, "w-a")
    worker_b, key_b = _register_worker(client, csrf, "w-b")
    job_id = _submit(client, csrf)

    ws_a = _connect(client, worker_a, key_a)
    try:
        ws_a.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_a)
        assert ws_a.receive_json()["type"] == "job"

        with client.websocket_connect("/api/agent/ws") as ws_b:
            challenge = ws_b.receive_json()
            sig = key_b.sign(challenge["nonce"].encode()).signature.hex()
            ws_b.send_json({"type": "auth", "worker_id": worker_b, "sig": sig})
            assert ws_b.receive_json()["type"] == "ready"

            ws_b.send_json({"type": "job_done", "job_id": job_id, "result_files": ["forged.png"]})
            agentws.dispatch_once(worker_b)

            with db.get_session() as session:
                job = session.get(db.Job, job_id)
                assert job.status == "assigned"
                assert job.worker_id == worker_a
                assert json.loads(job.result_files) == []
                # No receipt was minted for the thief.
                assert session.query(db.Receipt).count() == 0
    finally:
        ws_a.close()


def test_job_failed_from_a_foreign_worker_changes_nothing(client):
    csrf = _login(client)
    worker_a, key_a = _register_worker(client, csrf, "w-a")
    worker_b, key_b = _register_worker(client, csrf, "w-b")
    job_id = _submit(client, csrf)

    ws_a = _connect(client, worker_a, key_a)
    try:
        ws_a.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_a)
        assert ws_a.receive_json()["type"] == "job"

        with client.websocket_connect("/api/agent/ws") as ws_b:
            challenge = ws_b.receive_json()
            sig = key_b.sign(challenge["nonce"].encode()).signature.hex()
            ws_b.send_json({"type": "auth", "worker_id": worker_b, "sig": sig})
            assert ws_b.receive_json()["type"] == "ready"

            ws_b.send_json({"type": "job_failed", "job_id": job_id, "error": "sabotage"})
            agentws.dispatch_once(worker_b)

            with db.get_session() as session:
                job = session.get(db.Job, job_id)
                assert job.status == "assigned"
                assert job.error is None
    finally:
        ws_a.close()


def test_busy_heartbeat_for_a_foreign_job_does_not_start_it(client):
    csrf = _login(client)
    worker_a, key_a = _register_worker(client, csrf, "w-a")
    worker_b, key_b = _register_worker(client, csrf, "w-b")
    job_id = _submit(client, csrf)

    ws_a = _connect(client, worker_a, key_a)
    try:
        ws_a.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_a)
        assert ws_a.receive_json()["type"] == "job"

        with client.websocket_connect("/api/agent/ws") as ws_b:
            challenge = ws_b.receive_json()
            sig = key_b.sign(challenge["nonce"].encode()).signature.hex()
            ws_b.send_json({"type": "auth", "worker_id": worker_b, "sig": sig})
            assert ws_b.receive_json()["type"] == "ready"

            ws_b.send_json(
                {"type": "heartbeat", "state": "busy", "progress": 0.7, "job_id": job_id, "dynamic": {}}
            )
            agentws.dispatch_once(worker_b)

            with db.get_session() as session:
                job = session.get(db.Job, job_id)
                assert job.status == "assigned"
                assert job.started_at is None
                assert job.progress == 0
    finally:
        ws_a.close()


def test_byte_scale_inventory_is_converted_to_gigabytes(client):
    """C1: an old agent reporting raw bytes must not blow up the VRAM estimate."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    six_gb_in_bytes = 6 * 1024 ** 3

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json(
            {
                "type": "inventory",
                "models": [
                    {"name": "sd_xl_base.safetensors", "size": six_gb_in_bytes},
                    {"name": "vae.safetensors", "size": 0.3},  # already GB: untouched
                ],
            }
        )
        agentws.dispatch_once(worker_id)

    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        inventory = {e["name"]: e["size"] for e in json.loads(worker.model_inventory)}

    assert inventory["sd_xl_base.safetensors"] == 6.0
    assert inventory["vae.safetensors"] == 0.3

    # And the estimate that reads it stays in a sane GB range.
    workflow = {"1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sd_xl_base.safetensors"}}}
    job_id = _submit(client, csrf, workflow=workflow)
    detail = client.get(f"/api/jobs/{job_id}", headers={"X-CSRF": csrf}).json()
    assert 6.0 <= detail["est_vram_gb"] <= 8.0


def test_inventory_entries_with_exact_size_bytes_are_learned_verbatim(client):
    """A Task 1+ agent that also reports the file's exact `size_bytes`
    (`hardware.scan_models`) must have THAT value stored, not a
    reconstruction from the rounded `size` GB figure -- the signed manifest
    payload has to pin the real byte length."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    sha = hashlib.sha256(b"clip").hexdigest()
    exact_size_bytes = round(0.23 * (1024 ** 3)) + 7  # deliberately off the rounded GB figure

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json(
            {
                "type": "inventory",
                "models": [
                    {
                        "name": "text_encoders/clip_l.safetensors",
                        "size": 0.23,
                        "size_bytes": exact_size_bytes,
                        "sha256": sha,
                    },
                    {"name": "vae/no_hash_yet.safetensors", "size": 0.31},
                ],
            }
        )
        agentws.dispatch_once(worker_id)

    with db.get_session() as session:
        row = session.get(db.ModelHash, ("text_encoders/clip_l.safetensors", exact_size_bytes))
        assert row is not None
        assert row.sha256 == sha
        assert row.first_worker_id == worker_id
        # No row at the rounded-GB reconstruction -- the exact value won.
        assert session.get(db.ModelHash, ("text_encoders/clip_l.safetensors", round(0.23 * 1024 ** 3))) is None
        # The hash-less entry must not have produced any row at all.
        assert session.query(db.ModelHash).count() == 1


def test_inventory_entries_without_size_bytes_fall_back_to_rounded_gb(client):
    """An agent that hashes but predates the exact `size_bytes` field (only
    sends `sha256` + the rounded `size` GB) still gets learned, via the
    documented fallback reconstruction."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    sha = hashlib.sha256(b"clip").hexdigest()

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json(
            {
                "type": "inventory",
                "models": [
                    {"name": "text_encoders/clip_l.safetensors", "size": 0.23, "sha256": sha},
                    {"name": "vae/no_hash_yet.safetensors", "size": 0.31},
                ],
            }
        )
        agentws.dispatch_once(worker_id)

    size_bytes = round(0.23 * (1024 ** 3))
    with db.get_session() as session:
        row = session.get(db.ModelHash, ("text_encoders/clip_l.safetensors", size_bytes))
        assert row is not None
        assert row.sha256 == sha
        assert row.first_worker_id == worker_id
        # The hash-less entry must not have produced any row at all.
        assert session.query(db.ModelHash).count() == 1


def test_inventory_hash_conflict_between_two_workers_poisons_the_name(client, caplog):
    csrf = _login(client)
    worker_a, sk_a = _register_worker(client, csrf, "wa")
    worker_b, sk_b = _register_worker(client, csrf, "wb")
    sha_a = hashlib.sha256(b"a").hexdigest()
    sha_b = hashlib.sha256(b"b").hexdigest()

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        ws.send_json(
            {"type": "auth", "worker_id": worker_a, "sig": sk_a.sign(challenge["nonce"].encode()).signature.hex()}
        )
        assert ws.receive_json()["type"] == "ready"
        ws.send_json(
            {"type": "inventory", "models": [{"name": "clip_l.safetensors", "size": 0.23, "sha256": sha_a}]}
        )
        agentws.dispatch_once(worker_a)

    with caplog.at_level(logging.WARNING, logger="comfyfed_server.model_manifest"):
        with client.websocket_connect("/api/agent/ws") as ws:
            challenge = ws.receive_json()
            ws.send_json(
                {"type": "auth", "worker_id": worker_b, "sig": sk_b.sign(challenge["nonce"].encode()).signature.hex()}
            )
            assert ws.receive_json()["type"] == "ready"
            ws.send_json(
                {"type": "inventory", "models": [{"name": "clip_l.safetensors", "size": 0.23, "sha256": sha_b}]}
            )
            agentws.dispatch_once(worker_b)

    assert any(
        r.levelno == logging.WARNING and worker_a in r.message and worker_b in r.message
        for r in caplog.records
    )
    size_bytes = round(0.23 * (1024 ** 3))
    with db.get_session() as session:
        row = session.get(db.ModelHash, ("clip_l.safetensors", size_bytes))
        assert row is not None
        assert row.conflict is True


def test_repeated_busy_heartbeat_is_a_silent_no_op(client, caplog):
    """A job's later busy heartbeats must not warn.

    The agent heartbeats every 30s for the whole length of a job, but only the
    first one has a transition to make. If the rest logged at WARNING they
    would bury the cross-worker forgery signal that shares this code path.
    """
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            first = session.get(db.Job, job_id)
            assert first.status == "running"
            started_at = first.started_at

        # Everything from here on must be silent at WARNING and change nothing.
        with caplog.at_level(logging.DEBUG, logger="comfyfed_server.dispatch"):
            for progress in (0.3, 0.6, 0.9):
                ws.send_json(
                    {
                        "type": "heartbeat",
                        "state": "busy",
                        "progress": progress,
                        "job_id": job_id,
                        "dynamic": {},
                    }
                )
                agentws.dispatch_once(worker_id)

        warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
        assert warnings == [], [r.getMessage() for r in warnings]
        # It is still logged, just at DEBUG.
        assert any(r.levelno == logging.DEBUG for r in caplog.records)

        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            assert job.status == "running"
            assert job.started_at == started_at  # not restarted
            assert job.progress == 0.9  # progress still tracked


def test_foreign_and_terminal_transitions_still_warn(client, caplog):
    """The forgery signal stays loud: wrong owner, and re-finishing a done job."""
    csrf = _login(client)
    worker_a, key_a = _register_worker(client, csrf, "w-a")
    worker_b, _key_b = _register_worker(client, csrf, "w-b")
    job_id = _submit(client, csrf)

    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        job.status = "assigned"
        job.worker_id = worker_a
        session.commit()

    with caplog.at_level(logging.DEBUG, logger="comfyfed_server.dispatch"):
        # Wrong owner.
        assert dispatch.mark_done(job_id, worker_b, []) is False
        # Unknown job id.
        assert dispatch.mark_done("no-such-job", worker_a, []) is False

    warnings = [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING]
    assert len(warnings) == 2
    assert any(worker_b in m for m in warnings)
    assert any("no-such-job" in m for m in warnings)

    # Finish it legitimately, then try to finish it again.
    assert dispatch.mark_done(job_id, worker_a, ["out.png"]) is True

    caplog.clear()
    with caplog.at_level(logging.DEBUG, logger="comfyfed_server.dispatch"):
        assert dispatch.mark_done(job_id, worker_a, ["again.png"]) is False

    terminal_warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert len(terminal_warnings) == 1
    assert "done" in terminal_warnings[0].getMessage()


# --- Phase 1.7: job_cancelled push + blip re-adoption -----------------------


def test_busy_heartbeat_for_foreign_job_sends_job_cancelled_once_with_dedup(client, caplog):
    """(a) A worker repeatedly heartbeating a job it doesn't own gets
    `job_cancelled` exactly once (dedup), while the ownership WARNING from
    dispatch.mark_running fires once and is rate-limited to DEBUG for the
    same (connection, job id) after that -- see Task 2."""
    csrf = _login(client)
    worker_a, key_a = _register_worker(client, csrf, "w-a")
    worker_b, key_b = _register_worker(client, csrf, "w-b")
    job_id = _submit(client, csrf)

    ws_a = _connect(client, worker_a, key_a)
    try:
        ws_a.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_a)
        assert ws_a.receive_json()["type"] == "job"  # worker_a now owns job_id

        ws_b = _connect(client, worker_b, key_b)
        _send_hello_v2(ws_b)  # protocol 2, so it can be told via job_cancelled
        try:
            with caplog.at_level(logging.DEBUG, logger="comfyfed_server.dispatch"):
                for progress in (0.1, 0.4, 0.7):
                    ws_b.send_json(
                        {
                            "type": "heartbeat",
                            "state": "busy",
                            "progress": progress,
                            "job_id": job_id,
                            "dynamic": {},
                        }
                    )
                    agentws.dispatch_once(worker_b)

            cancelled_msg = ws_b.receive_json()
            assert cancelled_msg == {"type": "job_cancelled", "job_id": job_id}

            warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
            assert len(warnings) == 1  # rate-limited: only the first heartbeat warns
            debugs = [r for r in caplog.records if r.levelno == logging.DEBUG]
            assert len(debugs) == 2  # the repeats are downgraded, not silenced

            with db.get_session() as session:
                job = session.get(db.Job, job_id)
                assert job.status == "assigned"
                assert job.worker_id == worker_a
                assert job.started_at is None
        finally:
            ws_b.close()
    finally:
        ws_a.close()


def test_job_done_after_blip_readopts_and_completes(client):
    """(b) A job_done from the same worker last_worker_id names, for a job
    that's back to `queued` (a blip requeue), is re-adopted and finishes
    exactly like a normal completion -- no job_cancelled."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        # Simulate the requeue dispatch.requeue_stale performs when this
        # worker blips offline mid-run: back to queued, ownership cleared,
        # last_worker_id recorded.
        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            job.status = "queued"
            job.worker_id = None
            job.last_worker_id = worker_id
            session.commit()

        ws.send_json({"type": "job_done", "job_id": job_id, "result_files": ["out.png"]})
        agentws.dispatch_once(worker_id)

        # The very next message is the receipt -- not a job_cancelled.
        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"

        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            assert job.status == "done"
            assert json.loads(job.result_files) == ["out.png"]
            assert session.query(db.Receipt).count() == 1
    finally:
        ws.close()


def test_job_done_for_job_now_owned_by_another_worker_is_rejected_and_cancelled(client):
    """(c) A stale job_done from worker A for a job worker B now actually
    owns is rejected outright, A is told via job_cancelled, and B's job is
    untouched."""
    csrf = _login(client)
    worker_a, key_a = _register_worker(client, csrf, "w-a")
    worker_b, _key_b = _register_worker(client, csrf, "w-b")
    job_id = _submit(client, csrf)

    ws_a = _connect(client, worker_a, key_a)
    _send_hello_v2(ws_a)  # protocol 2, so it can be told the stale job_done via job_cancelled
    try:
        ws_a.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_a)
        assert ws_a.receive_json()["type"] == "job"

        # Simulate: A blipped, the job was requeued (last_worker_id=A), and
        # worker B has since actually picked it up and is running it.
        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            job.status = "running"
            job.worker_id = worker_b
            job.last_worker_id = worker_a
            job.started_at = datetime.now(timezone.utc).replace(tzinfo=None)
            session.commit()

        ws_a.send_json({"type": "job_done", "job_id": job_id, "result_files": ["stale.png"]})
        agentws.dispatch_once(worker_a)

        cancelled_msg = ws_a.receive_json()
        assert cancelled_msg == {"type": "job_cancelled", "job_id": job_id}

        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            assert job.status == "running"
            assert job.worker_id == worker_b
            assert json.loads(job.result_files) == []
            assert session.query(db.Receipt).count() == 0
    finally:
        ws_a.close()


# --- Task 2: cancel entry points push job_cancelled to the owning agent -----


def test_admin_cancel_pushes_job_cancelled_to_the_owning_agent(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_id, sk)
    _send_hello_v2(ws)  # protocol 2, so the cancel can reach it via job_cancelled
    try:
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"  # worker now owns job_id, status=assigned

        r = client.post(f"/api/jobs/{job_id}/cancel", headers={"X-CSRF": csrf})
        assert r.status_code == 200

        cancelled_msg = ws.receive_json()
        assert cancelled_msg == {"type": "job_cancelled", "job_id": job_id}

        with db.get_session() as session:
            assert session.get(db.Job, job_id).status == "cancelled"
    finally:
        ws.close()


def test_admin_cancel_of_an_unowned_queued_job_sends_nothing_to_any_agent(client):
    """A queued job has no owner yet -- there is no connection to push to."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_id, sk)
    try:
        r = client.post(f"/api/jobs/{job_id}/cancel", headers={"X-CSRF": csrf})
        assert r.status_code == 200

        with db.get_session() as session:
            assert session.get(db.Job, job_id).status == "cancelled"

        # Nothing was ever queued to push to this connection -- no job to
        # dispatch, and no job_cancelled for a job it never owned.
        assert agentws._connections[worker_id].cancelled_jobs_sent == set()
    finally:
        ws.close()


def test_comfy_interrupt_pushes_job_cancelled_to_the_running_worker(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit_panel(client)

    ws = _connect(client, worker_id, sk)
    _send_hello_v2(ws)  # protocol 2, so the interrupt can reach it via job_cancelled
    try:
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)  # -> running

        r = client.post("/comfy/api/interrupt")
        assert r.status_code == 200

        # The cancelled receipt is minted before job_cancelled is pushed (so
        # a push failure can never cost the receipt), so the receipt frame
        # now arrives first.
        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"
        assert receipt_msg["kind"] == "cancelled"
        cancelled_msg = ws.receive_json()
        assert cancelled_msg == {"type": "job_cancelled", "job_id": job_id}

        with db.get_session() as session:
            assert session.get(db.Job, job_id).status == "cancelled"
    finally:
        ws.close()


def test_comfy_queue_delete_pushes_job_cancelled_to_the_assigned_worker(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit_panel(client)

    ws = _connect(client, worker_id, sk)
    _send_hello_v2(ws)  # protocol 2, so the delete can reach it via job_cancelled
    try:
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"  # assigned to worker_id

        r = client.post("/comfy/api/queue", json={"delete": [job_id]})
        assert r.status_code == 200

        cancelled_msg = ws.receive_json()
        assert cancelled_msg == {"type": "job_cancelled", "job_id": job_id}
    finally:
        ws.close()


def test_job_done_resent_for_own_terminal_job_does_not_send_job_cancelled(client):
    """A duplicate job_done for a job this worker already legitimately
    finished must not be mistaken for "not owned" -- it still owns the job,
    it's just too late. No job_cancelled belongs on that socket."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "job_done", "job_id": job_id, "result_files": ["out.png"]})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "receipt"

        ws.send_json({"type": "job_done", "job_id": job_id, "result_files": ["again.png"]})
        agentws.dispatch_once(worker_id)

        # No job_cancelled was queued for the resend -- it still owns the
        # job, it's just too late to matter.
        assert job_id not in agentws._connections[worker_id].cancelled_jobs_sent

        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            assert job.status == "done"
            assert json.loads(job.result_files) == ["out.png"]
    finally:
        ws.close()


# --- Final review Major 1: a cancel the owner missed must be re-pushed ------


def test_cancel_then_owner_heartbeat_pushes_job_cancelled_once_without_warning_spam(client, caplog):
    """The cancel push landing nowhere (agent mid-reconnect) must not be the
    end of it: the owner's very next busy heartbeat has to learn about it.

    `cancel_job` clears `worker_id` (recording `last_worker_id`), so every
    later reference by the old owner takes the not-owned path -- which pushes
    `job_cancelled`, deduped per connection. And because that worker IS the
    job's former owner and the job is terminal, the repeat heartbeats log at
    DEBUG: WARNING stays reserved for forged job ids.
    """
    csrf = _login(client)
    worker_a, key_a = _register_worker(client, csrf, "w-a")
    job_id = _submit(client, csrf)

    ws_a = _connect(client, worker_a, key_a)
    _send_hello_v2(ws_a)  # protocol 2, so the re-push can reach it via job_cancelled
    try:
        ws_a.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_a)
        assert ws_a.receive_json()["type"] == "job"

        # Cancelled straight through dispatch, i.e. the push found no live
        # connection -- exactly the window the review reproduced.
        assert dispatch.cancel_job(job_id, reason="operator cancelled") == worker_a
        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            assert job.status == "cancelled"
            assert job.worker_id is None
            assert job.last_worker_id == worker_a

        with caplog.at_level(logging.DEBUG, logger="comfyfed_server.dispatch"):
            for progress in (0.1, 0.4, 0.7):
                ws_a.send_json(
                    {
                        "type": "heartbeat",
                        "state": "busy",
                        "progress": progress,
                        "job_id": job_id,
                        "dynamic": {},
                    }
                )
                agentws.dispatch_once(worker_a)

        assert ws_a.receive_json() == {"type": "job_cancelled", "job_id": job_id}
        # Exactly one push for the whole burst.
        assert agentws._connections[worker_a].cancelled_jobs_sent == {job_id}

        warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
        assert warnings == [], "a former owner's heartbeat for its cancelled job is not a forgery signal"
        assert any(r.levelno == logging.DEBUG for r in caplog.records)
    finally:
        ws_a.close()


def test_forged_job_id_from_a_stranger_still_warns(client, caplog):
    """The DEBUG downgrade above must not blind the forgery signal: a worker
    referencing a job it never owned still logs WARNING."""
    csrf = _login(client)
    worker_a, key_a = _register_worker(client, csrf, "w-a")
    worker_b, key_b = _register_worker(client, csrf, "w-b")
    job_id = _submit(client, csrf)

    ws_a = _connect(client, worker_a, key_a)
    try:
        ws_a.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_a)
        assert ws_a.receive_json()["type"] == "job"

        ws_b = _connect(client, worker_b, key_b)
        try:
            dispatch.cancel_job(job_id, reason="operator cancelled")
            with caplog.at_level(logging.DEBUG, logger="comfyfed_server.dispatch"):
                ws_b.send_json(
                    {"type": "heartbeat", "state": "busy", "progress": 0.5, "job_id": job_id, "dynamic": {}}
                )
                agentws.dispatch_once(worker_b)

            warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
            assert len(warnings) == 1
        finally:
            ws_b.close()
    finally:
        ws_a.close()


# --- Task 2: agentws hygiene -- bounded dedup, rate-limited warnings --------


def test_cancelled_jobs_sent_is_bounded_with_fifo_eviction(client):
    """A connection lives as long as the agent stays attached -- potentially
    days -- so `cancelled_jobs_sent` must not grow without bound. Capped at
    512, oldest entry evicted first (see agentws._BoundedSet)."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        conn = agentws._connections[worker_id]
        for i in range(600):
            conn.cancelled_jobs_sent.add(f"job-{i}")

        assert len(conn.cancelled_jobs_sent) == 512
        # The oldest 88 entries (600 - 512) were evicted...
        assert "job-0" not in conn.cancelled_jobs_sent
        assert "job-87" not in conn.cancelled_jobs_sent
        # ...and the 512 most recent survive, oldest-first eviction order.
        assert "job-88" in conn.cancelled_jobs_sent
        assert "job-599" in conn.cancelled_jobs_sent

        # Re-adding an already-present item is a no-op, not a re-insertion --
        # it must not disturb eviction order or count.
        conn.cancelled_jobs_sent.add("job-599")
        assert len(conn.cancelled_jobs_sent) == 512
    finally:
        ws.close()


def test_bounded_set_eviction_causes_only_a_harmless_duplicate_push(client):
    """Contract check for the behavior note in agentws._send_job_cancelled:
    if a job id is evicted from `cancelled_jobs_sent` and then referenced
    again, the dedup simply doesn't fire and a second `job_cancelled` push
    goes out -- there is no crash, no state corruption, and the agent treats
    the push idempotently (it just re-aborts a run it was already told to
    abort), so this is asserted as an accepted rare duplicate, not a bug."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        conn = agentws._connections[worker_id]
        conn.cancelled_jobs_sent.add("evicted-job")
        for i in range(512):
            conn.cancelled_jobs_sent.add(f"filler-{i}")
        assert "evicted-job" not in conn.cancelled_jobs_sent  # pushed out of the cap

        # A second push for the now-evicted id is allowed through again --
        # exactly the "rare duplicate push" the eviction note describes.
        assert "evicted-job" not in conn.cancelled_jobs_sent
    finally:
        ws.close()


def test_unknown_message_type_warns_once_then_debug(client, caplog):
    """Rate limit for unknown message types, mirroring the job-id policy:
    the first bogus type from a connection logs WARNING, repeats of the same
    type name log DEBUG instead."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        with caplog.at_level(logging.DEBUG, logger="comfyfed_server.agentws"):
            for _ in range(3):
                ws.send_json({"type": "not_a_real_type"})
                agentws.dispatch_once(worker_id)

        relevant = [r for r in caplog.records if "unknown message type" in r.getMessage()]
        warnings = [r for r in relevant if r.levelno >= logging.WARNING]
        debugs = [r for r in relevant if r.levelno == logging.DEBUG]
        assert len(warnings) == 1
        assert len(debugs) == 2
    finally:
        ws.close()


def test_unknown_message_type_rate_limit_is_per_type_name(client, caplog):
    """A different unknown type name gets its own first WARNING -- the rate
    limit is keyed by type name, not a single global switch."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        with caplog.at_level(logging.DEBUG, logger="comfyfed_server.agentws"):
            ws.send_json({"type": "bogus_a"})
            agentws.dispatch_once(worker_id)
            ws.send_json({"type": "bogus_a"})
            agentws.dispatch_once(worker_id)
            ws.send_json({"type": "bogus_b"})
            agentws.dispatch_once(worker_id)

        relevant = [r for r in caplog.records if "unknown message type" in r.getMessage()]
        warnings = [r for r in relevant if r.levelno >= logging.WARNING]
        assert len(warnings) == 2  # first bogus_a, first bogus_b
    finally:
        ws.close()


def test_repeat_forged_job_id_warns_once_then_debug_across_message_kinds(client, caplog):
    """The rate limit is per (connection, job id), not per message kind: a
    forged job id first seen via a busy heartbeat still gets downgraded to
    DEBUG on a subsequent `job_done` for the very same id."""
    csrf = _login(client)
    worker_a, key_a = _register_worker(client, csrf, "w-a")
    worker_b, key_b = _register_worker(client, csrf, "w-b")
    job_id = _submit(client, csrf)

    ws_a = _connect(client, worker_a, key_a)
    try:
        ws_a.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_a)
        assert ws_a.receive_json()["type"] == "job"  # worker_a now owns job_id

        ws_b = _connect(client, worker_b, key_b)
        _send_hello_v2(ws_b)  # protocol 2, so it can be told via job_cancelled
        try:
            with caplog.at_level(logging.DEBUG, logger="comfyfed_server.dispatch"):
                ws_b.send_json(
                    {"type": "heartbeat", "state": "busy", "progress": 0.1, "job_id": job_id, "dynamic": {}}
                )
                agentws.dispatch_once(worker_b)
                ws_b.receive_json()  # job_cancelled

                ws_b.send_json({"type": "job_done", "job_id": job_id, "result_files": ["x.png"]})
                agentws.dispatch_once(worker_b)

            warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
            debugs = [r for r in caplog.records if r.levelno == logging.DEBUG]
            assert len(warnings) == 1  # only the first (heartbeat) reference warned
            assert len(debugs) == 1  # the job_done repeat was downgraded

            with db.get_session() as session:
                job = session.get(db.Job, job_id)
                assert job.status == "assigned"
                assert job.worker_id == worker_a
                assert json.loads(job.result_files) == []
        finally:
            ws_b.close()
    finally:
        ws_a.close()


# --- Task 5: non-billable receipts for failed and cancelled runs -----------


def _run_to_running(client, csrf, worker_id, sk, job_id):
    """Connect `worker_id`, get `job_id` dispatched to it, and mark it
    running -- the shared setup every failed/cancelled-receipt test needs.
    Returns the open websocket (caller must close it)."""
    ws = _connect(client, worker_id, sk)
    _send_hello_v2(ws)  # protocol 2, so cancel/job_cancelled pushes reach it
    ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
    agentws.dispatch_once(worker_id)
    assert ws.receive_json()["type"] == "job"
    ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
    agentws.dispatch_once(worker_id)
    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "running"
    return ws


def test_job_failed_mints_non_billable_receipt_with_exec_basis(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _run_to_running(client, csrf, worker_id, sk, job_id)
    try:
        # Large wall-clock span so the exec/wall cap (m2) never binds here --
        # this test is about the exec basis being honoured, not the cap.
        _backdate_started_at(job_id, hours=1)
        ws.send_json(
            {"type": "job_failed", "job_id": job_id, "error": "boom", "exec_seconds": 2.5}
        )
        agentws.dispatch_once(worker_id)

        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"
        assert receipt_msg["kind"] == "failed"
        assert receipt_msg["billable"] is False
        assert receipt_msg["basis"] == "exec"
        # The signed payload byte-format is UNCHANGED: existing worker
        # verifiers must keep validating it regardless of the new kind/
        # billable/basis fields riding alongside it.
        assert receipt_msg["payload"] == f"{job_id}|{worker_id}|2.5"

        with db.get_session() as session:
            receipt = session.get(db.Receipt, receipt_msg["receipt_id"])
            assert receipt.kind == "failed"
            assert receipt.billable is False
            assert receipt.basis == "exec"
            assert receipt.gpu_seconds == 2.5
            assert receipt.job_id == job_id
            assert receipt.worker_id == worker_id
    finally:
        ws.close()


def test_job_failed_caps_absurd_exec_seconds_at_the_wall_clock(client):
    """Final-review m2: a failure receipt is non-billable, but
    `unbilled_gpu_seconds` in the contributions report is a capacity/health
    number -- an agent bug (or a hostile agent) reporting an absurd
    `exec_seconds` for a fast failure must still be capped at the wall
    clock, exactly like the completed-receipt path already is."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _run_to_running(client, csrf, worker_id, sk, job_id)
    try:
        # Wall clock stays small (no backdating) -- just the real time
        # elapsed by the test itself, well under a second.
        ws.send_json(
            {"type": "job_failed", "job_id": job_id, "error": "boom", "exec_seconds": 999999.0}
        )
        agentws.dispatch_once(worker_id)

        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"
        assert receipt_msg["basis"] == "exec"

        with db.get_session() as session:
            receipt = session.get(db.Receipt, receipt_msg["receipt_id"])
            assert 0.0 <= receipt.gpu_seconds < 5.0  # capped, nowhere near 999999
    finally:
        ws.close()


def test_job_failed_without_exec_seconds_falls_back_to_wall_basis(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _run_to_running(client, csrf, worker_id, sk, job_id)
    try:
        ws.send_json({"type": "job_failed", "job_id": job_id, "error": "boom"})
        agentws.dispatch_once(worker_id)

        receipt_msg = ws.receive_json()
        assert receipt_msg["kind"] == "failed"
        assert receipt_msg["billable"] is False
        assert receipt_msg["basis"] == "wall"

        with db.get_session() as session:
            receipt = session.get(db.Receipt, receipt_msg["receipt_id"])
            assert receipt.basis == "wall"
            assert receipt.gpu_seconds >= 0
    finally:
        ws.close()


def test_job_failed_receipt_can_still_be_counter_signed(client):
    """The failed-receipt frame is a real receipt, not a notification -- the
    worker's normal `receipt_ack` flow must work on it exactly like a
    completed one."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _run_to_running(client, csrf, worker_id, sk, job_id)
    try:
        ws.send_json({"type": "job_failed", "job_id": job_id, "error": "boom"})
        agentws.dispatch_once(worker_id)
        receipt_msg = ws.receive_json()

        worker_sig = sk.sign(receipt_msg["payload"].encode()).signature.hex()
        ws.send_json(
            {"type": "receipt_ack", "receipt_id": receipt_msg["receipt_id"], "worker_sig": worker_sig}
        )
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            receipt = session.get(db.Receipt, receipt_msg["receipt_id"])
            assert receipt.worker_sig == worker_sig
    finally:
        ws.close()


def test_console_cancel_of_running_job_mints_cancelled_receipt(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _run_to_running(client, csrf, worker_id, sk, job_id)
    try:
        res = client.post(f"/api/jobs/{job_id}/cancel", headers={"X-CSRF": csrf})
        assert res.status_code == 200

        # The cancelled receipt is minted before job_cancelled is pushed (so
        # a push failure can never cost the receipt), so the receipt frame
        # now arrives first.
        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"
        assert receipt_msg["kind"] == "cancelled"
        assert receipt_msg["billable"] is False
        assert receipt_msg["basis"] == "wall"
        cancelled_msg = ws.receive_json()
        assert cancelled_msg == {"type": "job_cancelled", "job_id": job_id}

        with db.get_session() as session:
            receipts = session.query(db.Receipt).filter(db.Receipt.job_id == job_id).all()
            assert len(receipts) == 1  # exactly once
            assert receipts[0].kind == "cancelled"
            assert receipts[0].gpu_seconds >= 0
    finally:
        ws.close()


def test_panel_interrupt_of_running_job_mints_cancelled_receipt(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit_panel(client)

    ws = _run_to_running(client, csrf, worker_id, sk, job_id)
    try:
        res = client.post("/comfy/api/interrupt")
        assert res.status_code == 200

        receipt_msg = ws.receive_json()  # receipt now precedes job_cancelled
        assert receipt_msg["kind"] == "cancelled"
        assert receipt_msg["billable"] is False
        ws.receive_json()  # job_cancelled

        with db.get_session() as session:
            assert session.query(db.Receipt).filter(db.Receipt.job_id == job_id).count() == 1
    finally:
        ws.close()


def test_panel_queue_delete_of_running_job_mints_cancelled_receipt(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit_panel(client)

    ws = _run_to_running(client, csrf, worker_id, sk, job_id)
    try:
        res = client.post("/comfy/api/queue", json={"delete": [job_id]})
        assert res.status_code == 200

        receipt_msg = ws.receive_json()  # receipt now precedes job_cancelled
        assert receipt_msg["kind"] == "cancelled"
        ws.receive_json()  # job_cancelled

        with db.get_session() as session:
            assert session.query(db.Receipt).filter(db.Receipt.job_id == job_id).count() == 1
    finally:
        ws.close()


def test_cancel_of_queued_job_mints_no_receipt(client):
    """Nothing ran, so nothing is owed a receipt at all -- billable or not."""
    csrf = _login(client)
    job_id = _submit(client, csrf)

    res = client.post(f"/api/jobs/{job_id}/cancel", headers={"X-CSRF": csrf})
    assert res.status_code == 200

    with db.get_session() as session:
        assert session.query(db.Receipt).filter(db.Receipt.job_id == job_id).count() == 0


def test_cancel_of_assigned_but_not_yet_running_job_mints_no_receipt(client):
    """`started_at` is only set by the busy heartbeat (mark_running); a job
    merely handed to a worker but not yet started has burned no GPU time."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        with db.get_session() as session:
            assert session.get(db.Job, job_id).status == "assigned"

        res = client.post(f"/api/jobs/{job_id}/cancel", headers={"X-CSRF": csrf})
        assert res.status_code == 200

        with db.get_session() as session:
            assert session.query(db.Receipt).filter(db.Receipt.job_id == job_id).count() == 0
    finally:
        ws.close()


def test_cancel_and_notify_pushes_receipt_across_event_loops(client):
    """`cancel_and_notify` (and therefore `_mint_cancelled_receipt` /
    `_push_receipt_frame`) can be invoked from a different event loop than
    the one the target connection was accepted on -- e.g. an admin/panel
    HTTP handler running under its own async context relative to a
    long-lived agent websocket. `asyncio.run(...)` here genuinely starts a
    fresh loop distinct from `TestClient`'s (mirrors the `relay()` helper in
    test_comfy_panel_ws.py, which exercises `panelws`'s equivalent
    cross-loop branch the same way): before the fix for review finding M1,
    `_push_receipt_frame` awaited `conn.ws.send_json` directly regardless of
    which loop `conn` belonged to, which fails against a foreign loop and
    was then silently swallowed by the bare `except Exception` around the
    send -- the worker would never see the frame to counter-sign. Pushing
    `job_cancelled` already had the loop-check/`run_coroutine_threadsafe`
    guard (`push_job_cancelled`); the receipt push now mirrors it."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _run_to_running(client, csrf, worker_id, sk, job_id)
    try:
        assert asyncio.run(agentws.cancel_and_notify(job_id, reason="cross-loop cancel"))

        # The cancelled receipt is minted before job_cancelled is pushed (so
        # a push failure can never cost the receipt), so the receipt frame
        # now arrives first.
        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"
        assert receipt_msg["kind"] == "cancelled"
        assert receipt_msg["billable"] is False
        cancelled_msg = ws.receive_json()
        assert cancelled_msg == {"type": "job_cancelled", "job_id": job_id}

        with db.get_session() as session:
            receipts = session.query(db.Receipt).filter(db.Receipt.job_id == job_id).all()
            assert len(receipts) == 1
    finally:
        ws.close()


def test_cancel_of_running_job_with_offline_worker_still_writes_receipt(client):
    """The owning worker may be offline at cancel time (an admin cancelling
    a job whose agent has already dropped/crashed). The receipt must still
    be written -- worker_sig NULL until an ack ever arrives -- rather than
    the mint being skipped just because there is nobody to push it to."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _run_to_running(client, csrf, worker_id, sk, job_id)
    ws.close()  # simulate the worker dropping off before the cancel lands

    res = client.post(f"/api/jobs/{job_id}/cancel", headers={"X-CSRF": csrf})
    assert res.status_code == 200

    with db.get_session() as session:
        receipts = session.query(db.Receipt).filter(db.Receipt.job_id == job_id).all()
        assert len(receipts) == 1
        assert receipts[0].kind == "cancelled"
        assert receipts[0].billable is False
        assert receipts[0].worker_sig is None


def test_cancel_and_notify_still_mints_receipt_when_job_cancelled_push_raises(client, monkeypatch, caplog):
    """Final-review M2: `push_job_cancelled` can raise (a wedged or closed
    target event loop surfaces as `TimeoutError`/`RuntimeError` from
    `run_coroutine_threadsafe(...).result()`, uncaught by anything below the
    HTTP handler). The cancelled receipt must still be minted -- the mint no
    longer sits downstream of the push -- and `cancel_and_notify` must not
    propagate the failure to its caller (an HTTP handler cancelling several
    jobs in a loop)."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _run_to_running(client, csrf, worker_id, sk, job_id)
    try:
        def _boom(*args, **kwargs):
            raise TimeoutError("wedged target loop")

        monkeypatch.setattr(agentws, "push_job_cancelled", _boom)

        with caplog.at_level(logging.WARNING, logger="comfyfed_server.agentws"):
            result = asyncio.run(agentws.cancel_and_notify(job_id, reason="push failure"))

        assert result is True
        assert any("push job_cancelled" in rec.message for rec in caplog.records)

        with db.get_session() as session:
            assert session.get(db.Job, job_id).status == "cancelled"
            receipts = session.query(db.Receipt).filter(db.Receipt.job_id == job_id).all()
            assert len(receipts) == 1
            assert receipts[0].kind == "cancelled"
    finally:
        ws.close()


def test_cancel_and_notify_isolates_panelws_notify_failure(client, monkeypatch, caplog):
    """A `panelws.job_cancelled` failure must not cost the already-minted
    receipt or the agent push, and must not propagate."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _run_to_running(client, csrf, worker_id, sk, job_id)
    try:
        async def _boom(*args, **kwargs):
            raise RuntimeError("panel loop closed")

        monkeypatch.setattr(agentws.panelws, "job_cancelled", _boom)

        with caplog.at_level(logging.WARNING, logger="comfyfed_server.agentws"):
            result = asyncio.run(agentws.cancel_and_notify(job_id, reason="panel failure"))

        assert result is True
        assert any("panelws.job_cancelled" in rec.message for rec in caplog.records)

        ws.receive_json()  # receipt
        ws.receive_json()  # job_cancelled

        with db.get_session() as session:
            assert session.query(db.Receipt).filter(db.Receipt.job_id == job_id).count() == 1
    finally:
        ws.close()


def test_panel_queue_clear_continues_past_one_jobs_notify_failure(client, monkeypatch):
    """Final-review M2: `POST /comfy/api/queue {"clear": true}` cancels every
    matching job in a loop -- one job's `cancel_and_notify` blowing up must
    not 500 the request or leave later jobs untouched."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_a = _submit_panel(client)
    job_b = _submit_panel(client)

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        first = ws.receive_json()
        assert first["type"] == "job"
        running_job = first["job_id"]
        queued_job = job_b if running_job == job_a else job_a

        real_cancel_and_notify = agentws.cancel_and_notify

        async def _flaky(job_id, *, reason):
            if job_id == running_job:
                raise RuntimeError("boom")
            return await real_cancel_and_notify(job_id, reason=reason)

        import comfyfed_server.comfyapi as comfyapi_module

        monkeypatch.setattr(comfyapi_module.agentws, "cancel_and_notify", _flaky)

        res = client.post("/comfy/api/queue", json={"clear": True})
        assert res.status_code == 200

        with db.get_session() as session:
            # running_job's cancel_and_notify blew up entirely, but the loop
            # in post_queue must not abort on that -- the OTHER job in the
            # same sweep is still cancelled.
            assert session.get(db.Job, queued_job).status == "cancelled"
    finally:
        ws.close()


# --- Task 6: agent protocol 2 ----------------------------------------------


def test_hello_records_reported_protocol_and_platform(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"cpu": "x", "platform": "Linux"},
                "backend": "cuda",
                "torch_version": "2.0",
                "node_classes": [],
                "protocol": 2,
            }
        )
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            assert worker.protocol == 2
            assert json.loads(worker.hardware)["platform"] == "Linux"
    finally:
        ws.close()


def test_hello_without_protocol_defaults_to_1_and_sends_deprecation_frame(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"cpu": "x"},
                "backend": "cuda",
                "torch_version": "2.0",
                "node_classes": [],
            }
        )
        frame = ws.receive_json()
        assert frame["type"] == "deprecation"
        assert "agent 版本過舊" in frame["message"]
        assert "outdated" in frame["message"].lower()

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            assert worker.protocol == 1
    finally:
        ws.close()


def test_hello_stores_reported_auto_fetch_true(client):
    """Phase 2.1 Task 3: hello's auto_fetch opt-in flag lands on the worker
    row so assess.verdict's eligible_after_fetch gate can read it."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"cpu": "x"},
                "backend": "cuda",
                "torch_version": "2.0",
                "node_classes": [],
                "protocol": 3,
                "auto_fetch": True,
            }
        )
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            assert worker.auto_fetch is True
    finally:
        ws.close()


def test_hello_stores_reported_auto_fetch_false(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"cpu": "x"},
                "backend": "cuda",
                "torch_version": "2.0",
                "node_classes": [],
                "protocol": 3,
                "auto_fetch": False,
            }
        )
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            assert worker.auto_fetch is False
    finally:
        ws.close()


def test_hello_stores_reported_max_fetch_gb_in_hardware_blob(client):
    """Phase 3.2 F1 fix: hello's optional `max_fetch_gb` rides inside the
    `hardware` JSON blob (no new column/migration) so
    assess._worker_max_fetch_gb can read it back."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"cpu": "x"},
                "backend": "cuda",
                "torch_version": "2.0",
                "node_classes": [],
                "protocol": 4,
                "auto_fetch": True,
                "max_fetch_gb": 5,
            }
        )
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            hardware = json.loads(worker.hardware)
            assert hardware["max_fetch_gb"] == 5
            assert hardware["cpu"] == "x"
    finally:
        ws.close()


def test_hello_without_max_fetch_gb_omits_it_from_hardware_blob(client):
    """An old agent's hello (or one that never reports the field) must not
    invent a value -- assess._worker_max_fetch_gb degrades to the shared
    default instead of trusting a missing/absent key as unlimited."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"cpu": "x"},
                "backend": "cuda",
                "torch_version": "2.0",
                "node_classes": [],
                "protocol": 3,
                "auto_fetch": True,
            }
        )
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            hardware = json.loads(worker.hardware)
            assert "max_fetch_gb" not in hardware
    finally:
        ws.close()


def test_hello_with_invalid_max_fetch_gb_is_ignored(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"cpu": "x"},
                "backend": "cuda",
                "torch_version": "2.0",
                "node_classes": [],
                "protocol": 4,
                "auto_fetch": True,
                "max_fetch_gb": -5,
            }
        )
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            hardware = json.loads(worker.hardware)
            assert "max_fetch_gb" not in hardware
    finally:
        ws.close()


def test_hello_stores_reported_peer_upload_min_mbps_in_hardware_blob(client):
    """The seeder's slowest configured P2P upload cap rides in the same
    `hardware` JSON blob (no new column/migration), read back by
    peer._seeder_rate_bytes_per_sec when sizing a grant's TTL."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"cpu": "x"},
                "backend": "cuda",
                "torch_version": "2.0",
                "node_classes": [],
                "protocol": 4,
                "peer_upload_min_mbps": 5,
            }
        )
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            hardware = json.loads(worker.hardware)
            assert hardware["peer_upload_min_mbps"] == 5
            assert hardware["cpu"] == "x"
    finally:
        ws.close()


@pytest.mark.parametrize("bad", [None, "5", 0, -5, True, float("inf"), float("nan")])
def test_hello_with_a_missing_or_garbage_peer_upload_min_mbps_is_ignored(client, bad):
    """Missing, `null` (both caps unlimited), or garbage must never be stored
    -- grant TTL then keeps its default rate assumption, today's behavior."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        message = {
            "type": "hello",
            "hardware": {"cpu": "x"},
            "backend": "cuda",
            "torch_version": "2.0",
            "node_classes": [],
            "protocol": 4,
        }
        if bad is not None:
            message["peer_upload_min_mbps"] = bad
        else:
            message["peer_upload_min_mbps"] = None
        ws.send_json(message)
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            assert "peer_upload_min_mbps" not in json.loads(worker.hardware)
    finally:
        ws.close()


def test_hello_without_auto_fetch_field_defaults_to_false(client):
    """An old (pre-Task-1) agent's hello has no `auto_fetch` key at all --
    must never be read as consent to auto-download models."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"cpu": "x"},
                "backend": "cuda",
                "torch_version": "2.0",
                "node_classes": [],
                "protocol": 2,
            }
        )
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            assert worker.auto_fetch is False
    finally:
        ws.close()


def test_hello_with_protocol_4_is_accepted_with_no_deprecation_frame(client):
    """Phase 3.1: protocol 4 (chunk-hash fields + peer_url) is a new agent,
    not an old one -- it must be recorded plainly and never earn the
    protocol-too-old deprecation frame."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"cpu": "x"},
                "backend": "cuda",
                "torch_version": "2.0",
                "node_classes": [],
                "protocol": 4,
            }
        )
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        # First frame is the job push, not a deprecation notice.
        job_msg = ws.receive_json()
        assert job_msg["type"] == "job"
        assert job_msg["job_id"] == job_id

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            assert worker.protocol == 4
    finally:
        ws.close()


def test_hello_stores_valid_peer_url(client):
    """Phase 3.1 P2P: a protocol-4 agent with peer_serve enabled advertises
    its seeder endpoint in hello.peer_url; it must land on Worker.peer_url
    verbatim."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"cpu": "x"},
                "backend": "cuda",
                "torch_version": "2.0",
                "node_classes": [],
                "protocol": 4,
                "peer_url": "http://192.168.1.5:8850",
            }
        )
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            assert worker.peer_url == "http://192.168.1.5:8850"
    finally:
        ws.close()


def test_hello_without_peer_url_leaves_it_none(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"cpu": "x"},
                "backend": "cuda",
                "torch_version": "2.0",
                "node_classes": [],
                "protocol": 4,
            }
        )
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            assert worker.peer_url is None
    finally:
        ws.close()


@pytest.mark.parametrize(
    "bad_peer_url",
    [
        "not-a-url",
        "ftp://192.168.1.5:8850",
        "http://",
        "javascript:alert(1)",
        123,
    ],
)
def test_hello_with_invalid_peer_url_is_ignored_and_logged(client, caplog, bad_peer_url):
    """An invalid peer_url (bad scheme, no host, wrong type) must never be
    stored -- it's ignored with a log line, not silently coerced or crashed
    on."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        with caplog.at_level(logging.WARNING):
            ws.send_json(
                {
                    "type": "hello",
                    "hardware": {"cpu": "x"},
                    "backend": "cuda",
                    "torch_version": "2.0",
                    "node_classes": [],
                    "protocol": 4,
                    "peer_url": bad_peer_url,
                }
            )
            agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            assert worker.peer_url is None
        assert any("peer_url" in rec.message for rec in caplog.records)
    finally:
        ws.close()


def test_hello_replaces_stale_peer_url_when_no_longer_advertised(client):
    """peer_url is fully replaced from each hello, same as the other hello
    fields -- an agent that reconnects with peer_serve now off must not
    keep a previous session's endpoint alive."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.peer_url = "http://old-host:8850"
        session.commit()

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"cpu": "x"},
                "backend": "cuda",
                "torch_version": "2.0",
                "node_classes": [],
                "protocol": 4,
            }
        )
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            assert worker.peer_url is None
    finally:
        ws.close()


def test_hello_with_protocol_2_sends_no_deprecation_frame(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"cpu": "x"},
                "backend": "cuda",
                "torch_version": "2.0",
                "node_classes": [],
                "protocol": 2,
            }
        )
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        # The first (and only) frame this connection receives is the job
        # push -- no deprecation frame was ever sent.
        job_msg = ws.receive_json()
        assert job_msg["type"] == "job"
        assert job_msg["job_id"] == job_id
    finally:
        ws.close()


def test_job_cancelled_is_not_pushed_to_a_protocol_1_worker(client, caplog):
    """A protocol-1 worker (the default for a freshly registered worker that
    has never sent a `hello` with `protocol: 2`) can't act on `job_cancelled`
    -- it would only log an unknown-message-type warning -- so the server
    must skip the push silently rather than sending it."""
    csrf = _login(client)
    worker_a, key_a = _register_worker(client, csrf, "w-a")
    worker_b, key_b = _register_worker(client, csrf, "w-b")
    job_id = _submit(client, csrf)

    ws_a = _connect(client, worker_a, key_a)
    try:
        ws_a.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_a)
        assert ws_a.receive_json()["type"] == "job"  # worker_a now owns job_id

        # worker_b is protocol 1 by default (no hello sent).
        ws_b = _connect(client, worker_b, key_b)
        try:
            with caplog.at_level(logging.DEBUG, logger="comfyfed_server.dispatch"):
                ws_b.send_json(
                    {
                        "type": "heartbeat",
                        "state": "busy",
                        "progress": 0.1,
                        "job_id": job_id,
                        "dynamic": {},
                    }
                )
                agentws.dispatch_once(worker_b)

            # No job_cancelled was ever queued to push to worker_b.
            assert agentws._connections[worker_b].cancelled_jobs_sent == set()
        finally:
            ws_b.close()
    finally:
        ws_a.close()


def test_job_done_missing_exec_seconds_for_protocol_2_logs_error(client, caplog):
    """A protocol-2 agent guarantees `exec_seconds` once the run started
    (Task 5) -- omitting it is a protocol violation, not a routine fallback,
    so it must log at ERROR (still falling back to wall-clock billing)."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"cpu": "x"},
                "backend": "cuda",
                "torch_version": "2.0",
                "node_classes": [],
                "protocol": 2,
            }
        )
        agentws.dispatch_once(worker_id)

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.5, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        with caplog.at_level(logging.ERROR, logger="comfyfed_server.agentws"):
            ws.send_json({"type": "job_done", "job_id": job_id, "result_files": ["out.png"]})
            agentws.dispatch_once(worker_id)
            ws.receive_json()  # receipt frame

        errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
        assert len(errors) == 1
        assert "protocol violation" in errors[0].message.lower()

        with db.get_session() as session:
            receipt = session.query(db.Receipt).filter(db.Receipt.job_id == job_id).one()
            assert receipt.basis == "wall"
    finally:
        ws.close()


def test_stageless_heartbeat_clears_fetch_chip_and_starts_the_run(client):
    """final-review m1, settled at the root on the AGENT side: every
    heartbeat the agent sends while the fetch phase is active carries
    stage="fetching_models" (initial busy beat, progress reports, AND the
    periodic 30s beat -- see runner._JobHandle.fetch_status), so the server
    may keep the simple contract asserted here: a stage-less busy beat
    means the download is over -- it clears the transient chip and is the
    run-started (started_at) transition, atomically from the panel's view."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_id, sk)
    try:
        _send_hello_v2(ws)
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json(
            {
                "type": "heartbeat",
                "state": "busy",
                "progress": 0.0,
                "job_id": job_id,
                "dynamic": {},
                "stage": "fetching_models",
                "fetch_pct": 33.0,
                "fetch_model": "m.safetensors",
            }
        )
        agentws.dispatch_once(worker_id)
        assert agentws._fetch_progress[job_id]["fetch_pct"] == 33.0

        # The first stage-less busy heartbeat: download over, run starts.
        # Chip cleared and started_at set by the same beat -- the agent
        # guarantees no stage-less beat can slip out mid-download, so this
        # transition is unambiguous.
        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        with db.get_session() as session:
            assert session.get(db.Job, job_id).status == "running"
        assert job_id not in agentws._fetch_progress
    finally:
        ws.close()


# ------------------------------------------- admin soft delete (Worker.deleted)


def test_handshake_refused_for_a_deleted_worker(client):
    """A soft-deleted worker can never get a live socket back, however valid
    its certificate and signature still are -- see `_handshake`."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w-deleted")

    assert client.delete(f"/api/workers/{worker_id}", headers={"X-CSRF": csrf}).status_code == 200

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})

        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()
        assert exc_info.value.code == 4401


def test_delete_kicks_a_live_agent_connection(client):
    """Deleting a CONNECTED worker closes its socket (4403) and unregisters
    it immediately, rather than leaving it heartbeating against a worker the
    console no longer shows -- see `agentws.kick_worker`."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w-live-delete")

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"
        assert worker_id in agentws._connections

        assert client.delete(f"/api/workers/{worker_id}", headers={"X-CSRF": csrf}).status_code == 200

        assert worker_id not in agentws._connections
        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()
        assert exc_info.value.code == 4403


def test_deleted_worker_is_not_dispatched_to(client):
    """Even with a stale registry entry, `assign_jobs` filters deleted rows,
    so a queued job is never handed to a deleted worker."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w-no-dispatch")
    job_id = _submit(client, csrf)

    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.deleted = True
        session.commit()

    assert dispatch.assign_jobs([worker_id], {}, frozenset()) == []

    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "queued"


# --- Phase 3.3 §3.6 fix round 1：取消父 job 要通知**每一台** worker --------


def _make_split_family(parent_id, child_worker_ids):
    """父 job + 一個子 job per worker，子 job 都在 running。

    直接寫 DB（而不是走一次真正的 tick 拆分）是刻意的：這個測試釘的是「取消
    一個已經拆好的 job 會發生什麼」，拆分本身在 test_split.py / test_dispatch.py
    已經有覆蓋，這裡不該再依賴排程器剛好把兩個子 job 派到這兩台 worker 上。
    """
    with db.get_session() as session:
        session.add(
            db.Job(
                id=parent_id,
                workflow_json="{}",
                status="running",
                split_count=len(child_worker_ids),
                split_plan=json.dumps({"source_node_id": "1", "batch_size": 2}),
            )
        )
        for index, worker_id in enumerate(child_worker_ids):
            session.add(
                db.Job(
                    id=f"{parent_id}-c{index}",
                    workflow_json="{}",
                    status="running",
                    worker_id=worker_id,
                    parent_id=parent_id,
                    split_index=index,
                )
            )
        session.commit()
    return [f"{parent_id}-c{index}" for index in range(len(child_worker_ids))]


def test_cancelling_a_split_parent_notifies_every_child_worker(client):
    """Review fix 1：串聯取消掉的兄弟，它們的 owner 也要收到 `job_cancelled`。

    以前只有迴圈第一圈的那個子 job 的 owner 收得到 -- 第一個子 job 的取消會
    透過 `refresh_parent` 把兄弟一起收掉，於是後面的圈次看到它們已經是
    cancelled、`cancel_job` 回 None，那些 owner 就被丟掉了。所以一個拆成 k 份
    的 job 被取消時，有 k-1 台 worker 會一路把圖跑完才發現沒人要。
    """
    csrf = _login(client)
    worker_a, sk_a = _register_worker(client, csrf, "wa")
    worker_b, sk_b = _register_worker(client, csrf, "wb")
    child_ids = _make_split_family("p_cancel", [worker_a, worker_b])

    ws_a = _connect(client, worker_a, sk_a)
    ws_b = _connect(client, worker_b, sk_b)
    try:
        _send_hello_v2(ws_a)
        _send_hello_v2(ws_b)
        for ws, child_id in ((ws_a, child_ids[0]), (ws_b, child_ids[1])):
            ws.send_json(
                {"type": "heartbeat", "state": "busy", "progress": 0.1, "job_id": child_id, "dynamic": {}}
            )

        assert client.post("/api/jobs/p_cancel/cancel", headers={"X-CSRF": csrf}).status_code == 200

        # 先用每條連線的去重集合斷言「推過了」-- 這是非阻塞的，迴歸時會立刻
        # 失敗而不是卡在下面的 receive_json 上等一個永遠不會來的 frame。
        for worker, child_id in ((worker_a, child_ids[0]), (worker_b, child_ids[1])):
            assert child_id in agentws._connections[worker].cancelled_jobs_sent

        # 再確認 frame 本身真的在線上。
        for ws, child_id in ((ws_a, child_ids[0]), (ws_b, child_ids[1])):
            assert ws.receive_json() == {"type": "job_cancelled", "job_id": child_id}
    finally:
        ws_a.close()
        ws_b.close()

    with db.get_session() as session:
        parent = session.get(db.Job, "p_cancel")
        children = [session.get(db.Job, child_id) for child_id in child_ids]
    assert parent.status == "cancelled"
    assert [c.status for c in children] == ["cancelled", "cancelled"]
    # 串聯掉的兄弟帶的是這次取消的理由，不是「sibling cancelled」。
    assert [c.error for c in children] == ["cancelled by admin", "cancelled by admin"]
    # 所有權都釋放了，所以那台 worker 之後的每一句話都會落在 not-owned 自癒路徑。
    assert all(c.worker_id is None for c in children)
    assert sorted(c.last_worker_id for c in children) == sorted([worker_a, worker_b])


def test_a_failed_child_cancels_its_sibling_and_tells_that_worker(client):
    """§3.4/§3.6：子 job 失敗 -> 父 job 失敗 + 兄弟取消 + 兄弟的 worker 收到
    `job_cancelled`（不用等下一次心跳落在 not-owned 路徑）。"""
    csrf = _login(client)
    worker_a, sk_a = _register_worker(client, csrf, "wa")
    worker_b, sk_b = _register_worker(client, csrf, "wb")
    child_ids = _make_split_family("p_fail", [worker_a, worker_b])
    # 2026-09-19 job-retry：連坐只在**終局**失敗時發生，所以先把這個子 job
    # 的 attempts 撐到上限。「第一次失敗不連坐」由
    # test_a_failed_child_is_retried_before_cascading 釘。
    _exhaust_attempts(child_ids[0])

    ws_a = _connect(client, worker_a, sk_a)
    ws_b = _connect(client, worker_b, sk_b)
    try:
        _send_hello_v2(ws_a)
        _send_hello_v2(ws_b)
        ws_a.send_json({"type": "job_failed", "job_id": child_ids[0], "error": "CUDA OOM"})
        # 同步一次，確保上面那個 fire-and-forget 的 frame 已經處理完。
        assert client.get("/api/jobs/p_fail", headers={"X-CSRF": csrf}).status_code == 200

        # 非阻塞斷言在前（見上一個測試的說明），frame 驗證在後。
        assert child_ids[1] in agentws._connections[worker_b].cancelled_jobs_sent
        assert ws_b.receive_json() == {"type": "job_cancelled", "job_id": child_ids[1]}
    finally:
        ws_a.close()
        ws_b.close()

    with db.get_session() as session:
        parent = session.get(db.Job, "p_fail")
        sibling = session.get(db.Job, child_ids[1])
    assert parent.status == "failed"
    assert parent.error.startswith("子任務 1/2：已在 ")
    assert "wa: CUDA OOM" in parent.error
    assert sibling.status == "cancelled"
    assert sibling.error == "sibling failed"
    assert sibling.worker_id is None


def test_a_failed_childs_cascaded_sibling_gets_a_cancelled_receipt(client):
    """一致性裁決：被**失敗**連坐取消的兄弟，如果取消當下正在跑，也要拿到一張
    non-billable 的 `cancelled` 收據 —— 和取消父 job 那條路徑同一個 helper、
    同一個 wall-clock 基準。失敗的那一個自己照舊拿 `failed` 收據。
    """
    csrf = _login(client)
    worker_a, sk_a = _register_worker(client, csrf, "wa")
    worker_b, sk_b = _register_worker(client, csrf, "wb")
    child_ids = _make_split_family("p_fail_rcpt", [worker_a, worker_b])
    # `_make_split_family` 直接寫 DB，沒有 `started_at`；沒有它兩邊都不算
    # 「真的燒過 GPU」，收據語意就不成立。
    for child_id in child_ids:
        _backdate_started_at(child_id, hours=1)
    # 連坐只在終局失敗時發生（見上一個測試）。
    _exhaust_attempts(child_ids[0])

    ws_a = _connect(client, worker_a, sk_a)
    ws_b = _connect(client, worker_b, sk_b)
    try:
        _send_hello_v2(ws_a)
        _send_hello_v2(ws_b)
        ws_a.send_json(
            {"type": "job_failed", "job_id": child_ids[0], "error": "CUDA OOM", "exec_seconds": 3.0}
        )
        assert client.get("/api/jobs/p_fail_rcpt", headers={"X-CSRF": csrf}).status_code == 200

        # 非阻塞斷言在前：兄弟那張收據已經寫下去了嗎？迴歸時這裡立刻失敗，
        # 而不是卡在下面那個永遠不會來的 frame 上（Task 6 報告的同一個教訓）。
        # 只看兄弟那一張：失敗者自己的 `failed` 收據是在 panel 通知**之後**
        # 才 mint 的，這個 HTTP 屏障不保證它已經落地（整個檔案一起跑時會race）
        # —— 它由下面的 frame 與收尾的 DB 斷言負責。
        with db.get_session() as session:
            minted = {r.job_id: (r.kind, r.worker_id) for r in session.query(db.Receipt).all()}
        assert minted.get(child_ids[1]) == ("cancelled", worker_b)

        # 兄弟：先 job_cancelled，再它自己那張 cancelled 收據。
        assert ws_b.receive_json() == {"type": "job_cancelled", "job_id": child_ids[1]}
        sibling_frame = ws_b.receive_json()
        assert sibling_frame["type"] == "receipt"
        assert sibling_frame["kind"] == "cancelled"
        assert sibling_frame["billable"] is False
        assert sibling_frame["basis"] == "wall"
        # 失敗的那一個：照舊是 failed 收據，一行都沒變。
        failed_frame = ws_a.receive_json()
        assert failed_frame["type"] == "receipt"
        assert failed_frame["kind"] == "failed"
        assert failed_frame["billable"] is False
    finally:
        ws_a.close()
        ws_b.close()

    with db.get_session() as session:
        receipts = session.query(db.Receipt).all()
    by_job = {r.job_id: r for r in receipts}
    assert set(by_job) == set(child_ids)  # 父 job 零張
    assert by_job[child_ids[0]].kind == "failed"
    assert by_job[child_ids[0]].worker_id == worker_a
    assert by_job[child_ids[1]].kind == "cancelled"
    assert by_job[child_ids[1]].billable is False
    assert by_job[child_ids[1]].worker_id == worker_b
    assert by_job[child_ids[1]].gpu_seconds > 0


def test_child_heartbeat_progress_drives_the_parent_progress(client):
    """§3.4：父 job 的 progress 是子 job 的平均，靠子 job 的心跳推動。"""
    csrf = _login(client)
    worker_a, sk_a = _register_worker(client, csrf, "wa")
    worker_b, sk_b = _register_worker(client, csrf, "wb")
    child_ids = _make_split_family("p_prog", [worker_a, worker_b])

    ws_a = _connect(client, worker_a, sk_a)
    ws_b = _connect(client, worker_b, sk_b)
    try:
        _send_hello_v2(ws_a)
        _send_hello_v2(ws_b)
        ws_a.send_json(
            {"type": "heartbeat", "state": "busy", "progress": 0.2, "job_id": child_ids[0], "dynamic": {}}
        )
        ws_b.send_json(
            {"type": "heartbeat", "state": "busy", "progress": 0.6, "job_id": child_ids[1], "dynamic": {}}
        )
        # 心跳是 fire-and-forget，用一句同步的 HTTP 請求確保兩個都處理完了。
        assert client.get("/api/jobs/p_prog", headers={"X-CSRF": csrf}).status_code == 200
    finally:
        ws_a.close()
        ws_b.close()

    with db.get_session() as session:
        parent = session.get(db.Job, "p_prog")
    assert parent.progress == pytest.approx(0.4)


# --- Phase 3.3 Task 10：端到端批次拆分（兩台假 worker，走面板送件路徑）------
#
# 上面那三個 §3.6 測試是直接寫 DB 造出一個已經拆好的家族（刻意的：它們釘的是
# 取消／串聯本身）。這一段相反 -- 從 `POST /comfy/api/prompt` 開始，讓**真的**
# dispatch tick 去拆、去派工，然後把兩台 worker 的輸出合回父 job，一路驗到
# 面板的 `/history` + `/view`、console 的 `/api/jobs`、收據與 `worker_job_stats`。
# 兩棧對照：`cloud/test/e2e.spec.ts` 的 "splits a batch_size=4 panel prompt..."。

_SPLIT_NODE_CLASSES = [
    "EmptySD3LatentImage",
    "KSampler",
    "VAEDecode",
    "SaveImage",
    # 子 workflow 多出來的那一個 -- 沒宣告的 worker 會被 §2.3 的 required_nodes
    # 判定擋在子 job 之外（見 split.create_children 的 child_nodes）。
    "LatentFromBatch",
]

# §3.2 的六個條件全部成立：唯一的批次來源（batch_size=4）、沒有別的 batch_size、
# 每個節點都在白名單裡、KSampler 的 latent 沿 slot 0 追得到來源、SaveImage 以
# 來源為祖先。
_SPLIT_WORKFLOW = {
    "1": {"class_type": "EmptySD3LatentImage", "inputs": {"width": 512, "height": 512, "batch_size": 4}},
    "2": {"class_type": "KSampler", "inputs": {"latent_image": ["1", 0], "steps": 4, "seed": 424242}},
    "3": {"class_type": "VAEDecode", "inputs": {"samples": ["2", 0]}},
    "4": {"class_type": "SaveImage", "inputs": {"images": ["3", 0]}},
}

# 兩台 worker 刻意回報**一模一樣**的檔名：ComfyUI 的輸出前綴計數器是每台機器
# 自己的，所以同一個父 job 的兩個子 job 產生同名檔案是常態。history 的
# `subfolder`（= 持有檔案的子 job id）就是用來讓 `/view` 分得出兩份的。
_COLLIDING_FILES = ["ComfyUI_00001_.png", "ComfyUI_00002_.png"]


def _send_split_hello(ws):
    """`_send_hello_v2` 但帶著拆分需要的節點清單（那個 helper 送空清單，而空
    清單在 assess.py 是「不知道」而不是「都不支援」-- 這裡要真的宣告）。"""
    ws.send_json(
        {
            "type": "hello",
            "hardware": {"vram_gb": 24},
            "backend": "cuda",
            "torch_version": "2.4.0",
            "node_classes": _SPLIT_NODE_CLASSES,
            "protocol": 2,
        }
    )


def _connect_idle_split_worker(client, csrf, name):
    """註冊 + 連線 + hello + 一次 idle 心跳，並用一次 `dispatch_once` 把那個
    心跳同步掉（和 test_paused_worker_excluded_from_dispatch... 同樣的作法）。"""
    worker_id, sk = _register_worker(client, csrf, name)
    ws = _connect(client, worker_id, sk)
    _send_split_hello(ws)
    ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
    agentws.dispatch_once(worker_id)
    return worker_id, sk, ws


def _signed_artifact_upload(client, job_id, worker_id, signing_key, filename, content):
    """簽名的 multipart artifact 上傳（和 test_receipts.py 的
    `_signed_post_multipart` 同一個樣板，那個檔案沒有 export 給別人用）。"""
    path = f"/api/agent/jobs/{job_id}/artifacts"
    req = httpx.Request(
        "POST",
        "http://testserver" + path,
        files={"file": (filename, content, "application/octet-stream")},
    )
    body = req.read()
    ts = str(int(time.time()))
    nonce = secrets.token_hex(8)
    message = f"POST\n{path}\n{ts}\n{nonce}\n".encode() + body
    sig = signing_key.sign(message).signature.hex()
    return client.post(
        path,
        content=body,
        headers={
            "Content-Type": req.headers["content-type"],
            "X-Worker-Id": worker_id,
            "X-Ts": ts,
            "X-Nonce": nonce,
            "X-Sig": sig,
        },
    )


def _split_children(parent_id):
    with db.get_session() as session:
        return (
            session.query(db.Job)
            .filter(db.Job.parent_id == parent_id)
            .order_by(db.Job.split_index.asc())
            .all()
        )


def test_batch_split_across_two_workers_end_to_end(client):
    """兩台 idle worker + 一張 batch_size=4 的面板送件 -> 2 個子 job 各 2 張，
    父 job 依序拿到 4 個輸出、面板只看得到父、收據一台一張。"""
    csrf = _login(client)
    worker_a, sk_a, ws_a = _connect_idle_split_worker(client, csrf, "gpu-split-0")
    worker_b, sk_b, ws_b = _connect_idle_split_worker(client, csrf, "gpu-split-1")
    by_worker = {worker_a: (sk_a, ws_a), worker_b: (sk_b, ws_b)}

    try:
        parent_id = _submit_panel(client, _SPLIT_WORKFLOW)

        with db.get_session() as session:
            parent = session.get(db.Job, parent_id)
            assert json.loads(parent.split_plan) == {"source_node_id": "1", "batch_size": 4}
            assert parent.split_count == 0  # 還沒 tick，還沒拆

        # 一次 tick：拆成 2 個子 job 並各派一台 worker。
        agentws.dispatch_once(worker_a)

        children = _split_children(parent_id)
        assert [c.split_index for c in children] == [0, 1]
        assert {c.worker_id for c in children} == {worker_a, worker_b}
        assert json.loads(children[0].workflow_json)["cfsplit"]["inputs"] == {
            "samples": ["1", 0],
            "batch_index": 0,
            "length": 2,
        }
        assert json.loads(children[1].workflow_json)["cfsplit"]["inputs"] == {
            "samples": ["1", 0],
            "batch_index": 2,
            "length": 2,
        }
        # 子 workflow 的 KSampler 改吃 cfsplit 的輸出，不再直接吃批次來源。
        assert json.loads(children[0].workflow_json)["2"]["inputs"]["latent_image"] == ["cfsplit", 0]

        with db.get_session() as session:
            parent = session.get(db.Job, parent_id)
            assert parent.split_count == 2
            # 派工也推導父 job：`dispatch.assign_jobs` 的原子 claim 成功之後會
            # 對每個有 `parent_id` 的 job 叫一次 `split.child_status_changed`，
            # 所以子 job 變成 assigned 的同一個 tick 裡，父 job 就從 queued 變成
            # assigned（§3.4 表格的 `[assigned] -> assigned` 那一列）。少了這個
            # 推導，console／面板會在「兩台 worker 已經在拿圖了」的整段區間裡
            # 顯示 queued，直到第一個子 job 的 busy 心跳才跳成 running。
            assert parent.status == "assigned"
            assert parent.worker_id is None  # 父 job 從來沒有自己的 worker

        # 每條連線各收到自己那個子 job 的 push，frame 裡的 workflow 帶著自己
        # 那一段 batch 範圍。
        pushed = {}
        for child in children:
            _sk, ws = by_worker[child.worker_id]
            frame = ws.receive_json()
            assert frame["type"] == "job"
            pushed[frame["job_id"]] = frame
        assert set(pushed) == {c.id for c in children}
        for child in children:
            frame_workflow = json.loads(pushed[child.id]["workflow_json"])
            assert frame_workflow["cfsplit"]["inputs"]["batch_index"] == child.split_index * 2
            assert frame_workflow["cfsplit"]["inputs"]["length"] == 2

        # 這時面板的 /queue 只看得到父 job -- 子 job 是拆分的實作細節。
        queue_mid = client.get("/comfy/api/queue").json()
        queued_ids = [entry[1] for entry in queue_mid["queue_running"] + queue_mid["queue_pending"]]
        assert queued_ids == [parent_id]

        # 兩台都開始跑 -> 父 job 被推導成 running，進度是子 job 的平均。
        for child in children:
            _sk, ws = by_worker[child.worker_id]
            ws.send_json(
                {"type": "heartbeat", "state": "busy", "progress": 0.5, "job_id": child.id, "dynamic": {}}
            )
            agentws.dispatch_once(child.worker_id)
        with db.get_session() as session:
            parent = session.get(db.Job, parent_id)
            assert parent.status == "running"
            assert parent.progress == pytest.approx(0.5)

        # 兩個子 job 各跑完 2 張（檔名故意相同），各回報 12.5 秒。
        for child in children:
            sk, ws = by_worker[child.worker_id]
            # exec_seconds 會被 wall clock 夾住，所以把開始時間推到一小時前，
            # 讓 gpu_seconds 就是回報的 12.5（見 _backdate_started_at）。
            _backdate_started_at(child.id, hours=1)
            for name in _COLLIDING_FILES:
                res = _signed_artifact_upload(
                    client, child.id, child.worker_id, sk, name,
                    f"c{child.split_index}-{name}".encode(),
                )
                assert res.status_code == 200
            ws.send_json(
                {
                    "type": "job_done",
                    "job_id": child.id,
                    "result_files": list(_COLLIDING_FILES),
                    "exec_seconds": 12.5,
                }
            )
            agentws.dispatch_once(child.worker_id)
            assert ws.receive_json()["type"] == "receipt"

        with db.get_session() as session:
            parent = session.get(db.Job, parent_id)
            assert parent.status == "done"
            assert json.loads(parent.result_files or "[]") == []  # 父 job 自己沒有檔案

        # ---- 面板：history 只有父 job，4 張圖依批次順序，subfolder 是持有者
        history = client.get("/comfy/api/history").json()
        assert list(history.keys()) == [parent_id]
        images = [
            image
            for payload in history[parent_id]["outputs"].values()
            for image in payload.get("images", [])
        ]
        assert [i["filename"] for i in images] == _COLLIDING_FILES + _COLLIDING_FILES
        assert [i["subfolder"] for i in images] == [
            children[0].id, children[0].id, children[1].id, children[1].id
        ]

        # 子 job 自己的 history 是空的。
        assert client.get(f"/comfy/api/history/{children[0].id}").json() == {}

        # ---- /view：同名檔案靠 subfolder 分得出來，各自拿到自己的位元組
        for child in children:
            for name in _COLLIDING_FILES:
                res = client.get(
                    "/comfy/api/view",
                    params={"filename": name, "subfolder": child.id, "type": "output"},
                )
                assert res.status_code == 200
                assert res.content == f"c{child.split_index}-{name}".encode()

        # ---- console：列表預設只有父 job，?include_children=1 才看得到三筆
        listed = client.get("/api/jobs", headers={"X-CSRF": csrf}).json()
        assert [j["id"] for j in listed] == [parent_id]
        assert listed[0]["split_count"] == 2
        listed_all = client.get(
            "/api/jobs", params={"include_children": 1}, headers={"X-CSRF": csrf}
        ).json()
        assert {j["id"] for j in listed_all} == {parent_id, children[0].id, children[1].id}
        assert {j["parent_id"] for j in listed_all} == {None, parent_id}

        # ---- console 詳細頁：父 job 沒有收據，改看 children / gpu_seconds_total
        detail = client.get(f"/api/jobs/{parent_id}", headers={"X-CSRF": csrf}).json()
        assert detail["receipt"] is None
        assert detail["split_count"] == 2
        assert [c["split_index"] for c in detail["children"]] == [0, 1]
        assert [c["gpu_seconds"] for c in detail["children"]] == [12.5, 12.5]
        assert detail["gpu_seconds_total"] == pytest.approx(25.0)
        assert detail["outputs"] == [
            {"job_id": children[0].id, "filename": _COLLIDING_FILES[0]},
            {"job_id": children[0].id, "filename": _COLLIDING_FILES[1]},
            {"job_id": children[1].id, "filename": _COLLIDING_FILES[0]},
            {"job_id": children[1].id, "filename": _COLLIDING_FILES[1]},
        ]

        # ---- 收據：一個子 job 一張，父 job 沒有；每台 worker 各一張
        with db.get_session() as session:
            receipts = session.query(db.Receipt).all()
            parent_receipts = [r for r in receipts if r.job_id == parent_id]
            assert parent_receipts == []
            assert len(receipts) == 2
            assert sorted(r.worker_id for r in receipts) == sorted([worker_a, worker_b])
            assert {r.job_id for r in receipts} == {children[0].id, children[1].id}
            assert all(r.kind == "completed" and r.billable for r in receipts)
            assert all(r.gpu_seconds == 12.5 for r in receipts)

            # ---- Final-review I1：子 job 不進統計。子 job 繼承父 job 的簽章，
            # 卻只跑 1/k 批；收它的 exec_seconds 會把這個簽章的 EWMA 拉到實際
            # 全批時間的 1/k（這裡就是 12.5 而不是 25），speed_index 也跟著偏。
            # 後續：幫子 job 算一個含切片長度的自己的簽章。
            signature = children[0].signature
            assert children[1].signature == signature
            assert session.query(db.WorkerJobStats).count() == 0
            for worker_id in (worker_a, worker_b):
                assert session.get(db.WorkerJobStats, (worker_id, signature)) is None
                assert session.get(db.Worker, worker_id).speed_index == 1.0
    finally:
        ws_a.close()
        ws_b.close()


def test_split_batches_false_keeps_the_prompt_whole(client):
    """平台設定關掉之後，同一張圖整包派給單一 worker，一個子 job 都不長。"""
    csrf = _login(client)
    r = client.post("/api/settings", json={"split_batches": False}, headers={"X-CSRF": csrf})
    assert r.status_code == 200
    assert r.json()["split_batches"] is False

    worker_a, sk_a, ws_a = _connect_idle_split_worker(client, csrf, "gpu-whole-0")
    worker_b, sk_b, ws_b = _connect_idle_split_worker(client, csrf, "gpu-whole-1")
    try:
        parent_id = _submit_panel(client, _SPLIT_WORKFLOW)

        # 送件時就已經不記計畫了（`split.plan_for_job` 讀的是同一個設定）。
        with db.get_session() as session:
            assert session.get(db.Job, parent_id).split_plan is None

        agentws.dispatch_once(worker_a)

        assert _split_children(parent_id) == []
        with db.get_session() as session:
            job = session.get(db.Job, parent_id)
            assert job.split_count == 0
            assert job.status == "assigned"
            assert job.worker_id in (worker_a, worker_b)
            owner = job.worker_id

        ws = ws_a if owner == worker_a else ws_b
        frame = ws.receive_json()
        assert frame["type"] == "job"
        assert frame["job_id"] == parent_id
        # 整包 -- 沒有 LatentFromBatch 被插進去。
        assert "cfsplit" not in json.loads(frame["workflow_json"])
    finally:
        ws_a.close()
        ws_b.close()


def test_cancelling_a_running_split_parent_stops_both_workers(client):
    """§3.6：父 job 在兩個子 job 都在跑的時候被取消 -> 兩台 worker 都收到
    自己那個子 job 的 `job_cancelled`，父 job 與兩個子 job 都 cancelled。

    和上面 `test_cancelling_a_split_parent_notifies_every_child_worker` 的差別
    是這個從真的送件 + 真的 tick 拆分開始（那個直接寫 DB 造家族）。
    """
    csrf = _login(client)
    worker_a, sk_a, ws_a = _connect_idle_split_worker(client, csrf, "gpu-cancel-0")
    worker_b, sk_b, ws_b = _connect_idle_split_worker(client, csrf, "gpu-cancel-1")
    by_worker = {worker_a: ws_a, worker_b: ws_b}

    try:
        parent_id = _submit_panel(client, _SPLIT_WORKFLOW)
        agentws.dispatch_once(worker_a)

        children = _split_children(parent_id)
        assert len(children) == 2
        for child in children:
            ws = by_worker[child.worker_id]
            assert ws.receive_json()["type"] == "job"
            ws.send_json(
                {"type": "heartbeat", "state": "busy", "progress": 0.1, "job_id": child.id, "dynamic": {}}
            )
            agentws.dispatch_once(child.worker_id)

        with db.get_session() as session:
            assert session.get(db.Job, parent_id).status == "running"

        assert client.post(f"/api/jobs/{parent_id}/cancel", headers={"X-CSRF": csrf}).status_code == 200

        # 非阻塞斷言在前（迴歸時立刻失敗而不是卡在 receive_json 上）。
        for child in children:
            assert child.id in agentws._connections[child.worker_id].cancelled_jobs_sent
        for child in children:
            ws = by_worker[child.worker_id]
            # 先 `job_cancelled`（串聯 flush），再一張 cancelled 收據 —— 真正在
            # 燒 GPU 的是子 job，所以每個「取消當下正在 running 的子 job」都要
            # 像單一 job 取消那樣 mint 一張 non-billable 的 cancelled 收據。
            assert ws.receive_json() == {"type": "job_cancelled", "job_id": child.id}
            frame = ws.receive_json()
            assert frame["type"] == "receipt"
            assert frame["kind"] == "cancelled"
            assert frame["billable"] is False
            assert frame["basis"] == "wall"
    finally:
        ws_a.close()
        ws_b.close()

    with db.get_session() as session:
        parent = session.get(db.Job, parent_id)
        rows = [session.get(db.Job, c.id) for c in children]
        receipts = session.query(db.Receipt).all()
    assert parent.status == "cancelled"
    assert [c.status for c in rows] == ["cancelled", "cancelled"]
    assert all(c.worker_id is None for c in rows)
    assert [c.error for c in rows] == ["cancelled by admin", "cancelled by admin"]
    # 剛好兩張 cancelled 收據，一台 worker 一張、開在子 job 上（父 job 自己
    # 從來沒有 started_at，所以不該有收據）。
    assert len(receipts) == 2
    assert {r.kind for r in receipts} == {"cancelled"}
    assert all(r.billable is False for r in receipts)
    assert {r.worker_id for r in receipts} == {worker_a, worker_b}
    assert {r.job_id for r in receipts} == {c.id for c in children}


# --- Phase 3.4 Task 1: ready.remote_ip 與 hello 的 P2P NAT 欄位 -------------


def _handshake_ws(client, worker_id, sk, headers=None):
    """開一條 agent WS 並完成挑戰-回應，回傳 (ws_context, ready_frame)。
    `headers` 讓測試模擬反向代理的 X-Forwarded-For。"""
    ctx = client.websocket_connect("/api/agent/ws", headers=headers or {})
    ws = ctx.__enter__()
    challenge = ws.receive_json()
    sig = sk.sign(challenge["nonce"].encode()).signature.hex()
    ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
    ready = ws.receive_json()
    return ctx, ws, ready


def test_ready_carries_remote_ip_from_client_host(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "nat-1")
    ctx, ws, ready = _handshake_ws(client, worker_id, sk)
    try:
        assert ready["type"] == "ready"
        # TestClient 的 client host 是 "testclient"，重點是欄位一定在且非 None。
        assert ready["remote_ip"] is not None
    finally:
        ctx.__exit__(None, None, None)


def _set_trust_proxy(value: bool) -> None:
    """平台設定 `trust_proxy`（預設關）。"""
    with db.get_session() as session:
        session.merge(db.Setting(key=agentws.TRUST_PROXY_SETTING_KEY, value="1" if value else "0"))
        session.commit()


def test_ready_ignores_x_forwarded_for_by_default(client):
    """最終審查 I2：`remote_ip` 會影響配種子（`peer.online_seeders` 的同 NAT
    分支），而 XFF 是 agent 自己就能塞的標頭 —— 預設一律不採信。"""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "nat-2")
    ctx, ws, ready = _handshake_ws(
        client, worker_id, sk, headers={"X-Forwarded-For": "203.0.113.7, 70.41.3.18"}
    )
    try:
        assert ready["remote_ip"] != "203.0.113.7"
        # TestClient 的 TCP 對端是 "testclient"。
        assert ready["remote_ip"] == "testclient"
    finally:
        ctx.__exit__(None, None, None)


def test_ready_prefers_first_hop_of_x_forwarded_for_when_trust_proxy_is_on(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "nat-2b")
    _set_trust_proxy(True)
    try:
        ctx, ws, ready = _handshake_ws(
            client, worker_id, sk, headers={"X-Forwarded-For": "203.0.113.7, 70.41.3.18"}
        )
        try:
            assert ready["remote_ip"] == "203.0.113.7"
        finally:
            ctx.__exit__(None, None, None)
    finally:
        _set_trust_proxy(False)


def test_hello_stores_peer_lan_url_peer_nat_and_remote_ip(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "nat-3")
    # XFF 只有在 `trust_proxy` 開著時才算數（最終審查 I2）。
    _set_trust_proxy(True)
    ctx, ws, _ = _handshake_ws(
        client, worker_id, sk, headers={"X-Forwarded-For": "203.0.113.7"}
    )
    try:
        ws.send_json(
            {
                "type": "hello",
                "protocol": 4,
                "peer_url": "http://203.0.113.7:8850",
                "peer_lan_url": "http://192.168.1.5:8850",
                "peer_nat": "natpmp",
            }
        )
        # hello 之後送一拍心跳，確保 hello 已被處理完（同步點）。
        ws.send_json({"type": "heartbeat", "state": "idle"})
        time.sleep(0.2)
    finally:
        ctx.__exit__(None, None, None)

    with db.get_session() as session:
        w = session.get(db.Worker, worker_id)
        assert w.peer_url == "http://203.0.113.7:8850"
        assert w.peer_lan_url == "http://192.168.1.5:8850"
        assert w.peer_nat == "natpmp"
        assert w.remote_ip == "203.0.113.7"
    _set_trust_proxy(False)


def test_hello_without_new_fields_defaults_to_lan(client):
    """舊 agent：不帶 peer_lan_url/peer_nat → lan_url=None、nat='lan'。"""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "nat-4")
    ctx, ws, _ = _handshake_ws(client, worker_id, sk)
    try:
        ws.send_json({"type": "hello", "protocol": 4, "peer_url": "http://192.168.1.9:8850"})
        ws.send_json({"type": "heartbeat", "state": "idle"})
        time.sleep(0.2)
    finally:
        ctx.__exit__(None, None, None)

    with db.get_session() as session:
        w = session.get(db.Worker, worker_id)
        assert w.peer_lan_url is None
        assert w.peer_nat == "lan"


def test_hello_rejects_malformed_peer_nat(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "nat-5")
    ctx, ws, _ = _handshake_ws(client, worker_id, sk)
    try:
        ws.send_json({"type": "hello", "protocol": 4, "peer_nat": "totally-made-up"})
        ws.send_json({"type": "heartbeat", "state": "idle"})
        time.sleep(0.2)
    finally:
        ctx.__exit__(None, None, None)

    with db.get_session() as session:
        assert session.get(db.Worker, worker_id).peer_nat == "lan"


def test_requeue_stale_clears_peer_reachable(client):
    csrf = _login(client)
    worker_id, _ = _register_worker(client, csrf, "nat-6")
    with db.get_session() as session:
        w = session.get(db.Worker, worker_id)
        w.status = "online"
        w.peer_url = "http://203.0.113.7:8850"
        w.peer_reachable = 1
        # dispatch.requeue_stale 比較的是 naive UTC（見 tests/server/
        # test_dispatch.py 的 _utcnow），跟 SQLite 存回來的值一致。
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        w.peer_checked_at = now
        w.last_seen = now - timedelta(seconds=600)
        session.commit()

    dispatch.requeue_stale(datetime.now(timezone.utc).replace(tzinfo=None))

    with db.get_session() as session:
        w = session.get(db.Worker, worker_id)
        assert w.status == "offline"
        assert w.peer_url is None
        assert w.peer_reachable is None


# --- Phase 3.4 Task 4: hello／heartbeat 觸發的可連性檢查與 peer_status ------


def _wait_until(predicate, timeout=5.0):
    """輪詢到 `predicate()` 回真為止（背景檢查任務是非同步的，沒有可等的
    handle），逾時就 assert 失敗。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    raise AssertionError("condition never became true")


def _backdate_peer_check(worker_id, minutes):
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.peer_checked_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(
            minutes=minutes
        )
        session.commit()


def test_hello_probes_the_peer_url_and_pushes_peer_status(client, monkeypatch):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "ph-ws-1")
    probed = []
    monkeypatch.setattr(peerhealth, "_probe", lambda url: probed.append(url) or True)

    ctx, ws, _ = _handshake_ws(client, worker_id, sk)
    try:
        ws.send_json(
            {"type": "hello", "protocol": 4, "peer_url": "http://203.0.113.7:8850"}
        )
        status = ws.receive_json()
    finally:
        ctx.__exit__(None, None, None)

    assert status == {
        "type": "peer_status",
        "reachable": True,
        "checked_url": "http://203.0.113.7:8850/peer/health",
    }
    assert probed == ["http://203.0.113.7:8850/peer/health"]
    with db.get_session() as session:
        assert session.get(db.Worker, worker_id).peer_reachable == 1


def test_hello_with_a_private_peer_url_is_unreachable_without_probing(client, monkeypatch):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "ph-ws-2")
    probed = []
    monkeypatch.setattr(peerhealth, "_probe", lambda url: probed.append(url) or True)

    ctx, ws, _ = _handshake_ws(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "protocol": 4,
                "peer_url": "http://192.168.1.5:8850",
                "peer_lan_url": "http://192.168.1.5:8850",
            }
        )
        status = ws.receive_json()
    finally:
        ctx.__exit__(None, None, None)

    assert status["type"] == "peer_status"
    assert status["reachable"] is False
    assert probed == []
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        assert worker.peer_reachable == 0
        # 靜態拒絕只否定對外位址，區網位址照樣留著（spec §4.2）。
        assert worker.peer_lan_url == "http://192.168.1.5:8850"


def test_hello_without_a_peer_url_pushes_nothing(client, monkeypatch):
    """沒通告 peer_url 就沒什麼好檢查的 —— 不發探針，也不推 peer_status。
    （用 deprecation frame 當「下一則訊息」的探測點。）"""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "ph-ws-3")
    monkeypatch.setattr(peerhealth, "_probe", lambda url: True)

    ctx, ws, _ = _handshake_ws(client, worker_id, sk)
    try:
        ws.send_json({"type": "hello", "protocol": 4})
        # 舊協定版本的 hello 會回 deprecation：若上一則 hello 錯誤地推了
        # peer_status，這裡收到的就會是它而不是 deprecation。
        ws.send_json({"type": "hello", "protocol": 1})
        assert ws.receive_json()["type"] == "deprecation"
    finally:
        ctx.__exit__(None, None, None)


def test_heartbeat_rechecks_after_ten_minutes_and_pushes_only_on_change(client, monkeypatch):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "ph-ws-4")
    verdict = {"value": True}
    monkeypatch.setattr(peerhealth, "_probe", lambda url: verdict["value"])

    ctx, ws, _ = _handshake_ws(client, worker_id, sk)
    try:
        ws.send_json({"type": "hello", "protocol": 4, "peer_url": "http://203.0.113.7:8850"})
        assert ws.receive_json()["reachable"] is True

        # 1) 還沒過 10 分鐘 ⇒ 心跳不重測（peer_checked_at 不動）。
        with db.get_session() as session:
            before = session.get(db.Worker, worker_id).peer_checked_at
        ws.send_json({"type": "heartbeat", "state": "idle"})
        time.sleep(0.3)
        with db.get_session() as session:
            assert session.get(db.Worker, worker_id).peer_checked_at == before

        # 2) 超過 10 分鐘但結論沒變 ⇒ 重測了（時間戳更新），但不推。
        _backdate_peer_check(worker_id, 11)
        ws.send_json({"type": "heartbeat", "state": "idle"})
        _wait_until(
            lambda: peerhealth.needs_recheck(
                _peer_checked_at(worker_id), datetime.now(timezone.utc)
            )
            is False
        )

        # 3) 結論翻成 False ⇒ 推一次。上一拍若錯誤地推了，這裡收到的會是
        #    reachable=True 的那則。
        verdict["value"] = False
        _backdate_peer_check(worker_id, 11)
        ws.send_json({"type": "heartbeat", "state": "idle"})
        status = ws.receive_json()
    finally:
        ctx.__exit__(None, None, None)

    assert status == {
        "type": "peer_status",
        "reachable": False,
        "checked_url": "http://203.0.113.7:8850/peer/health",
    }
    with db.get_session() as session:
        assert session.get(db.Worker, worker_id).peer_reachable == 0


def _peer_checked_at(worker_id):
    with db.get_session() as session:
        return session.get(db.Worker, worker_id).peer_checked_at


def test_a_failing_reachability_check_never_breaks_hello(client, monkeypatch):
    """探針爆炸（spec §8）：hello 照常完成、worker 照常上線。"""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "ph-ws-5")

    def _boom(url):
        raise RuntimeError("probe exploded")

    monkeypatch.setattr(peerhealth, "_probe", _boom)

    ctx, ws, _ = _handshake_ws(client, worker_id, sk)
    try:
        ws.send_json({"type": "hello", "protocol": 4, "peer_url": "http://203.0.113.7:8850"})
        ws.send_json({"type": "hello", "protocol": 1})
        assert ws.receive_json()["type"] == "deprecation"
    finally:
        ctx.__exit__(None, None, None)

    with db.get_session() as session:
        assert session.get(db.Worker, worker_id).status == "online"


def test_push_peer_status_to_a_disconnected_worker_is_a_no_op():
    """agent 不在線只是少一則通知，不能拋（`peerhealth.refresh` 的 notify
    是在背景任務裡叫的）。"""
    asyncio.run(agentws.push_peer_status("nobody-here", True, "http://x/peer/health"))


# --- Phase 3.4 Task 4 fix round 1 ------------------------------------------


def test_hello_stores_the_normalized_advert_urls(client):
    """fix round 1：通告位址存成 `scheme://host[:port]` —— 路徑／query／
    userinfo 都丟掉，`peerhealth.health_url` 才會組出正確的探針位址。"""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "nrm-1")
    ctx, ws, _ = _handshake_ws(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "protocol": 4,
                "peer_url": "http://admin:secret@203.0.113.7:8850/some/path?q=1#frag",
                "peer_lan_url": "http://192.168.1.5:8850/",
            }
        )
        ws.send_json({"type": "heartbeat", "state": "idle"})
        time.sleep(0.2)
    finally:
        ctx.__exit__(None, None, None)

    with db.get_session() as session:
        w = session.get(db.Worker, worker_id)
        assert w.peer_url == "http://203.0.113.7:8850"
        assert w.peer_lan_url == "http://192.168.1.5:8850"


def test_hello_drops_the_scheme_default_port_from_the_advert_urls(client):
    """最終審查：`http://h:80` 與 `http://h` 是同一個位址。不把預設埠丟掉的
    話，兩棧的正規形會不一樣（cloud 用 `URL.host`，本來就不帶預設埠），而且
    「`peer_url` 有沒有變」的比對與 `seeder_urls` 的去重都會被騙。"""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "nrm-2")
    ctx, ws, _ = _handshake_ws(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "protocol": 4,
                "peer_url": "https://203.0.113.7:443/",
                "peer_lan_url": "http://192.168.1.5:80/",
            }
        )
        ws.send_json({"type": "heartbeat", "state": "idle"})
        time.sleep(0.2)
    finally:
        ctx.__exit__(None, None, None)

    with db.get_session() as session:
        w = session.get(db.Worker, worker_id)
        assert w.peer_url == "https://203.0.113.7"
        assert w.peer_lan_url == "http://192.168.1.5"


def test_hello_probes_once_for_repeated_identical_advertisements(client, monkeypatch):
    """fix round 1：同一個 `peer_url` 重連幾次都只驗一次 —— 位址沒換，上次
    的結論還算數（重測交給心跳的 10 分鐘節奏）。

    fix round 2：雖然不重驗，但**既有結論會被回放**一則 `peer_status`，重啟
    後的 agent 才不用在「未知」停留到下一次重測。"""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "rep-1")
    probed = []
    monkeypatch.setattr(peerhealth, "_probe", lambda url: probed.append(url) or True)

    hello = {"type": "hello", "protocol": 4, "peer_url": "http://203.0.113.7:8850"}
    ctx, ws, _ = _handshake_ws(client, worker_id, sk)
    try:
        ws.send_json(hello)
        assert ws.receive_json()["type"] == "peer_status"
    finally:
        ctx.__exit__(None, None, None)

    # 同樣的通告再來兩次：不重驗，但每次都回放存著的結論。
    for _ in range(2):
        ctx, ws, _ = _handshake_ws(client, worker_id, sk)
        try:
            ws.send_json(hello)
            replayed = ws.receive_json()
        finally:
            ctx.__exit__(None, None, None)
        assert replayed == {
            "type": "peer_status",
            "reachable": True,
            "checked_url": "http://203.0.113.7:8850/peer/health",
        }

    assert probed == ["http://203.0.113.7:8850/peer/health"]
    with db.get_session() as session:
        w = session.get(db.Worker, worker_id)
        assert w.peer_reachable == 1
        assert w.peer_checked_at is not None


def test_hello_replays_a_stored_unreachable_verdict_without_probing(client, monkeypatch):
    """fix round 2：回放的是庫裡真正存著的值，不是永遠 true；而且結論還沒
    有（NULL）的時候不回放（沒有東西可以說）。"""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "rep-3")
    probed = []
    monkeypatch.setattr(peerhealth, "_probe", lambda url: probed.append(url) or True)
    hello = {"type": "hello", "protocol": 4, "peer_url": "http://203.0.113.7:8850"}

    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.peer_url = "http://203.0.113.7:8850"
        worker.peer_reachable = 0
        worker.peer_checked_at = datetime.now(timezone.utc).replace(tzinfo=None)
        session.commit()

    ctx, ws, _ = _handshake_ws(client, worker_id, sk)
    try:
        ws.send_json(hello)
        replayed = ws.receive_json()
    finally:
        ctx.__exit__(None, None, None)

    assert replayed == {
        "type": "peer_status",
        "reachable": False,
        "checked_url": "http://203.0.113.7:8850/peer/health",
    }
    assert probed == []

    # 結論清成 NULL（例如剛被 requeue_stale 掃過）⇒ 沒有東西可回放，
    # 而且位址也沒變 ⇒ 什麼都不推（用 deprecation 當下一則訊息的探測點）。
    with db.get_session() as session:
        session.get(db.Worker, worker_id).peer_reachable = None
        session.commit()

    ctx, ws, _ = _handshake_ws(client, worker_id, sk)
    try:
        ws.send_json(hello)
        ws.send_json({**hello, "protocol": 1})
        assert ws.receive_json()["type"] == "deprecation"
    finally:
        ctx.__exit__(None, None, None)

    assert probed == []


def test_hello_with_a_changed_peer_url_resets_the_verdict_and_reprobes(client, monkeypatch):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "rep-2")
    probed = []
    monkeypatch.setattr(peerhealth, "_probe", lambda url: probed.append(url) or True)

    ctx, ws, _ = _handshake_ws(client, worker_id, sk)
    try:
        ws.send_json({"type": "hello", "protocol": 4, "peer_url": "http://203.0.113.7:8850"})
        assert ws.receive_json()["reachable"] is True
    finally:
        ctx.__exit__(None, None, None)

    ctx, ws, _ = _handshake_ws(client, worker_id, sk)
    try:
        ws.send_json({"type": "hello", "protocol": 4, "peer_url": "http://198.51.100.9:8850"})
        status = ws.receive_json()
    finally:
        ctx.__exit__(None, None, None)

    assert status["checked_url"] == "http://198.51.100.9:8850/peer/health"
    assert probed == [
        "http://203.0.113.7:8850/peer/health",
        "http://198.51.100.9:8850/peer/health",
    ]


# --- 2026-09-19 model_fetch: 面板下載鈕建的純下載單 ------------------------


def _make_model_fetch_job(name, *, directory="vae", size_bytes=335_000_000, unverified=True):
    """Create a queued `kind=model_fetch` job the way `model_fetch.
    create_fetch_job` does, and return `(job_id, fetch_entry)`.

    Signed with the platform key so the entry that comes back out of the
    push is byte-identical to the one stored -- the agent verifies it.
    """
    from comfyfed_server import model_fetch, security

    signing_key, _vk = security.load_platform_keys(agentws._data_dir)
    if unverified:
        entry = model_fetch.sign_unverified_entry(
            signing_key,
            name=name,
            directory=directory,
            url=f"https://huggingface.co/x/resolve/main/{name}",
            size_bytes=size_bytes,
        )
    else:
        payload = f"{name}|{directory}|{'ab' * 32}|{size_bytes}"
        entry = {
            "name": name,
            "directory": directory,
            "url": f"https://huggingface.co/x/resolve/main/{name}",
            "backup_url": None,
            "sha256": "ab" * 32,
            "size_bytes": size_bytes,
            "sig": signing_key.sign(payload.encode()).signature.hex(),
        }

    with db.get_session() as session:
        job = db.Job(
            workflow_json="{}",
            kind="model_fetch",
            fetch_entry=json.dumps(entry),
            required_models=json.dumps([name]),
            required_nodes="[]",
            input_assets="[]",
            origin="panel",
        )
        session.add(job)
        session.commit()
        return job.id, entry


def _fetch_ready_worker(client, csrf, name, *, protocol):
    worker_id, sk = _register_worker(client, csrf, name)
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.status = "online"
        worker.protocol = protocol
        worker.auto_fetch = True
        worker.dynamic = json.dumps({"free_disk_gb": 100.0})
        worker.hardware = json.dumps({"max_fetch_gb": 100})
        session.commit()
    return worker_id, sk


def _hello_and_idle(ws, protocol):
    ws.send_json(
        {
            "type": "hello",
            "hardware": {"max_fetch_gb": 100},
            "backend": "cuda",
            "torch_version": "",
            "node_classes": [],
            "protocol": protocol,
            "auto_fetch": True,
        }
    )
    ws.send_json(
        {
            "type": "heartbeat",
            "state": "idle",
            "progress": 0.0,
            "job_id": None,
            "dynamic": {"free_disk_gb": 100.0},
        }
    )


def test_model_fetch_job_is_pushed_with_kind_and_unverified_entry(client):
    csrf = _login(client)
    worker_id, sk = _fetch_ready_worker(client, csrf, "w1", protocol=5)
    job_id, entry = _make_model_fetch_job("unknown_vae.safetensors")

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"
        _hello_and_idle(ws, 5)
        agentws.dispatch_once(worker_id)

        frame = ws.receive_json()
        assert frame["type"] == "job"
        assert frame["job_id"] == job_id
        assert frame["kind"] == "model_fetch"
        assert frame["workflow_json"] == "{}"
        assert frame["input_assets"] == []
        assert frame["fetch_models"] == [entry]


def test_prompt_job_push_still_carries_no_kind_key(client):
    """純加法：普通 prompt 單的推送形狀一個位元都不能變。"""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        frame = ws.receive_json()
        assert frame["job_id"] == job_id
        assert "kind" not in frame


def test_model_fetch_not_pushed_to_protocol_4(client):
    """未驗證來源項目要 protocol>=5；舊 agent 連被派工都不該發生，單子留在
    queued。"""
    csrf = _login(client)
    worker_id, sk = _fetch_ready_worker(client, csrf, "w4", protocol=4)
    job_id, _entry = _make_model_fetch_job("unknown_vae.safetensors")

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"
        _hello_and_idle(ws, 4)
        agentws.dispatch_once(worker_id)

    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "queued"


@pytest.mark.parametrize("protocol,pushed", [(3, False), (4, False), (5, True)])
def test_model_fetch_with_a_verified_entry_still_needs_protocol_5(client, protocol, pushed):
    """Final-review I1: a model_fetch job whose entry is VERIFIED leaves the
    dispatch tick's `unverified_models` empty, so the entry-keyed gate cannot
    fire and the floor would fall back to the protocol>=3 auto-fetch one. A
    protocol 3/4 agent does not know the `kind` field: it would set
    `started_at` (spec §8 says never) and run the `{}` placeholder workflow.
    The job kind is therefore its own gate."""
    csrf = _login(client)
    worker_id, sk = _fetch_ready_worker(client, csrf, f"w{protocol}", protocol=protocol)
    job_id, _entry = _make_model_fetch_job("unknown_vae.safetensors", unverified=False)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"
        _hello_and_idle(ws, protocol)
        agentws.dispatch_once(worker_id)
        if pushed:
            frame = ws.receive_json()
            assert frame["job_id"] == job_id and frame["kind"] == "model_fetch"

    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == ("assigned" if pushed else "queued")


@pytest.mark.parametrize("protocol,pushed", [(4, False), (5, True)])
def test_model_fetch_needs_protocol_5_even_with_nothing_to_fetch(client, protocol, pushed):
    """The hardest case for any model-name-keyed gate: the worker ALREADY
    holds the model (it learned it since the button was pressed), so there is
    no missing model for `unverified_models`/`peer_only_models` to be checked
    against and `verdict` returns a plain `eligible`. Only the kind gate can
    keep a protocol-4 agent away from the `{}` placeholder workflow."""
    csrf = _login(client)
    worker_id, sk = _fetch_ready_worker(client, csrf, f"w{protocol}", protocol=protocol)
    job_id, _entry = _make_model_fetch_job("unknown_vae.safetensors")
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.model_inventory = json.dumps(
            [{"name": "vae/unknown_vae.safetensors", "size_bytes": 335_000_000}]
        )
        session.commit()

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"
        _hello_and_idle(ws, protocol)
        agentws.dispatch_once(worker_id)
        if pushed:
            frame = ws.receive_json()
            assert frame["job_id"] == job_id and frame["kind"] == "model_fetch"

    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == ("assigned" if pushed else "queued")


def test_real_manifest_entry_wins_over_job_entry(client):
    """`ae.safetensors` 是 curated（有官方核可的 sha256），所以就算單子上存的
    是未驗證項目，派工時合併仍以真 manifest 為準。"""
    csrf = _login(client)
    worker_id, sk = _fetch_ready_worker(client, csrf, "w1", protocol=5)
    job_id, job_entry = _make_model_fetch_job("ae.safetensors")

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"
        _hello_and_idle(ws, 5)
        agentws.dispatch_once(worker_id)

        frame = ws.receive_json()
        assert frame["job_id"] == job_id
        entry = frame["fetch_models"][0]
        assert entry != job_entry
        assert entry.get("unverified") is not True
        assert len(entry["sha256"]) == 64


def test_job_done_learns_hash_and_mints_unbilled_receipt(client):
    csrf = _login(client)
    worker_id, sk = _fetch_ready_worker(client, csrf, "w1", protocol=5)
    job_id, entry = _make_model_fetch_job("unknown_vae.safetensors")

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"
        _hello_and_idle(ws, 5)
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["job_id"] == job_id

        ws.send_json(
            {
                "type": "job_done",
                "job_id": job_id,
                "result_files": [],
                "exec_seconds": 0,
                "fetched_models": [
                    {
                        "name": "unknown_vae.safetensors",
                        "directory": "vae",
                        "size_bytes": entry["size_bytes"],
                        "sha256": "ab" * 32,
                    },
                    # Not in this job's required_models -- a worker must not
                    # be able to teach the platform hashes for anything it
                    # likes just because it finished one fetch.
                    {"name": "not-in-job", "directory": "", "size_bytes": 1, "sha256": "cd" * 32},
                    {"name": "unknown_vae.safetensors", "size_bytes": -1, "sha256": "zz" * 32},
                    # Untrusted shapes that must be dropped, not crash the
                    # handler (an unhashable name, a bool size, a bad hex).
                    {"name": ["unknown_vae.safetensors"], "size_bytes": 1, "sha256": "ab" * 32},
                    {"name": "unknown_vae.safetensors", "size_bytes": True, "sha256": "ab" * 32},
                    {"name": "unknown_vae.safetensors", "size_bytes": 5, "sha256": "AB" * 32},
                    "not-even-a-dict",
                ],
            }
        )
        agentws.dispatch_once(worker_id)

    with db.get_session() as s:
        rows = s.query(db.ModelHash).all()
        assert len(rows) == 1
        assert rows[0].name == "unknown_vae.safetensors"
        assert rows[0].sha256 == "ab" * 32
        assert rows[0].size_bytes == entry["size_bytes"]

        rec = s.query(db.Receipt).filter_by(job_id=job_id).one()
        assert rec.kind == "model_fetch"
        assert rec.billable is False
        assert rec.basis == "model_fetch"
        assert rec.gpu_seconds == 0

        assert s.get(db.Job, job_id).status == "done"
        # signature 為 NULL 的單不進執行時間統計。
        assert s.query(db.WorkerJobStats).count() == 0


def test_job_done_fetched_models_ignored_for_a_prompt_job(client):
    """普通 prompt 單就算回報 fetched_models 也不學 -- 只有 model_fetch 單
    的回報算數（spec §9）。"""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["job_id"] == job_id

        ws.send_json(
            {
                "type": "job_done",
                "job_id": job_id,
                "result_files": [],
                "exec_seconds": 1.0,
                "fetched_models": [
                    {"name": "whatever.safetensors", "size_bytes": 1, "sha256": "ab" * 32}
                ],
            }
        )
        agentws.dispatch_once(worker_id)

    with db.get_session() as s:
        assert s.query(db.ModelHash).count() == 0
        rec = s.query(db.Receipt).filter_by(job_id=job_id).one()
        assert rec.kind == "completed" and rec.billable is True


# --- 2026-09-19 job-retry：失敗改派＋不適任紀錄 -----------------------------


def _exhaust_attempts(job_id, spent=None, spender="ghost-worker"):
    """把 `jobs.attempts` 先撐到「再失敗一次就達 `MAX_JOB_ATTEMPTS`」。

    釘「終局」行為的測試用它跳過前面幾輪 requeue -- 那幾輪由本節自己的
    requeue 測試覆蓋，重跑一遍只是讓別的測試又長又脆。
    """
    from comfyfed_server import retry

    spent = retry.MAX_JOB_ATTEMPTS - 1 if spent is None else spent
    with db.get_session() as session:
        session.get(db.Job, job_id).attempts = json.dumps({spender: spent})
        session.commit()


def _job_row(job_id):
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        session.expunge(job)
        return job


def _seed_unsuitable(worker_id, key, failures, error="earlier boom", job_id="j-old"):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    with db.get_session() as session:
        session.add(
            db.WorkerTaskFailure(
                worker_id=worker_id, task_key=key, failures=failures,
                last_error=error, last_job_id=job_id, updated_at=now,
            )
        )
        session.commit()


def _failure_rows():
    with db.get_session() as session:
        return {
            (r.worker_id, r.task_key): r.failures
            for r in session.query(db.WorkerTaskFailure).all()
        }


def test_job_failed_requeues_instead_of_failing(client, monkeypatch):
    """§5：一次失敗不再是終局。job 回 `queued`、放開 worker、記 attempts 與
    `retry_count`，錯誤留在 `error` 當「最後錯誤」，失敗收據照發，面板收到
    `job_requeued`。"""
    requeued: list = []

    async def _spy(job_id):
        requeued.append(job_id)

    monkeypatch.setattr(agentws.panelws, "job_requeued", _spy)

    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "wa")
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "job_failed", "job_id": job_id, "error": "boom"})
        agentws.dispatch_once(worker_id)
    finally:
        ws.close()

    job = _job_row(job_id)
    assert job.status == "queued"
    assert job.worker_id is None
    assert job.last_worker_id == worker_id
    assert job.error == "boom"
    assert job.retry_count == 1
    assert json.loads(job.attempts) == {worker_id: 1}

    with db.get_session() as session:
        receipts = session.query(db.Receipt).all()
    assert len(receipts) == 1
    assert (receipts[0].kind, receipts[0].billable) == ("failed", False)

    assert requeued == [job_id]


def test_two_failures_on_one_worker_send_the_job_to_another(client):
    """頭條情境：唯一在線的那台一直失敗，另一台（註冊了但從來沒連過線、
    在平台眼中是 offline）其實才跑得動。A 失敗兩次後這張 job 只能給 B。"""
    csrf = _login(client)
    worker_a, sk_a = _register_worker(client, csrf, "wa")
    worker_b, sk_b = _register_worker(client, csrf, "wb")
    job_id = _submit(client, csrf)

    ws_a = _connect(client, worker_a, sk_a)
    try:
        for expected in (1, 2):
            ws_a.send_json(
                {"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}}
            )
            agentws.dispatch_once(worker_a)
            assert ws_a.receive_json()["type"] == "job"
            ws_a.send_json({"type": "job_failed", "job_id": job_id, "error": "boom %d" % expected})
            agentws.dispatch_once(worker_a)
            ws_a.receive_json()  # failure receipt
            job = _job_row(job_id)
            assert job.status == "queued", "attempt %d must not be terminal" % expected
            assert json.loads(job.attempts) == {worker_a: expected}
            assert job.retry_count == expected

        # A 現在對這張 job 出局。A 仍然 idle 且連著線，但下一輪只能給 B。
        ws_b = _connect(client, worker_b, sk_b)
        try:
            ws_a.send_json(
                {"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}}
            )
            ws_b.send_json(
                {"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}}
            )
            agentws.dispatch_once(worker_b)

            job_msg = ws_b.receive_json()
            assert job_msg["type"] == "job" and job_msg["job_id"] == job_id
            assert _job_row(job_id).worker_id == worker_b

            # B 跑完 -> B 自己的不適任紀錄清空，A 的那一列原封不動。
            ws_b.send_json({"type": "job_done", "job_id": job_id, "result_files": ["out.png"]})
            agentws.dispatch_once(worker_b)
        finally:
            ws_b.close()
    finally:
        ws_a.close()

    job = _job_row(job_id)
    assert job.status == "done"
    key = job.signature
    assert key
    assert _failure_rows() == {(worker_a, key): 2}


def test_job_done_clears_this_workers_unsuitable_row(client):
    """§7：成功跑完同類任務 -> 自動解除那一台對那一類的不適任紀錄。"""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "wa")
    job_id = _submit(client, csrf)
    key = _job_row(job_id).signature
    assert key
    _seed_unsuitable(worker_id, key, failures=1)
    _seed_unsuitable("someone-else", key, failures=2)

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"
        ws.send_json({"type": "job_done", "job_id": job_id, "result_files": ["out.png"]})
        agentws.dispatch_once(worker_id)
    finally:
        ws.close()

    assert _failure_rows() == {("someone-else", key): 2}


def test_reaching_the_attempt_cap_fails_the_job_with_a_summary(client):
    """§5：總失敗次數達 `MAX_JOB_ATTEMPTS` -> 終局，`error` 換成彙整訊息
    （zh-TW 先、en 後，每台 worker 的最後錯誤）。艦隊裡還有一台完全合格的
    wc，所以這裡走的一定是次數上限那條路，不是「沒人跑得動」。"""
    csrf = _login(client)
    worker_a, sk_a = _register_worker(client, csrf, "wa")
    worker_b, _sk_b = _register_worker(client, csrf, "wb")
    _register_worker(client, csrf, "wc")
    job_id = _submit(client, csrf)
    key = _job_row(job_id).signature
    _exhaust_attempts(job_id, spent=5, spender=worker_b)
    _seed_unsuitable(worker_b, key, failures=5, error="wb exploded")

    ws = _connect(client, worker_a, sk_a)
    try:
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_a)
        assert ws.receive_json()["type"] == "job"
        ws.send_json({"type": "job_failed", "job_id": job_id, "error": "wa exploded"})
        agentws.dispatch_once(worker_a)
    finally:
        ws.close()

    job = _job_row(job_id)
    assert job.status == "failed"
    assert "已在 2 台 worker 嘗試 6 次全部失敗" in job.error
    assert "failed on 2 workers after 6 attempts" in job.error
    assert "wb: wb exploded" in job.error
    assert "wa: wa exploded" in job.error


def test_the_only_worker_being_excluded_fails_the_job_immediately(client):
    """§5：沒有任何一台有可能跑它 -> 不等次數上限，立刻終局。"""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "wa")
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_id, sk)
    try:
        for index in (1, 2):
            ws.send_json(
                {"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}}
            )
            agentws.dispatch_once(worker_id)
            assert ws.receive_json()["type"] == "job"
            ws.send_json({"type": "job_failed", "job_id": job_id, "error": "boom %d" % index})
            agentws.dispatch_once(worker_id)
            ws.receive_json()  # failure receipt
    finally:
        ws.close()

    job = _job_row(job_id)
    assert job.status == "failed"
    assert "已在 1 台 worker 嘗試 2 次全部失敗" in job.error
    assert "wa: boom 2" in job.error
    # 每一次嘗試都有一張非計費失敗收據，包含被 requeue 的那一次。
    with db.get_session() as session:
        receipts = session.query(db.Receipt).all()
    assert len(receipts) == 2
    assert all((r.kind, r.billable) == ("failed", False) for r in receipts)


def test_a_disabled_worker_is_not_a_possible_worker(client):
    """§6：「有可能跑它」只算未刪除、未停用的 worker；admin 停用的那台不算，
    所以唯一另一台被停用時第二次失敗就終局。"""
    csrf = _login(client)
    worker_a, sk_a = _register_worker(client, csrf, "wa")
    worker_b, _sk_b = _register_worker(client, csrf, "wb")
    disabled = client.post("/api/workers/%s/disable" % worker_b, headers={"X-CSRF": csrf})
    assert disabled.status_code == 200
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_a, sk_a)
    try:
        for index in (1, 2):
            ws.send_json(
                {"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}}
            )
            agentws.dispatch_once(worker_a)
            assert ws.receive_json()["type"] == "job"
            ws.send_json({"type": "job_failed", "job_id": job_id, "error": "boom %d" % index})
            agentws.dispatch_once(worker_a)
            ws.receive_json()
    finally:
        ws.close()

    assert _job_row(job_id).status == "failed"


def test_a_failed_child_is_retried_before_cascading(client):
    """§5 最後一段：分批子 job 也先重試 -- 第一次失敗不得連坐取消兄弟，
    也不得把父 job 打成 failed。"""
    csrf = _login(client)
    worker_a, sk_a = _register_worker(client, csrf, "wa")
    worker_b, sk_b = _register_worker(client, csrf, "wb")
    child_ids = _make_split_family("p_retry", [worker_a, worker_b])

    ws_a = _connect(client, worker_a, sk_a)
    ws_b = _connect(client, worker_b, sk_b)
    try:
        _send_hello_v2(ws_a)
        _send_hello_v2(ws_b)
        ws_b.send_json(
            {"type": "heartbeat", "state": "busy", "progress": 0.1, "job_id": child_ids[1], "dynamic": {}}
        )
        ws_a.send_json({"type": "job_failed", "job_id": child_ids[0], "error": "CUDA OOM"})
        assert client.get("/api/jobs/p_retry", headers={"X-CSRF": csrf}).status_code == 200

        assert child_ids[1] not in agentws._connections[worker_b].cancelled_jobs_sent
    finally:
        ws_a.close()
        ws_b.close()

    child = _job_row(child_ids[0])
    sibling = _job_row(child_ids[1])
    parent = _job_row("p_retry")
    assert child.status == "queued"
    assert child.retry_count == 1
    assert sibling.status == "running"
    assert parent.status != "failed"


def test_jobs_api_exposes_attempts_and_retry_count(client):
    """§8：`/api/jobs` 與 `/api/jobs/{id}` 多帶 `attempts`（dict）與
    `retry_count`，JobDetail 才畫得出「嘗試紀錄」。"""
    csrf = _login(client)
    worker_id, _sk = _register_worker(client, csrf, "wa")
    job_id = _submit(client, csrf)
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        job.attempts = json.dumps({worker_id: 2})
        job.retry_count = 2
        session.commit()

    listed = client.get("/api/jobs", headers={"X-CSRF": csrf}).json()
    rows = listed["jobs"] if isinstance(listed, dict) else listed
    row = next(j for j in rows if j["id"] == job_id)
    assert row["attempts"] == {worker_id: 2}
    assert row["retry_count"] == 2

    detail = client.get("/api/jobs/%s" % job_id, headers={"X-CSRF": csrf}).json()
    assert detail["attempts"] == {worker_id: 2}
    assert detail["retry_count"] == 2
