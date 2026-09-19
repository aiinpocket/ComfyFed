import asyncio
import hashlib
import json
import logging
import os
import threading
import time

import httpx
import pytest
from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK
from websockets.frames import Close

from comfyfed_agent import comfy, control, detect, fetcher, hardware, whitelist
from comfyfed_agent.config import AgentConfig, PlatformEntry
from comfyfed_agent.runner import (
    AgentLoop,
    AllRegistrationsRejected,
    CleanupMode,
    PlatformConnection,
    _is_auth_rejected,
    _is_safe_relative_path,
    cleanup_job_files,
)
from comfyfed_agent import runner as runner_module

_real_whitelist_check = whitelist.check


def test_check_blocks_unknown_node():
    allowed = {"KSampler", "SaveImage"}
    workflow = {
        "1": {"class_type": "KSampler", "inputs": {}},
        "2": {"class_type": "TotallyCustomEvilNode", "inputs": {}},
    }

    with pytest.raises(whitelist.NodeNotAllowed) as exc_info:
        whitelist.check(workflow, allowed)

    assert exc_info.value.node_class == "TotallyCustomEvilNode"


def test_check_allows_workflow_using_only_allowed_nodes():
    allowed = {"KSampler", "SaveImage"}
    workflow = {
        "1": {"class_type": "KSampler", "inputs": {}},
        "2": {"class_type": "SaveImage", "inputs": {}},
    }

    whitelist.check(workflow, allowed)  # should not raise


class FakeConnection:
    """Stand-in for `PlatformConnection` recording every message it would send."""

    def __init__(self, entry: PlatformEntry, config: AgentConfig):
        self.entry = entry
        self.config = config
        self.state = "idle"
        self.heartbeats: list[dict] = []
        self.job_done = None
        self.job_done_fetched_models = None
        self.job_failed = None
        self.object_info_hash = ""
        self.object_info_uploads: list[tuple[bytes, str]] = []
        self.receipt_acks: list[tuple[str, str]] = []
        self.model_inventory_hash = ""
        self.chunks_sent: dict[str, str] = {}
        self.inventories: list[list[dict]] = []
        # Mirrors the real `PlatformConnection`: consecutive 4401s seen on
        # this entry, and whether the 4403 "disabled" notice was logged.
        self.auth_rejections = 0
        self.disabled_logged = False
        # A live socket, as far as the reporting retry is concerned; a test
        # simulates a blip by setting it to None (what `close()` does).
        self.ws = object()

    async def recv(self):
        await asyncio.sleep(3600)  # nothing ever arrives; the poll times out

    async def send_heartbeat(
        self,
        state,
        progress=0.0,
        job_id=None,
        dynamic=None,
        object_info_hash=None,
        stage=None,
        fetch_pct=None,
        fetch_model=None,
    ):
        self.state = state
        self.heartbeats.append(
            {
                "state": state,
                "progress": progress,
                "job_id": job_id,
                "object_info_hash": object_info_hash,
                "stage": stage,
                "fetch_pct": fetch_pct,
                "fetch_model": fetch_model,
            }
        )

    async def send_job_done(self, job_id, result_files, exec_seconds=None, fetched_models=None):
        self.job_done = (job_id, result_files, exec_seconds)
        # Kept off the `job_done` tuple on purpose: every pre-existing
        # assertion compares that 3-tuple, and an ordinary job never carries
        # this field at all (see PlatformConnection.send_job_done).
        self.job_done_fetched_models = fetched_models

    async def send_job_failed(self, job_id, error, exec_seconds=None):
        self.job_failed = (job_id, error, exec_seconds)

    async def send_object_info(self, gzip_payload, oi_hash):
        self.object_info_uploads.append((gzip_payload, oi_hash))

    async def send_inventory(self, models):
        self.inventories.append(models)

    async def send_receipt_ack(self, receipt_id, worker_sig):
        self.receipt_acks.append((receipt_id, worker_sig))

    def sign_receipt_payload(self, payload: str) -> str:
        return "sig:" + payload


def _entry(worker_id: str) -> PlatformEntry:
    return PlatformEntry(
        platform_url="http://platform.example",
        platform_pubkey="pp",
        worker_id=worker_id,
        certificate="cert",
        signing_key_hex="11" * 32,
    )


@pytest.fixture()
def two_platform_loop(monkeypatch, tmp_path):
    monkeypatch.setattr(whitelist, "allowed_classes", lambda *a, **k: {"KSampler"})
    monkeypatch.setattr(whitelist, "check", lambda *a, **k: None)
    monkeypatch.setattr(comfy, "run_workflow", lambda *a, **k: ([], None))
    monkeypatch.setattr(hardware, "collect_dynamic", lambda *a, **k: {})

    # These tests are about job handling, not availability: idle detection
    # off keeps every would-be-"idle" heartbeat reporting "idle" regardless
    # of whether a human happens to be touching the machine running the
    # suite (see `AgentLoop.broadcast_heartbeat`'s availability gate). The
    # config path is a tmp dir so the runner's control files (agent_state.json)
    # land there instead of the test process's CWD.
    config = AgentConfig(
        platforms=[_entry("worker-a"), _entry("worker-b")], pause_when_active=False
    )
    return AgentLoop(config, str(tmp_path / "agent.json"), connection_factory=FakeConnection)


async def test_job_on_one_platform_broadcasts_busy_to_all_platforms(two_platform_loop):
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]
    conn_b = loop.connections["worker-b"]

    job_msg = {
        "job_id": "job-1",
        "workflow_json": json.dumps({"1": {"class_type": "KSampler", "inputs": {}}}),
        "input_assets": [],
    }

    await loop.handle_job(conn_a, job_msg)

    assert conn_a.job_done == ("job-1", [], None)

    busy_on_b = [hb for hb in conn_b.heartbeats if hb["state"] == "busy"]
    assert busy_on_b, "platform B should see a busy heartbeat while platform A dispatched the job"
    assert busy_on_b[0]["job_id"] == "job-1"

    # Both platforms should end up idle again once the job completes.
    assert conn_a.heartbeats[-1]["state"] == "idle"
    assert conn_b.heartbeats[-1]["state"] == "idle"


async def test_job_done_carries_exec_seconds_from_run_workflow(two_platform_loop, monkeypatch):
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]

    monkeypatch.setattr(comfy, "run_workflow", lambda *a, **k: ([], 2.5))

    job_msg = {
        "job_id": "job-1b",
        "workflow_json": json.dumps({"1": {"class_type": "KSampler", "inputs": {}}}),
        "input_assets": [],
    }

    await loop.handle_job(conn_a, job_msg)

    assert conn_a.job_done == ("job-1b", [], 2.5)


async def test_job_failure_sends_job_failed_and_returns_to_idle(two_platform_loop, monkeypatch):
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]

    def boom(*args, **kwargs):
        raise comfy.ComfyError("kaboom")

    monkeypatch.setattr(comfy, "run_workflow", boom)

    job_msg = {
        "job_id": "job-2",
        "workflow_json": json.dumps({"1": {"class_type": "KSampler", "inputs": {}}}),
        "input_assets": [],
    }

    await loop.handle_job(conn_a, job_msg)

    assert conn_a.job_failed == ("job-2", "kaboom", None)
    assert conn_a.heartbeats[-1]["state"] == "idle"


async def test_job_failure_after_prompt_started_carries_exec_seconds(two_platform_loop, monkeypatch):
    """A ComfyUI-reported execution error (as opposed to a /prompt submission
    rejection) happens after the prompt actually started running, so
    `ComfyError.exec_seconds` carries the same measurement the success path
    would have -- the platform must not bill for it (kind=failed,
    billable=0), but it should still know work was actually done."""
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]

    def boom(*args, **kwargs):
        raise comfy.ComfyError("ComfyUI job execution failed", exec_seconds=3.25)

    monkeypatch.setattr(comfy, "run_workflow", boom)

    job_msg = {
        "job_id": "job-2b",
        "workflow_json": json.dumps({"1": {"class_type": "KSampler", "inputs": {}}}),
        "input_assets": [],
    }

    await loop.handle_job(conn_a, job_msg)

    assert conn_a.job_failed == ("job-2b", "ComfyUI job execution failed", 3.25)


async def test_job_with_disallowed_node_is_rejected_before_running(two_platform_loop, monkeypatch):
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]

    monkeypatch.setattr(whitelist, "check", _real_whitelist_check)  # restore real check
    ran = {"called": False}

    def spy_run_workflow(*args, **kwargs):
        ran["called"] = True
        return [], None

    monkeypatch.setattr(comfy, "run_workflow", spy_run_workflow)

    job_msg = {
        "job_id": "job-3",
        "workflow_json": json.dumps({"1": {"class_type": "NotAllowedNode", "inputs": {}}}),
        "input_assets": [],
    }

    await loop.handle_job(conn_a, job_msg)

    assert not ran["called"]
    assert conn_a.job_failed is not None
    assert conn_a.job_failed[0] == "job-3"


async def test_refresh_object_info_uploads_once_then_skips_when_unchanged(two_platform_loop, monkeypatch):
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]

    monkeypatch.setattr(comfy, "get_object_info", lambda *a, **k: {"KSampler": {"input": {}}})

    await loop.refresh_object_info(conn_a)
    assert len(conn_a.object_info_uploads) == 1
    first_hash = conn_a.object_info_hash
    assert first_hash

    # Same object_info reported again -> hash unchanged -> no re-upload.
    await loop.refresh_object_info(conn_a)
    assert len(conn_a.object_info_uploads) == 1
    assert conn_a.object_info_hash == first_hash


async def test_refresh_object_info_reuploads_when_object_info_changes(two_platform_loop, monkeypatch):
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]

    monkeypatch.setattr(comfy, "get_object_info", lambda *a, **k: {"KSampler": {"input": {}}})
    await loop.refresh_object_info(conn_a)
    first_hash = conn_a.object_info_hash

    monkeypatch.setattr(
        comfy, "get_object_info", lambda *a, **k: {"KSampler": {"input": {}}, "SaveImage": {"input": {}}}
    )
    await loop.refresh_object_info(conn_a)

    assert len(conn_a.object_info_uploads) == 2
    assert conn_a.object_info_hash != first_hash
    _payload, sent_hash = conn_a.object_info_uploads[-1]
    assert sent_hash == conn_a.object_info_hash


async def test_want_object_info_forces_a_resend_even_if_hash_is_unchanged(two_platform_loop, monkeypatch):
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]

    monkeypatch.setattr(comfy, "get_object_info", lambda *a, **k: {"KSampler": {"input": {}}})
    await loop.refresh_object_info(conn_a)
    assert len(conn_a.object_info_uploads) == 1

    await loop._handle_message(conn_a, {"type": "want_object_info"})
    assert len(conn_a.object_info_uploads) == 2


async def test_refresh_object_info_failure_is_swallowed_and_hash_stays_unset(two_platform_loop, monkeypatch):
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]

    def boom(*a, **k):
        raise ConnectionError("comfy unreachable")

    monkeypatch.setattr(comfy, "get_object_info", boom)

    await loop.refresh_object_info(conn_a)  # must not raise

    assert conn_a.object_info_uploads == []
    assert conn_a.object_info_hash == ""


# --- Fix round 1 M1: periodic model inventory rescan ------------------------


async def test_refresh_model_inventory_pushes_when_a_file_is_added(two_platform_loop, tmp_path):
    loop = two_platform_loop
    loop.config.models_dir = str(tmp_path)
    conn_a = loop.connections["worker-a"]

    (tmp_path / "a.safetensors").write_bytes(b"one")
    await loop.refresh_model_inventory(conn_a)
    assert len(conn_a.inventories) == 1
    first_hash = conn_a.model_inventory_hash
    assert first_hash

    (tmp_path / "b.safetensors").write_bytes(b"two")
    await loop.refresh_model_inventory(conn_a)

    assert len(conn_a.inventories) == 2
    assert conn_a.model_inventory_hash != first_hash
    names = {m["name"] for m in conn_a.inventories[-1]}
    assert names == {"a.safetensors", "b.safetensors"}


async def test_refresh_model_inventory_skips_send_when_unchanged(two_platform_loop, tmp_path):
    loop = two_platform_loop
    loop.config.models_dir = str(tmp_path)
    conn_a = loop.connections["worker-a"]

    (tmp_path / "a.safetensors").write_bytes(b"one")
    await loop.refresh_model_inventory(conn_a)
    assert len(conn_a.inventories) == 1
    first_hash = conn_a.model_inventory_hash

    # Nothing changed on disk -> rescanning must not push a no-op message.
    await loop.refresh_model_inventory(conn_a)
    assert len(conn_a.inventories) == 1
    assert conn_a.model_inventory_hash == first_hash


async def test_refresh_model_inventory_noop_without_models_dir(two_platform_loop):
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]
    assert loop.config.models_dir is None

    await loop.refresh_model_inventory(conn_a)
    assert conn_a.inventories == []


async def test_refresh_model_inventory_failure_is_swallowed_and_hash_stays_unset(
    two_platform_loop, tmp_path, monkeypatch
):
    loop = two_platform_loop
    loop.config.models_dir = str(tmp_path)
    conn_a = loop.connections["worker-a"]
    (tmp_path / "a.safetensors").write_bytes(b"one")

    async def boom(*a, **k):
        raise ConnectionError("socket down")

    monkeypatch.setattr(conn_a, "send_inventory", boom)

    await loop.refresh_model_inventory(conn_a)  # must not raise
    assert conn_a.model_inventory_hash == ""


# --- M7 final-review fix: chunk-table payload dedup --------------------------


def test_dedup_chunk_lists_keeps_chunks_for_a_never_sent_name():
    models = [{"name": "a.bin", "sha256": "s1", "chunk_sha256s": ["c0", "c1"]}]
    out, updates = runner_module._dedup_chunk_lists(models, {})
    assert out == models
    assert updates == {"a.bin": "s1"}


def test_dedup_chunk_lists_strips_chunks_for_an_already_sent_unchanged_name():
    models = [{"name": "a.bin", "sha256": "s1", "chunk_sha256s": ["c0", "c1"]}]
    out, updates = runner_module._dedup_chunk_lists(models, {"a.bin": "s1"})
    assert out == [{"name": "a.bin", "sha256": "s1"}]
    assert updates == {}


def test_dedup_chunk_lists_keeps_chunks_when_the_hash_changed():
    """A file rehashed since the last report (different sha256) must carry
    its chunk list again even though its name was already sent before."""
    models = [{"name": "a.bin", "sha256": "s2", "chunk_sha256s": ["c2", "c3"]}]
    out, updates = runner_module._dedup_chunk_lists(models, {"a.bin": "s1"})
    assert out == models
    assert updates == {"a.bin": "s2"}


def test_dedup_chunk_lists_passes_through_entries_without_chunks():
    models = [{"name": "a.bin", "sha256": "s1"}]
    out, updates = runner_module._dedup_chunk_lists(models, {})
    assert out == models
    assert updates == {}


async def test_refresh_model_inventory_omits_chunks_on_second_report_keeps_new_ones(
    two_platform_loop, tmp_path, monkeypatch
):
    """Integration-level pin for M7: the first inventory report after
    connect carries chunk_sha256s; an unchanged second periodic report omits
    them; a file (re)hashed since the last report still carries its (new)
    chunk list."""
    loop = two_platform_loop
    loop.config.models_dir = str(tmp_path)
    conn_a = loop.connections["worker-a"]

    scans = [
        [
            {"name": "a.bin", "size": 0.0, "size_bytes": 3, "sha256": "sha-a-1", "chunk_sha256s": ["ca0"]},
            {"name": "b.bin", "size": 0.0, "size_bytes": 3, "sha256": "sha-b-1", "chunk_sha256s": ["cb0"]},
        ],
        [
            {"name": "a.bin", "size": 0.0, "size_bytes": 3, "sha256": "sha-a-1", "chunk_sha256s": ["ca0"]},
            # b.bin rehashed -- different sha256/chunk list.
            {"name": "b.bin", "size": 0.0, "size_bytes": 3, "sha256": "sha-b-2", "chunk_sha256s": ["cb1"]},
        ],
    ]
    calls = iter(scans)
    monkeypatch.setattr(hardware, "scan_models", lambda *a, **k: next(calls))

    await loop.refresh_model_inventory(conn_a)
    assert len(conn_a.inventories) == 1
    first = {m["name"]: m for m in conn_a.inventories[0]}
    assert first["a.bin"]["chunk_sha256s"] == ["ca0"]
    assert first["b.bin"]["chunk_sha256s"] == ["cb0"]

    await loop.refresh_model_inventory(conn_a)
    assert len(conn_a.inventories) == 2
    second = {m["name"]: m for m in conn_a.inventories[1]}
    assert "chunk_sha256s" not in second["a.bin"]  # unchanged -- omitted
    assert second["b.bin"]["chunk_sha256s"] == ["cb1"]  # rehashed -- still sent


async def test_connection_loop_rescans_models_on_the_object_info_timer(
    two_platform_loop, tmp_path, monkeypatch
):
    """The brief's shipped missing-model guidance promises a worker rescans
    and reports within 10 minutes with no restart -- so the periodic
    object_info timer must also drive a model rescan+push, piggybacking the
    same interval rather than a separate one."""
    loop = two_platform_loop
    loop.config.models_dir = str(tmp_path)
    conn_a = loop.connections["worker-a"]

    monkeypatch.setattr(comfy, "get_object_info", lambda *a, **k: {"KSampler": {"input": {}}})
    monkeypatch.setattr(runner_module, "_OBJECT_INFO_INTERVAL_SECONDS", 0)
    monkeypatch.setattr(runner_module, "_HEARTBEAT_INTERVAL_SECONDS", 9999)
    monkeypatch.setattr(runner_module, "_RECV_POLL_TIMEOUT_SECONDS", 0.01)

    (tmp_path / "a.safetensors").write_bytes(b"one")

    await _run_connection_loop_briefly(loop, conn_a, seconds=0.1)

    assert conn_a.inventories, "expected the periodic timer to push a model inventory update"
    assert {m["name"] for m in conn_a.inventories[-1]} == {"a.safetensors"}


async def test_broadcast_heartbeat_carries_each_connections_object_info_hash(two_platform_loop):
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]
    conn_a.object_info_hash = "deadbeef"

    await loop.broadcast_heartbeat("idle")

    assert conn_a.heartbeats[-1]["object_info_hash"] == "deadbeef"


async def test_broadcast_heartbeat_skips_a_not_connected_platform(two_platform_loop):
    """Live incident: a dead 4401 entry's connection has `ws is None`, and a
    job-lifecycle beat used to crash on it with `AttributeError: 'NoneType'
    object has no attribute 'send'`, once per beat per dead entry. The beat
    must reach the live connection only, raise nothing, and record nothing on
    the down one."""
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]
    conn_b = loop.connections["worker-b"]
    conn_a.ws = None  # down: no handshake, nothing to send on

    await loop.broadcast_heartbeat("idle")  # must not raise

    assert conn_a.heartbeats == [], "a down connection must receive no beat"
    assert conn_b.heartbeats, "the live connection must still receive the beat"
    assert conn_b.heartbeats[-1]["state"] == "idle"


# --- Artifact hash verification -------------------------------------------


class _FakeArtifactResponse:
    def __init__(self, status_code, sha256=None):
        self.status_code = status_code
        self._sha256 = sha256

    def json(self):
        return {"sha256": self._sha256}


def _fake_async_client_factory(responses):
    """A `httpx.AsyncClient` stand-in that pops one canned response per `send`."""

    class _FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        def build_request(self, method, path, files=None):
            return httpx.Request(method, "http://testserver" + path, files=files)

        async def send(self, request):
            return responses.pop(0)

    return _FakeAsyncClient


async def test_upload_artifact_succeeds_when_response_hash_matches(two_platform_loop, monkeypatch):
    loop = two_platform_loop
    entry = loop.connections["worker-a"].entry
    content = b"pixel-bytes"
    correct_hash = hashlib.sha256(content).hexdigest()

    monkeypatch.setattr(
        runner_module.httpx, "AsyncClient", _fake_async_client_factory([_FakeArtifactResponse(200, correct_hash)])
    )

    await loop._upload_artifact(entry, "job-x", "out.png", content)  # must not raise


async def test_upload_artifact_retries_once_then_succeeds(two_platform_loop, monkeypatch):
    loop = two_platform_loop
    entry = loop.connections["worker-a"].entry
    content = b"pixel-bytes"
    correct_hash = hashlib.sha256(content).hexdigest()

    # First attempt: platform rejects with a hash mismatch (400, no sha256).
    # Second attempt: succeeds with the matching hash.
    monkeypatch.setattr(
        runner_module.httpx,
        "AsyncClient",
        _fake_async_client_factory([_FakeArtifactResponse(400, None), _FakeArtifactResponse(200, correct_hash)]),
    )

    await loop._upload_artifact(entry, "job-x", "out.png", content)  # must not raise


async def test_upload_artifact_raises_after_two_failed_attempts(two_platform_loop, monkeypatch):
    loop = two_platform_loop
    entry = loop.connections["worker-a"].entry
    content = b"pixel-bytes"

    monkeypatch.setattr(
        runner_module.httpx,
        "AsyncClient",
        _fake_async_client_factory([_FakeArtifactResponse(400, None), _FakeArtifactResponse(400, None)]),
    )

    with pytest.raises(RuntimeError, match="artifact upload failed"):
        await loop._upload_artifact(entry, "job-x", "out.png", content)


# --- Presign upload protocol (Task 8) --------------------------------------


class _FakeJsonResponse:
    def __init__(self, status_code, json_body=None):
        self.status_code = status_code
        self._json_body = json_body if json_body is not None else {}

    def json(self):
        return self._json_body


def _fake_presign_client_factory(responses_by_method):
    """A richer `httpx.AsyncClient` stand-in supporting `post`/`put`, each
    popping its next canned response off `responses_by_method[method]` --
    needed once `_upload_artifact` can take the presign branch, which calls
    `client.post` (presign, confirm) and `client.put` (the raw/S3 PUT)
    instead of only the legacy path's `build_request`/`send`.
    """

    class _FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, path, content=None, headers=None, json=None):
            return responses_by_method["post"].pop(0)

        async def put(self, url, content=None):
            return responses_by_method["put"].pop(0)

    return _FakeAsyncClient


async def test_upload_artifact_falls_back_to_legacy_when_presign_404s(two_platform_loop, monkeypatch):
    """A platform that doesn't know the presign route (older ComfyFed)
    answers 404, and the upload must silently fall back to the exact legacy
    multipart flow -- verified by reusing the plain `_fake_async_client_factory`
    for the second (legacy) call. Two separate client classes stand in for
    the two calls `_upload_artifact` makes: the presign attempt and, once it
    returns None, the fallback -- verified by counting how many `AsyncClient`
    instantiations occur.
    """
    loop = two_platform_loop
    entry = loop.connections["worker-a"].entry
    content = b"pixel-bytes"
    correct_hash = hashlib.sha256(content).hexdigest()

    calls = {"post": [_FakeJsonResponse(404)]}
    presign_factory = _fake_presign_client_factory(calls)
    legacy_factory = _fake_async_client_factory([_FakeArtifactResponse(200, correct_hash)])

    factories = [presign_factory, legacy_factory]

    def next_client(*args, **kwargs):
        return factories.pop(0)(*args, **kwargs)

    monkeypatch.setattr(runner_module.httpx, "AsyncClient", next_client)

    await loop._upload_artifact(entry, "job-x", "out.png", content)  # must not raise


async def test_upload_artifact_presign_direct_mode_puts_raw_bytes(two_platform_loop, monkeypatch):
    loop = two_platform_loop
    entry = loop.connections["worker-a"].entry
    content = b"streamed-artifact-bytes"

    calls = {
        "post": [_FakeJsonResponse(200, {"mode": "direct", "url": "/api/agent/jobs/job-x/artifacts/raw/tok123"})],
        "put": [_FakeJsonResponse(200)],
    }
    monkeypatch.setattr(runner_module.httpx, "AsyncClient", _fake_presign_client_factory(calls))

    await loop._upload_artifact(entry, "job-x", "out.bin", content)  # must not raise
    assert calls["post"] == []
    assert calls["put"] == []


async def test_upload_artifact_presign_direct_mode_raises_on_rejection(two_platform_loop, monkeypatch):
    loop = two_platform_loop
    entry = loop.connections["worker-a"].entry
    content = b"streamed-artifact-bytes"

    calls = {
        "post": [_FakeJsonResponse(200, {"mode": "direct", "url": "/api/agent/jobs/job-x/artifacts/raw/tok123"})],
        "put": [_FakeJsonResponse(409)],
    }
    monkeypatch.setattr(runner_module.httpx, "AsyncClient", _fake_presign_client_factory(calls))

    with pytest.raises(RuntimeError, match="artifact upload failed"):
        await loop._upload_artifact(entry, "job-x", "out.bin", content)


async def test_upload_artifact_presign_s3_mode_puts_then_confirms(two_platform_loop, monkeypatch):
    loop = two_platform_loop
    entry = loop.connections["worker-a"].entry
    content = b"s3-mode-bytes"

    calls = {
        "post": [
            _FakeJsonResponse(200, {"mode": "s3", "url": "https://example.r2.cloudflarestorage.com/bucket/key?sig=x"}),
            _FakeJsonResponse(200, {"ok": True}),
        ],
        "put": [_FakeJsonResponse(200)],
    }
    monkeypatch.setattr(runner_module.httpx, "AsyncClient", _fake_presign_client_factory(calls))

    await loop._upload_artifact(entry, "job-x", "out.bin", content)  # must not raise
    assert calls["post"] == []
    assert calls["put"] == []


async def test_upload_artifact_presign_s3_mode_raises_when_storage_put_fails(two_platform_loop, monkeypatch):
    loop = two_platform_loop
    entry = loop.connections["worker-a"].entry
    content = b"s3-mode-bytes"

    calls = {
        "post": [_FakeJsonResponse(200, {"mode": "s3", "url": "https://example.r2.cloudflarestorage.com/bucket/key?sig=x"})],
        "put": [_FakeJsonResponse(403)],
    }
    monkeypatch.setattr(runner_module.httpx, "AsyncClient", _fake_presign_client_factory(calls))

    with pytest.raises(RuntimeError, match="storage PUT returned 403"):
        await loop._upload_artifact(entry, "job-x", "out.bin", content)


async def test_try_presign_returns_none_on_transport_error(two_platform_loop, monkeypatch):
    loop = two_platform_loop
    entry = loop.connections["worker-a"].entry

    class _RaisingClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, *a, **k):
            raise httpx.ConnectError("boom")

    monkeypatch.setattr(runner_module.httpx, "AsyncClient", _RaisingClient)

    result = await loop._try_presign(entry, "job-x", "out.png", "a" * 64, 3)
    assert result is None


async def test_handle_job_reports_job_failed_when_artifact_upload_never_verifies(two_platform_loop, monkeypatch):
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]

    monkeypatch.setattr(comfy, "run_workflow", lambda *a, **k: ([("out.png", b"bytes", "")], 1.0))
    monkeypatch.setattr(
        runner_module.httpx,
        "AsyncClient",
        _fake_async_client_factory([_FakeArtifactResponse(400, None), _FakeArtifactResponse(400, None)]),
    )

    job_msg = {
        "job_id": "job-hash-fail",
        "workflow_json": json.dumps({"1": {"class_type": "KSampler", "inputs": {}}}),
        "input_assets": [],
    }

    await loop.handle_job(conn_a, job_msg)

    assert conn_a.job_failed == ("job-hash-fail", "artifact upload failed", 1.0)


# --- Worker-side job file cleanup -------------------------------------------


def test_cleanup_job_files_removes_configured_output_and_input_files(tmp_path):
    output_dir = tmp_path / "output"
    input_dir = tmp_path / "input"
    (output_dir / "sub").mkdir(parents=True)
    input_dir.mkdir()
    out_file = output_dir / "sub" / "result.png"
    out_file.write_bytes(b"x")
    in_file = input_dir / "ref.png"
    in_file.write_bytes(b"y")

    cleanup_job_files(
        mode=CleanupMode.SUCCESS,
        comfy_output_dir=str(output_dir),
        comfy_input_dir=str(input_dir),
        output_files=[{"filename": "result.png", "subfolder": "sub"}],
        input_filenames=["ref.png"],
    )

    assert not out_file.exists()
    assert not in_file.exists()
    # The per-job subfolder is this job's litter too: gone once emptied.
    assert not (output_dir / "sub").exists()
    assert output_dir.exists()


def test_cleanup_job_files_removes_empty_namespace_chain_but_not_shared_dirs(tmp_path):
    """`namespace_outputs` nests outputs at e.g. `<job>/sub`; cleanup peels the
    emptied chain deepest-first and stops at a directory another job still
    uses."""
    output_dir = tmp_path / "output"
    (output_dir / "job-a" / "clips").mkdir(parents=True)
    (output_dir / "job-a" / "clips" / "v.mp4").write_bytes(b"x")
    # A sibling job's file keeps the shared parent alive.
    (output_dir / "job-b").mkdir()
    (output_dir / "job-b" / "other.png").write_bytes(b"y")

    cleanup_job_files(
        mode=CleanupMode.SUCCESS,
        comfy_output_dir=str(output_dir),
        comfy_input_dir=None,
        output_files=[{"filename": "v.mp4", "subfolder": "job-a/clips"}],
        input_filenames=[],
    )

    assert not (output_dir / "job-a").exists()
    assert (output_dir / "job-b" / "other.png").exists()
    assert output_dir.exists()


def test_cleanup_job_files_skips_everything_on_failure(tmp_path):
    output_dir = tmp_path / "output"
    input_dir = tmp_path / "input"
    output_dir.mkdir()
    input_dir.mkdir()
    out_file = output_dir / "result.png"
    out_file.write_bytes(b"x")
    in_file = input_dir / "ref.png"
    in_file.write_bytes(b"y")

    cleanup_job_files(
        mode=CleanupMode.FAILURE,
        comfy_output_dir=str(output_dir),
        comfy_input_dir=str(input_dir),
        output_files=[{"filename": "result.png", "subfolder": ""}],
        input_filenames=["ref.png"],
    )

    assert out_file.exists()
    assert in_file.exists()


def test_cleanup_job_files_no_op_when_dirs_not_configured(tmp_path):
    # Must not raise even though there is nowhere configured to clean up.
    cleanup_job_files(
        mode=CleanupMode.SUCCESS,
        comfy_output_dir=None,
        comfy_input_dir=None,
        output_files=[{"filename": "result.png", "subfolder": ""}],
        input_filenames=["ref.png"],
    )


def test_cleanup_job_files_refuses_path_traversal(tmp_path):
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    canary = tmp_path / "canary.txt"
    canary.write_bytes(b"do-not-delete")

    cleanup_job_files(
        mode=CleanupMode.SUCCESS,
        comfy_output_dir=str(output_dir),
        comfy_input_dir=None,
        output_files=[{"filename": "canary.txt", "subfolder": ".."}],
        input_filenames=[],
    )

    assert canary.exists()


@pytest.mark.parametrize(
    "unsafe",
    ["C:evil", "/etc/passwd", "..\\x", "sub/../..", "..", "C:\\evil", "\\evil"],
)
def test_is_safe_relative_path_rejects_windows_and_traversal_escapes(unsafe):
    assert _is_safe_relative_path(unsafe) is False


def test_is_safe_relative_path_accepts_normal_nested_relative_path():
    assert _is_safe_relative_path("subfolder/file.png") is True


@pytest.mark.parametrize(
    "unsafe_filename",
    ["C:evil", "/etc/passwd", "..\\x", "sub/../.."],
)
def test_cleanup_job_files_refuses_hardened_traversal_and_drive_escapes(tmp_path, unsafe_filename):
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    canary = tmp_path / "canary.txt"
    canary.write_bytes(b"do-not-delete")

    cleanup_job_files(
        mode=CleanupMode.SUCCESS,
        comfy_output_dir=str(output_dir),
        comfy_input_dir=None,
        output_files=[{"filename": unsafe_filename, "subfolder": ""}],
        input_filenames=[],
    )

    assert canary.exists()


def test_cleanup_job_files_still_deletes_normal_nested_output_path(tmp_path):
    output_dir = tmp_path / "output"
    (output_dir / "subfolder").mkdir(parents=True)
    out_file = output_dir / "subfolder" / "file.png"
    out_file.write_bytes(b"x")

    cleanup_job_files(
        mode=CleanupMode.SUCCESS,
        comfy_output_dir=str(output_dir),
        comfy_input_dir=None,
        output_files=[{"filename": "file.png", "subfolder": "subfolder"}],
        input_filenames=[],
    )

    assert not out_file.exists()


async def test_handle_job_cleans_up_comfy_output_dir_on_success(two_platform_loop, monkeypatch, tmp_path):
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    out_file = output_dir / "result.png"
    out_file.write_bytes(b"x")
    loop.config.comfy_output_dir = str(output_dir)

    monkeypatch.setattr(comfy, "run_workflow", lambda *a, **k: ([("result.png", b"bytes", "")], 1.0))
    monkeypatch.setattr(AgentLoop, "_upload_artifact", lambda self, *a, **k: _noop_coro())

    job_msg = {
        "job_id": "job-cleanup-out",
        "workflow_json": json.dumps({"1": {"class_type": "KSampler", "inputs": {}}}),
        "input_assets": [],
    }

    await loop.handle_job(conn_a, job_msg)

    assert conn_a.job_done == ("job-cleanup-out", ["result.png"], 1.0)
    assert not out_file.exists()


async def test_handle_job_leaves_comfy_output_dir_untouched_when_not_configured(
    two_platform_loop, monkeypatch, tmp_path
):
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    out_file = output_dir / "result.png"
    out_file.write_bytes(b"x")
    assert loop.config.comfy_output_dir is None

    monkeypatch.setattr(comfy, "run_workflow", lambda *a, **k: ([("result.png", b"bytes", "")], 1.0))
    monkeypatch.setattr(AgentLoop, "_upload_artifact", lambda self, *a, **k: _noop_coro())

    job_msg = {
        "job_id": "job-cleanup-noop",
        "workflow_json": json.dumps({"1": {"class_type": "KSampler", "inputs": {}}}),
        "input_assets": [],
    }

    await loop.handle_job(conn_a, job_msg)

    assert out_file.exists()  # untouched: comfy_output_dir was never configured


async def test_handle_job_cleans_up_comfy_input_dir_on_success(two_platform_loop, monkeypatch, tmp_path):
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]
    input_dir = tmp_path / "input"
    input_dir.mkdir()
    in_file = input_dir / "ref.png"
    in_file.write_bytes(b"y")
    loop.config.comfy_input_dir = str(input_dir)

    monkeypatch.setattr(AgentLoop, "_download_input", lambda self, *a, **k: _bytes_coro(b"ref-bytes"))
    monkeypatch.setattr(comfy, "upload_input", lambda *a, **k: None)
    monkeypatch.setattr(comfy, "run_workflow", lambda *a, **k: ([], 1.0))

    job_msg = {
        "job_id": "job-cleanup-in",
        "workflow_json": json.dumps({"1": {"class_type": "KSampler", "inputs": {}}}),
        "input_assets": ["ref.png"],
    }

    await loop.handle_job(conn_a, job_msg)

    assert conn_a.job_done == ("job-cleanup-in", [], 1.0)
    assert not in_file.exists()


async def _noop_coro():
    return None


async def _bytes_coro(value: bytes) -> bytes:
    return value


# --- Concurrent job task + server-driven cancellation -----------------------


def _slow_run_workflow(started: threading.Event, prompt_id: str = "p-slow"):
    """A `comfy.run_workflow` stand-in that blocks (in its worker thread) until
    the cancel event trips, exactly as the real polling loop would."""

    def _run(*args, cancel_event=None, on_prompt_id=None, **kwargs):
        if on_prompt_id is not None:
            on_prompt_id(prompt_id)
        started.set()
        deadline = time.monotonic() + 10.0
        while cancel_event is None or not cancel_event.is_set():
            if time.monotonic() > deadline:  # pragma: no cover - test safety net
                raise AssertionError("cancel event never tripped")
            time.sleep(0.01)
        raise comfy.JobCancelled()

    return _run


async def _await_flag(flag: threading.Event, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not flag.is_set():
        if time.monotonic() > deadline:  # pragma: no cover - test safety net
            raise AssertionError("timed out waiting for the job to start")
        await asyncio.sleep(0.01)


def _job_message(job_id: str, input_assets=None) -> dict:
    return {
        "type": "job",
        "job_id": job_id,
        "workflow_json": json.dumps({"1": {"class_type": "KSampler", "inputs": {}}}),
        "input_assets": list(input_assets or []),
    }


@pytest.fixture()
def cancellable_loop(two_platform_loop, monkeypatch):
    """`two_platform_loop` plus a slow fake ComfyUI and an interrupt spy."""
    started = threading.Event()
    interrupts: list[tuple[str, str]] = []

    monkeypatch.setattr(comfy, "run_workflow", _slow_run_workflow(started))

    def _spy_interrupt(comfy_url, prompt_id, **kwargs):
        interrupts.append((comfy_url, prompt_id))
        return "interrupted"

    monkeypatch.setattr(comfy, "interrupt_or_dequeue", _spy_interrupt)

    two_platform_loop.test_started = started
    two_platform_loop.test_interrupts = interrupts
    return two_platform_loop


async def test_job_cancelled_mid_run_interrupts_cleans_up_and_reports_nothing(
    cancellable_loop, monkeypatch, tmp_path
):
    loop = cancellable_loop
    conn_a = loop.connections["worker-a"]
    conn_b = loop.connections["worker-b"]

    input_dir = tmp_path / "input"
    input_dir.mkdir()
    in_file = input_dir / "ref.png"
    in_file.write_bytes(b"y")
    loop.config.comfy_input_dir = str(input_dir)

    monkeypatch.setattr(AgentLoop, "_download_input", lambda self, *a, **k: _bytes_coro(b"ref-bytes"))
    monkeypatch.setattr(comfy, "upload_input", lambda *a, **k: None)

    await loop._handle_message(conn_a, _job_message("job-cancel", ["ref.png"]))
    task = loop._current_job_task
    await _await_flag(loop.test_started)

    # The receive loop is still free to process this while the job runs.
    await loop._handle_message(conn_a, {"type": "job_cancelled", "job_id": "job-cancel"})
    await asyncio.wait_for(task, timeout=10)

    assert loop.test_interrupts == [(loop.config.comfy_url, "p-slow")]
    assert conn_a.job_done is None, "a cancelled job must not report job_done"
    assert conn_a.job_failed is None, "a cancelled job must not report job_failed"
    assert not in_file.exists(), "staged inputs must be cleaned up on cancel"
    assert conn_a.heartbeats[-1]["state"] == "idle"
    assert conn_b.heartbeats[-1]["state"] == "idle"


def test_cleanup_job_files_cancelled_mode_cleans_inputs_and_outputs(tmp_path):
    output_dir = tmp_path / "output"
    input_dir = tmp_path / "input"
    output_dir.mkdir()
    input_dir.mkdir()
    out_file = output_dir / "partial.png"
    out_file.write_bytes(b"x")
    in_file = input_dir / "ref.png"
    in_file.write_bytes(b"y")

    cleanup_job_files(
        mode=CleanupMode.CANCELLED,
        comfy_output_dir=str(output_dir),
        comfy_input_dir=str(input_dir),
        output_files=[{"filename": "partial.png", "subfolder": ""}],
        input_filenames=["ref.png"],
    )

    assert not out_file.exists()
    assert not in_file.exists()


async def test_job_cancelled_for_unknown_job_is_ignored_quietly(cancellable_loop):
    loop = cancellable_loop
    conn_a = loop.connections["worker-a"]

    await loop._handle_message(conn_a, _job_message("job-live"))
    task = loop._current_job_task
    await _await_flag(loop.test_started)

    await loop._handle_message(conn_a, {"type": "job_cancelled", "job_id": "some-other-job"})

    assert loop.test_interrupts == []
    assert not task.done(), "the running job must be untouched"

    # Unwind.
    await loop._handle_message(conn_a, {"type": "job_cancelled", "job_id": "job-live"})
    await asyncio.wait_for(task, timeout=10)


async def test_receipt_message_is_processed_while_a_job_is_running(cancellable_loop):
    loop = cancellable_loop
    conn_a = loop.connections["worker-a"]

    await loop._handle_message(conn_a, _job_message("job-concurrent"))
    task = loop._current_job_task
    await _await_flag(loop.test_started)

    await loop._handle_message(conn_a, {"type": "receipt", "receipt_id": "r-1", "payload": "p"})

    assert conn_a.receipt_acks == [("r-1", "sig:p")]

    await loop._handle_message(conn_a, {"type": "job_cancelled", "job_id": "job-concurrent"})
    await asyncio.wait_for(task, timeout=10)


async def test_normal_completion_through_the_spawned_task_is_unchanged(
    two_platform_loop, monkeypatch, tmp_path
):
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]

    output_dir = tmp_path / "output"
    output_dir.mkdir()
    out_file = output_dir / "result.png"
    out_file.write_bytes(b"x")
    loop.config.comfy_output_dir = str(output_dir)

    monkeypatch.setattr(comfy, "run_workflow", lambda *a, **k: ([("result.png", b"bytes", "")], 1.0))
    monkeypatch.setattr(AgentLoop, "_upload_artifact", lambda self, *a, **k: _noop_coro())

    await loop._handle_message(conn_a, _job_message("job-normal"))
    task = loop._current_job_task
    await asyncio.wait_for(task, timeout=10)

    assert conn_a.job_done == ("job-normal", ["result.png"], 1.0)
    assert not out_file.exists()
    assert conn_a.heartbeats[-1]["state"] == "idle"


async def test_shutdown_reaps_a_still_running_job_task(cancellable_loop):
    loop = cancellable_loop
    conn_a = loop.connections["worker-a"]

    await loop._handle_message(conn_a, _job_message("job-shutdown"))
    await _await_flag(loop.test_started)

    task = loop._current_job_task
    await asyncio.wait_for(loop.shutdown(), timeout=10)

    assert task.done()
    assert not loop._job_tasks


# --- Cancels that land in the narrow windows (review M1 / M2) ---------------


async def test_cancel_during_artifact_upload_winds_down_as_cancelled(
    two_platform_loop, monkeypatch, tmp_path
):
    """A cancel landing while artifacts upload must NOT become a job_failed.

    The server rejects the upload (the job is `cancelled`, the artifact gate
    wants assigned/running), `_upload_artifact` raises, and the naive path
    would report job_failed for a cancelled job AND pick CleanupMode.FAILURE,
    leaking exactly the files cancel cleanup exists to remove.
    """
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]

    output_dir = tmp_path / "output"
    input_dir = tmp_path / "input"
    output_dir.mkdir()
    input_dir.mkdir()
    out_file = output_dir / "result.png"
    out_file.write_bytes(b"x")
    in_file = input_dir / "ref.png"
    in_file.write_bytes(b"y")
    loop.config.comfy_output_dir = str(output_dir)
    loop.config.comfy_input_dir = str(input_dir)

    monkeypatch.setattr(AgentLoop, "_download_input", lambda self, *a, **k: _bytes_coro(b"ref-bytes"))
    monkeypatch.setattr(comfy, "upload_input", lambda *a, **k: None)
    monkeypatch.setattr(comfy, "interrupt_or_dequeue", lambda *a, **k: "absent")
    monkeypatch.setattr(
        comfy, "run_workflow", lambda *a, **k: ([("result.png", b"bytes", "")], 1.0)
    )

    upload_started = asyncio.Event()
    release = asyncio.Event()

    async def _blocking_upload(self, entry, job_id, filename, content):
        upload_started.set()
        await release.wait()
        raise RuntimeError("artifact upload failed")

    monkeypatch.setattr(AgentLoop, "_upload_artifact", _blocking_upload)

    await loop._handle_message(conn_a, _job_message("job-upload-cancel", ["ref.png"]))
    task = loop._current_job_task
    await asyncio.wait_for(upload_started.wait(), timeout=10)

    await loop._handle_message(conn_a, {"type": "job_cancelled", "job_id": "job-upload-cancel"})
    release.set()
    await asyncio.wait_for(task, timeout=10)

    assert conn_a.job_failed is None, "a cancelled job must not report job_failed"
    assert conn_a.job_done is None
    assert not out_file.exists(), "cancel cleanup must remove produced outputs"
    assert not in_file.exists(), "cancel cleanup must remove staged inputs"
    assert conn_a.heartbeats[-1]["state"] == "idle"


async def test_cancel_during_artifact_upload_stops_before_the_next_file(
    two_platform_loop, monkeypatch, tmp_path
):
    """Once cancelled, the upload loop must not keep pushing further files."""
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]

    monkeypatch.setattr(comfy, "interrupt_or_dequeue", lambda *a, **k: "absent")
    monkeypatch.setattr(
        comfy,
        "run_workflow",
        lambda *a, **k: ([("a.png", b"a", ""), ("b.png", b"b", "")], 1.0),
    )

    uploaded: list[str] = []
    first_upload = asyncio.Event()
    release = asyncio.Event()

    async def _record_upload(self, entry, job_id, filename, content):
        if not uploaded:
            uploaded.append(filename)
            first_upload.set()
            await release.wait()
            return
        uploaded.append(filename)

    monkeypatch.setattr(AgentLoop, "_upload_artifact", _record_upload)

    await loop._handle_message(conn_a, _job_message("job-upload-stop"))
    task = loop._current_job_task
    await asyncio.wait_for(first_upload.wait(), timeout=10)

    await loop._handle_message(conn_a, {"type": "job_cancelled", "job_id": "job-upload-stop"})
    release.set()
    await asyncio.wait_for(task, timeout=10)

    assert uploaded == ["a.png"], "the second artifact must not be uploaded after a cancel"
    assert conn_a.job_done is None
    assert conn_a.job_failed is None


async def test_cancel_racing_prompt_submission_still_interrupts_comfyui(
    two_platform_loop, monkeypatch
):
    """Cancel while `/prompt` is in flight: prompt_id appears only afterwards.

    Taking "nothing to interrupt" and never revisiting would leave ComfyUI
    rendering a ghost prompt while the agent advertises idle.
    """
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]

    interrupts: list[tuple[str, str]] = []
    monkeypatch.setattr(
        comfy,
        "interrupt_or_dequeue",
        lambda comfy_url, prompt_id, **k: (interrupts.append((comfy_url, prompt_id)), "interrupted")[1],
    )

    submitting = threading.Event()
    cancel_sent = threading.Event()

    def _run(*args, cancel_event=None, on_prompt_id=None, **kwargs):
        # The /prompt POST is on the wire: ComfyUI will accept it, but no
        # prompt_id has been reported back yet.
        submitting.set()
        if not cancel_sent.wait(10):  # pragma: no cover - test safety net
            raise AssertionError("cancel was never sent")
        on_prompt_id("p-late")
        while not cancel_event.is_set():
            time.sleep(0.01)
        raise comfy.JobCancelled()

    monkeypatch.setattr(comfy, "run_workflow", _run)

    await loop._handle_message(conn_a, _job_message("job-race"))
    task = loop._current_job_task
    await _await_flag(submitting)

    await loop._handle_message(conn_a, {"type": "job_cancelled", "job_id": "job-race"})
    cancel_sent.set()
    await asyncio.wait_for(task, timeout=10)

    assert interrupts == [(loop.config.comfy_url, "p-late")]
    assert conn_a.job_done is None
    assert conn_a.job_failed is None
    assert conn_a.heartbeats[-1]["state"] == "idle"


async def test_shutdown_interrupts_the_in_flight_comfyui_prompt(cancellable_loop):
    """Stopping the agent mid-run must not leave ComfyUI burning GPU."""
    loop = cancellable_loop
    conn_a = loop.connections["worker-a"]

    await loop._handle_message(conn_a, _job_message("job-shutdown-interrupt"))
    await _await_flag(loop.test_started)

    await asyncio.wait_for(loop.shutdown(), timeout=10)

    assert loop.test_interrupts == [(loop.config.comfy_url, "p-slow")]


async def test_cancel_interrupts_comfyui_exactly_once(cancellable_loop):
    """The wind-down re-check must not fire a second /interrupt for a prompt
    the receive loop already stopped -- on a shared worker that second call
    could land on somebody else's render."""
    loop = cancellable_loop
    conn_a = loop.connections["worker-a"]

    await loop._handle_message(conn_a, _job_message("job-once"))
    task = loop._current_job_task
    await _await_flag(loop.test_started)
    await loop._handle_message(conn_a, {"type": "job_cancelled", "job_id": "job-once"})
    await asyncio.wait_for(task, timeout=10)

    assert loop.test_interrupts == [(loop.config.comfy_url, "p-slow")]


async def test_current_job_pointers_are_cleared_when_the_job_ends(two_platform_loop, monkeypatch):
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]

    monkeypatch.setattr(comfy, "run_workflow", lambda *a, **k: ([], 1.0))

    await loop._handle_message(conn_a, _job_message("job-pointer"))
    task = loop._current_job_task
    await asyncio.wait_for(task, timeout=10)

    assert loop._current_job_id is None
    assert loop._current_job_task is None
    assert loop._jobs == {}


# --- Final review Major 2: completion must survive a connection blip -------


async def test_job_done_is_retried_until_the_connection_comes_back(
    two_platform_loop, monkeypatch, tmp_path
):
    """The run finishes DURING the outage -- the likeliest blip case, since
    the 90s requeue exists precisely for runs that outlive one. The
    completion must be held and re-sent on the new socket, never turned into
    a job_failed and never cleaned up as a FAILURE."""
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]

    output_dir = tmp_path / "output"
    output_dir.mkdir()
    out_file = output_dir / "result.png"
    out_file.write_bytes(b"x")
    loop.config.comfy_output_dir = str(output_dir)

    monkeypatch.setattr(runner_module, "_REPORT_RETRY_START_SECONDS", 0.01)
    monkeypatch.setattr(comfy, "run_workflow", lambda *a, **k: ([("result.png", b"bytes", "")], 1.0))
    monkeypatch.setattr(AgentLoop, "_upload_artifact", lambda self, *a, **k: _noop_coro())

    conn_a.ws = None  # the socket is down: PlatformConnection._send would raise
    attempts = {"n": 0}
    real_send_job_done = conn_a.send_job_done

    async def _send_job_done(job_id, result_files, exec_seconds=None, fetched_models=None):
        attempts["n"] += 1
        if conn_a.ws is None:
            raise AttributeError("'NoneType' object has no attribute 'send'")
        await real_send_job_done(job_id, result_files, exec_seconds, fetched_models)

    conn_a.send_job_done = _send_job_done

    await loop._handle_message(conn_a, _job_message("job-blip"))
    task = loop._current_job_task

    # Reconnect: `_run_platform` reuses the same connection object and
    # replaces `.ws` in place, which is the signal the retry waits on.
    await asyncio.sleep(0.05)
    assert not task.done(), "the completion must be held, not dropped"
    conn_a.ws = object()

    await asyncio.wait_for(task, timeout=10)

    assert attempts["n"] >= 2
    assert conn_a.job_done == ("job-blip", ["result.png"], 1.0)
    assert conn_a.job_failed is None, "a transport error is not a job failure"
    assert not out_file.exists(), "a reported completion still cleans up on success"


async def test_unreported_completion_at_shutdown_keeps_the_files(
    two_platform_loop, monkeypatch, tmp_path
):
    """Still unsent when the agent stops: leave everything on disk so a
    restart (or the server's requeue) can redo or re-adopt the work."""
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]

    output_dir = tmp_path / "output"
    output_dir.mkdir()
    out_file = output_dir / "result.png"
    out_file.write_bytes(b"x")
    loop.config.comfy_output_dir = str(output_dir)

    monkeypatch.setattr(runner_module, "_REPORT_RETRY_START_SECONDS", 0.01)
    monkeypatch.setattr(comfy, "run_workflow", lambda *a, **k: ([("result.png", b"bytes", "")], 1.0))
    monkeypatch.setattr(AgentLoop, "_upload_artifact", lambda self, *a, **k: _noop_coro())

    conn_a.ws = None
    reporting = asyncio.Event()

    async def _always_fails(job_id, result_files, exec_seconds=None, fetched_models=None):
        reporting.set()
        raise AttributeError("'NoneType' object has no attribute 'send'")

    conn_a.send_job_done = _always_fails

    await loop._handle_message(conn_a, _job_message("job-unreported"))
    await asyncio.wait_for(reporting.wait(), timeout=10)

    await asyncio.wait_for(loop.shutdown(timeout=0.2), timeout=10)

    assert conn_a.job_done is None
    assert conn_a.job_failed is None
    assert out_file.exists(), "an unreported completion must not be cleaned up"


async def test_a_genuine_upload_rejection_still_fails_the_job(two_platform_loop, monkeypatch):
    """The retry loop must not swallow real errors: a platform that answers
    and rejects is still a failed job."""
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]

    monkeypatch.setattr(comfy, "run_workflow", lambda *a, **k: ([("result.png", b"bytes", "")], 1.0))

    async def _rejected(self, entry, job_id, filename, content):
        raise RuntimeError("artifact upload failed")

    monkeypatch.setattr(AgentLoop, "_upload_artifact", _rejected)

    await loop._handle_message(conn_a, _job_message("job-rejected"))
    task = loop._current_job_task
    await asyncio.wait_for(task, timeout=10)

    assert conn_a.job_failed == ("job-rejected", "artifact upload failed", 1.0)


# --- Final review Major 3: the cancel handler must not block the loop ------


async def test_job_cancelled_does_not_block_the_receive_loop(cancellable_loop, monkeypatch):
    """A hung ComfyUI must not stall the socket: `interrupt_or_dequeue` runs
    as its own task, so `_handle_message` returns immediately."""
    loop = cancellable_loop
    conn_a = loop.connections["worker-a"]

    interrupt_running = threading.Event()
    release = threading.Event()

    def _hanging_interrupt(comfy_url, prompt_id, **kwargs):
        interrupt_running.set()
        release.wait(10)
        return "interrupted"

    monkeypatch.setattr(comfy, "interrupt_or_dequeue", _hanging_interrupt)

    await loop._handle_message(conn_a, _job_message("job-hang"))
    await _await_flag(loop.test_started)

    started = time.monotonic()
    await loop._handle_message(conn_a, {"type": "job_cancelled", "job_id": "job-hang"})
    elapsed = time.monotonic() - started

    assert elapsed < 1.0, "the receive loop waited for ComfyUI"
    await _await_flag(interrupt_running)
    release.set()
    await asyncio.wait_for(loop._current_job_task, timeout=10)


def test_interrupt_or_dequeue_uses_a_short_timeout():
    """Cancel-time HTTP gets its own short timeout -- the default 30s client
    would let a hung ComfyUI eat most of the server's 90s stale margin."""
    assert comfy._CANCEL_HTTP_TIMEOUT_SECONDS <= 10.0


# --- Final review Major 4: the periodic heartbeat carries the job id -------


async def test_periodic_heartbeat_carries_the_running_job_id(cancellable_loop, monkeypatch):
    """"A zombied worker learns within one heartbeat" is only true if the
    30s heartbeat actually names the job. The job task's own broadcasts only
    fire on ComfyUI progress events, which whole phases (model load, video
    encode, artifact upload) produce none of."""
    loop = cancellable_loop
    conn_a = loop.connections["worker-a"]

    monkeypatch.setattr(runner_module, "_HEARTBEAT_INTERVAL_SECONDS", 0)
    monkeypatch.setattr(runner_module, "_RECV_POLL_TIMEOUT_SECONDS", 0.01)

    await loop._handle_message(conn_a, _job_message("job-heartbeat"))
    task = loop._current_job_task
    await _await_flag(loop.test_started)

    conn_a.heartbeats.clear()
    loop_task = asyncio.create_task(loop._connection_loop(conn_a))
    await asyncio.sleep(0.1)
    loop_task.cancel()
    try:
        await loop_task
    except asyncio.CancelledError:
        pass

    assert conn_a.heartbeats, "the periodic heartbeat never fired"
    assert all(hb["job_id"] == "job-heartbeat" for hb in conn_a.heartbeats)

    await loop._handle_message(conn_a, {"type": "job_cancelled", "job_id": "job-heartbeat"})
    await asyncio.wait_for(task, timeout=10)


async def test_periodic_heartbeat_only_names_the_job_on_its_own_platform(
    cancellable_loop, monkeypatch
):
    """A job dispatched by platform A must never be named on platform B's
    heartbeat: B doesn't know the id, would treat it as not-owned, and would
    push a job_cancelled that kills a perfectly healthy run."""
    loop = cancellable_loop
    conn_a = loop.connections["worker-a"]
    conn_b = loop.connections["worker-b"]

    monkeypatch.setattr(runner_module, "_HEARTBEAT_INTERVAL_SECONDS", 0)
    monkeypatch.setattr(runner_module, "_RECV_POLL_TIMEOUT_SECONDS", 0.01)

    await loop._handle_message(conn_a, _job_message("job-scoped"))
    task = loop._current_job_task
    await _await_flag(loop.test_started)

    conn_b.heartbeats.clear()
    loop_task = asyncio.create_task(loop._connection_loop(conn_b))
    await asyncio.sleep(0.1)
    loop_task.cancel()
    try:
        await loop_task
    except asyncio.CancelledError:
        pass

    assert conn_b.heartbeats
    assert all(hb["job_id"] is None for hb in conn_b.heartbeats)

    await loop._handle_message(conn_a, {"type": "job_cancelled", "job_id": "job-scoped"})
    await asyncio.wait_for(task, timeout=10)


# --- Re-review round 2 ------------------------------------------------------


async def _run_connection_loop_briefly(loop, conn, seconds: float = 0.1) -> None:
    loop_task = asyncio.create_task(loop._connection_loop(conn))
    await asyncio.sleep(seconds)
    loop_task.cancel()
    try:
        await loop_task
    except asyncio.CancelledError:
        pass


async def test_heartbeat_keeps_naming_the_running_job_when_another_platform_dispatches(
    cancellable_loop, monkeypatch
):
    """A second platform's job queues behind the single-job lock. That must
    not stop platform A's heartbeat naming the job that is actually RUNNING
    -- otherwise "learns within one heartbeat" dies for the whole rest of
    job A's run, in exactly the multi-platform case federation exists for.

    The waiting platform's own heartbeat carries no job_id: its job has not
    started, and naming it would have the server mark it running and start
    its wall clock early.
    """
    loop = cancellable_loop
    conn_a = loop.connections["worker-a"]
    conn_b = loop.connections["worker-b"]

    monkeypatch.setattr(runner_module, "_HEARTBEAT_INTERVAL_SECONDS", 0)
    monkeypatch.setattr(runner_module, "_RECV_POLL_TIMEOUT_SECONDS", 0.01)

    await loop._handle_message(conn_a, _job_message("job-a"))
    task_a = loop._current_job_task
    await _await_flag(loop.test_started)

    # Platform B dispatches while A's job is mid-run: spawned, but parked on
    # the job lock until A finishes.
    await loop._handle_message(conn_b, _job_message("job-b"))
    task_b = loop._current_job_task
    await asyncio.sleep(0.05)
    assert not task_b.done()

    conn_a.heartbeats.clear()
    conn_b.heartbeats.clear()
    await _run_connection_loop_briefly(loop, conn_a)
    await _run_connection_loop_briefly(loop, conn_b)

    assert conn_a.heartbeats, "the periodic heartbeat never fired"
    assert all(hb["job_id"] == "job-a" for hb in conn_a.heartbeats)
    assert conn_b.heartbeats
    assert all(hb["job_id"] is None for hb in conn_b.heartbeats)

    # Unwind both.
    await loop._handle_message(conn_a, {"type": "job_cancelled", "job_id": "job-a"})
    await asyncio.wait_for(task_a, timeout=10)
    await loop._handle_message(conn_b, {"type": "job_cancelled", "job_id": "job-b"})
    await asyncio.wait_for(task_b, timeout=10)


async def test_held_completion_backs_off_when_the_socket_is_live_but_uploads_fail(
    two_platform_loop, monkeypatch
):
    """An artifact upload that cannot reach the platform over HTTP while the
    WebSocket is perfectly healthy must still be paced -- otherwise the
    documented 1s->30s backoff is skipped entirely and the agent hammers a
    failing endpoint as fast as it answers."""
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]

    monkeypatch.setattr(runner_module, "_REPORT_RETRY_START_SECONDS", 0.2)
    monkeypatch.setattr(comfy, "run_workflow", lambda *a, **k: ([("result.png", b"bytes", "")], 1.0))

    assert conn_a.ws is not None, "this test is about a LIVE socket"
    attempts: list[float] = []

    async def _unreachable_then_ok(self, entry, job_id, filename, content):
        attempts.append(time.monotonic())
        if len(attempts) < 3:
            raise runner_module.PlatformUnavailable("connection refused")

    monkeypatch.setattr(AgentLoop, "_upload_artifact", _unreachable_then_ok)

    await loop._handle_message(conn_a, _job_message("job-http-backoff"))
    task = loop._current_job_task
    await asyncio.wait_for(task, timeout=10)

    assert len(attempts) == 3
    gaps = [b - a for a, b in zip(attempts, attempts[1:])]
    assert gaps[0] >= 0.15, f"first retry was not paced: {gaps}"
    assert gaps[1] >= gaps[0], f"backoff did not grow: {gaps}"
    assert conn_a.job_done == ("job-http-backoff", ["result.png"], 1.0)
    assert conn_a.job_failed is None


# --- Task 6: agent protocol 2 ---------------------------------------------


def test_collect_hardware_reports_platform_system(monkeypatch):
    monkeypatch.setattr(hardware.platform, "system", lambda: "Linux")
    hw = hardware.collect_hardware("http://127.0.0.1:8188")
    assert hw["platform"] == "Linux"


class _RecordingWS:
    def __init__(self):
        self.sent: list[str] = []

    async def send(self, message: str) -> None:
        self.sent.append(message)


@pytest.mark.asyncio
async def test_send_hello_declares_protocol_5_and_auto_fetch_true_by_default():
    entry = PlatformEntry(
        platform_url="http://p",
        platform_pubkey="aa",
        worker_id="w1",
        certificate="cert",
        signing_key_hex="00" * 32,
    )
    conn = PlatformConnection(entry, AgentConfig())
    conn.ws = _RecordingWS()

    await conn.send_hello({"cpu": "x", "platform": "Windows"}, "cuda", "2.0", ["KSampler"])

    assert len(conn.ws.sent) == 1
    payload = json.loads(conn.ws.sent[0])
    assert payload["type"] == "hello"
    assert payload["protocol"] == 5
    assert payload["auto_fetch"] is True
    assert payload["max_fetch_gb"] == 20
    assert payload["hardware"]["platform"] == "Windows"
    assert "peer_url" not in payload


@pytest.mark.asyncio
async def test_send_hello_includes_peer_url_when_given():
    entry = PlatformEntry(
        platform_url="http://p",
        platform_pubkey="aa",
        worker_id="w1",
        certificate="cert",
        signing_key_hex="00" * 32,
    )
    conn = PlatformConnection(entry, AgentConfig())
    conn.ws = _RecordingWS()

    await conn.send_hello(
        {"cpu": "x", "platform": "Windows"}, "cuda", "2.0", ["KSampler"],
        peer_url="http://192.168.1.5:8850",
    )

    payload = json.loads(conn.ws.sent[0])
    assert payload["peer_url"] == "http://192.168.1.5:8850"


@pytest.mark.asyncio
async def test_send_hello_reports_auto_fetch_true_from_config():
    entry = PlatformEntry(
        platform_url="http://p",
        platform_pubkey="aa",
        worker_id="w1",
        certificate="cert",
        signing_key_hex="00" * 32,
    )
    conn = PlatformConnection(entry, AgentConfig(auto_fetch_models=True))
    conn.ws = _RecordingWS()

    await conn.send_hello({"cpu": "x", "platform": "Windows"}, "cuda", "2.0", ["KSampler"])

    payload = json.loads(conn.ws.sent[0])
    assert payload["auto_fetch"] is True


@pytest.mark.asyncio
async def test_send_hello_reports_configured_max_fetch_gb():
    entry = PlatformEntry(
        platform_url="http://p",
        platform_pubkey="aa",
        worker_id="w1",
        certificate="cert",
        signing_key_hex="00" * 32,
    )
    conn = PlatformConnection(entry, AgentConfig(max_fetch_gb=5))
    conn.ws = _RecordingWS()

    await conn.send_hello({"cpu": "x", "platform": "Windows"}, "cuda", "2.0", ["KSampler"])

    payload = json.loads(conn.ws.sent[0])
    assert payload["max_fetch_gb"] == 5


async def _hello_payload(config: AgentConfig) -> dict:
    entry = PlatformEntry(
        platform_url="http://p",
        platform_pubkey="aa",
        worker_id="w1",
        certificate="cert",
        signing_key_hex="00" * 32,
    )
    conn = PlatformConnection(entry, config)
    conn.ws = _RecordingWS()
    await conn.send_hello({"cpu": "x", "platform": "Windows"}, "cuda", "2.0", ["KSampler"])
    return json.loads(conn.ws.sent[0])


@pytest.mark.asyncio
async def test_send_hello_reports_the_default_upload_cap_as_peer_upload_min_mbps():
    """The stock config caps ACTIVE uploads at 20 Mbps and leaves idle
    unlimited (0) -- the slowest rate this seeder will ever serve at is
    therefore 20, and 0 is not a candidate for "slowest"."""
    payload = await _hello_payload(AgentConfig())
    assert payload["peer_upload_min_mbps"] == 20


@pytest.mark.asyncio
async def test_send_hello_reports_the_lower_of_the_two_upload_caps():
    payload = await _hello_payload(
        AgentConfig(peer_upload_limit_mbps=20, peer_upload_limit_idle_mbps=50)
    )
    assert payload["peer_upload_min_mbps"] == 20

    payload = await _hello_payload(
        AgentConfig(peer_upload_limit_mbps=50, peer_upload_limit_idle_mbps=5)
    )
    assert payload["peer_upload_min_mbps"] == 5


@pytest.mark.asyncio
async def test_send_hello_reports_null_when_both_upload_caps_are_unlimited():
    """`0` means UNLIMITED, so both-zero has no floor to report at all -- the
    platform then falls back to its own default rate assumption."""
    payload = await _hello_payload(
        AgentConfig(peer_upload_limit_mbps=0, peer_upload_limit_idle_mbps=0)
    )
    assert payload["peer_upload_min_mbps"] is None


@pytest.mark.asyncio
async def test_send_hello_skips_an_unlimited_cap_rather_than_reporting_zero():
    """Active unlimited + idle capped: the reported floor is the idle cap,
    NOT 0 (which the platform would read as "no value")."""
    payload = await _hello_payload(
        AgentConfig(peer_upload_limit_mbps=0, peer_upload_limit_idle_mbps=8)
    )
    assert payload["peer_upload_min_mbps"] == 8


# --- Console-signal (Ctrl-C / Ctrl-Break) shutdown --------------------------
#
# T3m9: the agent had no console-signal handling at all, so Ctrl-C (or
# CTRL_BREAK on Windows) killed the process instantly with zero cleanup --
# the dispatched ComfyUI prompt kept running as a ghost. A real OS signal
# can't be delivered inside pytest, so these exercise the pieces the signal
# handler drives directly: handler installation, the idempotent
# first-signal/second-signal dispatch, and the graceful-shutdown-and-stop
# coroutine it schedules.


class _FakeLoop:
    """Stand-in for the running event loop as seen by `_on_os_signal`."""

    def __init__(self):
        self.stopped = False
        self.created_tasks: list = []

    def call_soon_threadsafe(self, callback, *args):
        # The tests below call `_on_os_signal` directly (as
        # `call_soon_threadsafe` would eventually do on the real loop), so
        # this is only exercised by the handler-installation test.
        callback(*args)

    def create_task(self, coro, name=None):
        task = asyncio.ensure_future(coro)
        self.created_tasks.append(task)
        return task

    def stop(self):
        self.stopped = True


def test_install_signal_handlers_covers_sigint_sigterm_and_sigbreak(two_platform_loop, monkeypatch):
    import signal as signal_module

    installed = {}

    def _fake_signal(sig, handler):
        installed[sig] = handler

    monkeypatch.setattr(runner_module.signal, "signal", _fake_signal)

    loop = _FakeLoop()
    two_platform_loop._install_signal_handlers(loop)

    assert signal_module.SIGINT in installed
    assert signal_module.SIGTERM in installed
    if hasattr(signal_module, "SIGBREAK"):
        assert signal_module.SIGBREAK in installed


async def test_first_signal_schedules_graceful_shutdown_and_sets_flag(two_platform_loop, monkeypatch):
    loop = two_platform_loop
    scheduled = asyncio.Event()

    async def _fake_graceful(fake_loop):
        scheduled.set()

    monkeypatch.setattr(AgentLoop, "_graceful_shutdown_and_stop", lambda self, fake_loop: _fake_graceful(fake_loop))

    fake_loop = _FakeLoop()
    loop._on_os_signal(2, fake_loop)  # signal.SIGINT == 2

    assert loop._shutdown_in_progress is True
    await asyncio.wait_for(scheduled.wait(), timeout=10)


def test_second_signal_forces_immediate_exit(two_platform_loop, monkeypatch):
    loop = two_platform_loop
    loop._shutdown_in_progress = True  # as if a first signal already landed

    exit_calls = []
    monkeypatch.setattr(runner_module.os, "_exit", lambda code: exit_calls.append(code))

    fake_loop = _FakeLoop()
    loop._on_os_signal(2, fake_loop)

    assert exit_calls == [1]
    assert not fake_loop.created_tasks, "a forced exit must not also schedule a graceful shutdown"


async def test_graceful_shutdown_and_stop_interrupts_comfyui_and_reports_nothing(cancellable_loop):
    """The coroutine a signal schedules must reuse the same cancellation
    machinery as a server-driven cancel: interrupt/dequeue the ComfyUI
    prompt, run CANCELLED cleanup, and never report completion -- then stop
    the loop."""
    loop = cancellable_loop
    conn_a = loop.connections["worker-a"]

    await loop._handle_message(conn_a, _job_message("job-sigint"))
    await _await_flag(loop.test_started)

    fake_loop = _FakeLoop()
    await asyncio.wait_for(loop._graceful_shutdown_and_stop(fake_loop), timeout=10)

    assert loop.test_interrupts == [(loop.config.comfy_url, "p-slow")]
    assert conn_a.job_done is None, "a signal-driven shutdown must not report completion"
    assert conn_a.job_failed is None, "a signal-driven shutdown must not report failure"
    assert fake_loop.stopped is True
    assert not loop._jobs, "the job handle must be reaped"


async def test_graceful_shutdown_and_stop_forces_exit_on_timeout(cancellable_loop, monkeypatch):
    """A cleanup that never finishes inside the hard cap must not hang the
    process forever -- it exits instead."""
    loop = cancellable_loop

    async def _hang_forever():
        await asyncio.sleep(3600)

    monkeypatch.setattr(loop, "shutdown", _hang_forever)
    monkeypatch.setattr(runner_module, "_SIGNAL_SHUTDOWN_TIMEOUT_SECONDS", 0.05)

    exit_calls = []
    monkeypatch.setattr(runner_module.os, "_exit", lambda code: exit_calls.append(code))

    fake_loop = _FakeLoop()
    await asyncio.wait_for(loop._graceful_shutdown_and_stop(fake_loop), timeout=10)

    assert exit_calls == [1]


# --- Phase 2.1 Task 5: fetch_models pre-phase --------------------------------


def _fetch_job_message(job_id: str, fetch_models: list[dict]) -> dict:
    return {
        "job_id": job_id,
        "workflow_json": json.dumps({"1": {"class_type": "KSampler", "inputs": {}}}),
        "input_assets": [],
        "fetch_models": fetch_models,
    }


async def test_fetch_models_disabled_auto_fetch_fails_job_without_running(two_platform_loop, monkeypatch):
    """A `fetch_models` push reaching a worker with auto_fetch_models
    explicitly turned off (opted out) is always a race or a server bug --
    politely job_failed, and run_workflow must never be reached."""
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]
    loop.config.auto_fetch_models = False  # explicit opt-out; no longer the default

    def _must_not_run(*args, **kwargs):
        raise AssertionError("run_workflow must not be called when auto-fetch is disabled")

    monkeypatch.setattr(comfy, "run_workflow", _must_not_run)

    job_msg = _fetch_job_message("job-fetch-1", [{"name": "m.safetensors"}])
    await loop.handle_job(conn_a, job_msg)

    assert conn_a.job_failed == ("job-fetch-1", runner_module._AUTO_FETCH_DISABLED_MESSAGE, None)
    assert conn_a.job_done is None
    assert conn_a.heartbeats[-1]["state"] == "idle"


async def test_fetch_models_success_pushes_inventory_then_runs_workflow(two_platform_loop, monkeypatch):
    loop = two_platform_loop
    loop.config.auto_fetch_models = True
    loop.config.models_dir = "/fake/models"
    conn_a = loop.connections["worker-a"]

    fetch_calls = []

    async def _fake_fetch(**kwargs):
        fetch_calls.append(kwargs)
        await kwargs["report_progress"](50.0, "m.safetensors")

    monkeypatch.setattr(runner_module.fetcher, "fetch_and_verify_models", _fake_fetch)
    monkeypatch.setattr(hardware, "scan_models", lambda *a, **k: [{"name": "m.safetensors", "size": 0.1}])
    monkeypatch.setattr(comfy, "run_workflow", lambda *a, **k: ([], 1.0))

    entries = [{"name": "m.safetensors", "directory": "checkpoints", "url": "http://x", "sha256": "ab", "size_bytes": 5}]
    job_msg = _fetch_job_message("job-fetch-2", entries)
    await loop.handle_job(conn_a, job_msg)

    assert len(fetch_calls) == 1
    assert fetch_calls[0]["entries"] == entries
    assert fetch_calls[0]["platform_pubkey_hex"] == conn_a.entry.platform_pubkey
    assert fetch_calls[0]["models_dir"] == loop.config.models_dir
    assert fetch_calls[0]["max_fetch_gb"] == loop.config.max_fetch_gb

    # The inventory rescan+push happens immediately (not on the 10-minute
    # timer) once the fetch succeeds.
    assert conn_a.inventories == [[{"name": "m.safetensors", "size": 0.1}]]

    # And the job continues into the normal run path afterward.
    assert conn_a.job_done == ("job-fetch-2", [], 1.0)


async def test_fetch_progress_relayed_as_stage_heartbeat(two_platform_loop, monkeypatch):
    loop = two_platform_loop
    loop.config.auto_fetch_models = True
    conn_a = loop.connections["worker-a"]

    async def _fake_fetch(**kwargs):
        await kwargs["report_progress"](42.0, "foo.safetensors")

    monkeypatch.setattr(runner_module.fetcher, "fetch_and_verify_models", _fake_fetch)
    monkeypatch.setattr(hardware, "scan_models", lambda *a, **k: [])
    monkeypatch.setattr(comfy, "run_workflow", lambda *a, **k: ([], None))

    job_msg = _fetch_job_message("job-fetch-3", [{"name": "foo.safetensors"}])
    await loop.handle_job(conn_a, job_msg)

    stage_heartbeats = [hb for hb in conn_a.heartbeats if hb.get("stage") == "fetching_models"]
    # The INITIAL busy beat already carries the stage (fetch_pct 0.0) so the
    # server never sees a stage-less beat before the download -- the actual
    # progress report is the last one.
    assert len(stage_heartbeats) >= 2, "expected initial + progress fetching_models heartbeats"
    assert stage_heartbeats[0]["fetch_pct"] == 0.0
    assert stage_heartbeats[-1]["fetch_pct"] == 42.0
    assert stage_heartbeats[-1]["fetch_model"] == "foo.safetensors"
    assert stage_heartbeats[-1]["job_id"] == "job-fetch-3"


async def test_fetch_error_fails_job_and_skips_run_workflow(two_platform_loop, monkeypatch):
    loop = two_platform_loop
    loop.config.auto_fetch_models = True
    conn_a = loop.connections["worker-a"]

    async def _fake_fetch(**kwargs):
        raise fetcher.FetchError("模型清單簽章驗證失敗：m.safetensors / manifest signature verification failed")

    monkeypatch.setattr(runner_module.fetcher, "fetch_and_verify_models", _fake_fetch)

    def _must_not_run(*args, **kwargs):
        raise AssertionError("run_workflow must not be called after a fetch failure")

    monkeypatch.setattr(comfy, "run_workflow", _must_not_run)

    job_msg = _fetch_job_message("job-fetch-4", [{"name": "m.safetensors"}])
    await loop.handle_job(conn_a, job_msg)

    assert conn_a.job_failed == (
        "job-fetch-4",
        "模型清單簽章驗證失敗：m.safetensors / manifest signature verification failed",
        None,
    )
    assert conn_a.job_done is None


async def test_fetch_cancelled_reports_nothing(two_platform_loop, monkeypatch):
    """`fetcher.fetch_and_verify_models` raises `comfy.JobCancelled` when the
    cancel_event trips mid-download -- must flow through the exact same
    silent-cancellation path as a cancel mid-render: no job_done, no
    job_failed."""
    loop = two_platform_loop
    loop.config.auto_fetch_models = True
    conn_a = loop.connections["worker-a"]

    async def _fake_fetch(**kwargs):
        raise comfy.JobCancelled()

    monkeypatch.setattr(runner_module.fetcher, "fetch_and_verify_models", _fake_fetch)

    def _must_not_run(*args, **kwargs):
        raise AssertionError("run_workflow must not be called after a fetch cancellation")

    monkeypatch.setattr(comfy, "run_workflow", _must_not_run)

    job_msg = _fetch_job_message("job-fetch-5", [{"name": "m.safetensors"}])
    await loop.handle_job(conn_a, job_msg)

    assert conn_a.job_failed is None
    assert conn_a.job_done is None
    assert conn_a.heartbeats[-1]["state"] == "idle"


async def test_fetch_models_absent_does_not_touch_fetcher(two_platform_loop, monkeypatch):
    """A plain job push (no `fetch_models` key -- the common case, and every
    push to a directly-`eligible` worker) must never invoke the fetcher at
    all."""
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]

    def _must_not_fetch(**kwargs):
        raise AssertionError("fetch_and_verify_models must not be called without fetch_models")

    monkeypatch.setattr(runner_module.fetcher, "fetch_and_verify_models", _must_not_fetch)
    monkeypatch.setattr(comfy, "run_workflow", lambda *a, **k: ([], None))

    job_msg = {
        "job_id": "job-no-fetch",
        "workflow_json": json.dumps({"1": {"class_type": "KSampler", "inputs": {}}}),
        "input_assets": [],
    }
    await loop.handle_job(conn_a, job_msg)

    assert conn_a.job_done == ("job-no-fetch", [], None)


async def test_shutdown_cancels_a_job_stuck_in_the_fetch_phase(two_platform_loop, monkeypatch):
    """The graceful-shutdown path trips the same `cancel_event` a
    platform-driven job_cancelled would -- a fetch loop that is checking it
    (see fetcher._download_one) must abort and clean up exactly like a
    cancel mid-render."""
    loop = two_platform_loop
    loop.config.auto_fetch_models = True
    conn_a = loop.connections["worker-a"]

    fetch_started = asyncio.Event()

    async def _slow_fetch(**kwargs):
        cancel_event = kwargs["cancel_event"]
        fetch_started.set()
        deadline = time.monotonic() + 10.0
        while not cancel_event.is_set():
            if time.monotonic() > deadline:  # pragma: no cover - test safety net
                raise AssertionError("cancel event never tripped")
            await asyncio.sleep(0.01)
        raise comfy.JobCancelled()

    monkeypatch.setattr(runner_module.fetcher, "fetch_and_verify_models", _slow_fetch)

    def _must_not_run(*args, **kwargs):
        raise AssertionError("run_workflow must not be called once the fetch phase is cancelled")

    monkeypatch.setattr(comfy, "run_workflow", _must_not_run)

    job_msg = _fetch_job_message("job-fetch-shutdown", [{"name": "m.safetensors"}])
    task = asyncio.create_task(loop._handle_message(conn_a, {**job_msg, "type": "job"}))
    await asyncio.wait_for(fetch_started.wait(), timeout=5.0)

    await asyncio.wait_for(loop.shutdown(), timeout=5.0)
    await asyncio.wait_for(task, timeout=5.0)

    assert conn_a.job_failed is None
    assert conn_a.job_done is None
    assert not loop._jobs


async def test_periodic_heartbeat_carries_fetch_stage_while_downloading(cancellable_loop, monkeypatch):
    """final-review m1, root fix: while the auto-fetch pre-phase is active,
    the periodic heartbeat must carry stage="fetching_models" (from
    `_JobHandle.fetch_status`) -- a stage-less busy beat is the server's
    run-started signal, and the download phase is deliberately never
    billed. Simulated by pinning fetch_status on the running handle."""
    loop = cancellable_loop
    conn_a = loop.connections["worker-a"]

    monkeypatch.setattr(runner_module, "_HEARTBEAT_INTERVAL_SECONDS", 0)
    monkeypatch.setattr(runner_module, "_RECV_POLL_TIMEOUT_SECONDS", 0.01)

    await loop._handle_message(conn_a, _job_message("job-fetch-hb"))
    task = loop._current_job_task
    await _await_flag(loop.test_started)

    handle = loop._jobs["job-fetch-hb"]
    handle.fetch_status = {
        "stage": "fetching_models",
        "fetch_pct": 55.0,
        "fetch_model": "big.safetensors",
    }
    try:
        conn_a.heartbeats.clear()
        loop_task = asyncio.create_task(loop._connection_loop(conn_a))
        await asyncio.sleep(0.1)
        loop_task.cancel()
        try:
            await loop_task
        except asyncio.CancelledError:
            pass

        assert conn_a.heartbeats, "the periodic heartbeat never fired"
        assert all(hb.get("stage") == "fetching_models" for hb in conn_a.heartbeats)
        assert all(hb.get("fetch_pct") == 55.0 for hb in conn_a.heartbeats)
        assert all(hb.get("fetch_model") == "big.safetensors" for hb in conn_a.heartbeats)

        # Fetch over: stage disappears from subsequent periodic beats.
        handle.fetch_status = None
        conn_a.heartbeats.clear()
        loop_task = asyncio.create_task(loop._connection_loop(conn_a))
        await asyncio.sleep(0.1)
        loop_task.cancel()
        try:
            await loop_task
        except asyncio.CancelledError:
            pass
        assert conn_a.heartbeats
        # The fake conn records kwargs verbatim (stage=None when unset).
        assert all(hb["stage"] is None for hb in conn_a.heartbeats)
    finally:
        await loop._handle_message(conn_a, {"type": "job_cancelled", "job_id": "job-fetch-hb"})
        await asyncio.wait_for(task, timeout=10)


# --- Task 3: 4401 dead-registration classification + give-up ----------------


def test_is_auth_rejected_true_for_4401_received_close():
    exc = ConnectionClosedError(Close(_4401(), "gone"), None)
    assert _is_auth_rejected(exc) is True


def test_is_auth_rejected_true_for_4401_sent_close():
    exc = ConnectionClosedError(None, Close(_4401(), "gone"))
    assert _is_auth_rejected(exc) is True


def test_is_auth_rejected_true_for_4401_connection_closed_ok():
    exc = ConnectionClosedOK(Close(_4401(), "gone"), None)
    assert _is_auth_rejected(exc) is True


def test_is_auth_rejected_false_for_1006_close():
    exc = ConnectionClosedError(Close(1006, "abnormal"), None)
    assert _is_auth_rejected(exc) is False


def test_is_auth_rejected_false_for_plain_oserror():
    assert _is_auth_rejected(OSError("connection refused")) is False


def test_is_auth_rejected_ignores_4401_in_a_non_auth_reason_string():
    """A transient 1006/1011 whose server reason merely CONTAINS "4401" (a
    nonce, a request id) must NOT be read as a permanent auth rejection --
    the decision is the close-frame CODE only, never a string match. A false
    positive here would make a healthy agent give up forever (review MEDIUM)."""
    exc = ConnectionClosedError(Close(1011, "internal error ref=4401xyz"), None)
    assert _is_auth_rejected(exc) is False


def _4401() -> int:
    return runner_module._AUTH_REJECTED_CLOSE_CODE


async def _noop(*args, **kwargs):
    return None


async def _ready(*args, **kwargs):
    """A stand-in for `PlatformConnection.handshake`, which returns the whole
    `ready` frame (Phase 3.4). An old platform's frame carries no
    `remote_ip`, which is exactly what this empty-but-present dict models."""
    return {"type": "ready"}


@pytest.fixture()
def one_platform_loop(monkeypatch, tmp_path):
    """A single-platform loop with the connection-setup calls stubbed, so a
    test can drive `_run_platform`'s connect/handshake retry loop directly and
    only the handshake outcome matters. Backoff is zeroed so a retry path
    doesn't actually sleep 5s between iterations."""
    monkeypatch.setattr(hardware, "collect_hardware", lambda *a, **k: {})
    monkeypatch.setattr(hardware, "detect_backend", lambda: ("cpu", "0"))
    monkeypatch.setattr(hardware, "collect_dynamic", lambda *a, **k: {})
    monkeypatch.setattr(whitelist, "allowed_classes", lambda *a, **k: {"KSampler"})
    # `_run_platform` now waits for ComfyUI BEFORE connecting; unless a
    # test is specifically about that wait, ComfyUI is up and the probe is
    # a no-op (otherwise every one of these would park on a real probe).
    monkeypatch.setattr(detect, "probe_comfy", lambda *a, **k: True)
    monkeypatch.setattr(runner_module, "_BACKOFF_START_SECONDS", 0)
    monkeypatch.setattr(runner_module, "_BACKOFF_MAX_SECONDS", 0)

    config = AgentConfig(platforms=[_entry("worker-a")], pause_when_active=False)
    return AgentLoop(config, str(tmp_path / "agent.json"), connection_factory=FakeConnection)


async def test_run_platform_gives_up_and_returns_on_repeated_4401(one_platform_loop):
    """Two CONSECUTIVE 4401 handshakes are definitive: `_run_platform` must
    RETURN (stop retrying this entry) and record the give-up -- but only on
    the second, since an older platform sends 4401 on a mere timeout too."""
    loop = one_platform_loop
    conn = loop.connections["worker-a"]

    calls = {"n": 0}

    async def _handshake_4401():
        calls["n"] += 1
        raise ConnectionClosedError(Close(_4401(), "worker removed"), None)

    conn.connect = _noop
    conn.close = _noop
    conn.handshake = _handshake_4401

    # Returns rather than looping forever.
    await asyncio.wait_for(loop._run_platform(conn), timeout=5)

    assert calls["n"] == 2, "the FIRST 4401 must be retried, the second gives up"
    assert loop._auth_gave_up is True
    assert loop._connected_ever is False


async def test_run_platform_retries_on_1006(one_platform_loop):
    """A 1006 (abnormal closure) is a transient blip: `_run_platform` must
    back off and retry it, not give up like a 4401."""
    loop = one_platform_loop
    conn = loop.connections["worker-a"]

    calls = {"n": 0}

    async def _handshake_1006():
        calls["n"] += 1
        if calls["n"] >= 3:
            # Break out of the otherwise-infinite retry loop; CancelledError
            # is not caught by `except Exception`, so it propagates cleanly.
            raise asyncio.CancelledError()
        raise ConnectionClosedError(Close(1006, "blip"), None)

    conn.connect = _noop
    conn.close = _noop
    conn.handshake = _handshake_1006

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(loop._run_platform(conn), timeout=5)

    assert calls["n"] >= 2, "a 1006 entry must be retried, not given up on"
    assert loop._auth_gave_up is False


async def test_run_raises_all_registrations_rejected_when_the_only_entry_is_4401(
    one_platform_loop, monkeypatch
):
    """`run()` with a single 4401-dead entry: every `_run_platform` returns,
    nothing ever connected, so `run()` raises `AllRegistrationsRejected`."""
    loop = one_platform_loop
    conn = loop.connections["worker-a"]

    async def _handshake_4401():
        raise ConnectionClosedError(Close(_4401(), "gone"), None)

    conn.connect = _noop
    conn.close = _noop
    conn.handshake = _handshake_4401

    monkeypatch.setattr(loop, "_start_peer_server", lambda: None)
    monkeypatch.setattr(loop, "_install_signal_handlers", lambda event_loop: None)

    with pytest.raises(AllRegistrationsRejected):
        await asyncio.wait_for(loop.run(), timeout=5)


# --- 4401 give-up prunes the dead registration to agent.dead.json -----------


def _entry_at(worker_id: str, platform_url: str) -> PlatformEntry:
    entry = _entry(worker_id)
    entry.platform_url = platform_url
    return entry


def _dead_records(tmp_path) -> list:
    with open(tmp_path / "agent.dead.json", "r", encoding="utf-8") as f:
        return json.load(f)


@pytest.fixture()
def prunable_loop(monkeypatch, tmp_path):
    """A two-entry (two DIFFERENT platforms) loop whose config really exists
    on disk, so `_prune_dead_registration` has something to rewrite."""
    monkeypatch.setattr(hardware, "collect_hardware", lambda *a, **k: {})
    monkeypatch.setattr(hardware, "detect_backend", lambda: ("cpu", "0"))
    monkeypatch.setattr(hardware, "collect_dynamic", lambda *a, **k: {})
    monkeypatch.setattr(whitelist, "allowed_classes", lambda *a, **k: {"KSampler"})
    # `_run_platform` now waits for ComfyUI BEFORE connecting; unless a
    # test is specifically about that wait, ComfyUI is up and the probe is
    # a no-op (otherwise every one of these would park on a real probe).
    monkeypatch.setattr(detect, "probe_comfy", lambda *a, **k: True)
    monkeypatch.setattr(runner_module, "_BACKOFF_START_SECONDS", 0)
    monkeypatch.setattr(runner_module, "_BACKOFF_MAX_SECONDS", 0)

    cfg_path = str(tmp_path / "agent.json")
    config = AgentConfig(
        platforms=[
            _entry_at("worker-dead", "http://dead.example"),
            _entry_at("worker-live", "http://live.example"),
        ],
        pause_when_active=False,
    )
    config.save(cfg_path)
    return AgentLoop(config, cfg_path, connection_factory=FakeConnection)


async def test_4401_give_up_prunes_only_that_entry_and_backs_it_up(prunable_loop, tmp_path):
    """The definitive per-entry 4401 give-up removes exactly that entry from
    agent.json, keeps the signing key recoverable in agent.dead.json, and
    leaves every other platform's entry untouched."""
    loop = prunable_loop
    conn = loop.connections["worker-dead"]

    async def _handshake_4401():
        raise ConnectionClosedError(Close(_4401(), "worker removed"), None)

    conn.connect = _noop
    conn.close = _noop
    conn.handshake = _handshake_4401

    await asyncio.wait_for(loop._run_platform(conn), timeout=5)

    saved = AgentConfig.load(loop.cfg_path)
    assert [p.worker_id for p in saved.platforms] == ["worker-live"]
    # The in-memory config follows the file; the OTHER platform's connection
    # is untouched so its own `_run_platform` keeps running.
    assert [p.worker_id for p in loop.config.platforms] == ["worker-live"]
    assert set(loop.connections) == {"worker-dead", "worker-live"}

    records = _dead_records(tmp_path)
    assert len(records) == 1
    assert records[0]["worker_id"] == "worker-dead"
    assert records[0]["platform_url"] == "http://dead.example"
    # The whole point of the backup: the signing key is recoverable.
    assert records[0]["signing_key_hex"] == "11" * 32
    assert records[0]["certificate"] == "cert"
    assert records[0]["reason"] == "auth_rejected_4401"
    assert records[0]["removed_at"].endswith("+00:00")


async def test_4401_prune_leaves_no_temp_file_behind(prunable_loop, tmp_path):
    """Both writes go through tmp + os.replace (config.save's contract), so a
    completed prune leaves exactly agent.json and agent.dead.json."""
    loop = prunable_loop
    conn = loop.connections["worker-dead"]

    async def _handshake_4401():
        raise ConnectionClosedError(Close(_4401(), "gone"), None)

    conn.connect = _noop
    conn.close = _noop
    conn.handshake = _handshake_4401

    await asyncio.wait_for(loop._run_platform(conn), timeout=5)

    leftovers = [p.name for p in tmp_path.iterdir() if ".tmp-" in p.name]
    assert leftovers == []


async def test_1006_drop_prunes_nothing(prunable_loop, tmp_path):
    """A transient 1006 is retried, never pruned: agent.json keeps both
    entries and no backup file is created at all."""
    loop = prunable_loop
    conn = loop.connections["worker-dead"]

    calls = {"n": 0}

    async def _handshake_1006():
        calls["n"] += 1
        if calls["n"] >= 3:
            raise asyncio.CancelledError()
        raise ConnectionClosedError(Close(1006, "blip"), None)

    conn.connect = _noop
    conn.close = _noop
    conn.handshake = _handshake_1006

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(loop._run_platform(conn), timeout=5)

    saved = AgentConfig.load(loop.cfg_path)
    assert [p.worker_id for p in saved.platforms] == ["worker-dead", "worker-live"]
    assert not (tmp_path / "agent.dead.json").exists()


async def test_two_prunes_append_to_the_same_backup_file(prunable_loop, tmp_path):
    """agent.dead.json is a growing JSON list, not a one-shot file: a second
    dead registration is APPENDED, the first record is still there."""
    loop = prunable_loop

    async def _handshake_4401():
        raise ConnectionClosedError(Close(_4401(), "gone"), None)

    for worker_id in ("worker-dead", "worker-live"):
        conn = loop.connections[worker_id]
        conn.connect = _noop
        conn.close = _noop
        conn.handshake = _handshake_4401
        await asyncio.wait_for(loop._run_platform(conn), timeout=5)

    assert AgentConfig.load(loop.cfg_path).platforms == []

    records = _dead_records(tmp_path)
    assert [r["worker_id"] for r in records] == ["worker-dead", "worker-live"]


@pytest.mark.skipif(os.name == "nt", reason="POSIX file modes only")
async def test_dead_registration_backup_is_owner_only(prunable_loop, tmp_path):
    """It carries a signing key in the clear, same as agent.json, so it must
    not be group/world readable where the OS can express that."""
    loop = prunable_loop
    conn = loop.connections["worker-dead"]

    async def _handshake_4401():
        raise ConnectionClosedError(Close(_4401(), "gone"), None)

    conn.connect = _noop
    conn.close = _noop
    conn.handshake = _handshake_4401

    await asyncio.wait_for(loop._run_platform(conn), timeout=5)

    mode = os.stat(tmp_path / "agent.dead.json").st_mode & 0o777
    assert mode == 0o600


async def test_prune_of_an_already_absent_entry_is_a_no_op(prunable_loop, tmp_path):
    """Hand-edited away (or pruned by an earlier run): nothing to back up, so
    no backup file appears and the surviving entry is left alone."""
    loop = prunable_loop
    stranger = _entry_at("worker-gone", "http://gone.example")

    await loop._prune_dead_registration(stranger)

    saved = AgentConfig.load(loop.cfg_path)
    assert [p.worker_id for p in saved.platforms] == ["worker-dead", "worker-live"]
    assert not (tmp_path / "agent.dead.json").exists()


# --- H1/L4: 4403 (disabled) and 4408 (timeout) are NOT a dead registration --


def _close_exc(code: int, reason: str = "x") -> ConnectionClosedError:
    return ConnectionClosedError(Close(code, reason), None)


async def test_4403_disabled_keeps_retrying_and_prunes_nothing(prunable_loop, tmp_path, caplog):
    """An admin DISABLING a worker is reversible: the agent must keep
    retrying (so it reconnects by itself once the worker is re-enabled) and
    must never give up or prune -- a pruned entry would not come back."""
    loop = prunable_loop
    conn = loop.connections["worker-dead"]

    calls = {"n": 0}

    async def _handshake_4403():
        calls["n"] += 1
        if calls["n"] >= 4:
            raise asyncio.CancelledError()
        raise _close_exc(runner_module._WORKER_DISABLED_CLOSE_CODE, "worker disabled")

    conn.connect = _noop
    conn.close = _noop
    conn.handshake = _handshake_4403

    with caplog.at_level(logging.ERROR, logger="comfyfed_agent.runner"):
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(loop._run_platform(conn), timeout=5)

    assert calls["n"] >= 3, "a disabled worker must keep being retried"
    assert loop._auth_gave_up is False
    # Nothing pruned, nothing backed up.
    saved = AgentConfig.load(loop.cfg_path)
    assert [p.worker_id for p in saved.platforms] == ["worker-dead", "worker-live"]
    assert not (tmp_path / "agent.dead.json").exists()
    # ...and the bilingual notice was logged exactly ONCE, not per retry.
    disabled_logs = [r for r in caplog.records if "已被平台" in r.getMessage()]
    assert len(disabled_logs) == 1
    assert "disabled by the platform admin" in disabled_logs[0].getMessage()


async def test_4408_handshake_timeout_prunes_nothing(prunable_loop, tmp_path):
    """4408 is the platform saying "you didn't answer in time" -- as
    transient as a 1006, so it is retried and never pruned."""
    loop = prunable_loop
    conn = loop.connections["worker-dead"]

    calls = {"n": 0}

    async def _handshake_4408():
        calls["n"] += 1
        if calls["n"] >= 4:
            raise asyncio.CancelledError()
        raise _close_exc(runner_module._AUTH_TIMEOUT_CLOSE_CODE, "handshake timeout")

    conn.connect = _noop
    conn.close = _noop
    conn.handshake = _handshake_4408

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(loop._run_platform(conn), timeout=5)

    assert calls["n"] >= 3
    assert loop._auth_gave_up is False
    saved = AgentConfig.load(loop.cfg_path)
    assert [p.worker_id for p in saved.platforms] == ["worker-dead", "worker-live"]
    assert not (tmp_path / "agent.dead.json").exists()


async def test_a_single_4401_followed_by_a_good_handshake_prunes_nothing(
    prunable_loop, tmp_path
):
    """The false positive this rule exists to stop: one 4401 (an old platform
    answering a handshake TIMEOUT) followed by a successful handshake must
    leave the registration exactly where it was, counter reset."""
    loop = prunable_loop
    conn = loop.connections["worker-dead"]

    calls = {"n": 0}

    async def _handshake_once_4401():
        calls["n"] += 1
        if calls["n"] == 1:
            raise _close_exc(runner_module._AUTH_REJECTED_CLOSE_CODE, "timeout, really")
        return {"type": "ready"}

    async def _stop_after_hello(*args, **kwargs):
        # Break out right after the handshake succeeded; CancelledError is
        # not caught by `except Exception`, so it propagates cleanly.
        raise asyncio.CancelledError()

    conn.connect = _noop
    conn.close = _noop
    conn.handshake = _handshake_once_4401
    conn.send_hello = _stop_after_hello

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(loop._run_platform(conn), timeout=5)

    assert calls["n"] == 2
    assert conn.auth_rejections == 0, "a successful handshake resets the counter"
    assert loop._auth_gave_up is False
    saved = AgentConfig.load(loop.cfg_path)
    assert [p.worker_id for p in saved.platforms] == ["worker-dead", "worker-live"]
    assert not (tmp_path / "agent.dead.json").exists()


async def test_two_consecutive_4401_prune_the_entry(prunable_loop, tmp_path):
    """...and the second consecutive 4401 does prune it, backup and all."""
    loop = prunable_loop
    conn = loop.connections["worker-dead"]

    async def _handshake_4401():
        raise _close_exc(runner_module._AUTH_REJECTED_CLOSE_CODE, "worker removed")

    conn.connect = _noop
    conn.close = _noop
    conn.handshake = _handshake_4401

    await asyncio.wait_for(loop._run_platform(conn), timeout=5)

    assert conn.auth_rejections == runner_module._AUTH_REJECTIONS_BEFORE_GIVING_UP
    assert [p.worker_id for p in AgentConfig.load(loop.cfg_path).platforms] == ["worker-live"]
    assert [r["worker_id"] for r in _dead_records(tmp_path)] == ["worker-dead"]


# --- H1(c): the blocking hello-time calls must not stall the event loop -----


async def test_hello_time_blocking_calls_go_through_to_thread(monkeypatch, tmp_path):
    """`collect_hardware`/`scan_models` block (an HTTP call; minutes of
    sha256 with `hash_models`). On the event loop they stall every OTHER
    platform's coroutine past the platform's 10 s handshake timer -- which is
    exactly how a healthy registration used to collect a spurious rejection.
    They must be dispatched via `asyncio.to_thread`, like
    `whitelist.allowed_classes` beside them."""
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    monkeypatch.setattr(hardware, "collect_hardware", lambda *a, **k: {})
    monkeypatch.setattr(hardware, "scan_models", lambda *a, **k: [])
    monkeypatch.setattr(hardware, "detect_backend", lambda: ("cpu", "0"))
    monkeypatch.setattr(hardware, "collect_dynamic", lambda *a, **k: {})
    monkeypatch.setattr(whitelist, "allowed_classes", lambda *a, **k: {"KSampler"})
    # `_run_platform` now waits for ComfyUI BEFORE connecting; unless a
    # test is specifically about that wait, ComfyUI is up and the probe is
    # a no-op (otherwise every one of these would park on a real probe).
    monkeypatch.setattr(detect, "probe_comfy", lambda *a, **k: True)
    monkeypatch.setattr(runner_module, "_BACKOFF_START_SECONDS", 0)
    monkeypatch.setattr(runner_module, "_BACKOFF_MAX_SECONDS", 0)

    dispatched = []
    real_to_thread = asyncio.to_thread

    async def _recording_to_thread(func, *args, **kwargs):
        dispatched.append(func)
        return await real_to_thread(func, *args, **kwargs)

    monkeypatch.setattr(asyncio, "to_thread", _recording_to_thread)

    config = AgentConfig(
        platforms=[_entry("worker-a")],
        pause_when_active=False,
        models_dir=str(models_dir),
    )
    loop = AgentLoop(config, str(tmp_path / "agent.json"), connection_factory=FakeConnection)
    conn = loop.connections["worker-a"]

    async def _stop_at_inventory(*args, **kwargs):
        raise asyncio.CancelledError()

    conn.connect = _noop
    conn.close = _noop
    conn.handshake = _ready
    conn.send_hello = _noop
    conn.send_inventory = _stop_at_inventory

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(loop._run_platform(conn), timeout=5)

    assert hardware.collect_hardware in dispatched
    assert hardware.scan_models in dispatched


async def test_a_slow_collect_hardware_does_not_stall_another_platform(monkeypatch, tmp_path):
    """The concrete starvation: platform A's blocking hello-time work must
    not delay platform B's handshake. B's handshake completes WHILE A is
    still inside its 0.3 s `collect_hardware`."""
    order: list[str] = []

    def _slow_collect(*args, **kwargs):
        time.sleep(0.3)
        order.append("a-collect-done")
        return {}

    monkeypatch.setattr(hardware, "collect_hardware", _slow_collect)
    monkeypatch.setattr(hardware, "detect_backend", lambda: ("cpu", "0"))
    monkeypatch.setattr(hardware, "collect_dynamic", lambda *a, **k: {})
    monkeypatch.setattr(whitelist, "allowed_classes", lambda *a, **k: {"KSampler"})
    # `_run_platform` now waits for ComfyUI BEFORE connecting; unless a
    # test is specifically about that wait, ComfyUI is up and the probe is
    # a no-op (otherwise every one of these would park on a real probe).
    monkeypatch.setattr(detect, "probe_comfy", lambda *a, **k: True)
    monkeypatch.setattr(runner_module, "_BACKOFF_START_SECONDS", 0)
    monkeypatch.setattr(runner_module, "_BACKOFF_MAX_SECONDS", 0)

    config = AgentConfig(
        platforms=[
            _entry_at("worker-a", "http://a.example"),
            _entry_at("worker-b", "http://b.example"),
        ],
        pause_when_active=False,
    )
    loop = AgentLoop(config, str(tmp_path / "agent.json"), connection_factory=FakeConnection)
    conn_a = loop.connections["worker-a"]
    conn_b = loop.connections["worker-b"]

    async def _stop(*args, **kwargs):
        raise asyncio.CancelledError()

    conn_a.connect = _noop
    conn_a.close = _noop
    conn_a.handshake = _ready
    conn_a.send_hello = _stop

    async def _b_handshake():
        # B only gets here if A's blocking call is off the event loop.
        await asyncio.sleep(0.05)
        order.append("b-handshake-done")
        raise asyncio.CancelledError()

    conn_b.connect = _noop
    conn_b.close = _noop
    conn_b.handshake = _b_handshake

    results = await asyncio.wait_for(
        asyncio.gather(
            loop._run_platform(conn_a),
            loop._run_platform(conn_b),
            return_exceptions=True,
        ),
        timeout=5,
    )
    assert all(isinstance(r, asyncio.CancelledError) for r in results)
    assert order == ["b-handshake-done", "a-collect-done"]


# --- M1: a hand-edited agent.json must never escape and kill the agent ------


async def test_prune_skips_when_the_config_cannot_be_reparsed(prunable_loop, tmp_path, caplog):
    """`PlatformEntry(**p)` raises TypeError on an unknown key, and the prune
    runs INSIDE `_run_platform`'s except block -- an escape there propagates
    through `asyncio.gather` and takes every healthy platform down with it."""
    loop = prunable_loop
    conn = loop.connections["worker-dead"]

    raw = json.loads((tmp_path / "agent.json").read_text(encoding="utf-8"))
    raw["platforms"][0]["totally_unknown_key"] = "hand edited"
    (tmp_path / "agent.json").write_text(json.dumps(raw), encoding="utf-8")

    async def _handshake_4401():
        raise _close_exc(runner_module._AUTH_REJECTED_CLOSE_CODE, "gone")

    conn.connect = _noop
    conn.close = _noop
    conn.handshake = _handshake_4401

    with caplog.at_level(logging.ERROR, logger="comfyfed_agent.runner"):
        # Does NOT raise: the agent keeps running, the prune is skipped.
        await asyncio.wait_for(loop._run_platform(conn), timeout=5)

    assert json.loads((tmp_path / "agent.json").read_text(encoding="utf-8")) == raw
    assert not (tmp_path / "agent.dead.json").exists()
    assert any("略過這次清除" in r.getMessage() for r in caplog.records)


# --- M3: a corrupt agent.dead.json is preserved, never overwritten ----------


async def test_a_corrupt_dead_file_is_renamed_aside_not_overwritten(prunable_loop, tmp_path):
    """Whatever is in there is the only copy of earlier registrations'
    signing keys, so it is renamed to `.corrupt-<utc>` and a fresh list is
    started -- the prune still proceeds."""
    loop = prunable_loop
    conn = loop.connections["worker-dead"]
    dead_path = tmp_path / "agent.dead.json"
    corrupt_payload = '{"not": "a list"'
    dead_path.write_text(corrupt_payload, encoding="utf-8")

    async def _handshake_4401():
        raise _close_exc(runner_module._AUTH_REJECTED_CLOSE_CODE, "gone")

    conn.connect = _noop
    conn.close = _noop
    conn.handshake = _handshake_4401

    await asyncio.wait_for(loop._run_platform(conn), timeout=5)

    preserved = [p for p in tmp_path.iterdir() if ".corrupt-" in p.name]
    assert len(preserved) == 1
    assert preserved[0].read_text(encoding="utf-8") == corrupt_payload
    # The prune proceeded, and the new file holds exactly the new record.
    assert [r["worker_id"] for r in _dead_records(tmp_path)] == ["worker-dead"]
    assert [p.worker_id for p in AgentConfig.load(loop.cfg_path).platforms] == ["worker-live"]


# --- M4: the prune is locked, and a failed backup cancels it ----------------


async def test_two_concurrent_prunes_do_not_lose_an_update(prunable_loop, tmp_path):
    """Two platforms giving up at the same time: both entries must leave
    agent.json and both must be backed up -- neither removal may be lost to
    the other's read-modify-write."""
    loop = prunable_loop
    dead = _entry_at("worker-dead", "http://dead.example")
    live = _entry_at("worker-live", "http://live.example")

    await asyncio.gather(
        loop._prune_dead_registration(dead),
        loop._prune_dead_registration(live),
    )

    assert AgentConfig.load(loop.cfg_path).platforms == []
    assert sorted(r["worker_id"] for r in _dead_records(tmp_path)) == [
        "worker-dead",
        "worker-live",
    ]


async def test_a_failed_backup_cancels_the_prune(prunable_loop, tmp_path, monkeypatch):
    """The single most important safety property: without the backup the
    signing key would be unrecoverable, so a backup failure must leave
    agent.json exactly as it was (the entry is simply retried next start)."""
    loop = prunable_loop

    def _boom(entry):
        raise OSError("disk full")

    monkeypatch.setattr(loop, "_append_dead_registration", _boom)

    await loop._prune_dead_registration(_entry_at("worker-dead", "http://dead.example"))

    saved = AgentConfig.load(loop.cfg_path)
    assert [p.worker_id for p in saved.platforms] == ["worker-dead", "worker-live"]
    assert [p.worker_id for p in loop.config.platforms] == ["worker-dead", "worker-live"]
    assert not (tmp_path / "agent.dead.json").exists()


# ---------------------------------------------------------------------------
# Waiting for ComfyUI instead of crash-looping (live incident 2026-09-16)
# ---------------------------------------------------------------------------


async def test_run_platform_waits_for_comfy_before_connecting(
    one_platform_loop, monkeypatch, caplog
):
    """POKAI-HOME: the agent autostarts at logon, ComfyUI Desktop does not.
    Connecting first is what produced the endless post-handshake traceback,
    so `_run_platform` must probe ComfyUI BEFORE `connect()`, park quietly
    while it is down (ONE warning, however many probes it takes), and then
    announce it is reachable exactly once before proceeding."""
    loop = one_platform_loop
    conn = loop.connections["worker-a"]
    monkeypatch.setattr(runner_module, "_COMFY_WAIT_POLL_SECONDS", 0)

    probes = {"n": 0}

    def _probe(url, client):
        probes["n"] += 1
        return probes["n"] > 3  # down for the first three probes

    monkeypatch.setattr(detect, "probe_comfy", _probe)

    connects = {"n": 0}

    async def _connect(*args, **kwargs):
        connects["n"] += 1
        # No connect may have happened before ComfyUI answered.
        assert probes["n"] == 4

    async def _handshake(*args, **kwargs):
        raise asyncio.CancelledError()

    conn.connect = _connect
    conn.close = _noop
    conn.handshake = _handshake

    with caplog.at_level(logging.INFO, logger="comfyfed_agent.runner"):
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(loop._run_platform(conn), timeout=5)

    assert connects["n"] == 1, "connect() must happen only once ComfyUI is up"

    warnings = [
        r for r in caplog.records
        if r.levelno == logging.WARNING and "not running" in r.getMessage()
    ]
    assert len(warnings) == 1, "the wait must log ONCE, not once per probe"
    infos = [
        r for r in caplog.records
        if r.levelno == logging.INFO and "ComfyUI reachable" in r.getMessage()
    ]
    assert len(infos) == 1


async def test_waiting_for_comfy_publishes_paused_with_a_reason(
    one_platform_loop, monkeypatch
):
    """`agent_state.json` must explain the unavailability: `paused` plus
    `reason: comfyui_unreachable` while waiting, and NO `reason` key at all
    otherwise (readers that predate the field must see what they always
    saw)."""
    loop = one_platform_loop

    loop._publish_control_state()
    state = control.read_state(loop._config_dir)
    assert state["state"] == "idle"
    assert "reason" not in state

    loop._comfy_waiting.add("worker-a")
    loop._publish_control_state()
    state = control.read_state(loop._config_dir)
    assert state["state"] == "paused"
    assert state["reason"] == "comfyui_unreachable"

    loop._comfy_waiting.discard("worker-a")
    loop._publish_control_state()
    assert "reason" not in control.read_state(loop._config_dir)


def _comfy_connect_error(url: str) -> httpx.ConnectError:
    """What httpx raises when ComfyUI is not listening, cause chain and all."""
    request = httpx.Request("GET", url.rstrip("/") + "/object_info")
    exc = httpx.ConnectError("All connection attempts failed", request=request)
    return exc


async def test_drop_handler_logs_a_comfy_connect_error_without_a_traceback(
    one_platform_loop, monkeypatch, caplog
):
    """The 18k-line agent.log: a refused ComfyUI connection is expected and
    self-healing, so it gets ONE warning line -- no `logger.exception`."""
    loop = one_platform_loop
    conn = loop.connections["worker-a"]

    calls = {"n": 0}

    async def _handshake(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] >= 2:
            raise asyncio.CancelledError()
        raise _comfy_connect_error(loop.config.comfy_url)

    conn.connect = _noop
    conn.close = _noop
    conn.handshake = _handshake

    with caplog.at_level(logging.WARNING, logger="comfyfed_agent.runner"):
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(loop._run_platform(conn), timeout=5)

    records = [r for r in caplog.records if "ComfyUI request failed" in r.getMessage()]
    assert len(records) == 1
    assert records[0].levelno == logging.WARNING
    assert records[0].exc_info is None
    assert "Traceback" not in caplog.text


async def test_drop_handler_still_logs_a_traceback_for_other_exceptions(
    one_platform_loop, monkeypatch, caplog
):
    """The downgrade is narrow: anything that is not a refused ComfyUI
    connection keeps its `logger.exception` traceback."""
    loop = one_platform_loop
    conn = loop.connections["worker-a"]

    calls = {"n": 0}

    async def _handshake(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] >= 2:
            raise asyncio.CancelledError()
        raise RuntimeError("something else entirely")

    conn.connect = _noop
    conn.close = _noop
    conn.handshake = _handshake

    with caplog.at_level(logging.WARNING, logger="comfyfed_agent.runner"):
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(loop._run_platform(conn), timeout=5)

    dropped = [r for r in caplog.records if "dropped, retrying" in r.getMessage()]
    assert len(dropped) == 1
    assert dropped[0].exc_info is not None
    assert "Traceback" in caplog.text


async def test_a_connect_error_to_some_other_host_is_not_treated_as_comfy(
    one_platform_loop,
):
    """The recognition is URL-checked, not type-checked: a ConnectError to
    anything other than `comfy_url` must keep its traceback."""
    loop = one_platform_loop
    other = _comfy_connect_error("http://not-comfy.example:9999")
    assert runner_module._comfy_connect_error(other, loop.config.comfy_url) is False
    mine = _comfy_connect_error(loop.config.comfy_url)
    assert runner_module._comfy_connect_error(mine, loop.config.comfy_url) is True


# --- Phase 3.4 Task 3: NAT 映射、hello 欄位、ready.remote_ip、peer_status ---

from comfyfed_agent import natmap, peerserve  # noqa: E402


def _loop_with_peer(tmp_path, **overrides):
    cfg = AgentConfig(
        platforms=[],
        models_dir=str(tmp_path),
        peer_serve=True,
        peer_listen_port=8850,
        **overrides,
    )
    return AgentLoop(cfg, str(tmp_path / "agent.json"))


def _mapping(**overrides):
    fields = dict(
        method="natpmp",
        external_ip="203.0.113.7",
        external_port=8850,
        internal_port=8850,
        lifetime=3600,
        gateway="192.168.1.1",
    )
    fields.update(overrides)
    return natmap.Mapping(**fields)


@pytest.mark.asyncio
async def test_port_mapping_success_advertises_the_external_address(tmp_path, monkeypatch):
    monkeypatch.setattr(peerserve, "_detect_local_ip", lambda: "192.168.1.5")
    monkeypatch.setattr(natmap, "map_port", lambda **kwargs: _mapping())
    loop = _loop_with_peer(tmp_path)

    await loop._setup_port_mapping()

    assert loop._peer_advertised_url == "http://203.0.113.7:8850"
    assert loop._peer_lan_url == "http://192.168.1.5:8850"
    assert loop._peer_nat == "natpmp"


@pytest.mark.asyncio
async def test_port_mapping_failure_falls_back_to_the_lan_address(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(peerserve, "_detect_local_ip", lambda: "192.168.1.5")
    monkeypatch.setattr(natmap, "map_port", lambda **kwargs: None)
    loop = _loop_with_peer(tmp_path)

    with caplog.at_level(logging.WARNING):
        await loop._setup_port_mapping()

    assert loop._peer_advertised_url == "http://192.168.1.5:8850"
    assert loop._peer_nat == "lan"
    assert "無法自動開埠" in caplog.text


@pytest.mark.asyncio
async def test_peer_advertise_host_skips_mapping_entirely(tmp_path, monkeypatch):
    monkeypatch.setattr(peerserve, "_detect_local_ip", lambda: "192.168.1.5")
    called = []
    monkeypatch.setattr(natmap, "map_port", lambda **kwargs: called.append(kwargs) or _mapping())
    loop = _loop_with_peer(tmp_path, peer_advertise_host="nat.example.com")

    await loop._setup_port_mapping()

    assert called == []
    assert loop._peer_advertised_url == "http://nat.example.com:8850"
    assert loop._peer_nat == "manual"


@pytest.mark.asyncio
async def test_peer_nat_traversal_off_skips_mapping(tmp_path, monkeypatch):
    monkeypatch.setattr(peerserve, "_detect_local_ip", lambda: "192.168.1.5")
    called = []
    monkeypatch.setattr(natmap, "map_port", lambda **kwargs: called.append(kwargs) or _mapping())
    loop = _loop_with_peer(tmp_path, peer_nat_traversal="off")

    await loop._setup_port_mapping()

    assert called == []
    assert loop._peer_advertised_url == "http://192.168.1.5:8850"
    assert loop._peer_nat == "lan"


@pytest.mark.asyncio
async def test_private_external_ip_waits_for_ready_remote_ip(tmp_path, monkeypatch):
    """雙層 NAT：映射成功但外部 IP 不可用 ⇒ 先用區網位址連平台。"""
    monkeypatch.setattr(peerserve, "_detect_local_ip", lambda: "192.168.1.5")
    monkeypatch.setattr(natmap, "map_port", lambda **kwargs: _mapping(external_ip=None))
    loop = _loop_with_peer(tmp_path)

    await loop._setup_port_mapping()

    assert loop._peer_advertised_url == "http://192.168.1.5:8850"
    assert loop._peer_nat == "natpmp"


def test_apply_remote_ip_rebuilds_the_url_and_asks_for_one_reconnect(tmp_path, monkeypatch):
    monkeypatch.setattr(peerserve, "_detect_local_ip", lambda: "192.168.1.5")
    loop = _loop_with_peer(tmp_path)
    loop._peer_mapping = _mapping(external_ip=None, external_port=9001)
    loop._peer_nat = "natpmp"
    loop._peer_advertised_url = "http://192.168.1.5:8850"

    assert loop._apply_remote_ip("203.0.113.7") is True
    assert loop._peer_advertised_url == "http://203.0.113.7:9001"
    # 同一個 IP 再來一次不該再要求重連。
    assert loop._apply_remote_ip("203.0.113.7") is False


def test_apply_remote_ip_pins_the_first_public_ip_it_is_told(tmp_path, monkeypatch):
    """Fix round 1 裁定：多平台各自回報的 `remote_ip` 可能不同（不同出口、
    CDN、或其中一方看到的是自己的 proxy）。規則是**認第一個**非私有值，
    之後不一樣的一律 debug 記一行然後忽略 —— 簡單、可預測，而且不會讓兩個
    平台互相把通告位址推來推去。"""
    monkeypatch.setattr(peerserve, "_detect_local_ip", lambda: "192.168.1.5")
    loop = _loop_with_peer(tmp_path)
    loop._peer_mapping = _mapping(external_ip=None)
    loop._peer_nat = "natpmp"

    # 平台 A 先講話。
    assert loop._apply_remote_ip("203.0.113.7") is True
    assert loop._peer_advertised_url == "http://203.0.113.7:8850"
    # 平台 B 講了另一個位址 ⇒ 不重連、不改通告位址。
    assert loop._apply_remote_ip("203.0.113.9") is False
    assert loop._peer_remote_ip == "203.0.113.7"
    assert loop._peer_advertised_url == "http://203.0.113.7:8850"
    assert len(loop._peer_reconnects_at) == 1


@pytest.mark.asyncio
async def test_request_peer_reconnect_is_throttled_to_a_rolling_hour(tmp_path, monkeypatch):
    """節流是「滾動一小時最多一次」，不是「一個 process 永遠只有一次」
    （spec §8 勝過 §3.1 的「一次」）。"""
    monkeypatch.setattr(peerserve, "_detect_local_ip", lambda: "192.168.1.5")
    loop = _loop_with_peer(tmp_path)
    conn = _ClosableConn()
    loop.connections = {"a": conn}

    await loop._request_peer_reconnect()
    assert conn.closes == 1

    await loop._request_peer_reconnect()
    assert conn.closes == 1  # 同一小時內，不再踢第二次

    # 把那一筆紀錄推到一小時以前。
    loop._peer_reconnects_at = [
        t - runner_module._PEER_RECONNECT_WINDOW_SECONDS - 1.0
        for t in loop._peer_reconnects_at
    ]
    await loop._request_peer_reconnect()
    assert conn.closes == 2


def test_apply_remote_ip_ignores_a_private_or_missing_address(tmp_path, monkeypatch):
    monkeypatch.setattr(peerserve, "_detect_local_ip", lambda: "192.168.1.5")
    loop = _loop_with_peer(tmp_path)
    loop._peer_mapping = _mapping(external_ip=None)
    loop._peer_nat = "natpmp"

    assert loop._apply_remote_ip(None) is False
    assert loop._apply_remote_ip("192.168.1.9") is False
    assert loop._peer_remote_ip is None


def test_apply_remote_ip_ignores_a_manual_advertise_host(tmp_path, monkeypatch):
    monkeypatch.setattr(peerserve, "_detect_local_ip", lambda: "192.168.1.5")
    loop = _loop_with_peer(tmp_path, peer_advertise_host="nat.example.com")
    loop._peer_nat = "manual"
    loop._peer_advertised_url = "http://nat.example.com:8850"

    assert loop._apply_remote_ip("203.0.113.7") is False
    assert loop._peer_advertised_url == "http://nat.example.com:8850"


@pytest.mark.asyncio
async def test_handle_peer_status_records_and_warns(tmp_path, caplog):
    loop = _loop_with_peer(tmp_path)
    loop._peer_nat = "natpmp"
    conn = object()

    with caplog.at_level(logging.WARNING):
        await loop._handle_message(
            conn, {"type": "peer_status", "reachable": False, "checked_url": "http://203.0.113.7:8850"}
        )

    assert loop._peer_reachable is False
    assert loop._peer_checked_url == "http://203.0.113.7:8850"
    assert "無法自動開埠" in caplog.text or "連不到" in caplog.text


@pytest.mark.asyncio
async def test_handle_peer_status_warns_only_when_the_verdict_changes(tmp_path, caplog):
    """兩次連續的 `reachable: false` 只該吼一次 —— 平台會週期性複查，否則
    一台真的沒開埠的機器會把 log 洗滿一模一樣的段落。"""
    loop = _loop_with_peer(tmp_path)
    loop._peer_nat = "natpmp"

    with caplog.at_level(logging.WARNING):
        await loop._handle_message(object(), {"type": "peer_status", "reachable": False})
        await loop._handle_message(object(), {"type": "peer_status", "reachable": False})

    assert caplog.text.count("無法自動開埠") == 1


@pytest.mark.asyncio
async def test_handle_peer_status_true_does_not_warn(tmp_path, caplog):
    loop = _loop_with_peer(tmp_path)
    loop._peer_nat = "upnp"
    with caplog.at_level(logging.WARNING):
        await loop._handle_message(object(), {"type": "peer_status", "reachable": True})
    assert loop._peer_reachable is True
    assert caplog.text == ""


@pytest.mark.asyncio
async def test_shutdown_releases_the_port_mapping(tmp_path, monkeypatch):
    released = []
    monkeypatch.setattr(natmap, "unmap_port", lambda mapping: released.append(mapping))
    loop = _loop_with_peer(tmp_path)
    loop._peer_mapping = _mapping()

    await loop.shutdown()

    assert released and released[0].external_port == 8850
    assert loop._peer_mapping is None


@pytest.mark.asyncio
async def test_shutdown_cancels_the_renewal_task_before_unmapping(tmp_path, monkeypatch):
    """續租任務必須先取消並 await 完，才能解除映射 —— 否則正在飛的續租會
    在路由器上重新開好一個沒人收的轉埠。"""
    order = []

    async def _never_ending():
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            order.append("cancelled")
            raise

    monkeypatch.setattr(natmap, "unmap_port", lambda mapping: order.append("unmapped"))
    loop = _loop_with_peer(tmp_path)
    loop._peer_mapping = _mapping()
    loop._peer_renew_task = asyncio.create_task(_never_ending())
    await asyncio.sleep(0)

    await loop.shutdown()

    assert order == ["cancelled", "unmapped"]
    assert loop._peer_renew_task is None


def test_peer_state_payload_is_published_with_the_control_state(tmp_path, monkeypatch):
    written = {}
    monkeypatch.setattr(
        control, "write_state",
        lambda config_dir, state, job_id, reason=None, peer=None: written.update(peer=peer),
    )
    loop = _loop_with_peer(tmp_path)
    loop._peer_nat = "natpmp"
    loop._peer_advertised_url = "http://203.0.113.7:8850"
    loop._peer_lan_url = "http://192.168.1.5:8850"
    loop._peer_reachable = True

    loop._publish_control_state()

    assert written["peer"] == {
        "enabled": False,
        "nat": "natpmp",
        "url": "http://203.0.113.7:8850",
        "lan_url": "http://192.168.1.5:8850",
        "reachable": True,
    }


@pytest.mark.asyncio
async def test_send_hello_carries_peer_url_lan_url_and_nat():
    sent = []

    class FakeWs:
        async def send(self, text):
            sent.append(json.loads(text))

    entry = PlatformEntry(
        platform_url="http://platform.example",
        platform_pubkey="00" * 32,
        worker_id="w-1",
        certificate="cert",
        signing_key_hex="11" * 32,
    )
    conn = PlatformConnection(entry, AgentConfig())
    conn.ws = FakeWs()

    await conn.send_hello(
        {"gpu_name": "5080"},
        "cuda",
        "2.4.0",
        ["KSampler"],
        peer_url="http://203.0.113.7:8850",
        peer_lan_url="http://192.168.1.5:8850",
        peer_nat="natpmp",
    )

    assert sent[0]["peer_url"] == "http://203.0.113.7:8850"
    assert sent[0]["peer_lan_url"] == "http://192.168.1.5:8850"
    assert sent[0]["peer_nat"] == "natpmp"


@pytest.mark.asyncio
async def test_handshake_returns_the_ready_frame_with_remote_ip():
    frames = [
        json.dumps({"type": "challenge", "nonce": "abc"}),
        json.dumps({"type": "ready", "remote_ip": "203.0.113.7"}),
    ]

    class FakeWs:
        async def send(self, text):
            return None

        async def recv(self):
            return frames.pop(0)

    entry = PlatformEntry(
        platform_url="http://platform.example",
        platform_pubkey="00" * 32,
        worker_id="w-1",
        certificate="cert",
        signing_key_hex="11" * 32,
    )
    conn = PlatformConnection(entry, AgentConfig())
    conn.ws = FakeWs()

    ready = await conn.handshake()

    assert ready["remote_ip"] == "203.0.113.7"


@pytest.mark.asyncio
async def test_run_platform_reconnects_once_to_advertise_the_public_ip(
    one_platform_loop, monkeypatch
):
    """`ready.remote_ip` 把「區網位址」換成真正的公網位址 ⇒ 立刻關掉這條
    連線重來一次，讓平台拿到帶著新位址的 hello（spec §3.1 第 5 點）。"""
    loop = one_platform_loop
    conn = loop.connections["worker-a"]
    loop._peer_mapping = natmap.Mapping(
        method="natpmp",
        external_ip=None,
        external_port=8850,
        internal_port=8850,
        lifetime=3600,
        gateway="192.168.1.1",
    )
    loop._peer_nat = "natpmp"
    loop._peer_advertised_url = "http://192.168.1.5:8850"

    closes = {"n": 0}
    hellos = []

    async def _connect(*args, **kwargs):
        return None

    async def _close(*args, **kwargs):
        closes["n"] += 1

    async def _handshake(*args, **kwargs):
        return {"type": "ready", "remote_ip": "203.0.113.7"}

    async def _send_hello(*args, **kwargs):
        hellos.append(kwargs.get("peer_url"))
        raise asyncio.CancelledError()

    conn.connect = _connect
    conn.close = _close
    conn.handshake = _handshake
    conn.send_hello = _send_hello

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(loop._run_platform(conn), timeout=5)

    # 第一輪只重連、沒送 hello；第二輪送出的才是帶著公網位址的那一份，
    # 而且只有那一份（`_apply_remote_ip` 第二次看到同一個 IP 回 False，
    # 所以不會無限重連）。
    assert closes["n"] >= 1
    assert hellos == ["http://203.0.113.7:8850"]


# --- Fix round 1: 續租迴圈 --------------------------------------------------


class _ClosableConn:
    """只需要 `close()` 的假連線：`_request_peer_reconnect` 只碰這一個方法。"""

    def __init__(self):
        self.closes = 0

    async def close(self):
        self.closes += 1


async def _drive_renew_ticks(loop, calls, target, timeout=5.0):
    """跑 `_peer_renew_loop` 直到 `map_port` 被叫滿 `target` 次，然後收掉。"""
    task = asyncio.create_task(loop._peer_renew_loop())
    deadline = time.monotonic() + timeout
    try:
        while calls["n"] < target and time.monotonic() < deadline:
            await asyncio.sleep(0.005)
        # `calls` 是在 worker thread 裡加的，迴圈本體處理那個結果（記 log、
        # 換位址、踢連線）發生在之後 —— 給它一拍再收工。
        await asyncio.sleep(0.05)
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    assert calls["n"] >= target, f"renewal only ran {calls['n']} times"


@pytest.mark.asyncio
async def test_renewal_with_a_new_external_ip_reconnects_every_connection_once(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(natmap, "RENEW_SECONDS", 0.01)
    calls = {"n": 0}

    def _map(**kwargs):
        calls["n"] += 1
        return _mapping(external_ip="203.0.113.9")

    monkeypatch.setattr(natmap, "map_port", _map)
    loop = _loop_with_peer(tmp_path)
    loop._peer_mapping = _mapping()
    loop._peer_nat = "natpmp"
    loop._peer_advertised_url = "http://203.0.113.7:8850"
    conn_a, conn_b = _ClosableConn(), _ClosableConn()
    loop.connections = {"a": conn_a, "b": conn_b}

    # 至少三輪：第一輪換位址 + 重連，之後兩輪位址沒變 ⇒ 不該再踢任何人。
    await _drive_renew_ticks(loop, calls, 3)

    assert loop._peer_advertised_url == "http://203.0.113.9:8850"
    assert conn_a.closes == 1
    assert conn_b.closes == 1
    assert len(loop._peer_reconnects_at) == 1


@pytest.mark.asyncio
async def test_a_single_failed_renewal_keeps_the_current_lease(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(natmap, "RENEW_SECONDS", 0.01)
    calls = {"n": 0}
    gate = threading.Event()

    def _map(**kwargs):
        calls["n"] += 1
        if calls["n"] >= 2:
            # 只讓第一輪失敗：第二輪卡在這裡，測試就不會滑進「連兩次失敗」。
            gate.wait(1.0)
        return None

    monkeypatch.setattr(natmap, "map_port", _map)
    loop = _loop_with_peer(tmp_path)
    kept = _mapping()
    loop._peer_mapping = kept
    loop._peer_nat = "natpmp"
    loop._peer_advertised_url = "http://203.0.113.7:8850"
    conn = _ClosableConn()
    loop.connections = {"a": conn}

    with caplog.at_level(logging.WARNING):
        await _drive_renew_ticks(loop, calls, 1)

    assert loop._peer_mapping is kept
    assert loop._peer_advertised_url == "http://203.0.113.7:8850"
    assert loop._peer_nat == "natpmp"
    assert conn.closes == 0
    assert "renewal failed" in caplog.text
    gate.set()


@pytest.mark.asyncio
async def test_two_failed_renewals_downgrade_to_the_lan_address(tmp_path, monkeypatch, caplog):
    """連兩次沒開成 ⇒ 這台已經不能算「對外可連」了。降級成 lan、把對外
    位址換回區網位址，並且（照 §8 的節流）重連一次讓平台知道。"""
    monkeypatch.setattr(natmap, "RENEW_SECONDS", 0.01)
    calls = {"n": 0}

    def _map(**kwargs):
        calls["n"] += 1
        return None

    monkeypatch.setattr(natmap, "map_port", _map)
    loop = _loop_with_peer(tmp_path)
    loop._peer_mapping = _mapping()
    loop._peer_nat = "natpmp"
    loop._peer_lan_url = "http://192.168.1.5:8850"
    loop._peer_advertised_url = "http://203.0.113.7:8850"
    conn = _ClosableConn()
    loop.connections = {"a": conn}

    with caplog.at_level(logging.WARNING):
        await _drive_renew_ticks(loop, calls, 4)

    assert loop._peer_nat == "lan"
    assert loop._peer_advertised_url == "http://192.168.1.5:8850"
    assert conn.closes == 1
    # 降級只吼一次，不是每一輪都吼。
    assert caplog.text.count("無法自動開埠") == 1


@pytest.mark.asyncio
async def test_shutdown_unmaps_a_second_time_when_a_renewal_was_in_flight(
    tmp_path, monkeypatch
):
    """關機時正在飛的續租會在 `unmap_port` 之後才把轉埠重新開回路由器上。
    收不到那個 thread 的結果（`to_thread` 取消不了它），所以關機末尾再補一次
    盡力而為的解除。"""
    monkeypatch.setattr(natmap, "RENEW_SECONDS", 0.01)
    monkeypatch.setattr(runner_module, "_PEER_RENEW_DRAIN_SECONDS", 0.05)
    started = threading.Event()

    def _slow_map(**kwargs):
        started.set()
        time.sleep(0.3)
        return _mapping()

    unmapped = []
    monkeypatch.setattr(natmap, "map_port", _slow_map)
    monkeypatch.setattr(natmap, "unmap_port", lambda m: unmapped.append(m))
    loop = _loop_with_peer(tmp_path)
    loop._peer_mapping = _mapping()
    loop._peer_renew_task = asyncio.create_task(loop._peer_renew_loop())
    await asyncio.to_thread(started.wait, 5)

    await loop.shutdown()

    assert len(unmapped) == 2
    assert loop._peer_mapping is None


@pytest.mark.asyncio
async def test_shutdown_unmaps_the_mapping_the_in_flight_renewal_actually_created(
    tmp_path, monkeypatch
):
    """最終審查：那個「飛在半空中」的續租如果在 drain 期間才落地，它會把
    **新的**映射寫進 `_peer_mapping`（續租可能拿到另一個外部埠 —— 718 衝突
    會換埠）。第二次解除必須重讀那一筆，拿舊的去刪等於在路由器上留下一筆
    指向已關閉服務的轉埠。"""
    monkeypatch.setattr(runner_module, "_PEER_RENEW_DRAIN_SECONDS", 0.2)
    unmapped = []
    monkeypatch.setattr(natmap, "unmap_port", lambda m: unmapped.append(m))
    loop = _loop_with_peer(tmp_path)
    loop._peer_mapping = _mapping(external_port=8850)
    # 續租還在別的 thread 上飛（`shutdown` 因此會補第二次解除）。
    loop._peer_renew_in_flight = True
    renewed = _mapping(external_port=8853)

    async def _lands_during_the_drain():
        await asyncio.sleep(0.02)
        loop._peer_mapping = renewed

    late = asyncio.create_task(_lands_during_the_drain())
    await loop.shutdown()
    await late

    assert [m.external_port for m in unmapped] == [8850, 8853]
    assert loop._peer_mapping is None


@pytest.mark.asyncio
async def test_a_successful_renewal_without_a_usable_host_keeps_the_nat_label(
    tmp_path, monkeypatch
):
    """續租成功但沒有任何可用主機（UPnP 沒回外部 IP、平台也還沒給
    remote_ip）：通告位址沒得更新，標籤就不能跟著跳成 upnp —— 否則平台與
    主控台會顯示一個跟 `peer_url` 對不起來的來源。"""
    monkeypatch.setattr(natmap, "RENEW_SECONDS", 0.01)
    calls = {"n": 0}

    def _map(**kwargs):
        calls["n"] += 1
        return _mapping(method="upnp", external_ip=None)

    monkeypatch.setattr(natmap, "map_port", _map)
    loop = _loop_with_peer(tmp_path)
    loop._peer_mapping = _mapping(method="upnp", external_ip=None)
    loop._peer_nat = "lan"
    loop._peer_remote_ip = None
    loop._peer_advertised_url = "http://192.168.1.5:8850"
    conn = _ClosableConn()
    loop.connections = {"a": conn}

    await _drive_renew_ticks(loop, calls, 2)

    assert loop._peer_nat == "lan"
    assert loop._peer_advertised_url == "http://192.168.1.5:8850"
    assert conn.closes == 0
    # 續租本身是成功的，映射還是要更新（關機時要拿它去解除）。
    assert loop._peer_mapping is not None


@pytest.mark.asyncio
async def test_a_renewal_does_not_start_once_shutdown_has_begun(tmp_path, monkeypatch):
    monkeypatch.setattr(natmap, "RENEW_SECONDS", 0.01)
    calls = {"n": 0}
    monkeypatch.setattr(natmap, "map_port", lambda **kwargs: calls.__setitem__("n", calls["n"] + 1))
    loop = _loop_with_peer(tmp_path)
    loop._peer_mapping = _mapping()
    loop._peer_shutting_down = True

    task = asyncio.create_task(loop._peer_renew_loop())
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass

    assert calls["n"] == 0


# --- Phase 3.5 Task 6: model_fetch jobs --------------------------------------


def _model_fetch_job_message(job_id: str, fetch_models=None) -> dict:
    """A `kind: "model_fetch"` push: the workflow_json is a placeholder `{}`
    the agent must never run (the server sends it only because the frame
    shape requires the field)."""
    message = {
        "job_id": job_id,
        "workflow_json": "{}",
        "input_assets": [],
        "kind": "model_fetch",
    }
    if fetch_models is not None:
        message["fetch_models"] = fetch_models
    return message


async def test_model_fetch_job_skips_workflow_and_reports_fetched_models(
    two_platform_loop, monkeypatch
):
    loop = two_platform_loop
    loop.config.auto_fetch_models = True
    loop.config.models_dir = "/fake/models"
    conn_a = loop.connections["worker-a"]

    ran = []
    monkeypatch.setattr(comfy, "run_workflow", lambda *a, **k: ran.append(1))
    monkeypatch.setattr(hardware, "scan_models", lambda *a, **k: [{"name": "vae/ae.safetensors", "size": 0.1}])

    fetched = [
        {"name": "ae.safetensors", "directory": "vae", "size_bytes": 5, "sha256": "ab" * 32}
    ]

    async def _fake_fetch(**kwargs):
        return fetched

    monkeypatch.setattr(runner_module.fetcher, "fetch_and_verify_models", _fake_fetch)

    def _must_not_check(*a, **k):
        raise AssertionError("whitelist.check must not run for a model_fetch job")

    monkeypatch.setattr(whitelist, "check", _must_not_check)

    await loop.handle_job(conn_a, _model_fetch_job_message("job-mf-1", [{"name": "ae.safetensors"}]))

    assert ran == []
    assert conn_a.job_done == ("job-mf-1", [], 0.0)
    assert conn_a.job_done_fetched_models == fetched
    assert conn_a.job_failed is None
    # The fetch phase still reports itself as such, so the server never
    # starts the (unbillable) run clock for this job.
    assert any(hb.get("stage") == "fetching_models" for hb in conn_a.heartbeats)
    assert conn_a.heartbeats[-1]["state"] == "idle"


async def test_model_fetch_job_without_fetch_models_is_done_immediately(
    two_platform_loop, monkeypatch
):
    """The worker already had the model (the platform found it `eligible`,
    so the push carries no `fetch_models`) -- still a completed model_fetch
    job, just with nothing learned."""
    loop = two_platform_loop
    loop.config.models_dir = "/fake/models"
    conn_a = loop.connections["worker-a"]

    def _must_not_fetch(**kwargs):
        raise AssertionError("fetch_and_verify_models must not be called without fetch_models")

    def _must_not_run(*a, **k):
        raise AssertionError("run_workflow must not be called for a model_fetch job")

    monkeypatch.setattr(runner_module.fetcher, "fetch_and_verify_models", _must_not_fetch)
    monkeypatch.setattr(comfy, "run_workflow", _must_not_run)
    monkeypatch.setattr(hardware, "scan_models", lambda *a, **k: [])

    await loop.handle_job(conn_a, _model_fetch_job_message("job-mf-2"))

    assert conn_a.job_done == ("job-mf-2", [], 0.0)
    assert conn_a.job_done_fetched_models == []
    assert conn_a.job_failed is None


async def test_model_fetch_job_fetch_failure_still_reports_job_failed(
    two_platform_loop, monkeypatch
):
    """A model_fetch job's fetch failure is reported exactly like any other
    fetch failure -- the zh-TW-first FetchError message, verbatim."""
    loop = two_platform_loop
    loop.config.auto_fetch_models = True
    conn_a = loop.connections["worker-a"]

    async def _fake_fetch(**kwargs):
        raise fetcher.FetchError("模型 ae.safetensors 下載失敗 / failed to download")

    monkeypatch.setattr(runner_module.fetcher, "fetch_and_verify_models", _fake_fetch)

    await loop.handle_job(conn_a, _model_fetch_job_message("job-mf-3", [{"name": "ae.safetensors"}]))

    assert conn_a.job_done is None
    assert conn_a.job_failed == (
        "job-mf-3",
        "模型 ae.safetensors 下載失敗 / failed to download",
        None,
    )


async def test_ordinary_job_done_carries_no_fetched_models_key():
    """`fetched_models` is omitted entirely from an ordinary job_done, so an
    older server's message shape is unchanged."""
    entry = PlatformEntry(
        platform_url="http://p",
        platform_pubkey="aa",
        worker_id="w1",
        certificate="cert",
        signing_key_hex="00" * 32,
    )
    conn = PlatformConnection(entry, AgentConfig())
    conn.ws = _RecordingWS()

    await conn.send_job_done("j1", ["a.png"], 1.5)
    payload = json.loads(conn.ws.sent[0])
    assert payload["type"] == "job_done"
    assert "fetched_models" not in payload

    await conn.send_job_done("j2", [], 0.0, fetched_models=[{"name": "ae.safetensors"}])
    payload = json.loads(conn.ws.sent[1])
    assert payload["fetched_models"] == [{"name": "ae.safetensors"}]
