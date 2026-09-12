"""End-to-end smoke test: the full platform+agent protocol loop in one process.

This does NOT run the real `AgentLoop` (agent/comfyfed_agent/runner.py) — that
loop's internals are covered by Task 11's tests. Instead it drives the
*protocol* directly using the same building blocks the loop uses
(identity.register, signing.signed_headers, comfy.py's HTTP calls) against a
real `create_app` server and a small mock ComfyUI FastAPI app, to prove the
server-side pipeline and wire protocol work end to end:

  admin login -> issue worker token -> agent register -> WS handshake ->
  hello/heartbeat -> submit job -> dispatch push over WS -> agent downloads
  input asset -> runs workflow against (mock) ComfyUI -> uploads artifact ->
  reports job_done -> receives platform-signed receipt -> counter-signs it ->
  contributions report and job detail reflect the completed job.
"""

from __future__ import annotations

import json
import os
import uuid
from io import BytesIO

import httpx
import pytest
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import Response
from fastapi.testclient import TestClient
from nacl.signing import SigningKey

from comfyfed_agent import comfy, identity, signing
from comfyfed_server import agentws, app as app_module
from comfyfed_server import bootstrap, db, dispatch, security

WORKFLOW = {
    "1": {"class_type": "LoadImage", "inputs": {"image": "ref.png"}},
    "2": {"class_type": "KSampler", "inputs": {"image": ["1", 0], "seed": 1}},
}


def _mock_comfy_app() -> tuple[FastAPI, dict]:
    """A minimal ComfyUI stand-in: object_info, prompt submission, polling, view, upload."""
    app = FastAPI()
    state = {"prompts": {}, "uploads": {}}

    @app.get("/object_info")
    def object_info():
        return {"KSampler": {"input": {}}, "LoadImage": {"input": {}}}

    @app.post("/prompt")
    async def submit_prompt(request: Request):
        body = await request.json()
        prompt_id = str(uuid.uuid4())
        state["prompts"][prompt_id] = {"workflow": body.get("prompt"), "polls": 0}
        return {"prompt_id": prompt_id}

    @app.get("/history/{prompt_id}")
    def history(prompt_id: str):
        entry = state["prompts"].get(prompt_id)
        if entry is None:
            return {}
        entry["polls"] += 1
        # First poll finds nothing yet, so comfy.run_workflow's poll loop is
        # actually exercised; second+ poll reports completion.
        if entry["polls"] < 2:
            return {}
        return {
            prompt_id: {
                "status": {"status_str": "success"},
                "outputs": {
                    "9": {"images": [{"filename": "out.png", "subfolder": "", "type": "output"}]}
                },
            }
        }

    @app.get("/view")
    def view(filename: str, subfolder: str = "", type: str = "output"):
        return Response(content=b"FAKE-PNG-BYTES", media_type="image/png")

    @app.post("/upload/image")
    async def upload_image(image: UploadFile = File(...), overwrite: str = Form("false")):
        content = await image.read()
        state["uploads"][image.filename] = content
        return {"name": image.filename}

    return app, state


@pytest.fixture()
def server(tmp_path):
    data_dir = str(tmp_path / "server")
    result = bootstrap.ensure_installed(data_dir, lang="en", url="http://testserver", interactive=False)
    app = app_module.create_app(data_dir)
    client = TestClient(app)
    client.admin_password = result.admin_password
    client.data_dir = data_dir
    return client


@pytest.fixture()
def mock_comfy():
    app, state = _mock_comfy_app()
    client = TestClient(app)
    return client, state


def _login(server) -> str:
    r = server.post("/api/auth/login", json={"password": server.admin_password})
    assert r.status_code == 200
    return r.json()["csrf"]


def _sign_and_send(server, entry, method: str, path: str, body: bytes = b"", headers: dict | None = None):
    signed = signing.signed_headers(entry, method, path, body)
    if headers:
        signed = {**signed, **headers}
    if method.upper() == "GET":
        return server.get(path, headers=signed)
    return server.request(method, path, content=body, headers=signed)


def test_full_job_lifecycle_over_the_wire(server, mock_comfy, tmp_path):
    mock_client, _mock_state = mock_comfy

    # 1. Admin logs in and issues a worker registration bundle.
    csrf = _login(server)
    r = server.post("/api/workers/tokens", json={"name": "worker-1"}, headers={"X-CSRF": csrf})
    assert r.status_code == 200
    bundle = r.json()["bundle"]

    # 2. Agent registers with the platform, pinning its certificate.
    cfg_path = str(tmp_path / "agent" / "config.json")
    entry = identity.register(bundle, "worker-1", cfg_path, server)
    sk = SigningKey(bytes.fromhex(entry.signing_key_hex))

    # 3. Agent inspects (mock) ComfyUI's installed node classes.
    object_info = comfy.get_object_info("http://mockcomfy", client=mock_client)
    node_classes = sorted(object_info.keys())
    assert {"KSampler", "LoadImage"} <= set(node_classes)

    # 4. Open the authenticated agent WebSocket: challenge/response handshake,
    #    then hello + an idle heartbeat.
    with server.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        assert challenge["type"] == "challenge"
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": entry.worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json(
            {
                "type": "hello",
                "hardware": {"vram_gb": 24.0, "gpu_name": "Mock GPU"},
                "backend": "cuda",
                "torch_version": "2.4.0",
                "node_classes": node_classes,
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

        # 5. Submit a job with an input asset via the admin API.
        files = [("assets", ("ref.png", BytesIO(b"input-image-bytes"), "image/png"))]
        submit = server.post(
            "/api/jobs",
            data={"workflow_json": json.dumps(WORKFLOW)},
            files=files,
            headers={"X-CSRF": csrf},
        )
        assert submit.status_code == 200
        job_id = submit.json()["job_id"]

        # 6. Trigger dispatch: the idle worker gets the job pushed over WS.
        agentws.dispatch_once(entry.worker_id)
        job_msg = ws.receive_json()
        assert job_msg["type"] == "job"
        assert job_msg["job_id"] == job_id
        assert job_msg["input_assets"] == ["ref.png"]
        workflow = json.loads(job_msg["workflow_json"])

        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            assert job.status == "assigned"

        dispatch.mark_running(job_id, entry.worker_id)

        # 7. Agent-side: download the input asset via a signed GET...
        input_path = f"/api/agent/jobs/{job_id}/inputs/ref.png"
        input_resp = _sign_and_send(server, entry, "GET", input_path)
        assert input_resp.status_code == 200
        assert input_resp.content == b"input-image-bytes"

        # ...upload it into (mock) ComfyUI...
        comfy.upload_input("http://mockcomfy", "ref.png", input_resp.content, client=mock_client)
        assert _mock_state["uploads"]["ref.png"] == b"input-image-bytes"

        # ...run the workflow against (mock) ComfyUI...
        results, exec_seconds = comfy.run_workflow("http://mockcomfy", workflow, client=mock_client)
        assert results == [("out.png", b"FAKE-PNG-BYTES", "")]
        # The mock ComfyUI has no /queue endpoint, so the prompt was never
        # observed under queue_running -- exec_seconds falls back to the span
        # since the local /prompt POST, which still excludes federation
        # dispatch and input download. (The server's own wall-clock fallback,
        # for a genuinely absent exec_seconds, is covered by test_agent_ws.py.)
        assert exec_seconds is not None and exec_seconds >= 0

        # ...upload the resulting artifact back to the platform via a signed
        # multipart POST. The multipart body must be frozen to concrete bytes
        # *before* signing (httpx.Request(...).read()), since the signature
        # covers exactly what the server will read from request.body() — and
        # signing goes through the real agent-side `signing.signed_headers`,
        # the same code path a real agent uses, so a future wire-format
        # change there breaks this test instead of a hand-rolled duplicate.
        filename, content, _subfolder = results[0]
        artifact_path = f"/api/agent/jobs/{job_id}/artifacts"
        prebuilt = httpx.Request(
            "POST",
            f"http://testserver{artifact_path}",
            files={"file": (filename, content, "application/octet-stream")},
        )
        body = prebuilt.read()
        sig_headers = signing.signed_headers(entry, "POST", artifact_path, body)
        artifact_resp = server.post(
            artifact_path,
            content=body,
            headers={**sig_headers, "Content-Type": prebuilt.headers["content-type"]},
        )
        assert artifact_resp.status_code == 200
        assert artifact_resp.json()["stored"] == filename

        # ...and finally reports job_done over the WebSocket.
        ws.send_json(
            {
                "type": "job_done",
                "job_id": job_id,
                "result_files": [filename],
                "exec_seconds": exec_seconds,
            }
        )

        # The server immediately pushes back a platform-signed receipt.
        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"
        receipt_id = receipt_msg["receipt_id"]
        payload = receipt_msg["payload"]

        # 8. Agent counter-signs the receipt and sends the ack.
        worker_sig = sk.sign(payload.encode()).signature.hex()
        ws.send_json({"type": "receipt_ack", "receipt_id": receipt_id, "worker_sig": worker_sig})

        agentws.dispatch_once(entry.worker_id)

    # --- Assertions -----------------------------------------------------

    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        assert job.status == "done"
        assert json.loads(job.result_files) == [filename]

        receipt = session.get(db.Receipt, receipt_id)
        assert receipt is not None
        assert receipt.worker_sig == worker_sig
        assert receipt.platform_sig

        _, platform_verify_key = security.load_platform_keys(server.data_dir)
        platform_verify_key.verify(payload.encode(), bytes.fromhex(receipt.platform_sig))
        sk.verify_key.verify(payload.encode(), bytes.fromhex(worker_sig))

    artifact_file = os.path.join(server.data_dir, "artifacts", job_id, filename)
    assert os.path.isfile(artifact_file)
    with open(artifact_file, "rb") as f:
        assert f.read() == content

    report = server.get("/api/reports/contributions", headers={"X-CSRF": csrf})
    assert report.status_code == 200
    rows = report.json()
    worker_row = next(row for row in rows if row["worker_id"] == entry.worker_id)
    assert worker_row["jobs"] == 1
    assert worker_row["gpu_seconds"] >= 0

    detail = server.get(f"/api/jobs/{job_id}", headers={"X-CSRF": csrf})
    assert detail.status_code == 200
    assert detail.json()["result_files"] == [filename]
