import io
import json
import os
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from comfyfed_server import agentws, app as app_module
from comfyfed_server import bootstrap, db, dispatch, jobs as jobs_module, model_manifest


def _pick_job_for(worker_id):
    """Test-only stand-in for the old single-worker `dispatch.pick_job_for`:
    dispatch now ranks a whole idle batch at once via `assign_jobs`. Returns
    the job assigned to `worker_id`, or None if nothing eligible was found
    for it."""
    for assigned_worker_id, job in dispatch.assign_jobs([worker_id]):
        if assigned_worker_id == worker_id:
            return job
    return None


@pytest.fixture()
def client(tmp_path):
    data_dir = str(tmp_path)
    result = bootstrap.ensure_installed(data_dir, lang="en", url="http://h", interactive=False)
    app = app_module.create_app(data_dir)
    c = TestClient(app)
    c.admin_password = result.admin_password
    c.data_dir = data_dir
    yield c
    # Module-level, in-memory, per-process (see agentws.py) -- reset between
    # tests so one test's fetch-progress state doesn't bleed into the next.
    agentws._fetch_progress.clear()


def _login(client):
    r = client.post("/api/auth/login", json={"username": "admin", "password": client.admin_password})
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


def test_create_job_stamps_the_given_origin(client):
    """`create_job` is the single assess-and-persist path shared by the
    console and the panel -- each caller must be able to stamp its own
    origin onto the row it creates."""
    console_id = jobs_module.create_job(
        json.dumps(SIMPLE_WORKFLOW), SIMPLE_WORKFLOW, origin="console"
    )
    panel_id = jobs_module.create_job(
        json.dumps(SIMPLE_WORKFLOW), SIMPLE_WORKFLOW, origin="panel"
    )

    with db.get_session() as session:
        assert session.get(db.Job, console_id).origin == "console"
        assert session.get(db.Job, panel_id).origin == "panel"


def test_console_submit_stamps_console_origin(client):
    """Console's `POST /api/jobs` funnels through `create_job(origin=...)` --
    the list and detail responses must both surface it, since the console is
    the audit surface that has to tell panel- and console-submitted jobs
    apart."""
    csrf = _login(client)
    job_id = _submit(client, csrf).json()["job_id"]

    listed = client.get("/api/jobs", headers={"X-CSRF": csrf}).json()
    job = next(j for j in listed if j["id"] == job_id)
    assert job["origin"] == "console"

    detail = client.get(f"/api/jobs/{job_id}", headers={"X-CSRF": csrf}).json()
    assert detail["origin"] == "console"


def test_console_jobs_list_includes_panel_hidden_jobs_too(client):
    """Console is the audit surface -- it must list every job regardless of
    `panel_hidden`, unlike the panel's `/comfy/api/history`."""
    csrf = _login(client)
    job_id = _submit(client, csrf).json()["job_id"]
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        job.panel_hidden = True
        session.commit()

    listed = client.get("/api/jobs", headers={"X-CSRF": csrf}).json()
    assert any(j["id"] == job_id for j in listed)


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

    job_a = _pick_job_for(w1)
    job_b = _pick_job_for(w2)

    assert job_a is not None
    assert job_a.id != (job_b.id if job_b else None)
    # Only two jobs existed; a third pick should find nothing left.
    job_c = _pick_job_for(w1)
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

    picked = _pick_job_for(worker)
    assert picked is not None
    assert picked.id == job2_id


def test_requeue_stale_returns_job_to_queue_and_it_can_be_repicked(client):
    csrf = _login(client)
    w1 = _register_worker(client, csrf, "w1")
    w2 = _register_worker(client, csrf, "w2")

    r = _submit(client, csrf)
    job_id = r.json()["job_id"]

    picked = _pick_job_for(w1)
    assert picked is not None and picked.id == job_id
    dispatch.mark_running(job_id, w1)

    stale_time = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=91)
    with db.get_session() as session:
        worker = session.get(db.Worker, w1)
        worker.last_seen = stale_time
        session.commit()

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    requeued = dispatch.requeue_stale(now)
    assert requeued == [job_id]

    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        assert job.status == "queued"
        assert job.worker_id is None
        assert job.progress == 0
        worker = session.get(db.Worker, w1)
        assert worker.status == "offline"

    repicked = _pick_job_for(w2)
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


def test_requeue_stale_requeues_a_worker_that_never_heartbeated(client):
    """I1: a handshaked-but-dead agent's job must not be stranded.

    `last_seen` is None until the first heartbeat, so a worker that took a job
    push and then died was previously skipped by the staleness sweep forever.
    """
    csrf = _login(client)
    w1 = _register_worker(client, csrf, "w1")
    w2 = _register_worker(client, csrf, "w2")

    r = _submit(client, csrf)
    job_id = r.json()["job_id"]

    picked = _pick_job_for(w1)
    assert picked is not None and picked.id == job_id

    old = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=200)
    with db.get_session() as session:
        worker = session.get(db.Worker, w1)
        worker.last_seen = None
        worker.created_at = old  # registered long ago, never checked in
        # Keep w2 fresh so the sweep doesn't take it offline too.
        session.get(db.Worker, w2).last_seen = datetime.now(timezone.utc).replace(tzinfo=None)
        session.commit()

    requeued = dispatch.requeue_stale(datetime.now(timezone.utc).replace(tzinfo=None))
    assert requeued == [job_id]

    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        assert job.status == "queued"
        assert job.worker_id is None
        assert session.get(db.Worker, w1).status == "offline"


def test_requeue_stale_leaves_a_freshly_registered_worker_alone(client):
    """The created_at fallback must not requeue a worker that just joined."""
    csrf = _login(client)
    w1 = _register_worker(client, csrf, "w1")

    r = _submit(client, csrf)
    job_id = r.json()["job_id"]
    assert _pick_job_for(w1) is not None

    assert dispatch.requeue_stale(datetime.now(timezone.utc).replace(tzinfo=None)) == []
    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "assigned"


def test_upload_with_dot_dot_filename_is_400_not_500(client):
    """M1: a bare '..' asset name used to reach os.path.basename and blow up."""
    csrf = _login(client)
    workflow = {"1": {"class_type": "LoadImage", "inputs": {"image": ".."}}}
    files = [("assets", ("..", io.BytesIO(b"evil"), "application/octet-stream"))]
    r = _submit(client, csrf, workflow=workflow, files=files)

    assert r.status_code == 400
    assert r.json()["error"]["code"] == "jobs.bad_asset_name"


def test_upload_with_traversal_filename_is_400(client):
    csrf = _login(client)
    files = [("assets", ("../../etc/passwd", io.BytesIO(b"evil"), "application/octet-stream"))]
    r = _submit(client, csrf, files=files)

    assert r.status_code == 400
    assert r.json()["error"]["code"] == "jobs.bad_asset_name"


def _fail_job(job_id, worker_id):
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        job.status = "failed"
        job.worker_id = worker_id
        job.error = "boom"
        job.progress = 0.4
        job.started_at = datetime.now(timezone.utc).replace(tzinfo=None)
        job.finished_at = datetime.now(timezone.utc).replace(tzinfo=None)
        session.commit()


def test_retry_requeues_a_failed_job_and_clears_the_last_attempt(client):
    csrf = _login(client)
    w1 = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf).json()["job_id"]
    _fail_job(job_id, w1)

    r = client.post(f"/api/jobs/{job_id}/retry", headers={"X-CSRF": csrf})
    assert r.status_code == 200

    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        assert job.status == "queued"
        assert job.worker_id is None
        assert job.error is None
        assert job.progress == 0
        assert job.started_at is None
        assert job.finished_at is None

    # And it is dispatchable again.
    assert _pick_job_for(w1) is not None


def test_retry_on_a_non_failed_job_is_409(client):
    csrf = _login(client)
    job_id = _submit(client, csrf).json()["job_id"]  # still queued

    r = client.post(f"/api/jobs/{job_id}/retry", headers={"X-CSRF": csrf})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "jobs.not_retryable"


def test_retry_unknown_job_is_404(client):
    csrf = _login(client)
    r = client.post("/api/jobs/does-not-exist/retry", headers={"X-CSRF": csrf})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "jobs.not_found"


def test_cancel_queued_job_moves_to_cancelled(client):
    csrf = _login(client)
    job_id = _submit(client, csrf).json()["job_id"]

    r = client.post(f"/api/jobs/{job_id}/cancel", headers={"X-CSRF": csrf})
    assert r.status_code == 200
    assert r.json() == {"status": "cancelled"}

    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        assert job.status == "cancelled"
        assert job.error == "cancelled by admin"
        assert job.finished_at is not None


def test_cancel_assigned_job_moves_to_cancelled(client):
    csrf = _login(client)
    w1 = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf).json()["job_id"]
    assert _pick_job_for(w1) is not None

    r = client.post(f"/api/jobs/{job_id}/cancel", headers={"X-CSRF": csrf})
    assert r.status_code == 200

    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "cancelled"


def test_cancel_unknown_job_is_404(client):
    csrf = _login(client)
    r = client.post("/api/jobs/does-not-exist/cancel", headers={"X-CSRF": csrf})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "jobs.not_found"


def test_cancel_already_done_job_is_409_with_terminal_status(client):
    csrf = _login(client)
    w1 = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf).json()["job_id"]
    assert _pick_job_for(w1) is not None
    assert dispatch.mark_done(job_id, w1, ["out.png"])

    r = client.post(f"/api/jobs/{job_id}/cancel", headers={"X-CSRF": csrf})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "jobs.already_terminal"
    assert r.json()["status"] == "done"

    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "done"


def test_cancel_already_cancelled_job_is_409(client):
    csrf = _login(client)
    job_id = _submit(client, csrf).json()["job_id"]

    first = client.post(f"/api/jobs/{job_id}/cancel", headers={"X-CSRF": csrf})
    assert first.status_code == 200

    second = client.post(f"/api/jobs/{job_id}/cancel", headers={"X-CSRF": csrf})
    assert second.status_code == 409
    assert second.json()["status"] == "cancelled"


def test_cancel_requires_csrf(client):
    csrf = _login(client)
    job_id = _submit(client, csrf).json()["job_id"]
    r = client.post(f"/api/jobs/{job_id}/cancel")
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "auth.csrf"


def test_retry_requires_csrf(client):
    csrf = _login(client)
    job_id = _submit(client, csrf).json()["job_id"]
    r = client.post(f"/api/jobs/{job_id}/retry")
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "auth.csrf"


def test_artifact_download_streams_the_stored_file(client):
    from comfyfed_server import storage

    csrf = _login(client)
    job_id = _submit(client, csrf).json()["job_id"]

    store = storage.get_store(client.data_dir)
    store.put(job_id, "out.png", io.BytesIO(b"RESULT-BYTES"))

    r = client.get(f"/api/jobs/{job_id}/artifacts/out.png", headers={"X-CSRF": csrf})
    assert r.status_code == 200
    assert r.content == b"RESULT-BYTES"
    assert r.headers["content-length"] == str(len(b"RESULT-BYTES"))


def test_artifact_download_missing_file_is_404(client):
    csrf = _login(client)
    job_id = _submit(client, csrf).json()["job_id"]
    r = client.get(f"/api/jobs/{job_id}/artifacts/nope.png", headers={"X-CSRF": csrf})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "jobs.artifact_not_found"


def test_artifact_store_path_rejects_traversal_and_missing_files(client):
    """`path()` is what the download route hands to FileResponse, so it must
    apply the same sanitising as `open()` (and not exist-check its way out)."""
    import pytest as _pytest

    from comfyfed_server import storage

    csrf = _login(client)
    job_id = _submit(client, csrf).json()["job_id"]
    store = storage.get_store(client.data_dir)

    with _pytest.raises(ValueError):
        store.path(job_id, "../../secrets.txt")
    with _pytest.raises(ValueError):
        store.path(job_id, "..")
    with _pytest.raises(FileNotFoundError):
        store.path(job_id, "never-written.png")

    store.put(job_id, "ok.png", io.BytesIO(b"x"))
    assert os.path.isfile(store.path(job_id, "ok.png"))


def test_artifact_store_base_path_is_not_implemented_by_default():
    """A non-local backend must raise, so its route can redirect instead."""
    import pytest as _pytest

    from comfyfed_server import storage

    class _Remote(storage.ArtifactStore):
        def put(self, job_id, filename, stream):
            return filename

        def open(self, job_id, filename):
            raise FileNotFoundError

        def url(self, job_id, filename):
            return "https://example.invalid/x"

    with _pytest.raises(NotImplementedError):
        _Remote().path("j", "f.png")


# A realistic flux workflow: loader values are CATEGORY-relative bare names.
FLUX_WORKFLOW = {
    "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-dev.safetensors"}},
    "2": {
        "class_type": "DualCLIPLoader",
        "inputs": {"clip_name1": "t5xxl_fp16.safetensors", "clip_name2": "clip_l.safetensors"},
    },
    "3": {"class_type": "VAELoader", "inputs": {"vae_name": "ae.safetensors"}},
    "4": {"class_type": "KSampler", "inputs": {"seed": 1, "model": ["1", 0]}},
}

# The same models as the agent reports them: relative to the models ROOT.
FLUX_ROOT_RELATIVE_INVENTORY = [
    {"name": "diffusion_models/flux1-dev.safetensors", "size": 11.9},
    {"name": "text_encoders/t5xxl_fp16.safetensors", "size": 9.8},
    {"name": "text_encoders/clip_l.safetensors", "size": 0.25},
    {"name": "vae/ae.safetensors", "size": 0.3},
]


def test_flux_job_fits_a_16gb_card_and_dispatches(client):
    """End-to-end guard for the live-reproduced failure on rtx5080-main.

    Two separate defects had to be fixed for this to pass, and this test
    covers both:

    1. The worker's inventory is models-root-relative
       ("diffusion_models/flux1-dev.safetensors") while the workflow's loader
       values are category-relative ("flux1-dev.safetensors"). Exact-string
       comparison judged every model missing.
    2. Peak VRAM is the LARGEST single model (11.9 * 1.15 = 13.7), not the sum
       of all four (25.6, which would still have blocked a 16 GB card).
       ComfyUI loads and offloads models around the diffusion pass.
    """
    csrf = _login(client)
    worker_id = _register_worker(
        client,
        csrf,
        "rtx5080-main",
        node_classes=["UNETLoader", "DualCLIPLoader", "VAELoader", "KSampler"],
        model_inventory=FLUX_ROOT_RELATIVE_INVENTORY,
        hardware={"vram_gb": 16.0},
        dynamic={"free_disk_gb": 500.0},
    )

    job_id = _submit(client, csrf, workflow=FLUX_WORKFLOW).json()["job_id"]

    detail = client.get(f"/api/jobs/{job_id}", headers={"X-CSRF": csrf}).json()
    assert detail["est_vram_gb"] == pytest.approx(11.9 * 1.15)  # 13.685

    entry = client.get(f"/api/jobs/{job_id}/assessment", headers={"X-CSRF": csrf}).json()["workers"][0]
    assert entry["missing_models"] == []
    assert entry["verdict"] == "eligible", entry

    # And it actually dispatches, which is the whole point.
    picked = _pick_job_for(worker_id)
    assert picked is not None and picked.id == job_id


def test_an_oversized_single_model_is_still_blocked_on_vram(client):
    """The gate still catches absurd mismatches, but the bar is VRAM PLUS RAM.

    LIVE-3: ComfyUI offloads weights to system RAM when they do not fit in
    VRAM, so `est > vram` alone is not a refusal. A 40 GB model on an 8 GB
    card with 16 GB of RAM fits nowhere, and that IS.
    """
    csrf = _login(client)
    _register_worker(
        client,
        csrf,
        "small-card",
        node_classes=["UNETLoader", "KSampler"],
        model_inventory=[{"name": "diffusion_models/huge-model.safetensors", "size": 40.0}],
        hardware={"vram_gb": 8.0, "ram_gb": 16.0},
        dynamic={"free_disk_gb": 500.0},
    )

    workflow = {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "huge-model.safetensors"}}}
    job_id = _submit(client, csrf, workflow=workflow).json()["job_id"]

    detail = client.get(f"/api/jobs/{job_id}", headers={"X-CSRF": csrf}).json()
    assert detail["est_vram_gb"] == pytest.approx(40.0 * 1.15)

    entry = client.get(f"/api/jobs/{job_id}/assessment", headers={"X-CSRF": csrf}).json()["workers"][0]
    assert entry["verdict"] == "ineligible"
    assert any(r.startswith("vram:") for r in entry["reasons"])
    assert entry["warnings"] == []

    # And it stays in the queue.
    assert _pick_job_for(entry["worker_id"]) is None


def test_a_model_over_vram_but_under_vram_plus_ram_dispatches_with_a_warning(client):
    """LIVE-3, the real machine that prompted this: flux1-dev is 22.17 GB and
    est = 25.49, on a 15.9 GB card with 63.6 GB of RAM. That card demonstrably
    runs flux (and a 33B video model) because ComfyUI streams weights from
    system RAM. The old hard `est > vram` gate made every worker ineligible,
    so a panel-submitted job sat queued forever with no error.
    """
    csrf = _login(client)
    worker_id = _register_worker(
        client,
        csrf,
        "real-card",
        node_classes=["UNETLoader", "KSampler"],
        model_inventory=[{"name": "diffusion_models/flux1-dev.safetensors", "size": 22.17}],
        hardware={"vram_gb": 15.9, "ram_gb": 63.6},
        dynamic={"free_disk_gb": 500.0},
    )

    workflow = {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-dev.safetensors"}}}
    job_id = _submit(client, csrf, workflow=workflow).json()["job_id"]

    detail = client.get(f"/api/jobs/{job_id}", headers={"X-CSRF": csrf}).json()
    assert detail["est_vram_gb"] == pytest.approx(22.17 * 1.15)

    entry = client.get(f"/api/jobs/{job_id}/assessment", headers={"X-CSRF": csrf}).json()["workers"][0]
    assert entry["verdict"] == "eligible"
    assert entry["reasons"] == []
    assert len(entry["warnings"]) == 1
    assert entry["warnings"][0].startswith("vram_offload:")
    assert entry["warnings"][0].endswith(">15.9")

    # The point of the whole fix: an eligible-with-warning worker DISPATCHES.
    picked = _pick_job_for(worker_id)
    assert picked is not None and picked.id == job_id


def test_a_model_that_fits_in_vram_carries_no_warning(client):
    csrf = _login(client)
    _register_worker(
        client,
        csrf,
        "big-card",
        node_classes=["UNETLoader", "KSampler"],
        model_inventory=[{"name": "diffusion_models/small.safetensors", "size": 4.0}],
        hardware={"vram_gb": 24.0, "ram_gb": 64.0},
        dynamic={"free_disk_gb": 500.0},
    )

    workflow = {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "small.safetensors"}}}
    job_id = _submit(client, csrf, workflow=workflow).json()["job_id"]

    entry = client.get(f"/api/jobs/{job_id}/assessment", headers={"X-CSRF": csrf}).json()["workers"][0]
    assert entry["verdict"] == "eligible"
    assert entry["warnings"] == []


def test_min_vram_override_stays_a_hard_refusal(client):
    """The automatic gate softened; the manual override did not."""
    csrf = _login(client)
    _register_worker(
        client,
        csrf,
        "real-card",
        node_classes=["UNETLoader", "KSampler"],
        model_inventory=[{"name": "diffusion_models/flux1-dev.safetensors", "size": 22.17}],
        hardware={"vram_gb": 15.9, "ram_gb": 63.6},
        dynamic={"free_disk_gb": 500.0},
    )

    workflow = {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-dev.safetensors"}}}
    job_id = _submit(
        client, csrf, workflow=workflow, requirements={"min_vram_gb": 24.0}
    ).json()["job_id"]

    entry = client.get(f"/api/jobs/{job_id}/assessment", headers={"X-CSRF": csrf}).json()["workers"][0]
    assert entry["verdict"] == "ineligible"
    assert "override:min_vram_gb" in entry["reasons"]


def test_job_detail_has_no_receipt_before_one_is_minted(client):
    csrf = _login(client)
    job_id = _submit(client, csrf).json()["job_id"]

    detail = client.get(f"/api/jobs/{job_id}", headers={"X-CSRF": csrf}).json()
    assert detail["receipt"] is None


def test_job_detail_embeds_the_receipt_summary(client):
    """Task 9: the console job detail page reads the receipt straight off
    `GET /api/jobs/{id}` rather than needing a separate lookup -- same field
    names/semantics as `reports.contributions`'s per-receipt listing."""
    csrf = _login(client)
    w1 = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf).json()["job_id"]

    with db.get_session() as session:
        receipt = db.Receipt(
            job_id=job_id,
            worker_id=w1,
            gpu_seconds=12.5,
            platform_sig="sig-platform",
            worker_sig="sig-worker",
            kind="completed",
            billable=True,
            basis="exec",
        )
        session.add(receipt)
        session.commit()

    detail = client.get(f"/api/jobs/{job_id}", headers={"X-CSRF": csrf}).json()
    assert detail["receipt"] == {
        "gpu_seconds": 12.5,
        "kind": "completed",
        "billable": True,
        "basis": "exec",
        "acked": True,
    }


def test_job_detail_receipt_unacked_when_worker_sig_missing(client):
    csrf = _login(client)
    w1 = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf).json()["job_id"]

    with db.get_session() as session:
        receipt = db.Receipt(
            job_id=job_id,
            worker_id=w1,
            gpu_seconds=3.0,
            platform_sig="sig-platform",
            worker_sig=None,
            kind="failed",
            billable=False,
            basis="wall",
        )
        session.add(receipt)
        session.commit()

    detail = client.get(f"/api/jobs/{job_id}", headers={"X-CSRF": csrf}).json()
    assert detail["receipt"]["acked"] is False
    assert detail["receipt"]["billable"] is False
    assert detail["receipt"]["kind"] == "failed"
    assert detail["receipt"]["basis"] == "wall"


def test_job_detail_uses_the_newest_receipt_when_a_job_was_retried(client):
    csrf = _login(client)
    w1 = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf).json()["job_id"]

    with db.get_session() as session:
        session.add(
            db.Receipt(
                job_id=job_id,
                worker_id=w1,
                gpu_seconds=1.0,
                platform_sig="s1",
                worker_sig="w1sig",
                kind="failed",
                billable=False,
                basis="wall",
                created_at=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=5),
            )
        )
        session.add(
            db.Receipt(
                job_id=job_id,
                worker_id=w1,
                gpu_seconds=9.0,
                platform_sig="s2",
                worker_sig="w2sig",
                kind="completed",
                billable=True,
                basis="exec",
                created_at=datetime.now(timezone.utc).replace(tzinfo=None),
            )
        )
        session.commit()

    detail = client.get(f"/api/jobs/{job_id}", headers={"X-CSRF": csrf}).json()
    assert detail["receipt"]["gpu_seconds"] == 9.0
    assert detail["receipt"]["kind"] == "completed"


def test_flux_job_with_a_genuinely_absent_model_is_still_ineligible(client):
    """The looser matching must not turn real misses into false eligibility."""
    csrf = _login(client)
    _register_worker(
        client,
        csrf,
        "w1",
        node_classes=["UNETLoader", "KSampler"],
        model_inventory=[{"name": "diffusion_models/some-other-model.safetensors", "size": 4.0}],
        hardware={"vram_gb": 16.0},
    )
    # A second worker DOES have the model, so it is not missing fleet-wide --
    # the console's own submit predicate (Phase 2.1 Task 4) only blocks a
    # model missing from EVERY worker; this test is about w1's own verdict,
    # not about whether the fleet as a whole can run the job. Peer inventory
    # plays no part in w1's OWN eligibility (Task 3 removed that fallback --
    # only the signed manifest can make a missing model eligible_after_fetch),
    # so w1 stays genuinely ineligible for it regardless.
    _register_worker(
        client,
        csrf,
        "w2",
        model_inventory=[{"name": "diffusion_models/flux1-dev.safetensors", "size": 22.17}],
    )

    workflow = {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-dev.safetensors"}}}
    job_id = _submit(client, csrf, workflow=workflow).json()["job_id"]

    assessment = client.get(f"/api/jobs/{job_id}/assessment", headers={"X-CSRF": csrf}).json()
    entry = assessment["workers"][0]
    assert entry["verdict"] == "ineligible"
    assert entry["missing_models"] == ["flux1-dev.safetensors"]


# --- Task 4: console submit predicate + assessment/dict manifest wiring ----


def _bytes(gb: float) -> int:
    return round(gb * (1024 ** 3))


def _sha(label: str) -> str:
    import hashlib

    return hashlib.sha256(label.encode()).hexdigest()


FLUX_WORKFLOW = {
    "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-dev.safetensors"}},
}

TWO_MODEL_WORKFLOW = {
    "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-dev.safetensors"}},
    "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "clip_l.safetensors"}},
}


def test_submit_accepts_when_missing_model_is_fully_fetchable(client):
    """A model missing from every worker no longer hard-blocks submission
    when the manifest has a signed entry for it AND at least one online,
    opted-in worker could fetch it (assess.partition_fleet_fetchable)."""
    csrf = _login(client)
    model_manifest.record_hash(
        "some-worker", "diffusion_models/flux1-dev.safetensors", _bytes(22.17), _sha("flux")
    )
    _register_worker(
        client,
        csrf,
        "fetcher",
        status="online",
        protocol=3,
        auto_fetch=True,
        dynamic={"free_disk_gb": 100.0},
    )

    r = _submit(client, csrf, workflow=FLUX_WORKFLOW)
    assert r.status_code == 200


def test_submit_rejects_when_missing_model_has_no_manifest_entry(client):
    csrf = _login(client)
    _register_worker(client, csrf, "w1", status="online")

    r = _submit(client, csrf, workflow=FLUX_WORKFLOW)
    assert r.status_code == 400
    body = r.json()
    assert body["error"]["code"] == "jobs.missing_models"
    assert "flux1-dev.safetensors" in body["error"]["message"]


def test_submit_rejects_when_manifest_entry_exists_but_no_optin_worker(client):
    """A manifest entry alone doesn't help if nobody can actually fetch it."""
    csrf = _login(client)
    model_manifest.record_hash(
        "some-worker", "diffusion_models/flux1-dev.safetensors", _bytes(22.17), _sha("flux")
    )
    # protocol/auto_fetch left at their not-opted-in defaults.
    _register_worker(client, csrf, "w1", status="online")

    r = _submit(client, csrf, workflow=FLUX_WORKFLOW)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "jobs.missing_models"


def test_submit_mixed_fetchable_and_unfetchable_lists_only_unfetchable(client):
    """Two missing models, one fetchable and one not: 400 message names
    ONLY the unfetchable one -- the fetchable one queues normally."""
    csrf = _login(client)
    model_manifest.record_hash(
        "some-worker", "diffusion_models/flux1-dev.safetensors", _bytes(22.17), _sha("flux")
    )
    _register_worker(
        client,
        csrf,
        "fetcher",
        status="online",
        protocol=3,
        auto_fetch=True,
        dynamic={"free_disk_gb": 100.0},
    )

    r = _submit(client, csrf, workflow=TWO_MODEL_WORKFLOW)
    assert r.status_code == 400
    message = r.json()["error"]["message"]
    assert "clip_l.safetensors" in message
    assert "flux1-dev.safetensors" not in message


def test_submit_rejects_when_combined_fetch_set_exceeds_disk_margin(client):
    """The disk gate is COMBINED over the whole manifest-covered missing set:
    a worker with barely any free disk can't fetch either model, so BOTH
    land in the 400 even though both have manifest entries."""
    csrf = _login(client)
    model_manifest.record_hash(
        "some-worker", "diffusion_models/flux1-dev.safetensors", _bytes(22.17), _sha("flux")
    )
    model_manifest.record_hash(
        "some-worker", "text_encoders/clip_l.safetensors", _bytes(0.23), _sha("clip")
    )
    _register_worker(
        client,
        csrf,
        "tight",
        status="online",
        protocol=3,
        auto_fetch=True,
        dynamic={"free_disk_gb": 1.0},  # nowhere near 1.2 x (22.17 + 0.23)
    )

    r = _submit(client, csrf, workflow=TWO_MODEL_WORKFLOW)
    assert r.status_code == 400
    message = r.json()["error"]["message"]
    assert "flux1-dev.safetensors" in message
    assert "clip_l.safetensors" in message


def test_submit_still_queues_when_missing_model_is_offline_worker_only(client):
    """Unchanged pre-Task-4 behavior: a model present on SOME registered
    worker's inventory (even offline/disabled) is not fleet-wide missing at
    all -- never reaches the fetchability question."""
    csrf = _login(client)
    _register_worker(
        client,
        csrf,
        "gpu-box",
        status="offline",
        model_inventory=[{"name": "diffusion_models/flux1-dev.safetensors", "size": 22.17}],
    )

    r = _submit(client, csrf, workflow=FLUX_WORKFLOW)
    assert r.status_code == 200


def test_job_assessment_reports_eligible_after_fetch_when_manifest_wired(client):
    csrf = _login(client)
    model_manifest.record_hash(
        "some-worker", "diffusion_models/flux1-dev.safetensors", _bytes(22.17), _sha("flux")
    )
    worker_id = _register_worker(
        client,
        csrf,
        "fetcher",
        status="online",
        protocol=3,
        auto_fetch=True,
        dynamic={"free_disk_gb": 100.0},
    )

    job_id = _submit(client, csrf, workflow=FLUX_WORKFLOW).json()["job_id"]

    assessment = client.get(f"/api/jobs/{job_id}/assessment", headers={"X-CSRF": csrf}).json()
    entry = next(w for w in assessment["workers"] if w["worker_id"] == worker_id)
    assert entry["verdict"] == "eligible_after_fetch"
    assert entry["missing_models"] == ["flux1-dev.safetensors"]


def test_job_dict_includes_fetch_stage_fields_when_present(client):
    """`_job_dict` reads agentws's transient fetch-progress store (Phase 2.1
    Task 4's `stage`/`fetch_pct`/`fetch_model` heartbeat extension) -- see
    `agentws._fetch_progress`."""
    csrf = _login(client)
    job_id = _submit(client, csrf).json()["job_id"]

    agentws._fetch_progress[job_id] = {
        "stage": "fetching_models",
        "fetch_pct": 42.5,
        "fetch_model": "flux1-dev.safetensors",
    }

    listed = client.get("/api/jobs", headers={"X-CSRF": csrf}).json()
    job = next(j for j in listed if j["id"] == job_id)
    assert job["stage"] == "fetching_models"
    assert job["fetch_pct"] == 42.5
    assert job["fetch_model"] == "flux1-dev.safetensors"


def test_job_dict_omits_fetch_stage_fields_when_absent(client):
    csrf = _login(client)
    job_id = _submit(client, csrf).json()["job_id"]

    listed = client.get("/api/jobs", headers={"X-CSRF": csrf}).json()
    job = next(j for j in listed if j["id"] == job_id)
    assert "stage" not in job
    assert "fetch_pct" not in job
    assert "fetch_model" not in job


def test_job_dict_omits_invalid_fetch_pct_and_model_rather_than_sending_null(client):
    """`stage` can be present while `fetch_pct`/`fetch_model` are None (the
    agent sent a malformed value -- see `_handle_heartbeat`); those two keys
    must be OMITTED from the dict, not sent as an explicit `null`, matching
    `panelws.job_progress`'s omit-if-None style for the same data."""
    csrf = _login(client)
    job_id = _submit(client, csrf).json()["job_id"]

    agentws._fetch_progress[job_id] = {
        "stage": "fetching_models",
        "fetch_pct": None,
        "fetch_model": None,
    }

    listed = client.get("/api/jobs", headers={"X-CSRF": csrf}).json()
    job = next(j for j in listed if j["id"] == job_id)
    assert job["stage"] == "fetching_models"
    assert "fetch_pct" not in job
    assert "fetch_model" not in job
