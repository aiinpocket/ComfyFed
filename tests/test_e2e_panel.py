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
from comfyfed_server import bootstrap, comfy_frontend, comfyapi, db, dispatch

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
    r = server.post("/api/auth/login", json={"password": server.admin_password})
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
