"""End-to-end smoke test for the embedded ComfyUI panel.

Same shape as `tests/test_e2e.py` -- a real `create_app` server driven through
the actual wire protocol -- but from the *panel's* point of view instead of
the console's: everything a browser running the stock ComfyUI frontend at
`/comfy/` would do, in order.

  worker registers + connects -> uploads its full object_info ->
  GET /comfy/api/object_info shows its nodes ->
  POST /comfy/api/upload/image stages an input ->
  POST /comfy/api/prompt (a workflow whose LoadImage references it) ->
  dispatch pushes the job over the agent WS (with the staged file copied into
  the job's inputs) -> worker uploads an artifact and reports job_done ->
  GET /comfy/api/history/{prompt_id} lists the output ->
  GET /comfy/api/view returns its bytes.

Plus the serving/authorisation half of `/comfy` itself: no session redirects
to the console login, a session with no fetched bundle gets the
`fetch-comfy-ui` notice, and a populated `data/comfy_frontend/` is served.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
from io import BytesIO

import httpx
import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey

from comfyfed_agent import signing
from comfyfed_agent.config import PlatformEntry
from comfyfed_server import agentws, app as app_module
from comfyfed_server import (
    bootstrap,
    comfy_frontend,
    comfyapi,
    db,
    dispatch,
    model_fetch,
    security,
)

# Deliberately API-format ComfyUI JSON, as the panel's "Queue" button sends:
# a LoadImage referencing a staged upload, and a SaveImage whose node id keys
# the history `outputs` entry.
PANEL_WORKFLOW = {
    "1": {"class_type": "LoadImage", "inputs": {"image": "panel-ref.png"}},
    "2": {"class_type": "KSampler", "inputs": {"image": ["1", 0], "seed": 7}},
    "9": {"class_type": "SaveImage", "inputs": {"images": ["2", 0]}},
}

OBJECT_INFO = {
    "LoadImage": {"input": {"required": {}}, "category": "image"},
    "KSampler": {"input": {"required": {}}, "category": "sampling"},
    "SaveImage": {"input": {"required": {}}, "category": "image"},
}

ARTIFACT_NAME = "panel-out.png"
ARTIFACT_BYTES = b"PANEL-FAKE-PNG"


def _make_server(tmp_path, name="server") -> TestClient:
    comfyapi.clear_object_info_cache()
    data_dir = str(tmp_path / name)
    result = bootstrap.ensure_installed(data_dir, lang="en", url="http://testserver", interactive=False)
    client = TestClient(app_module.create_app(data_dir))
    client.admin_password = result.admin_password
    client.data_dir = data_dir
    return client


@pytest.fixture()
def server(tmp_path):
    return _make_server(tmp_path)


def _login(server) -> str:
    r = server.post("/api/auth/login", json={"username": "admin", "password": server.admin_password})
    assert r.status_code == 200
    return r.json()["csrf"]


def _register_worker(server, csrf, name="panel-worker") -> PlatformEntry:
    r = server.post("/api/workers/tokens", json={"name": name}, headers={"X-CSRF": csrf})
    assert r.status_code == 200
    token = r.json()["bundle"]["register_token"]

    signing_key = SigningKey.generate()
    reg = server.post(
        "/api/agent/register",
        json={"token": token, "name": name, "pubkey": bytes(signing_key.verify_key).hex()},
    )
    assert reg.status_code == 200
    body = reg.json()
    return PlatformEntry(
        platform_url="http://testserver",
        platform_pubkey="",
        worker_id=body["worker_id"],
        certificate=body["certificate"],
        signing_key_hex=bytes(signing_key).hex(),
    )


def _upload_object_info(server, entry: PlatformEntry, payload: dict) -> None:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    gz = gzip.compress(raw)
    headers = signing.signed_headers(entry, "POST", "/api/agent/object_info", gz)
    headers["X-OI-Hash"] = hashlib.sha256(raw).hexdigest()
    headers["Content-Encoding"] = "gzip"
    r = server.post("/api/agent/object_info", headers=headers, content=gz)
    assert r.status_code == 200, r.text


def test_panel_drives_a_job_end_to_end(server, tmp_path):
    csrf = _login(server)
    entry = _register_worker(server, csrf)
    sk = SigningKey(bytes.fromhex(entry.signing_key_hex))

    # The agent reports its full node catalogue ahead of connecting; the panel
    # only sees it once the worker is actually online (below).
    _upload_object_info(server, entry, OBJECT_INFO)

    with server.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        assert challenge["type"] == "challenge"
        ws.send_json(
            {
                "type": "auth",
                "worker_id": entry.worker_id,
                "sig": sk.sign(challenge["nonce"].encode()).signature.hex(),
            }
        )
        assert ws.receive_json()["type"] == "ready"

        ws.send_json(
            {
                "type": "hello",
                "hardware": {"vram_gb": 24.0, "gpu_name": "Mock GPU"},
                "backend": "cuda",
                "torch_version": "2.4.0",
                "node_classes": sorted(OBJECT_INFO),
                "protocol": 2,
            }
        )
        ws.send_json(
            {
                "type": "heartbeat",
                "state": "idle",
                "progress": 0.0,
                "job_id": None,
                "dynamic": {"free_vram_gb": 20.0, "free_disk_gb": 100.0},
            }
        )

        # 1. The panel loads its node definitions: the union over online workers.
        info = server.get("/comfy/api/object_info")
        assert info.status_code == 200
        assert info.headers.get("X-ComfyFed-No-Workers") is None
        assert set(info.json()) == set(OBJECT_INFO)

        # 2. The LoadImage widget uploads the referenced image into staging.
        upload = server.post(
            "/comfy/api/upload/image",
            files={"image": ("panel-ref.png", BytesIO(b"panel-input-bytes"), "image/png")},
            data={"overwrite": "true"},
        )
        assert upload.status_code == 200
        assert upload.json() == {"name": "panel-ref.png", "subfolder": "", "type": "input"}

        # 3. "Queue" submits the workflow; prompt_id is the ComfyFed job id.
        queued = server.post(
            "/comfy/api/prompt",
            json={"prompt": PANEL_WORKFLOW, "client_id": "panel-e2e"},
        )
        assert queued.status_code == 200, queued.text
        prompt_id = queued.json()["prompt_id"]
        assert queued.json()["node_errors"] == {}

        pending = server.get("/comfy/api/queue")
        assert pending.status_code == 200
        assert any(entry_[1] == prompt_id for entry_ in pending.json()["queue_pending"])

        # 4. Dispatch pushes it to the idle worker, staged input and all.
        agentws.dispatch_once(entry.worker_id)
        job_msg = ws.receive_json()
        assert job_msg["type"] == "job"
        assert job_msg["job_id"] == prompt_id
        assert job_msg["input_assets"] == ["panel-ref.png"]

        input_path = f"/api/agent/jobs/{prompt_id}/inputs/panel-ref.png"
        input_resp = server.get(
            input_path, headers=signing.signed_headers(entry, "GET", input_path, b"")
        )
        assert input_resp.status_code == 200
        assert input_resp.content == b"panel-input-bytes"

        dispatch.mark_running(prompt_id, entry.worker_id)

        # 5. The worker finishes: artifact upload, then job_done.
        artifact_path = f"/api/agent/jobs/{prompt_id}/artifacts"
        prebuilt = httpx.Request(
            "POST",
            f"http://testserver{artifact_path}",
            files={"file": (ARTIFACT_NAME, ARTIFACT_BYTES, "application/octet-stream")},
        )
        body = prebuilt.read()
        artifact_resp = server.post(
            artifact_path,
            content=body,
            headers={
                **signing.signed_headers(entry, "POST", artifact_path, body),
                "Content-Type": prebuilt.headers["content-type"],
            },
        )
        assert artifact_resp.status_code == 200

        ws.send_json({"type": "job_done", "job_id": prompt_id, "result_files": [ARTIFACT_NAME]})
        assert ws.receive_json()["type"] == "receipt"

    with db.get_session() as session:
        assert session.get(db.Job, prompt_id).status == "done"

    # 6. The panel polls history and reads the output back through /view.
    history = server.get(f"/comfy/api/history/{prompt_id}")
    assert history.status_code == 200
    entry_body = history.json()[prompt_id]
    assert entry_body["status"]["completed"] is True
    # Keyed by the SaveImage node's id, which is what the frontend looks up.
    assert entry_body["outputs"]["9"]["images"] == [
        {"filename": ARTIFACT_NAME, "subfolder": prompt_id, "type": "output"}
    ]

    # The frontend round-trips `subfolder` straight out of history, which is
    # what scopes the lookup to this job.
    image = entry_body["outputs"]["9"]["images"][0]
    view = server.get(
        "/comfy/api/view",
        params={
            "filename": image["filename"],
            "type": image["type"],
            "subfolder": image["subfolder"],
        },
    )
    assert view.status_code == 200
    assert view.content == ARTIFACT_BYTES


# --------------------------------------------- panel "Download" -> model_fetch

# A name the platform has no curated/learned hash for, so the button takes the
# UNVERIFIED-source path (spec 2026-09-19 §6). `ae.safetensors` -- the spec's
# motivating example -- is one of the 11 curated models and would take the
# verified-manifest branch instead, which is not what this test is about.
FETCH_NAME = "zz_e2e_model.safetensors"
FETCH_DIR = "vae"
FETCH_URL = "https://huggingface.co/e2e/x/resolve/main/zz_e2e_model.safetensors"
FETCH_SIZE = 5
FETCH_SHA = "ab" * 32


def test_panel_download_button_dispatches_model_fetch_job(server, monkeypatch):
    """The panel's missing-model "Download" button, end to end (spec §12).

    POST /comfy/api/comfyfed/model-fetch -> a `kind=model_fetch` job -> the
    signed unverified-source entry reaches a real agent connection -> fetch
    progress is pollable -> `job_done` carrying `fetched_models` teaches the
    platform the sha256 and mints a NON-billable receipt, with the job never
    having started (there is no GPU time to bill).
    """
    csrf = _login(server)
    entry = _register_worker(server, csrf, name="fetch-worker")
    sk = SigningKey(bytes.fromhex(entry.signing_key_hex))

    # The button's HEAD probe (§5.1) -- the only outbound network call the
    # route makes; it pins `size_bytes` into the signed entry.
    monkeypatch.setattr(model_fetch, "head_size_bytes", lambda url, **kwargs: FETCH_SIZE)

    with server.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        assert challenge["type"] == "challenge"
        ws.send_json(
            {
                "type": "auth",
                "worker_id": entry.worker_id,
                "sig": sk.sign(challenge["nonce"].encode()).signature.hex(),
            }
        )
        assert ws.receive_json()["type"] == "ready"

        # protocol 5 (agent >= 0.1.14) is what makes this worker eligible to be
        # handed an unverified-source entry at all; `auto_fetch`/`max_fetch_gb`
        # ride the hello, free disk rides the heartbeat. Empty node list and
        # empty inventory: a model_fetch job needs no nodes, and the whole
        # point is that nobody in the federation has this model yet.
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"vram_gb": 24.0, "gpu_name": "Mock GPU"},
                "backend": "cuda",
                "torch_version": "2.4.0",
                "node_classes": [],
                "models": [],
                "protocol": 5,
                "auto_fetch": True,
                "max_fetch_gb": 30,
            }
        )
        ws.send_json(
            {
                "type": "heartbeat",
                "state": "idle",
                "progress": 0.0,
                "job_id": None,
                "dynamic": {"free_vram_gb": 20.0, "free_disk_gb": 100.0},
            }
        )
        # A dispatch tick doubles as this harness's "let the server drain the
        # frames I just sent": it runs on the connection's own event loop.
        agentws.dispatch_once(entry.worker_id)

        # 1. The button POSTs the missing model's name/directory/url.
        created = server.post(
            "/comfy/api/comfyfed/model-fetch",
            json={"name": FETCH_NAME, "directory": FETCH_DIR, "url": FETCH_URL},
        )
        assert created.status_code == 201, created.text
        assert created.json()["reused"] is False
        job_id = created.json()["job_id"]

        # 2. Dispatch pushes it as a model_fetch job carrying the signed entry.
        agentws.dispatch_once(entry.worker_id)
        job_msg = ws.receive_json()
        assert job_msg["type"] == "job"
        assert job_msg["job_id"] == job_id
        assert job_msg["kind"] == "model_fetch"
        assert job_msg["workflow_json"] == "{}"
        assert job_msg["input_assets"] == []

        fetch_models = job_msg["fetch_models"]
        assert [e["name"] for e in fetch_models] == [FETCH_NAME]
        pushed = fetch_models[0]
        assert pushed["unverified"] is True
        assert pushed["sha256"] is None
        assert pushed["url"] == FETCH_URL
        assert pushed["size_bytes"] == FETCH_SIZE

        # The agent's only trust root for an unverified entry: the platform
        # signed THIS url at THIS size (§6).
        _platform_sk, platform_vk = security.load_platform_keys(server.data_dir)
        platform_vk.verify(
            model_fetch.unverified_payload(
                FETCH_NAME, FETCH_DIR, FETCH_URL, FETCH_SIZE
            ).encode(),
            bytes.fromhex(pushed["sig"]),
        )

        # 3. Download progress: every heartbeat of the fetch phase carries the
        # stage, which is also what keeps the job out of the billing clock.
        ws.send_json(
            {
                "type": "heartbeat",
                "state": "busy",
                "progress": 0.0,
                "job_id": job_id,
                "dynamic": {"free_vram_gb": 20.0, "free_disk_gb": 100.0},
                "stage": "fetching_models",
                "fetch_pct": 50.0,
                "fetch_model": FETCH_NAME,
            }
        )
        agentws.dispatch_once(entry.worker_id)

        status = server.get(f"/comfy/api/comfyfed/model-fetch/{job_id}")
        assert status.status_code == 200, status.text
        body = status.json()
        assert body["stage"] == "fetching_models"
        assert body["fetch_pct"] == 50.0
        assert body["fetch_model"] == FETCH_NAME
        assert body["name"] == FETCH_NAME
        assert body["worker_id"] == entry.worker_id

        # 4. Done: no artifacts, no exec time, but the measured sha256.
        ws.send_json(
            {
                "type": "job_done",
                "job_id": job_id,
                "result_files": [],
                "exec_seconds": 0,
                "fetched_models": [
                    {
                        "name": FETCH_NAME,
                        "directory": FETCH_DIR,
                        "size_bytes": FETCH_SIZE,
                        "sha256": FETCH_SHA,
                    }
                ],
            }
        )
        assert ws.receive_json()["type"] == "receipt"

    final = server.get(f"/comfy/api/comfyfed/model-fetch/{job_id}").json()
    assert final["status"] == "done"
    assert final["error"] is None
    # The transient fetch-progress fields are cleared once the job ends.
    assert final["stage"] is None

    # 5. The console's job detail shows it as a download, not a run.
    detail = server.get(f"/api/jobs/{job_id}")
    assert detail.status_code == 200, detail.text
    detail_body = detail.json()
    assert detail_body["kind"] == "model_fetch"
    assert detail_body["fetch_entry"]["name"] == FETCH_NAME
    assert detail_body["fetch_entry"]["unverified"] is True
    # Never ran, so never billed: `started_at` is what a wall-clock basis
    # would have been measured from.
    assert detail_body["started_at"] is None

    receipt = detail_body["receipt"]
    assert receipt is not None
    assert receipt["kind"] == "model_fetch"
    assert receipt["billable"] is False
    assert receipt["basis"] == "model_fetch"
    assert receipt["gpu_seconds"] == 0

    # 6. And the platform has learned what the file actually is, so the next
    # worker fetches it as a verified (content-addressed) entry.
    with db.get_session() as session:
        row = session.get(db.ModelHash, (FETCH_NAME, FETCH_SIZE))
        assert row is not None
        assert row.sha256 == FETCH_SHA
        assert row.conflict is False


# --------------------------------------------------------------- /comfy gate


def test_panel_without_session_redirects_to_console(server):
    r = server.get("/comfy", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == "/"

    r = server.get("/comfy/assets/index.js", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == "/"


def test_panel_root_redirects_to_trailing_slash_for_the_api_base(server):
    """`/comfy` -> `/comfy/`: the frontend derives its API base from the last
    path segment, so without the slash it would call `/api/...` instead of
    `/comfy/api/...`."""
    _login(server)
    r = server.get("/comfy", follow_redirects=False)
    assert r.status_code == 307
    assert r.headers["location"] == "/comfy/"


def test_panel_notice_page_when_frontend_not_fetched(server):
    _login(server)
    assert not comfy_frontend.is_populated(server.data_dir)

    r = server.get("/comfy")
    assert r.status_code == 200
    assert "fetch-comfy-ui" in r.text
    assert "工作流編輯器尚未安裝" in r.text


def test_panel_serves_the_fetched_bundle(tmp_path):
    data_dir = tmp_path / "with-frontend"
    static = data_dir / "comfy_frontend"
    static.mkdir(parents=True)
    (static / "index.html").write_text("<!doctype html><title>ComfyUI</title>", encoding="utf-8")
    (static / "assets").mkdir()
    (static / "assets" / "index.js").write_text("export const x = 1;\n", encoding="utf-8")

    server = _make_server(tmp_path, name="with-frontend")
    _login(server)

    r = server.get("/comfy/")
    assert r.status_code == 200
    assert "<title>ComfyUI</title>" in r.text

    r = server.get("/comfy/assets/index.js")
    assert r.status_code == 200
    assert "export const x" in r.text

    # A missing panel asset must stay a 404, not fall through to the console
    # SPA's index.html.
    r = server.get("/comfy/assets/nope.js")
    assert r.status_code == 404


def test_fetched_bundle_dir_is_where_the_cli_writes(tmp_path):
    """The mount and `fetch-comfy-ui` agree on one path (guards a rename)."""
    assert comfy_frontend.frontend_dir(str(tmp_path)) == os.path.join(str(tmp_path), "comfy_frontend")
