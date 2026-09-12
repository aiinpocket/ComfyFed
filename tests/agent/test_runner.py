import hashlib
import json
import os

import httpx
import pytest

from comfyfed_agent import comfy, hardware, whitelist
from comfyfed_agent.config import AgentConfig, PlatformEntry
from comfyfed_agent.runner import AgentLoop, _is_safe_relative_path, cleanup_job_files
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
        self.job_failed = None
        self.object_info_hash = ""
        self.object_info_uploads: list[tuple[bytes, str]] = []

    async def send_heartbeat(self, state, progress=0.0, job_id=None, dynamic=None, object_info_hash=None):
        self.state = state
        self.heartbeats.append(
            {"state": state, "progress": progress, "job_id": job_id, "object_info_hash": object_info_hash}
        )

    async def send_job_done(self, job_id, result_files, exec_seconds=None):
        self.job_done = (job_id, result_files, exec_seconds)

    async def send_job_failed(self, job_id, error):
        self.job_failed = (job_id, error)

    async def send_object_info(self, gzip_payload, oi_hash):
        self.object_info_uploads.append((gzip_payload, oi_hash))


def _entry(worker_id: str) -> PlatformEntry:
    return PlatformEntry(
        platform_url="http://platform.example",
        platform_pubkey="pp",
        worker_id=worker_id,
        certificate="cert",
        signing_key_hex="11" * 32,
    )


@pytest.fixture()
def two_platform_loop(monkeypatch):
    monkeypatch.setattr(whitelist, "allowed_classes", lambda *a, **k: {"KSampler"})
    monkeypatch.setattr(whitelist, "check", lambda *a, **k: None)
    monkeypatch.setattr(comfy, "run_workflow", lambda *a, **k: ([], None))
    monkeypatch.setattr(hardware, "collect_dynamic", lambda *a, **k: {})

    config = AgentConfig(platforms=[_entry("worker-a"), _entry("worker-b")])
    return AgentLoop(config, "unused-config.json", connection_factory=FakeConnection)


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

    assert conn_a.job_failed == ("job-2", "kaboom")
    assert conn_a.heartbeats[-1]["state"] == "idle"


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


async def test_broadcast_heartbeat_carries_each_connections_object_info_hash(two_platform_loop):
    loop = two_platform_loop
    conn_a = loop.connections["worker-a"]
    conn_a.object_info_hash = "deadbeef"

    await loop.broadcast_heartbeat("idle")

    assert conn_a.heartbeats[-1]["object_info_hash"] == "deadbeef"


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

    assert conn_a.job_failed == ("job-hash-fail", "artifact upload failed")


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
        success=True,
        comfy_output_dir=str(output_dir),
        comfy_input_dir=str(input_dir),
        output_files=[{"filename": "result.png", "subfolder": "sub"}],
        input_filenames=["ref.png"],
    )

    assert not out_file.exists()
    assert not in_file.exists()


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
        success=False,
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
        success=True,
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
        success=True,
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
        success=True,
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
        success=True,
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
