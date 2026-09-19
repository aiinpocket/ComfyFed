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
    r = server.post("/api/auth/login", json={"username": "admin", "password": server.admin_password})
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


# --- 2026-09-19 job-retry：失敗改派＋不適任紀錄 e2e --------------------------

# 策展模型（`model_guide.SOURCES`）：有 official_url、有 operator 背書的
# sha256／size_bytes，所以就算一顆學習到的雜湊都沒有，`model_manifest.entries`
# 也會為它生出一條可抓的 manifest 列 -- B 之所以能 `eligible_after_fetch` 的
# 前提。A 的 inventory 回報同一組 sha256／size_bytes，順便讓 manifest 學到
# （`_record_model_hashes`），兩條路徑在這個 e2e 裡同時成立。
UPSCALE_MODEL = "RealESRGAN_x4plus.pth"
UPSCALE_SHA256 = "4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1"
UPSCALE_SIZE_BYTES = 67040989

UPSCALE_WORKFLOW = {
    "1": {"class_type": "LoadImage", "inputs": {"image": "ref.png"}},
    "2": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": UPSCALE_MODEL}},
    "3": {
        "class_type": "ImageUpscaleWithModel",
        "inputs": {"upscale_model": ["2", 0], "image": ["1", 0]},
    },
    "4": {"class_type": "SaveImage", "inputs": {"images": ["3", 0]}},
}
UPSCALE_NODE_CLASSES = [
    "ImageUpscaleWithModel",
    "LoadImage",
    "SaveImage",
    "UpscaleModelLoader",
]


def _register_agent(server, csrf, name: str, tmp_path):
    """Issue a worker bundle and run the real agent-side registration."""
    r = server.post("/api/workers/tokens", json={"name": name}, headers={"X-CSRF": csrf})
    assert r.status_code == 200
    entry = identity.register(
        r.json()["bundle"], name, str(tmp_path / name / "config.json"), server
    )
    return entry, SigningKey(bytes.fromhex(entry.signing_key_hex))


def _handshake(ws, entry, sk) -> None:
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


def _hello(ws) -> None:
    """protocol 5 + auto_fetch：`eligible_after_fetch` 的入場條件。"""
    ws.send_json(
        {
            "type": "hello",
            "hardware": {"vram_gb": 24.0, "gpu_name": "Mock GPU", "max_fetch_gb": 30},
            "backend": "cuda",
            "torch_version": "2.4.0",
            "node_classes": UPSCALE_NODE_CLASSES,
            "protocol": 5,
            "auto_fetch": True,
        }
    )


def _beat(ws, state: str = "idle") -> None:
    ws.send_json(
        {
            "type": "heartbeat",
            "state": state,
            "progress": 0.0,
            "job_id": None,
            "dynamic": {"free_vram_gb": 20.0, "free_disk_gb": 100.0},
        }
    )


def _job_snapshot(job_id):
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        return {
            "status": job.status,
            "worker_id": job.worker_id,
            "attempts": json.loads(job.attempts or "{}"),
            "retry_count": job.retry_count,
            "signature": job.signature,
            "error": job.error,
        }


def test_failed_job_is_retried_then_dispatched_to_a_fetching_worker(server, mock_comfy, tmp_path):
    """2026-09-19 §9 e2e：A 連兩次跑爛 -> 平台不再派給 A，改派給沒有模型但
    開了 auto_fetch 的 B（push 帶 `fetch_models`），B 跑完 job 就 done。

    釘的是整條使用者可見的路徑，不是單一函式：requeue（而非終局失敗）、每
    次失敗照樣一張非計費收據、A 被記成對這「類」任務不適任、B 完全沒有紀
    錄，以及管理員在 Workers 頁按下「清除」時走的那支 DELETE。
    """
    mock_client, _mock_state = mock_comfy
    csrf = _login(server)

    entry_a, sk_a = _register_agent(server, csrf, "worker-a", tmp_path)
    entry_b, sk_b = _register_agent(server, csrf, "worker-b", tmp_path)

    with server.websocket_connect("/api/agent/ws") as ws_a:
        _handshake(ws_a, entry_a, sk_a)
        _hello(ws_a)
        _beat(ws_a)
        # A 有模型（帶 sha256／size_bytes，manifest 因此學到這顆的雜湊）。
        ws_a.send_json(
            {
                "type": "inventory",
                "models": [
                    {
                        "name": f"upscale_models/{UPSCALE_MODEL}",
                        "size": round(UPSCALE_SIZE_BYTES / (1024 ** 3), 3),
                        "size_bytes": UPSCALE_SIZE_BYTES,
                        "sha256": UPSCALE_SHA256,
                    }
                ],
            }
        )

        with server.websocket_connect("/api/agent/ws") as ws_b:
            _handshake(ws_b, entry_b, sk_b)
            _hello(ws_b)
            # B 沒有任何模型。先 `paused`：平台看得到它（`any_possible_worker`
            # 因此找得到「還有台跑得動」），但派工只挑 idle 連線，所以 A 出局
            # 之前這張 job 不會被 B 搶走。
            _beat(ws_b, state="paused")
            ws_b.send_json({"type": "inventory", "models": []})

            # 1. 送一張需要那顆模型的 console job（A 有模型，提交閘門放行）。
            submit = server.post(
                "/api/jobs",
                data={"workflow_json": json.dumps(UPSCALE_WORKFLOW)},
                files=[("assets", ("ref.png", BytesIO(b"input-image-bytes"), "image/png"))],
                headers={"X-CSRF": csrf},
            )
            assert submit.status_code == 200, submit.text
            job_id = submit.json()["job_id"]

            # 2. A 連兩次失敗。第一次之後 A 還有資格，所以它自己又接到同一張。
            for attempt in (1, 2):
                _beat(ws_a)
                agentws.dispatch_once(entry_a.worker_id)
                job_msg = ws_a.receive_json()
                assert job_msg["type"] == "job"
                assert job_msg["job_id"] == job_id
                # A 自己就有模型 -> 直接 eligible，push 不帶 fetch_models。
                assert "fetch_models" not in job_msg

                ws_a.send_json(
                    {"type": "job_failed", "job_id": job_id, "error": f"CUDA boom {attempt}"}
                )
                agentws.dispatch_once(entry_a.worker_id)
                failure_receipt = ws_a.receive_json()
                assert failure_receipt["type"] == "receipt"

                snapshot = _job_snapshot(job_id)
                assert snapshot["status"] == "queued", f"attempt {attempt} must not be terminal"
                assert snapshot["worker_id"] is None
                assert snapshot["attempts"] == {entry_a.worker_id: attempt}
                assert snapshot["retry_count"] == attempt
                assert snapshot["error"] == f"CUDA boom {attempt}"

            with db.get_session() as session:
                receipts = session.query(db.Receipt).all()
                assert len(receipts) == 2
                assert all((r.kind, r.billable) == ("failed", False) for r in receipts)

            # 3. A 現在對這張 job 出局。A 仍然 idle 且連著線，下一輪只能給 B --
            #    而 B 沒有模型，所以 push 必須帶 fetch_models。
            _beat(ws_a)
            _beat(ws_b)
            agentws.dispatch_once(entry_b.worker_id)

            job_msg = ws_b.receive_json()
            assert job_msg["type"] == "job"
            assert job_msg["job_id"] == job_id
            assert _job_snapshot(job_id)["worker_id"] == entry_b.worker_id

            fetch_entries = job_msg["fetch_models"]
            assert [e["name"] for e in fetch_entries] == [UPSCALE_MODEL]
            fetch_entry = fetch_entries[0]
            assert fetch_entry["directory"] == "upscale_models"
            assert fetch_entry["sha256"] == UPSCALE_SHA256
            assert fetch_entry["size_bytes"] == UPSCALE_SIZE_BYTES
            assert fetch_entry["url"]
            assert fetch_entry["sig"]

            # 4. B 下載完模型（這裡不真的抓檔），照常跑完整條 agent 流程。
            dispatch.mark_running(job_id, entry_b.worker_id)
            workflow = json.loads(job_msg["workflow_json"])

            input_path = f"/api/agent/jobs/{job_id}/inputs/ref.png"
            input_resp = _sign_and_send(server, entry_b, "GET", input_path)
            assert input_resp.status_code == 200
            comfy.upload_input("http://mockcomfy", "ref.png", input_resp.content, client=mock_client)

            results, exec_seconds = comfy.run_workflow(
                "http://mockcomfy", workflow, client=mock_client
            )
            filename, content, _subfolder = results[0]

            artifact_path = f"/api/agent/jobs/{job_id}/artifacts"
            prebuilt = httpx.Request(
                "POST",
                f"http://testserver{artifact_path}",
                files={"file": (filename, content, "application/octet-stream")},
            )
            body = prebuilt.read()
            sig_headers = signing.signed_headers(entry_b, "POST", artifact_path, body)
            artifact_resp = server.post(
                artifact_path,
                content=body,
                headers={**sig_headers, "Content-Type": prebuilt.headers["content-type"]},
            )
            assert artifact_resp.status_code == 200

            ws_b.send_json(
                {
                    "type": "job_done",
                    "job_id": job_id,
                    "result_files": [filename],
                    "exec_seconds": exec_seconds,
                }
            )
            receipt_msg = ws_b.receive_json()
            assert receipt_msg["type"] == "receipt"
            ws_b.send_json(
                {
                    "type": "receipt_ack",
                    "receipt_id": receipt_msg["receipt_id"],
                    "worker_sig": sk_b.sign(receipt_msg["payload"].encode()).signature.hex(),
                }
            )
            agentws.dispatch_once(entry_b.worker_id)

    # --- Assertions -----------------------------------------------------

    snapshot = _job_snapshot(job_id)
    assert snapshot["status"] == "done"
    assert snapshot["attempts"] == {entry_a.worker_id: 2}
    assert snapshot["retry_count"] == 2
    task_key = snapshot["signature"]
    assert task_key

    detail = server.get(f"/api/jobs/{job_id}", headers={"X-CSRF": csrf}).json()
    assert detail["attempts"] == {entry_a.worker_id: 2}
    assert detail["retry_count"] == 2
    assert detail["result_files"] == [filename]

    # A 對這「類」任務被記成不適任（active，7 天內同類 job 不會再派給它）；
    # B 跑成功，一列都沒有。
    rows = {w["id"]: w for w in server.get("/api/workers", headers={"X-CSRF": csrf}).json()}
    a_unsuitable = rows[entry_a.worker_id]["unsuitable"]
    assert len(a_unsuitable) == 1
    assert a_unsuitable[0]["task_key"] == task_key
    assert a_unsuitable[0]["failures"] == 2
    assert a_unsuitable[0]["active"] is True
    assert a_unsuitable[0]["last_job_id"] == job_id
    assert "CUDA boom 2" in (a_unsuitable[0]["last_error"] or "")
    assert rows[entry_b.worker_id]["unsuitable"] == []

    # 管理員在 Workers 頁按「清除」：那一列消失。
    cleared = server.request(
        "DELETE",
        f"/api/workers/{entry_a.worker_id}/unsuitable/{task_key}",
        headers={"X-CSRF": csrf},
    )
    assert cleared.status_code == 200
    assert cleared.json() == {"cleared": 1}

    rows = {w["id"]: w for w in server.get("/api/workers", headers={"X-CSRF": csrf}).json()}
    assert rows[entry_a.worker_id]["unsuitable"] == []
