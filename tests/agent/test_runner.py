import json

import pytest

from comfyfed_agent import comfy, hardware, whitelist
from comfyfed_agent.config import AgentConfig, PlatformEntry
from comfyfed_agent.runner import AgentLoop

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

    async def send_heartbeat(self, state, progress=0.0, job_id=None, dynamic=None):
        self.state = state
        self.heartbeats.append({"state": state, "progress": progress, "job_id": job_id})

    async def send_job_done(self, job_id, result_files):
        self.job_done = (job_id, result_files)

    async def send_job_failed(self, job_id, error):
        self.job_failed = (job_id, error)


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
    monkeypatch.setattr(comfy, "run_workflow", lambda *a, **k: [])
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

    assert conn_a.job_done == ("job-1", [])

    busy_on_b = [hb for hb in conn_b.heartbeats if hb["state"] == "busy"]
    assert busy_on_b, "platform B should see a busy heartbeat while platform A dispatched the job"
    assert busy_on_b[0]["job_id"] == "job-1"

    # Both platforms should end up idle again once the job completes.
    assert conn_a.heartbeats[-1]["state"] == "idle"
    assert conn_b.heartbeats[-1]["state"] == "idle"


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
        return []

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
