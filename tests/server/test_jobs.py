import io
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from comfyfed_server import app as app_module
from comfyfed_server import bootstrap, db, dispatch


@pytest.fixture()
def client(tmp_path):
    data_dir = str(tmp_path)
    result = bootstrap.ensure_installed(data_dir, lang="en", url="http://h", interactive=False)
    app = app_module.create_app(data_dir)
    c = TestClient(app)
    c.admin_password = result.admin_password
    c.data_dir = data_dir
    return c


def _login(client):
    r = client.post("/api/auth/login", json={"password": client.admin_password})
    assert r.status_code == 200
    return r.json()["csrf"]


def _register_worker(client, csrf, name, **kwargs):
    r = client.post("/api/workers/tokens", json={"name": name}, headers={"X-CSRF": csrf})
    token = r.json()["bundle"]["register_token"]
    reg = client.post("/api/agent/register", json={"token": token, "name": name, "pubkey": "ab" * 32})
    worker_id = reg.json()["worker_id"]

    if kwargs:
        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            for key, value in kwargs.items():
                setattr(worker, key, json.dumps(value) if isinstance(value, (dict, list)) else value)
            session.commit()

    return worker_id


SIMPLE_WORKFLOW = {
    "1": {
        "class_type": "KSampler",
        "inputs": {"seed": 1},
    },
}


def _submit(client, csrf, workflow=None, requirements=None, files=None):
    data = {"workflow_json": json.dumps(workflow if workflow is not None else SIMPLE_WORKFLOW)}
    if requirements is not None:
        data["requirements"] = json.dumps(requirements)
    return client.post(
        "/api/jobs",
        data=data,
        files=files or [],
        headers={"X-CSRF": csrf},
    )


def test_submit_job_creates_queued_job(client):
    csrf = _login(client)
    r = _submit(client, csrf)
    assert r.status_code == 200
    job_id = r.json()["job_id"]

    listed = client.get("/api/jobs", headers={"X-CSRF": csrf}).json()
    job = next(j for j in listed if j["id"] == job_id)
    assert job["status"] == "queued"


def test_submit_missing_assets_400(client):
    csrf = _login(client)
    workflow = {"1": {"class_type": "LoadImage", "inputs": {"image": "ref.png"}}}
    r = _submit(client, csrf, workflow=workflow)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "jobs.missing_assets"
    assert "ref.png" in r.json()["error"]["message"]


def test_submit_with_asset_upload_succeeds(client):
    csrf = _login(client)
    workflow = {"1": {"class_type": "LoadImage", "inputs": {"image": "ref.png"}}}
    files = [("assets", ("ref.png", io.BytesIO(b"fake-png-bytes"), "image/png"))]
    r = _submit(client, csrf, workflow=workflow, files=files)
    assert r.status_code == 200
    job_id = r.json()["job_id"]

    detail = client.get(f"/api/jobs/{job_id}", headers={"X-CSRF": csrf}).json()
    assert detail["input_assets"] == ["ref.png"]


def test_dispatch_pick_is_atomic_across_two_workers(client):
    csrf = _login(client)
    w1 = _register_worker(client, csrf, "w1")
    w2 = _register_worker(client, csrf, "w2")

    r1 = _submit(client, csrf)
    r2 = _submit(client, csrf)
    assert r1.status_code == 200 and r2.status_code == 200

    job_a = dispatch.pick_job_for(w1)
    job_b = dispatch.pick_job_for(w2)

    assert job_a is not None
    assert job_a.id != (job_b.id if job_b else None)
    # Only two jobs existed; a third pick should find nothing left.
    job_c = dispatch.pick_job_for(w1)
    assert job_c is None


def test_dispatch_pick_skips_ineligible_without_blocking_later_jobs(client):
    csrf = _login(client)
    # Worker knows no custom nodes for the exotic job, but IS connected
    # (nonempty node_classes), so the node check applies and it's ineligible.
    worker = _register_worker(client, csrf, "w1", node_classes=["KSampler", "CheckpointLoaderSimple"])

    exotic_workflow = {"1": {"class_type": "SomeExoticNode", "inputs": {}}}
    _submit(client, csrf, workflow=exotic_workflow)
    r2 = _submit(client, csrf)  # simple workflow the worker CAN run
    job2_id = r2.json()["job_id"]

    picked = dispatch.pick_job_for(worker)
    assert picked is not None
    assert picked.id == job2_id


def test_requeue_stale_returns_job_to_queue_and_it_can_be_repicked(client):
    csrf = _login(client)
    w1 = _register_worker(client, csrf, "w1")
    w2 = _register_worker(client, csrf, "w2")

    r = _submit(client, csrf)
    job_id = r.json()["job_id"]

    picked = dispatch.pick_job_for(w1)
    assert picked is not None and picked.id == job_id
    dispatch.mark_running(job_id)

    stale_time = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=91)
    with db.get_session() as session:
        worker = session.get(db.Worker, w1)
        worker.last_seen = stale_time
        session.commit()

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    count = dispatch.requeue_stale(now)
    assert count == 1

    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        assert job.status == "queued"
        assert job.worker_id is None
        assert job.progress == 0
        worker = session.get(db.Worker, w1)
        assert worker.status == "offline"

    repicked = dispatch.pick_job_for(w2)
    assert repicked is not None
    assert repicked.id == job_id


def test_assessment_endpoint_reports_per_worker_verdicts(client):
    csrf = _login(client)
    _register_worker(client, csrf, "w1", model_inventory=[{"name": "sd_xl_base.safetensors", "size": 4.0}])

    r = _submit(client, csrf)
    job_id = r.json()["job_id"]

    res = client.get(f"/api/jobs/{job_id}/assessment", headers={"X-CSRF": csrf})
    assert res.status_code == 200
    workers = res.json()["workers"]
    assert len(workers) == 1
    assert workers[0]["verdict"] == "eligible"


def test_asset_download_only_for_assigned_worker(client):
    csrf = _login(client)

    # Register two workers with real keypairs so we can sign agent requests.
    from nacl.signing import SigningKey

    def register_with_key(name):
        sk = SigningKey.generate()
        pubkey_hex = bytes(sk.verify_key).hex()
        r = client.post("/api/workers/tokens", json={"name": name}, headers={"X-CSRF": csrf})
        token = r.json()["bundle"]["register_token"]
        reg = client.post("/api/agent/register", json={"token": token, "name": name, "pubkey": pubkey_hex})
        return reg.json()["worker_id"], sk

    w1_id, w1_key = register_with_key("agent1")
    w2_id, w2_key = register_with_key("agent2")

    workflow = {"1": {"class_type": "LoadImage", "inputs": {"image": "ref.png"}}}
    files = [("assets", ("ref.png", io.BytesIO(b"fake-png-bytes"), "image/png"))]
    r = _submit(client, csrf, workflow=workflow, files=files)
    job_id = r.json()["job_id"]

    # Assign the job to worker 1 directly via dispatch.
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        job.status = "assigned"
        job.worker_id = w1_id
        session.commit()

    def sign_and_get(worker_id, signing_key, path):
        import secrets
        import time

        ts = str(int(time.time()))
        nonce = secrets.token_hex(8)
        message = f"GET\n{path}\n{ts}\n{nonce}\n".encode()
        sig = signing_key.sign(message).signature.hex()
        return client.get(
            path,
            headers={
                "X-Worker-Id": worker_id,
                "X-Ts": ts,
                "X-Nonce": nonce,
                "X-Sig": sig,
            },
        )

    path = f"/api/agent/jobs/{job_id}/inputs/ref.png"

    ok = sign_and_get(w1_id, w1_key, path)
    assert ok.status_code == 200
    assert ok.content == b"fake-png-bytes"

    forbidden = sign_and_get(w2_id, w2_key, path)
    assert forbidden.status_code == 403
    assert forbidden.json()["error"]["code"] == "jobs.not_assigned"
