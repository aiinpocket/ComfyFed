"""ComfyUI-compatible API surface (`/comfy/api/*`).

Shapes here are dictated by the real ComfyUI server (`server.py` /
`execution.py`), not by ComfyFed's own error envelope: the official ComfyUI
frontend is the client, so `/prompt` errors are `{"error": {...},
"node_errors": {...}}` and history entries are `{"prompt": [...],
"outputs": {...}, "status": {...}}`.
"""

import gzip
import io
import json
import os

import pytest
from fastapi.testclient import TestClient

from comfyfed_server import app as app_module
from comfyfed_server import bootstrap, comfyapi, db, dispatch, jobs, model_manifest, storage, workers


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
    comfyapi.clear_object_info_cache()
    data_dir = str(tmp_path)
    result = bootstrap.ensure_installed(data_dir, lang="en", url="http://h", interactive=False)
    app = app_module.create_app(data_dir)
    c = TestClient(app)
    c.admin_password = result.admin_password
    c.data_dir = data_dir
    yield c


def _login(client, username="admin", password=None):
    r = client.post(
        "/api/auth/login",
        json={"username": username, "password": password or client.admin_password},
    )
    assert r.status_code == 200, r.text
    return r.json()["csrf"]


def _uid(username="admin"):
    with db.get_session() as session:
        row = session.query(db.User).filter(db.User.username == username).one()
        return row.id


def _create_user(client, admin_csrf, username, role="user", password="password123"):
    r = client.post(
        "/api/users",
        json={"username": username, "role": role, "password": password},
        headers={"X-CSRF": admin_csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


ALICE = ("alice", "alice-pw-123")
BOB = ("bob", "bob-pw-123")


@pytest.fixture()
def two_users(client):
    """Creates admin (bootstrap) + two plain users, alice and bob.

    Mirrors `test_job_scoping.py`'s fixture of the same name/shape: leaves NO
    particular session active on return, since `TestClient` holds one cookie
    jar for the whole test -- callers must `_login(client, *ALICE)` (etc.)
    right before acting as one of them.
    """
    admin_csrf = _login(client)
    _create_user(client, admin_csrf, ALICE[0], password=ALICE[1])
    _create_user(client, admin_csrf, BOB[0], password=BOB[1])
    return {"admin_pw": client.admin_password}


def _register_worker(client, csrf, name, *, status="online", object_info=None, disabled=False):
    r = client.post("/api/workers/tokens", json={"name": name}, headers={"X-CSRF": csrf})
    token = r.json()["bundle"]["register_token"]
    reg = client.post(
        "/api/agent/register", json={"token": token, "name": name, "pubkey": "ab" * 32}
    )
    worker_id = reg.json()["worker_id"]

    if object_info is not None:
        _write_object_info(client.data_dir, worker_id, object_info)

    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.status = status
        worker.disabled = disabled
        if object_info is not None:
            worker.object_info_hash = f"hash-{name}"
        session.commit()

    return worker_id


def _write_object_info(data_dir, worker_id, payload):
    """Inverse of `workers.load_object_info`: gzip a JSON snapshot onto disk."""
    path = workers.object_info_path(data_dir, worker_id)
    import os

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(gzip.compress(json.dumps(payload).encode()))


SIMPLE_PROMPT = {
    "1": {"class_type": "KSampler", "inputs": {"seed": 1}},
    "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}},
}


def _post_prompt(client, prompt=None, client_id="frontend-1"):
    return client.post(
        "/comfy/api/prompt",
        json={"prompt": prompt if prompt is not None else SIMPLE_PROMPT, "client_id": client_id},
    )


def _finish_job(client, csrf, job_id, *, result_files, artifact_bytes=b"png-bytes"):
    """Drive a queued job to `done` with stored artifacts, via the real dispatch path."""
    worker_id = _register_worker(client, csrf, f"runner-{job_id[:6]}")
    picked = _pick_job_for(worker_id)
    assert picked is not None and picked.id == job_id
    assert dispatch.mark_running(job_id, worker_id)

    store = storage.get_store(client.data_dir)
    for name in result_files:
        store.put(job_id, name, io.BytesIO(artifact_bytes))

    assert dispatch.mark_done(job_id, worker_id, list(result_files))
    return worker_id


# --- auth ------------------------------------------------------------------


@pytest.mark.parametrize(
    "method,path",
    [
        ("get", "/comfy/api/object_info"),
        ("get", "/comfy/api/queue"),
        ("get", "/comfy/api/history"),
        ("get", "/comfy/api/history/abc"),
        ("get", "/comfy/api/view?filename=x.png"),
        ("post", "/comfy/api/prompt"),
        ("post", "/comfy/api/interrupt"),
        ("post", "/comfy/api/queue"),
        ("post", "/comfy/api/history"),
    ],
)
def test_all_routes_require_login(client, method, path):
    """Phase 3.0 Task 4: the panel gate loosened from admin-only to
    any-logged-in-user, but it is still a GATE -- an anonymous caller gets
    401 exactly as before."""
    r = getattr(client, method)(path, follow_redirects=False)
    assert r.status_code == 401


def test_non_admin_can_open_the_panel_surface(client, two_users):
    """Task 4's whole point: a plain `user` role, not just admin, can reach
    the panel's bootstrap/API surface. Scoping (what they SEE) is a separate
    concern, covered by the isolation tests below."""
    _login(client, *ALICE)
    assert client.get("/comfy/api/object_info").status_code == 200
    assert client.get("/comfy/api/features").status_code == 200
    assert client.get("/comfy/api/queue").status_code == 200
    assert client.get("/comfy/api/history").status_code == 200


def test_non_admin_can_open_the_comfy_static_gate(client, two_users):
    """The `/comfy` static-file gate in `app.py` (separate from this
    router's own `require_user` dependency) must likewise accept any
    logged-in user now, not just admin."""
    _login(client, *ALICE)
    r = client.get("/comfy/", follow_redirects=False)
    assert r.status_code != 302

    client.cookies.clear()
    r_anon = client.get("/comfy/", follow_redirects=False)
    assert r_anon.status_code == 302


# --- object_info -----------------------------------------------------------


def test_object_info_unions_online_enabled_workers(client):
    csrf = _login(client)
    _register_worker(client, csrf, "w1", object_info={"KSampler": {"input": {}}, "Shared": {"v": 1}})
    _register_worker(client, csrf, "w2", object_info={"LoadImage": {"input": {}}, "Shared": {"v": 2}})
    # Offline and disabled workers contribute nothing.
    _register_worker(client, csrf, "w3", status="offline", object_info={"OfflineOnly": {}})
    _register_worker(client, csrf, "w4", disabled=True, object_info={"DisabledOnly": {}})

    r = client.get("/comfy/api/object_info")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"KSampler", "Shared", "LoadImage"}
    # Same-name node: first worker wins.
    assert body["Shared"] == {"v": 1}
    assert "X-ComfyFed-No-Workers" not in r.headers


def test_object_info_no_online_workers_returns_empty_with_header(client):
    _login(client)
    r = client.get("/comfy/api/object_info")
    assert r.status_code == 200
    assert r.json() == {}
    assert r.headers.get("X-ComfyFed-No-Workers") == "1"


def test_object_info_no_online_workers_returns_empty_regardless_of_mode(client):
    """The empty-fleet early return must fire before the mode branch is ever
    consulted -- intersection mode with zero online workers gets the exact
    same `{}` + no-workers-header response as union, not an empty result
    produced by the intersection-of-nothing logic taking a different path."""
    csrf = _login(client)
    r = client.post(
        "/api/settings", json={"object_info_mode": "intersection"}, headers={"X-CSRF": csrf}
    )
    assert r.status_code == 200

    r = client.get("/comfy/api/object_info")
    assert r.status_code == 200
    assert r.json() == {}
    assert r.headers.get("X-ComfyFed-No-Workers") == "1"
    assert r.headers["X-ComfyFed-Worker-Count"] == "0"


def test_object_info_reports_source_worker_count_in_a_header(client):
    """M5: how many workers the union came from, without polluting the body.

    The body has to stay a plausible ComfyUI `/object_info` -- the stock
    frontend turns every top-level key into a node -- so the count rides in a
    response header instead. It is what lets a caller warn that a graph mixing
    nodes from different workers may submit but never be dispatchable.
    """
    csrf = _login(client)
    _register_worker(client, csrf, "w1", object_info={"KSampler": {}})
    _register_worker(client, csrf, "w2", object_info={"LoadImage": {}})
    # Neither of these contributes, so neither is counted.
    _register_worker(client, csrf, "w3", status="offline", object_info={"OfflineOnly": {}})
    _register_worker(client, csrf, "w4", disabled=True, object_info={"DisabledOnly": {}})

    r = client.get("/comfy/api/object_info")
    assert r.status_code == 200
    assert r.headers["X-ComfyFed-Worker-Count"] == "2"
    assert set(r.json()) == {"KSampler", "LoadImage"}


def test_object_info_worker_count_is_zero_with_no_workers(client):
    _login(client)
    r = client.get("/comfy/api/object_info")
    assert r.headers["X-ComfyFed-Worker-Count"] == "0"
    assert r.headers["X-ComfyFed-No-Workers"] == "1"


def test_object_info_intersection_mode_drops_classes_missing_on_any_worker(client):
    csrf = _login(client)
    _register_worker(
        client, csrf, "w1", object_info={"KSampler": {"input": {}}, "Shared": {"v": 1}}
    )
    _register_worker(
        client, csrf, "w2", object_info={"LoadImage": {"input": {}}, "Shared": {"v": 2}}
    )

    r = client.post(
        "/api/settings", json={"object_info_mode": "intersection"}, headers={"X-CSRF": csrf}
    )
    assert r.status_code == 200

    body = client.get("/comfy/api/object_info").json()
    # Only present on w1/w2 both -> KSampler and LoadImage are each on just
    # one worker and are dropped; Shared is on both and survives.
    assert set(body) == {"Shared"}
    # Value-level merge for a surviving class stays the plain first-worker-
    # wins pick -- intersection only governs class *presence*.
    assert body["Shared"] == {"v": 1}


def test_object_info_intersection_mode_keeps_classes_on_every_worker(client):
    csrf = _login(client)
    _register_worker(client, csrf, "w1", object_info={"KSampler": {}, "Shared": {}})
    _register_worker(client, csrf, "w2", object_info={"KSampler": {}, "Shared": {}})

    client.post("/api/settings", json={"object_info_mode": "intersection"}, headers={"X-CSRF": csrf})

    body = client.get("/comfy/api/object_info").json()
    assert set(body) == {"KSampler", "Shared"}


def test_object_info_mode_change_misses_the_cache(client):
    """The cache is keyed on (fleet, mode): flipping the setting must not
    keep serving the other mode's stale answer."""
    csrf = _login(client)
    _register_worker(client, csrf, "w1", object_info={"KSampler": {}})
    _register_worker(client, csrf, "w2", object_info={"LoadImage": {}})

    assert set(client.get("/comfy/api/object_info").json()) == {"KSampler", "LoadImage"}

    client.post("/api/settings", json={"object_info_mode": "intersection"}, headers={"X-CSRF": csrf})
    assert set(client.get("/comfy/api/object_info").json()) == set()

    client.post("/api/settings", json={"object_info_mode": "union"}, headers={"X-CSRF": csrf})
    assert set(client.get("/comfy/api/object_info").json()) == {"KSampler", "LoadImage"}


def test_object_info_cache_invalidates_when_worker_hash_changes(client):
    csrf = _login(client)
    worker_id = _register_worker(client, csrf, "w1", object_info={"NodeA": {}})
    assert set(client.get("/comfy/api/object_info").json()) == {"NodeA"}

    # Same hash -> cached answer even though the file changed underneath.
    _write_object_info(client.data_dir, worker_id, {"NodeB": {}})
    assert set(client.get("/comfy/api/object_info").json()) == {"NodeA"}

    with db.get_session() as session:
        session.get(db.Worker, worker_id).object_info_hash = "hash-changed"
        session.commit()
    assert set(client.get("/comfy/api/object_info").json()) == {"NodeB"}


# --- prompt ----------------------------------------------------------------


def test_prompt_creates_job_visible_in_jobs_api(client):
    csrf = _login(client)
    r = _post_prompt(client)
    assert r.status_code == 200
    body = r.json()
    assert body["node_errors"] == {}
    assert body["number"] == 1
    prompt_id = body["prompt_id"]

    listed = client.get("/api/jobs", headers={"X-CSRF": csrf}).json()
    job = next(j for j in listed if j["id"] == prompt_id)
    assert job["status"] == "queued"

    second = _post_prompt(client)
    assert second.json()["number"] == 2


def test_prompt_rejects_non_dict_prompt(client):
    _login(client)
    r = client.post("/comfy/api/prompt", json={"prompt": "not-a-dict"})
    assert r.status_code == 400
    body = r.json()
    assert body["error"]["type"] == "invalid_prompt"
    assert body["node_errors"] == {}


def test_prompt_missing_prompt_key_is_no_prompt_error(client):
    _login(client)
    r = client.post("/comfy/api/prompt", json={"client_id": "x"})
    assert r.status_code == 400
    assert r.json()["error"]["type"] == "no_prompt"


def test_prompt_with_unstaged_asset_returns_comfy_style_error(client):
    _login(client)
    prompt = {"1": {"class_type": "LoadImage", "inputs": {"image": "ref.png"}}}
    r = client.post("/comfy/api/prompt", json={"prompt": prompt})
    assert r.status_code == 400
    body = r.json()
    assert body["error"]["type"] == "invalid_prompt"
    assert "ref.png" in body["error"]["message"] + body["error"].get("details", "")
    assert body["node_errors"] == {}
    # Nothing was persisted.
    with db.get_session() as session:
        assert session.query(db.Job).count() == 0


FLUX_PROMPT = {
    "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-dev.safetensors"}},
    "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}},
}


def _set_model_inventory(client, worker_id, inventory):
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.model_inventory = json.dumps(inventory)
        session.commit()


def _set_node_classes(client, worker_id, classes):
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.node_classes = json.dumps(classes)
        session.commit()


def test_prompt_rejects_when_no_registered_worker_has_the_model(client):
    csrf = _login(client)
    worker_id = _register_worker(client, csrf, "runner-1")
    _set_model_inventory(client, worker_id, [{"name": "diffusion_models/other.safetensors", "size": 1.0}])

    r = _post_prompt(client, prompt=FLUX_PROMPT)
    assert r.status_code == 400
    body = r.json()
    assert body["error"]["type"] == "prompt.missing_models"

    # message is a SHORT one-line summary: the frontend uses it as the errors
    # panel's card title and as the first half of the dialog's
    # `message + ": " + details`.
    message = body["error"]["message"]
    assert message == "缺少模型：flux1-dev.safetensors，無法執行——詳見下方下載指引"
    assert "\n" not in message

    # details carries the full multi-block guidance.
    details = body["error"]["details"]
    assert (
        "官方載點：https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/flux1-dev.safetensors"
        in details
    )
    assert (
        "備份載點：https://storage.googleapis.com/comfyfed-models/models/diffusion_models/flux1-dev.safetensors"
        in details
    )
    node_errors = body["node_errors"]
    assert set(node_errors.keys()) == {"1"}
    node_entry = node_errors["1"]
    assert node_entry["class_type"] == "UNETLoader"
    assert node_entry["dependent_outputs"] == []
    assert len(node_entry["errors"]) == 1
    err = node_entry["errors"][0]
    assert err["type"] == "comfyfed.missing_model"
    assert err["message"] == "缺少模型：flux1-dev.safetensors，無法執行——詳見下方下載指引"
    assert "\n" not in err["message"]
    assert err["extra_info"] == {}
    assert (
        "官方載點：https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/flux1-dev.safetensors"
        in err["details"]
    )
    assert "備份載點：" in err["details"]
    # per-node details is ONLY that model's own block -- not the shared
    # header or any other missing model's block.
    assert "無法執行：聯邦裡所有已註冊的 worker" not in err["details"]

    with db.get_session() as session:
        assert session.query(db.Job).count() == 0


TWO_MODELS_ONE_NODE_PROMPT = {
    "1": {
        "class_type": "DualCLIPLoader",
        "inputs": {"clip_name1": "clip_l.safetensors", "clip_name2": "t5xxl_fp16.safetensors"},
    },
    "2": {"class_type": "SaveText", "inputs": {}},
}

ONE_MODEL_TWO_NODES_PROMPT = {
    "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "flux1-dev.safetensors"}},
    "2": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-dev.safetensors"}},
}


def test_prompt_rejection_node_errors_one_model_referenced_by_two_nodes(client):
    csrf = _login(client)
    _register_worker(client, csrf, "runner-1")

    r = _post_prompt(client, prompt=ONE_MODEL_TWO_NODES_PROMPT)
    assert r.status_code == 400
    node_errors = r.json()["node_errors"]

    assert set(node_errors.keys()) == {"1", "2"}
    assert node_errors["1"]["class_type"] == "CheckpointLoaderSimple"
    assert node_errors["2"]["class_type"] == "UNETLoader"
    for node_id in ("1", "2"):
        entry = node_errors[node_id]
        assert entry["dependent_outputs"] == []
        assert len(entry["errors"]) == 1
        assert entry["errors"][0]["message"] == (
            "缺少模型：flux1-dev.safetensors，無法執行——詳見下方下載指引"
        )


def test_prompt_rejection_node_errors_two_models_referenced_by_one_node(client):
    csrf = _login(client)
    _register_worker(client, csrf, "runner-1")

    r = _post_prompt(client, prompt=TWO_MODELS_ONE_NODE_PROMPT)
    assert r.status_code == 400
    node_errors = r.json()["node_errors"]

    assert set(node_errors.keys()) == {"1"}
    entry = node_errors["1"]
    assert entry["class_type"] == "DualCLIPLoader"
    assert entry["dependent_outputs"] == []
    assert len(entry["errors"]) == 2
    messages = {e["message"] for e in entry["errors"]}
    assert messages == {
        "缺少模型：clip_l.safetensors，無法執行——詳見下方下載指引",
        "缺少模型：t5xxl_fp16.safetensors，無法執行——詳見下方下載指引",
    }
    details_by_message = {e["message"]: e["details"] for e in entry["errors"]}
    assert "clip_l.safetensors" in details_by_message[
        "缺少模型：clip_l.safetensors，無法執行——詳見下方下載指引"
    ]
    assert "t5xxl_fp16.safetensors" in details_by_message[
        "缺少模型：t5xxl_fp16.safetensors，無法執行——詳見下方下載指引"
    ]
    for e in entry["errors"]:
        assert e["type"] == "comfyfed.missing_model"
        assert e["extra_info"] == {}


def test_prompt_still_queues_when_no_workers_registered(client):
    _login(client)
    r = _post_prompt(client, prompt=FLUX_PROMPT)
    assert r.status_code == 200
    with db.get_session() as session:
        assert session.query(db.Job).count() == 1


def test_prompt_still_queues_when_a_worker_is_eligible(client):
    csrf = _login(client)
    worker_id = _register_worker(client, csrf, "runner-1")
    _set_model_inventory(client, worker_id, [{"name": "diffusion_models/flux1-dev.safetensors", "size": 22.17}])

    r = _post_prompt(client, prompt=FLUX_PROMPT)
    assert r.status_code == 200
    with db.get_session() as session:
        assert session.query(db.Job).count() == 1


def test_prompt_queues_when_the_only_worker_with_the_model_is_offline(client):
    """The classic home federation: one GPU box holding everything, rebooting,
    plus a small always-on box holding nothing. The job must wait, not be
    refused with instructions to re-download models the user already owns."""
    csrf = _login(client)
    gpu = _register_worker(client, csrf, "gpu-box", status="offline")
    _set_model_inventory(client, gpu, [{"name": "diffusion_models/flux1-dev.safetensors", "size": 22.17}])
    small = _register_worker(client, csrf, "always-on")
    _set_model_inventory(client, small, [])

    r = _post_prompt(client, prompt=FLUX_PROMPT)
    assert r.status_code == 200
    with db.get_session() as session:
        assert session.query(db.Job).count() == 1


def test_prompt_queues_when_a_disabled_worker_has_the_model(client):
    csrf = _login(client)
    holder = _register_worker(client, csrf, "paused-box", disabled=True)
    _set_model_inventory(client, holder, [{"name": "diffusion_models/flux1-dev.safetensors", "size": 22.17}])
    _register_worker(client, csrf, "empty-box")

    r = _post_prompt(client, prompt=FLUX_PROMPT)
    assert r.status_code == 200


def test_prompt_rejection_fires_past_an_unrelated_online_bystander(client):
    """A model absent fleet-wide is still a dead end even when some other
    worker happens to be online and busy with something else."""
    csrf = _login(client)
    a = _register_worker(client, csrf, "bystander")
    _set_model_inventory(client, a, [{"name": "vae/ae.safetensors", "size": 0.31}])
    b = _register_worker(client, csrf, "other", status="offline")
    _set_model_inventory(client, b, [{"name": "loras/unrelated.safetensors", "size": 0.1}])

    r = _post_prompt(client, prompt=FLUX_PROMPT)
    assert r.status_code == 400
    assert r.json()["error"]["type"] == "prompt.missing_models"


def test_prompt_with_only_missing_nodes_never_triggers_model_guidance(client):
    """Missing node classes are not a missing-model problem: the job queues
    (unchanged behavior) rather than being refused with download links."""
    csrf = _login(client)
    worker_id = _register_worker(client, csrf, "runner-1")
    _set_model_inventory(client, worker_id, [{"name": "diffusion_models/flux1-dev.safetensors", "size": 22.17}])
    _set_node_classes(client, worker_id, ["SaveImage"])  # no UNETLoader

    r = _post_prompt(client, prompt=FLUX_PROMPT)
    assert r.status_code == 200
    with db.get_session() as session:
        assert session.query(db.Job).count() == 1


# --- Task 4: submission-relaxation matrix (fetchable missing models) ------


def _bytes(gb: float) -> int:
    return round(gb * (1024 ** 3))


def _sha(label: str) -> str:
    import hashlib

    return hashlib.sha256(label.encode()).hexdigest()


TWO_MODEL_PROMPT = {
    "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-dev.safetensors"}},
    # A genuinely unknown model (not in model_guide.SOURCES, not harvested):
    # unlike the 11 curated models (Phase 3.2), the manifest can never
    # produce a fetchable entry for this one -- no guide-vouched hash, no
    # learned consensus, nothing. This is the case that must still 400.
    "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "totally_unknown_model.safetensors"}},
}


def test_prompt_queues_when_missing_model_is_fully_fetchable(client):
    """A model missing from every worker no longer hard-blocks `/prompt` when
    the manifest has a signed entry for it AND at least one online, opted-in
    worker could fetch it (assess.partition_fleet_fetchable)."""
    csrf = _login(client)
    model_manifest.record_hash(
        "some-worker", "diffusion_models/flux1-dev.safetensors", _bytes(22.17), _sha("flux")
    )
    fetcher = _register_worker(client, csrf, "fetcher", status="online")
    with db.get_session() as session:
        worker = session.get(db.Worker, fetcher)
        worker.protocol = 3
        worker.auto_fetch = True
        worker.dynamic = json.dumps({"free_disk_gb": 100.0})
        worker.hardware = json.dumps({"max_fetch_gb": 100})
        session.commit()

    r = _post_prompt(client, prompt=FLUX_PROMPT)
    assert r.status_code == 200
    with db.get_session() as session:
        assert session.query(db.Job).count() == 1


def test_prompt_queues_zero_holder_curated_model_via_guide_hash_alone(client):
    """Phase 3.2: `flux1-dev.safetensors` is curated with an operator-vouched
    sha256/size_bytes in `model_guide.SOURCES` -- the manifest signs a
    zero-holder entry for it straight from those values, with NO worker ever
    having reported an inventory hash (`model_manifest.record_hash` is never
    called here). An online, opted-in, disk-capable worker is then enough to
    queue the job instead of 400ing with a manual-download prompt."""
    csrf = _login(client)
    fetcher = _register_worker(client, csrf, "fetcher", status="online")
    with db.get_session() as session:
        worker = session.get(db.Worker, fetcher)
        worker.protocol = 3
        worker.auto_fetch = True
        worker.dynamic = json.dumps({"free_disk_gb": 100.0})
        worker.hardware = json.dumps({"max_fetch_gb": 100})
        session.commit()

    r = _post_prompt(client, prompt=FLUX_PROMPT)
    assert r.status_code == 200
    with db.get_session() as session:
        assert session.query(db.Job).count() == 1


def test_prompt_rejects_when_missing_model_has_no_manifest_entry(client):
    """Unlike the 11 curated models, a name with neither a curated guide hash
    nor a harvested source nor a learned consensus never gets a manifest
    entry at all -- still a hard 400 even with a fetch-capable worker
    standing by."""
    csrf = _login(client)
    fetcher = _register_worker(client, csrf, "fetcher", status="online")
    with db.get_session() as session:
        worker = session.get(db.Worker, fetcher)
        worker.protocol = 3
        worker.auto_fetch = True
        worker.dynamic = json.dumps({"free_disk_gb": 100.0})
        session.commit()

    prompt = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "totally_unknown_model.safetensors"}},
    }
    r = _post_prompt(client, prompt=prompt)
    assert r.status_code == 400
    assert r.json()["error"]["type"] == "prompt.missing_models"


def test_prompt_rejects_when_manifest_entry_exists_but_no_optin_worker(client):
    csrf = _login(client)
    model_manifest.record_hash(
        "some-worker", "diffusion_models/flux1-dev.safetensors", _bytes(22.17), _sha("flux")
    )
    _register_worker(client, csrf, "runner-1")  # not opted into auto_fetch

    r = _post_prompt(client, prompt=FLUX_PROMPT)
    assert r.status_code == 400
    assert r.json()["error"]["type"] == "prompt.missing_models"


def test_prompt_mixed_fetchable_and_unfetchable_lists_only_unfetchable(client):
    csrf = _login(client)
    model_manifest.record_hash(
        "some-worker", "diffusion_models/flux1-dev.safetensors", _bytes(22.17), _sha("flux")
    )
    fetcher = _register_worker(client, csrf, "fetcher", status="online")
    with db.get_session() as session:
        worker = session.get(db.Worker, fetcher)
        worker.protocol = 3
        worker.auto_fetch = True
        worker.dynamic = json.dumps({"free_disk_gb": 100.0})
        worker.hardware = json.dumps({"max_fetch_gb": 100})
        session.commit()

    r = _post_prompt(client, prompt=TWO_MODEL_PROMPT)
    assert r.status_code == 400
    body = r.json()
    assert "totally_unknown_model.safetensors" in body["error"]["message"]
    assert "flux1-dev.safetensors" not in body["error"]["message"]
    assert set(body["node_errors"].keys()) == {"2"}


# --- Phase 3.1 P2P: peer-seeded models never reach the missing-model gate -


def test_prompt_queues_when_missing_model_is_only_reachable_via_a_peer_seeder(client):
    """Task 6 deliverable #3's finding, pinned as a test: a peer-only manifest
    entry can only exist for a model that some registered worker's inventory
    already has (`model_manifest._peer_only_entry` requires
    `peer.online_seeders` non-empty, which itself requires a worker's
    inventory to hold the consensus file -- see `peer.online_seeders`'s
    docstring). `comfyapi._fleet_wide_gaps` -> `assess.fleet_wide_gaps` checks
    every registered worker's inventory (online or not) before a model is
    ever considered "missing" -- so a model any worker holds, seeder or not,
    NEVER reaches `_partition_missing_models`/the guidance-rendering 400 path
    at all. No `model_guide`/guidance wording change was needed for the peer
    branch: this submission queues normally, exactly like the pre-existing
    "the only worker with the model is offline" case, for the same reason.
    """
    csrf = _login(client)
    seeder = _register_worker(client, csrf, "seeder-box")
    _set_model_inventory(
        client, seeder, [{"name": "diffusion_models/flux1-dev.safetensors", "size": 22.17}]
    )
    with db.get_session() as session:
        worker = session.get(db.Worker, seeder)
        worker.protocol = 4
        worker.peer_url = "http://10.0.0.5:8850"
        # Phase 3.4 §4.2：種子條件多了「平台驗證過連得到」（peerhealth）。
        worker.peer_reachable = 1
        session.commit()
    # The requesting worker has neither the model nor any fetch opt-in --
    # only the seeder above holds it.
    _register_worker(client, csrf, "requester-box")

    r = _post_prompt(client, prompt=FLUX_PROMPT)
    assert r.status_code == 200
    with db.get_session() as session:
        assert session.query(db.Job).count() == 1


def test_prompt_rejection_also_names_fleet_wide_missing_nodes(client):
    """Both missing: the guidance must not send the admin off to download
    22 GB for a job that still cannot run for want of a custom node."""
    csrf = _login(client)
    worker_id = _register_worker(client, csrf, "runner-1")
    _set_model_inventory(client, worker_id, [])
    _set_node_classes(client, worker_id, ["SaveImage"])  # no UNETLoader

    r = _post_prompt(client, prompt=FLUX_PROMPT)
    assert r.status_code == 400
    details = r.json()["error"]["details"]
    assert "另外，所有 worker 也都缺少節點：UNETLoader" in details
    assert "需在 worker 端安裝對應 custom node" in details


def test_prompt_rejection_omits_the_node_line_when_nodes_are_fine(client):
    csrf = _login(client)
    worker_id = _register_worker(client, csrf, "runner-1")
    _set_model_inventory(client, worker_id, [])
    _set_node_classes(client, worker_id, ["UNETLoader", "SaveImage"])

    r = _post_prompt(client, prompt=FLUX_PROMPT)
    assert r.status_code == 400
    assert "缺少節點" not in r.json()["error"]["details"]


def test_prompt_summary_counts_models_when_several_are_missing(client):
    csrf = _login(client)
    worker_id = _register_worker(client, csrf, "runner-1")
    _set_model_inventory(client, worker_id, [])

    prompt = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-dev.safetensors"}},
        "2": {"class_type": "VAELoader", "inputs": {"vae_name": "ae.safetensors"}},
        "3": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}},
    }
    r = _post_prompt(client, prompt=prompt)
    assert r.status_code == 400
    assert r.json()["error"]["message"] == (
        "缺少模型：ae.safetensors 等 2 項，無法執行——詳見下方下載指引"
    )


# --- queue -----------------------------------------------------------------


def test_queue_shape_splits_running_and_pending(client):
    csrf = _login(client)
    queued_id = _post_prompt(client).json()["prompt_id"]
    running_id = _post_prompt(client).json()["prompt_id"]

    worker_id = _register_worker(client, csrf, "runner")
    picked = _pick_job_for(worker_id)
    assert picked is not None and picked.id == queued_id
    dispatch.mark_running(queued_id, worker_id)
    running_id, queued_id = queued_id, running_id

    r = client.get("/comfy/api/queue")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"queue_running", "queue_pending"}
    assert [e[1] for e in body["queue_running"]] == [running_id]
    assert [e[1] for e in body["queue_pending"]] == [queued_id]

    entry = body["queue_running"][0]
    # [number, prompt_id, prompt, extra_data, outputs_to_execute] per server.py
    assert len(entry) == 5
    assert isinstance(entry[0], (int, float))
    assert entry[2] == SIMPLE_PROMPT
    assert isinstance(entry[3], dict)
    assert entry[4] == ["2"]


# --- cancellation: /interrupt and /queue ------------------------------------


def test_interrupt_with_nothing_running_is_still_200(client):
    _login(client)
    r = client.post("/comfy/api/interrupt")
    assert r.status_code == 200
    assert r.json() == {}


def test_interrupt_cancels_the_oldest_running_job(client):
    csrf = _login(client)
    older_id = _post_prompt(client).json()["prompt_id"]
    newer_id = _post_prompt(client).json()["prompt_id"]

    worker_id = _register_worker(client, csrf, "runner")
    picked = _pick_job_for(worker_id)
    assert picked is not None and picked.id == older_id
    dispatch.mark_running(older_id, worker_id)

    r = client.post("/comfy/api/interrupt")
    assert r.status_code == 200
    assert r.json() == {}

    with db.get_session() as session:
        assert session.get(db.Job, older_id).status == "cancelled"
        # The still-queued job is untouched.
        assert session.get(db.Job, newer_id).status == "queued"


def test_interrupt_does_not_touch_only_queued_jobs(client):
    """Nothing is `assigned`/`running` yet -- /interrupt has nothing to cancel."""
    _login(client)
    job_id = _post_prompt(client).json()["prompt_id"]

    r = client.post("/comfy/api/interrupt")
    assert r.status_code == 200

    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "queued"


def test_interrupt_skips_a_console_origin_job_even_if_older_and_running(client):
    """`/interrupt` is the panel's own "stop what I'm looking at" button --
    it must never reach into a console-submitted job just because it happens
    to be the oldest running one."""
    csrf = _login(client)
    console_job_id = jobs.create_job(
        json.dumps(SIMPLE_PROMPT), SIMPLE_PROMPT, origin="console"
    )
    panel_job_id = _post_prompt(client).json()["prompt_id"]

    worker_id = _register_worker(client, csrf, "runner")
    with db.get_session() as session:
        for job_id in (console_job_id, panel_job_id):
            job = session.get(db.Job, job_id)
            job.status = "running"
            job.worker_id = worker_id
        session.commit()

    r = client.post("/comfy/api/interrupt")
    assert r.status_code == 200

    with db.get_session() as session:
        assert session.get(db.Job, console_job_id).status == "running"
        assert session.get(db.Job, panel_job_id).status == "cancelled"


def test_queue_delete_cancels_listed_jobs_only(client):
    csrf = _login(client)
    job_a = _post_prompt(client).json()["prompt_id"]
    job_b = _post_prompt(client).json()["prompt_id"]
    job_c = _post_prompt(client).json()["prompt_id"]

    r = client.post("/comfy/api/queue", json={"delete": [job_a, job_c]})
    assert r.status_code == 200
    assert r.json() == {}

    with db.get_session() as session:
        assert session.get(db.Job, job_a).status == "cancelled"
        assert session.get(db.Job, job_b).status == "queued"
        assert session.get(db.Job, job_c).status == "cancelled"


def test_queue_delete_ignores_unknown_and_terminal_ids(client):
    csrf = _login(client)
    job_id = _post_prompt(client).json()["prompt_id"]
    _finish_job(client, csrf, job_id, result_files=["out.png"])

    r = client.post("/comfy/api/queue", json={"delete": [job_id, "no-such-job"]})
    assert r.status_code == 200

    with db.get_session() as session:
        # Still done -- a terminal job must never be clobbered back to cancelled.
        assert session.get(db.Job, job_id).status == "done"


def test_queue_clear_cancels_every_non_terminal_job(client):
    csrf = _login(client)
    queued_id = _post_prompt(client).json()["prompt_id"]
    running_id = _post_prompt(client).json()["prompt_id"]
    done_id = _post_prompt(client).json()["prompt_id"]

    worker_id = _register_worker(client, csrf, "runner")
    _pick_job_for(worker_id)
    with db.get_session() as session:
        job = session.get(db.Job, running_id)
        job.status = "running"
        job.worker_id = worker_id
        session.commit()
    _finish_job(client, csrf, done_id, result_files=["out.png"])

    r = client.post("/comfy/api/queue", json={"clear": True})
    assert r.status_code == 200

    with db.get_session() as session:
        assert session.get(db.Job, queued_id).status == "cancelled"
        assert session.get(db.Job, running_id).status == "cancelled"
        # A job that already finished is left alone.
        assert session.get(db.Job, done_id).status == "done"


def test_queue_clear_leaves_console_origin_jobs_queued(client):
    """`{"clear": true}` is the panel's "empty my queue" button -- it must
    never cancel a job the console submitted, even though both funnel
    through the same `jobs` table."""
    _login(client)
    console_job_id = jobs.create_job(
        json.dumps(SIMPLE_PROMPT), SIMPLE_PROMPT, origin="console"
    )
    panel_job_id = _post_prompt(client).json()["prompt_id"]

    r = client.post("/comfy/api/queue", json={"clear": True})
    assert r.status_code == 200

    with db.get_session() as session:
        assert session.get(db.Job, console_job_id).status == "queued"
        assert session.get(db.Job, panel_job_id).status == "cancelled"


def test_queue_delete_ignores_a_named_console_origin_job(client):
    """Even explicitly named, a console job must survive `{"delete": [...]}`
    from the panel -- origin scoping, not just default queue semantics."""
    _login(client)
    console_job_id = jobs.create_job(
        json.dumps(SIMPLE_PROMPT), SIMPLE_PROMPT, origin="console"
    )

    r = client.post("/comfy/api/queue", json={"delete": [console_job_id]})
    assert r.status_code == 200

    with db.get_session() as session:
        assert session.get(db.Job, console_job_id).status == "queued"


def test_queue_delete_with_empty_body_is_a_noop(client):
    _login(client)
    job_id = _post_prompt(client).json()["prompt_id"]

    r = client.post("/comfy/api/queue", json={})
    assert r.status_code == 200

    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "queued"


# --- history ---------------------------------------------------------------


def test_history_shape_for_done_job(client):
    csrf = _login(client)
    prompt_id = _post_prompt(client).json()["prompt_id"]
    _finish_job(client, csrf, prompt_id, result_files=["out_00001_.png"])

    r = client.get("/comfy/api/history")
    assert r.status_code == 200
    history = r.json()
    assert set(history) == {prompt_id}

    entry = history[prompt_id]
    assert set(entry) >= {"prompt", "outputs", "status"}
    assert len(entry["prompt"]) == 5
    assert entry["prompt"][1] == prompt_id
    assert entry["prompt"][2] == SIMPLE_PROMPT
    # Outputs keyed by the workflow's SaveImage node id; `subfolder` carries
    # the owning job id so a recycled ComfyUI filename still resolves to THIS
    # job's bytes when the frontend round-trips it into /view.
    assert entry["outputs"] == {
        "2": {
            "images": [
                {"filename": "out_00001_.png", "subfolder": prompt_id, "type": "output"}
            ]
        }
    }
    assert entry["status"]["status_str"] == "success"
    assert entry["status"]["completed"] is True
    assert isinstance(entry["status"]["messages"], list)


def test_history_by_prompt_id_and_unknown_id(client):
    csrf = _login(client)
    prompt_id = _post_prompt(client).json()["prompt_id"]
    _finish_job(client, csrf, prompt_id, result_files=["a.png"])

    r = client.get(f"/comfy/api/history/{prompt_id}")
    assert r.status_code == 200
    assert set(r.json()) == {prompt_id}

    # ComfyUI returns an empty dict, not a 404, for an unknown prompt id.
    assert client.get("/comfy/api/history/nope").json() == {}


def test_history_includes_failed_job_with_error_status(client):
    csrf = _login(client)
    prompt_id = _post_prompt(client).json()["prompt_id"]
    worker_id = _register_worker(client, csrf, "runner")
    _pick_job_for(worker_id)
    dispatch.mark_failed(prompt_id, worker_id, "boom")

    entry = client.get("/comfy/api/history").json()[prompt_id]
    assert entry["status"]["status_str"] == "error"
    assert entry["status"]["completed"] is False
    assert entry["outputs"] == {}


def test_history_falls_back_to_comfyfed_output_key(client):
    csrf = _login(client)
    prompt = {"1": {"class_type": "KSampler", "inputs": {"seed": 1}}}
    prompt_id = _post_prompt(client, prompt=prompt).json()["prompt_id"]
    _finish_job(client, csrf, prompt_id, result_files=["z.png"])

    outputs = client.get("/comfy/api/history").json()[prompt_id]["outputs"]
    assert list(outputs) == ["comfyfed"]


# --- text outputs (SaveText / PreviewAny) -----------------------------------

TEXT_PROMPT = {
    "1": {"class_type": "TextGenerate", "inputs": {}},
    "2": {"class_type": "SaveText", "inputs": {"text": ["1", 0]}},
    "3": {"class_type": "PreviewAny", "inputs": {"source": ["1", 0]}},
}


def test_history_text_only_job_populates_save_text_and_preview_any(client):
    csrf = _login(client)
    prompt_id = _post_prompt(client, prompt=TEXT_PROMPT).json()["prompt_id"]
    _finish_job(client, csrf, prompt_id, result_files=["comfyfed_prompt.txt"], artifact_bytes=b"a lovely prompt")

    outputs = client.get("/comfy/api/history").json()[prompt_id]["outputs"]

    # Media never appears for a text-only job.
    assert set(outputs) == {"2", "3"}

    assert outputs["2"] == {
        "text": ["a lovely prompt"],
        "files": [
            {"filename": "comfyfed_prompt.txt", "subfolder": prompt_id, "type": "output"}
        ],
    }
    # PreviewAny is the node novices actually look at -- duplicate just the
    # text, no files (PreviewAny never produces a file).
    assert outputs["3"] == {"text": ["a lovely prompt"]}


def test_history_mixed_media_and_text_job(client):
    csrf = _login(client)
    prompt = {
        "1": {"class_type": "KSampler", "inputs": {}},
        "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}},
        "3": {"class_type": "SaveText", "inputs": {"text": ["1", 0]}},
    }
    prompt_id = _post_prompt(client, prompt=prompt).json()["prompt_id"]
    csrf_dummy = csrf  # keep name used below for clarity
    worker_id = _register_worker(client, csrf_dummy, f"runner-{prompt_id[:6]}")
    picked = _pick_job_for(worker_id)
    assert picked is not None and picked.id == prompt_id
    assert dispatch.mark_running(prompt_id, worker_id)

    store = storage.get_store(client.data_dir)
    store.put(prompt_id, "out.png", io.BytesIO(b"png-bytes"))
    store.put(prompt_id, "out.txt", io.BytesIO(b"text-bytes"))
    assert dispatch.mark_done(prompt_id, worker_id, ["out.png", "out.txt"])

    outputs = client.get("/comfy/api/history").json()[prompt_id]["outputs"]
    assert set(outputs) == {"2", "3"}
    assert outputs["2"] == {
        "images": [{"filename": "out.png", "subfolder": prompt_id, "type": "output"}]
    }
    assert outputs["3"] == {
        "text": ["text-bytes"],
        "files": [{"filename": "out.txt", "subfolder": prompt_id, "type": "output"}],
    }


def test_history_text_artifact_unreadable_falls_back_to_files_only(client):
    csrf = _login(client)
    prompt_id = _post_prompt(client, prompt=TEXT_PROMPT).json()["prompt_id"]

    # Drive the job to done WITHOUT actually storing the artifact bytes, so
    # the content read fails but result_files still names it.
    worker_id = _register_worker(client, csrf, f"runner-{prompt_id[:6]}")
    picked = _pick_job_for(worker_id)
    assert picked is not None and picked.id == prompt_id
    assert dispatch.mark_running(prompt_id, worker_id)
    assert dispatch.mark_done(prompt_id, worker_id, ["missing.txt"])

    outputs = client.get("/comfy/api/history").json()[prompt_id]["outputs"]
    assert "text" not in outputs["2"]
    assert outputs["2"]["files"] == [
        {"filename": "missing.txt", "subfolder": prompt_id, "type": "output"}
    ]
    # Nothing readable to duplicate onto PreviewAny.
    assert "3" not in outputs


def test_history_text_artifact_content_capped_at_100kb(client):
    csrf = _login(client)
    prompt_id = _post_prompt(client, prompt=TEXT_PROMPT).json()["prompt_id"]
    big = (b"x" * 150_000)
    _finish_job(client, csrf, prompt_id, result_files=["big.txt"], artifact_bytes=big)

    outputs = client.get("/comfy/api/history").json()[prompt_id]["outputs"]
    assert len(outputs["2"]["text"][0]) == 100_000


# --- history delete (panel_hidden) ------------------------------------


def test_history_delete_hides_named_terminal_panel_job(client):
    """The live frontend's `deleteItem('history', id)` posts `{"delete":
    [id]}` to `/history` (verified against the shipped dist) -- ComfyFed
    must never actually delete the row (receipts reference it), only hide it
    from the panel's own history view."""
    csrf = _login(client)
    prompt_id = _post_prompt(client).json()["prompt_id"]
    _finish_job(client, csrf, prompt_id, result_files=["out.png"])

    r = client.post("/comfy/api/history", json={"delete": [prompt_id]})
    assert r.status_code == 200
    assert r.json() == {}

    assert client.get("/comfy/api/history").json() == {}

    with db.get_session() as session:
        job = session.get(db.Job, prompt_id)
        assert job is not None
        assert job.status == "done"
        assert job.panel_hidden is True


def test_history_delete_ignores_a_non_terminal_job(client):
    _login(client)
    prompt_id = _post_prompt(client).json()["prompt_id"]

    r = client.post("/comfy/api/history", json={"delete": [prompt_id]})
    assert r.status_code == 200

    with db.get_session() as session:
        assert session.get(db.Job, prompt_id).panel_hidden is False


def test_history_delete_ignores_a_console_origin_job(client):
    csrf = _login(client)
    console_job_id = jobs.create_job(
        json.dumps(SIMPLE_PROMPT), SIMPLE_PROMPT, origin="console"
    )
    with db.get_session() as session:
        job = session.get(db.Job, console_job_id)
        job.status = "done"
        session.commit()

    r = client.post("/comfy/api/history", json={"delete": [console_job_id]})
    assert r.status_code == 200

    with db.get_session() as session:
        assert session.get(db.Job, console_job_id).panel_hidden is False


def test_history_clear_hides_all_terminal_panel_jobs(client):
    csrf = _login(client)
    done_id = _post_prompt(client).json()["prompt_id"]
    _finish_job(client, csrf, done_id, result_files=["out.png"])

    failed_id = _post_prompt(client).json()["prompt_id"]
    worker_id = _register_worker(client, csrf, "runner2")
    picked = _pick_job_for(worker_id)
    assert picked is not None and picked.id == failed_id
    dispatch.mark_failed(failed_id, worker_id, "boom")

    still_queued_id = _post_prompt(client).json()["prompt_id"]

    r = client.post("/comfy/api/history", json={"clear": True})
    assert r.status_code == 200

    assert client.get("/comfy/api/history").json() == {}

    with db.get_session() as session:
        assert session.get(db.Job, done_id).panel_hidden is True
        assert session.get(db.Job, failed_id).panel_hidden is True
        # Never terminal, so clear does not touch it.
        assert session.get(db.Job, still_queued_id).panel_hidden is False


def test_history_excludes_a_console_origin_job(client):
    """GET /history is scoped to origin == "panel", matching POST
    /history's write scope -- a console job must never appear in the
    panel's own history list (it could never be hidden from it either,
    since panel_hidden is only ever set by panel-origin history mutations).
    The console's all-seeing surface is /api/jobs, not this endpoint."""
    _login(client)
    console_job_id = jobs.create_job(
        json.dumps(SIMPLE_PROMPT), SIMPLE_PROMPT, origin="console"
    )
    with db.get_session() as session:
        job = session.get(db.Job, console_job_id)
        job.status = "done"
        session.commit()

    assert client.get("/comfy/api/history").json() == {}
    assert client.get(f"/comfy/api/history/{console_job_id}").json() == {}


def test_history_clear_clears_everything_the_panel_can_see(client):
    """A panel-origin done job disappears from GET /history after clear,
    while a console-origin done job -- invisible to GET /history to begin
    with -- is untouched by the panel's clear and stays visible to the
    console's /api/jobs."""
    csrf = _login(client)
    panel_job_id = _post_prompt(client).json()["prompt_id"]
    _finish_job(client, csrf, panel_job_id, result_files=["out.png"])

    console_job_id = jobs.create_job(
        json.dumps(SIMPLE_PROMPT), SIMPLE_PROMPT, origin="console"
    )
    with db.get_session() as session:
        job = session.get(db.Job, console_job_id)
        job.status = "done"
        session.commit()

    r = client.post("/comfy/api/history", json={"clear": True})
    assert r.status_code == 200

    assert client.get("/comfy/api/history").json() == {}

    with db.get_session() as session:
        assert session.get(db.Job, panel_job_id).panel_hidden is True
        console_job = session.get(db.Job, console_job_id)
        assert console_job.panel_hidden is False
        assert console_job.status == "done"


def test_history_get_by_prompt_id_omits_a_panel_hidden_job(client):
    csrf = _login(client)
    prompt_id = _post_prompt(client).json()["prompt_id"]
    _finish_job(client, csrf, prompt_id, result_files=["out.png"])

    client.post("/comfy/api/history", json={"delete": [prompt_id]})

    assert client.get(f"/comfy/api/history/{prompt_id}").json() == {}


def test_history_text_file_without_save_text_node_uses_fallback_key(client):
    csrf = _login(client)
    prompt = {"1": {"class_type": "KSampler", "inputs": {}}}
    prompt_id = _post_prompt(client, prompt=prompt).json()["prompt_id"]
    _finish_job(client, csrf, prompt_id, result_files=["notes.txt"], artifact_bytes=b"hello")

    outputs = client.get("/comfy/api/history").json()[prompt_id]["outputs"]
    assert list(outputs) == [comfyapi.FALLBACK_OUTPUT_KEY]
    assert outputs[comfyapi.FALLBACK_OUTPUT_KEY]["files"] == [
        {"filename": "notes.txt", "subfolder": prompt_id, "type": "output"}
    ]


def test_read_text_artifact_memoizes_per_job_and_filename(client, monkeypatch):
    """M2: `_read_text_artifact` must not re-open the store and re-read disk
    for a `(job_id, filename)` it already served -- artifacts are immutable
    once written, and `GET /history`'s per-job fan-out was hitting the store
    (a fresh DB session for the `artifact_store` setting, plus a file read)
    on every single poll."""
    comfyapi._text_artifact_cache.clear()
    csrf = _login(client)
    prompt_id = _post_prompt(client, prompt=TEXT_PROMPT).json()["prompt_id"]
    _finish_job(
        client, csrf, prompt_id, result_files=["comfyfed_prompt.txt"], artifact_bytes=b"cached text"
    )

    with db.get_session() as session:
        job = session.get(db.Job, prompt_id)

        calls = []
        original_open = storage.LocalStore.open

        def counting_open(self, job_id, filename):
            calls.append((job_id, filename))
            return original_open(self, job_id, filename)

        monkeypatch.setattr(storage.LocalStore, "open", counting_open)

        first = comfyapi._read_text_artifact(job.id, "comfyfed_prompt.txt")
        second = comfyapi._read_text_artifact(job.id, "comfyfed_prompt.txt")

        assert first == second == "cached text"
        assert len(calls) == 1


def test_read_text_artifact_does_not_cache_a_failed_read(client):
    """A retry after a late-arriving upload must still succeed -- caching a
    `None` (missing-file) result would make that failure permanent for the
    process's lifetime instead of just until the file shows up."""
    comfyapi._text_artifact_cache.clear()
    csrf = _login(client)
    prompt_id = _post_prompt(client, prompt=TEXT_PROMPT).json()["prompt_id"]
    worker_id = _register_worker(client, csrf, f"runner-{prompt_id[:6]}")
    picked = _pick_job_for(worker_id)
    assert picked is not None and picked.id == prompt_id
    assert dispatch.mark_running(prompt_id, worker_id)
    assert dispatch.mark_done(prompt_id, worker_id, ["late.txt"])

    with db.get_session() as session:
        job = session.get(db.Job, prompt_id)
        assert comfyapi._read_text_artifact(job.id, "late.txt") is None

        # The worker's upload lands after the first (failed) read.
        storage.get_store(client.data_dir).put(prompt_id, "late.txt", io.BytesIO(b"finally"))

        assert comfyapi._read_text_artifact(job.id, "late.txt") == "finally"


def test_read_text_artifact_cache_evicts_oldest_past_128_entries(client):
    """Drives the real eviction path through `_read_text_artifact` itself
    (not a re-implementation of the cap) -- 129 distinct jobs must leave
    exactly 128 entries, with the very first one evicted."""
    comfyapi._text_artifact_cache.clear()
    csrf = _login(client)
    jobs = []
    for i in range(129):
        prompt_id = _post_prompt(client, prompt=TEXT_PROMPT).json()["prompt_id"]
        _finish_job(
            client, csrf, prompt_id, result_files=[f"n{i}.txt"], artifact_bytes=f"t{i}".encode()
        )
        jobs.append(prompt_id)

    for i, prompt_id in enumerate(jobs):
        comfyapi._read_text_artifact(prompt_id, f"n{i}.txt")

    assert len(comfyapi._text_artifact_cache) == 128
    assert (jobs[0], "n0.txt") not in comfyapi._text_artifact_cache
    assert (jobs[128], "n128.txt") in comfyapi._text_artifact_cache


# --- view ------------------------------------------------------------------


def test_view_streams_a_done_jobs_artifact(client):
    csrf = _login(client)
    prompt_id = _post_prompt(client).json()["prompt_id"]
    _finish_job(client, csrf, prompt_id, result_files=["out.png"], artifact_bytes=b"IMGDATA")

    r = client.get("/comfy/api/view?filename=out.png")
    assert r.status_code == 200
    assert r.content == b"IMGDATA"


def test_view_scopes_a_colliding_filename_to_its_own_job(client):
    """C2: ComfyUI's default output names recur across jobs constantly.

    Every worker numbers `ComfyUI_00001_.png` from its own counter, so two
    unrelated jobs routinely produce the identical filename. The global
    newest-first scan served the most recent job's bytes for EVERY history
    entry with that name; the fix is `subfolder` = the owning job id, which
    the frontend round-trips out of history into its /view call.
    """
    csrf = _login(client)
    name = "ComfyUI_00001_.png"

    job1 = _post_prompt(client).json()["prompt_id"]
    _finish_job(client, csrf, job1, result_files=[name], artifact_bytes=b"FIRST-JOB-BYTES")
    job2 = _post_prompt(client).json()["prompt_id"]
    _finish_job(client, csrf, job2, result_files=[name], artifact_bytes=b"SECOND-JOB-BYTES")

    # The old job's history entry hands the frontend everything it needs.
    entry = client.get(f"/comfy/api/history/{job1}").json()[job1]
    image = next(iter(entry["outputs"].values()))["images"][0]
    assert image["subfolder"] == job1

    r = client.get(
        "/comfy/api/view",
        params={
            "filename": image["filename"],
            "type": image["type"],
            "subfolder": image["subfolder"],
        },
    )
    assert r.status_code == 200
    assert r.content == b"FIRST-JOB-BYTES"

    # ...and the newer job still resolves to its own bytes.
    r2 = client.get(
        "/comfy/api/view", params={"filename": name, "type": "output", "subfolder": job2}
    )
    assert r2.status_code == 200
    assert r2.content == b"SECOND-JOB-BYTES"


def test_view_with_unknown_subfolder_job_is_404(client):
    csrf = _login(client)
    prompt_id = _post_prompt(client).json()["prompt_id"]
    _finish_job(client, csrf, prompt_id, result_files=["out.png"])

    r = client.get(
        "/comfy/api/view",
        params={"filename": "out.png", "type": "output", "subfolder": "no-such-job"},
    )
    assert r.status_code == 404


def test_view_with_subfolder_not_owning_the_file_is_404(client):
    """A job id that exists but never produced this filename must not serve it."""
    csrf = _login(client)
    job1 = _post_prompt(client).json()["prompt_id"]
    _finish_job(client, csrf, job1, result_files=["mine.png"], artifact_bytes=b"MINE")
    job2 = _post_prompt(client).json()["prompt_id"]
    _finish_job(client, csrf, job2, result_files=["other.png"], artifact_bytes=b"OTHER")

    r = client.get(
        "/comfy/api/view",
        params={"filename": "mine.png", "type": "output", "subfolder": job2},
    )
    assert r.status_code == 404


def test_view_subfolder_traversal_is_rejected(client):
    _login(client)
    r = client.get(
        "/comfy/api/view",
        params={"filename": "out.png", "type": "output", "subfolder": "../../etc"},
    )
    assert r.status_code == 400


def test_view_without_subfolder_still_resolves_legacy_links(client):
    """The empty-subfolder global scan stays as a fallback for older links."""
    csrf = _login(client)
    prompt_id = _post_prompt(client).json()["prompt_id"]
    _finish_job(client, csrf, prompt_id, result_files=["legacy.png"], artifact_bytes=b"LEGACY")

    r = client.get("/comfy/api/view", params={"filename": "legacy.png"})
    assert r.status_code == 200
    assert r.content == b"LEGACY"


def test_view_unknown_filename_404(client):
    _login(client)
    r = client.get("/comfy/api/view?filename=missing.png")
    assert r.status_code == 404


def test_view_input_type_404_until_staging_exists(client):
    csrf = _login(client)
    prompt_id = _post_prompt(client).json()["prompt_id"]
    _finish_job(client, csrf, prompt_id, result_files=["out.png"])

    r = client.get("/comfy/api/view?filename=out.png&type=input")
    assert r.status_code == 404


def test_view_rejects_path_traversal(client):
    _login(client)
    r = client.get("/comfy/api/view", params={"filename": "../../etc/passwd"})
    assert r.status_code == 400


# --- upload/image + input staging -------------------------------------------


def test_upload_image_requires_admin_session(client):
    r = client.post("/comfy/api/upload/image", files={"image": ("a.png", b"data", "image/png")})
    assert r.status_code == 401


def test_upload_image_lands_in_staging_and_response_shape(client):
    _login(client)
    r = client.post(
        "/comfy/api/upload/image", files={"image": ("ref.png", b"PNGDATA", "image/png")}
    )
    assert r.status_code == 200
    assert r.json() == {"name": "ref.png", "subfolder": "", "type": "input"}

    staged = os.path.join(client.data_dir, "comfy_staging", _uid(), "ref.png")
    assert os.path.isfile(staged)
    with open(staged, "rb") as f:
        assert f.read() == b"PNGDATA"


def test_upload_image_same_name_overwrites(client):
    _login(client)
    client.post("/comfy/api/upload/image", files={"image": ("ref.png", b"OLD", "image/png")})
    r = client.post(
        "/comfy/api/upload/image",
        data={"overwrite": "true"},
        files={"image": ("ref.png", b"NEW", "image/png")},
    )
    assert r.status_code == 200

    staged = os.path.join(client.data_dir, "comfy_staging", _uid(), "ref.png")
    with open(staged, "rb") as f:
        assert f.read() == b"NEW"


def test_upload_image_rejects_path_traversal_filename(client):
    _login(client)
    r = client.post(
        "/comfy/api/upload/image",
        files={"image": ("../../etc/passwd", b"data", "image/png")},
    )
    assert r.status_code == 400


def test_view_input_type_serves_staged_file(client):
    _login(client)
    client.post("/comfy/api/upload/image", files={"image": ("ref.png", b"STAGED", "image/png")})

    r = client.get("/comfy/api/view?filename=ref.png&type=input")
    assert r.status_code == 200
    assert r.content == b"STAGED"


def test_view_input_type_missing_staged_file_404(client):
    _login(client)
    r = client.get("/comfy/api/view?filename=nope.png&type=input")
    assert r.status_code == 404


def test_staging_is_isolated_between_users(client, two_users):
    """Final review finding #1: the staging area used to be one flat,
    process-wide directory -- any user could view or overwrite any other
    user's staged upload, and the next `/prompt` would silently resolve
    against the wrong bytes."""
    _login(client, *ALICE)
    client.post(
        "/comfy/api/upload/image", files={"image": ("reference.png", b"ALICE-BYTES", "image/png")}
    )

    # Bob cannot view Alice's staged file even though he knows its exact name.
    _login(client, *BOB)
    r = client.get("/comfy/api/view?filename=reference.png&type=input")
    assert r.status_code == 404

    # Bob's own object_info dropdown does not list Alice's staged file.
    assert "reference.png" not in comfyapi.staged_image_names(client.data_dir, _uid("bob"))

    # Bob uploads a same-named file -- it must NOT overwrite Alice's.
    r = client.post(
        "/comfy/api/upload/image", files={"image": ("reference.png", b"BOB-BYTES", "image/png")}
    )
    assert r.status_code == 200

    alice_staged = os.path.join(client.data_dir, "comfy_staging", _uid("alice"), "reference.png")
    with open(alice_staged, "rb") as f:
        assert f.read() == b"ALICE-BYTES"

    # Alice's own next /prompt still resolves against her own file.
    _login(client, *ALICE)
    prompt = {"1": {"class_type": "LoadImage", "inputs": {"image": "reference.png"}}}
    r = client.post("/comfy/api/prompt", json={"prompt": prompt})
    assert r.status_code == 200
    job_id = r.json()["prompt_id"]
    job_input = os.path.join(client.data_dir, "job_inputs", job_id, "reference.png")
    with open(job_input, "rb") as f:
        assert f.read() == b"ALICE-BYTES"


def test_prompt_copies_staged_asset_into_job_inputs(client):
    _login(client)
    client.post("/comfy/api/upload/image", files={"image": ("ref.png", b"STAGED", "image/png")})

    prompt = {"1": {"class_type": "LoadImage", "inputs": {"image": "ref.png"}}}
    r = client.post("/comfy/api/prompt", json={"prompt": prompt})
    assert r.status_code == 200
    job_id = r.json()["prompt_id"]

    job_input = os.path.join(client.data_dir, "job_inputs", job_id, "ref.png")
    assert os.path.isfile(job_input)
    with open(job_input, "rb") as f:
        assert f.read() == b"STAGED"

    # Copy, not move: the staged file is still there for reuse by another prompt.
    staged = os.path.join(client.data_dir, "comfy_staging", _uid(), "ref.png")
    assert os.path.isfile(staged)

    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        assert json.loads(job.input_assets) == ["ref.png"]


# --- Task 4: per-user panel isolation ---------------------------------------
#
# The panel is a per-user workspace now (any logged-in user, not just admin):
# every panel-native route is scoped to `origin == "panel" AND user_id ==
# <the caller's own uid>`. These tests exercise that with two real distinct
# accounts (`two_users`) rather than the single-admin scenario every test
# above this section uses -- a single-admin fixture can never catch a missing
# `user_id` predicate, since admin's own uid trivially "matches itself".


def _queue_ids(body):
    return {e[1] for e in body["queue_running"]} | {e[1] for e in body["queue_pending"]}


def test_queue_isolated_between_users(client, two_users):
    _login(client, *ALICE)
    alice_job = _post_prompt(client).json()["prompt_id"]

    _login(client, *BOB)
    bob_job = _post_prompt(client).json()["prompt_id"]

    _login(client, *ALICE)
    alice_ids = _queue_ids(client.get("/comfy/api/queue").json())
    assert alice_job in alice_ids
    assert bob_job not in alice_ids

    _login(client, *BOB)
    bob_ids = _queue_ids(client.get("/comfy/api/queue").json())
    assert bob_job in bob_ids
    assert alice_job not in bob_ids


def test_history_isolated_between_users(client, two_users):
    admin_csrf = _login(client)
    worker_id = _register_worker(client, admin_csrf, "shared-runner")

    _login(client, *ALICE)
    alice_job = _post_prompt(client).json()["prompt_id"]
    _login(client, *BOB)
    bob_job = _post_prompt(client).json()["prompt_id"]

    for job_id in (alice_job, bob_job):
        picked = _pick_job_for(worker_id)
        assert picked is not None and picked.id == job_id
        assert dispatch.mark_running(job_id, worker_id)
        assert dispatch.mark_done(job_id, worker_id, [f"{job_id}.png"])

    _login(client, *ALICE)
    alice_history = client.get("/comfy/api/history").json()
    assert set(alice_history) == {alice_job}
    assert client.get(f"/comfy/api/history/{bob_job}").json() == {}

    _login(client, *BOB)
    bob_history = client.get("/comfy/api/history").json()
    assert set(bob_history) == {bob_job}
    assert client.get(f"/comfy/api/history/{alice_job}").json() == {}


def test_interrupt_only_cancels_the_callers_own_running_job(client, two_users):
    admin_csrf = _login(client)
    worker_a = _register_worker(client, admin_csrf, "runner-a")
    worker_b = _register_worker(client, admin_csrf, "runner-b")

    _login(client, *ALICE)
    alice_job = _post_prompt(client).json()["prompt_id"]
    _login(client, *BOB)
    bob_job = _post_prompt(client).json()["prompt_id"]

    with db.get_session() as session:
        for job_id, worker_id in ((alice_job, worker_a), (bob_job, worker_b)):
            job = session.get(db.Job, job_id)
            job.status = "running"
            job.worker_id = worker_id
        session.commit()

    _login(client, *ALICE)
    r = client.post("/comfy/api/interrupt")
    assert r.status_code == 200

    with db.get_session() as session:
        assert session.get(db.Job, alice_job).status == "cancelled"
        # Bob's job, also running, is untouched by Alice's interrupt.
        assert session.get(db.Job, bob_job).status == "running"


def test_queue_delete_only_touches_the_callers_own_job(client, two_users):
    _login(client, *ALICE)
    alice_job = _post_prompt(client).json()["prompt_id"]
    _login(client, *BOB)
    bob_job = _post_prompt(client).json()["prompt_id"]

    # Bob tries to delete Alice's job by id -- scoping means it is simply
    # not his to name, same as a console-origin job never was.
    r = client.post("/comfy/api/queue", json={"delete": [alice_job, bob_job]})
    assert r.status_code == 200

    with db.get_session() as session:
        assert session.get(db.Job, alice_job).status == "queued"
        assert session.get(db.Job, bob_job).status == "cancelled"


def test_queue_clear_only_touches_the_callers_own_jobs(client, two_users):
    _login(client, *ALICE)
    alice_job = _post_prompt(client).json()["prompt_id"]
    _login(client, *BOB)
    bob_job = _post_prompt(client).json()["prompt_id"]

    _login(client, *ALICE)
    r = client.post("/comfy/api/queue", json={"clear": True})
    assert r.status_code == 200

    with db.get_session() as session:
        assert session.get(db.Job, alice_job).status == "cancelled"
        assert session.get(db.Job, bob_job).status == "queued"


def test_history_hide_only_touches_the_callers_own_job(client, two_users):
    admin_csrf = _login(client)
    worker_id = _register_worker(client, admin_csrf, "shared-runner")

    _login(client, *ALICE)
    alice_job = _post_prompt(client).json()["prompt_id"]
    _login(client, *BOB)
    bob_job = _post_prompt(client).json()["prompt_id"]

    for job_id in (alice_job, bob_job):
        picked = _pick_job_for(worker_id)
        assert picked is not None and picked.id == job_id
        assert dispatch.mark_running(job_id, worker_id)
        assert dispatch.mark_done(job_id, worker_id, [f"{job_id}.png"])

    _login(client, *ALICE)
    r = client.post("/comfy/api/history", json={"delete": [alice_job, bob_job]})
    assert r.status_code == 200

    with db.get_session() as session:
        assert session.get(db.Job, alice_job).panel_hidden is True
        # Bob's job cannot be hidden by Alice's request, scoping prevented
        # it from ever matching the write's own query.
        assert session.get(db.Job, bob_job).panel_hidden is False


def test_view_404_for_a_panel_job_owned_by_another_user(client, two_users):
    admin_csrf = _login(client)
    worker_id = _register_worker(client, admin_csrf, "shared-runner")

    _login(client, *ALICE)
    alice_job = _post_prompt(client).json()["prompt_id"]
    picked = _pick_job_for(worker_id)
    assert picked is not None and picked.id == alice_job
    assert dispatch.mark_running(alice_job, worker_id)
    store = storage.get_store(client.data_dir)
    store.put(alice_job, "out.png", io.BytesIO(b"ALICE-BYTES"))
    assert dispatch.mark_done(alice_job, worker_id, ["out.png"])

    # Alice can see her own artifact...
    r = client.get(
        "/comfy/api/view",
        params={"filename": "out.png", "type": "output", "subfolder": alice_job},
    )
    assert r.status_code == 200
    assert r.content == b"ALICE-BYTES"
    # ...and the subfolder-less legacy fallback also resolves it for her.
    r = client.get("/comfy/api/view", params={"filename": "out.png"})
    assert r.status_code == 200

    # Bob names the exact same job id and filename -- 404, not Alice's bytes.
    _login(client, *BOB)
    r = client.get(
        "/comfy/api/view",
        params={"filename": "out.png", "type": "output", "subfolder": alice_job},
    )
    assert r.status_code == 404
    # The legacy fallback must not leak it to Bob either.
    r = client.get("/comfy/api/view", params={"filename": "out.png"})
    assert r.status_code == 404


def test_admin_panel_view_excludes_other_users_panel_jobs(client, two_users):
    """Spec ruling: an admin's panel is personal too -- full fleet visibility
    lives in the console (`/api/jobs`), not here."""
    admin_csrf = _login(client)
    worker_id = _register_worker(client, admin_csrf, "shared-runner")

    _login(client, *ALICE)
    alice_job = _post_prompt(client).json()["prompt_id"]

    admin_csrf = _login(client)  # back to admin -- refreshes the csrf token too
    admin_job = _post_prompt(client).json()["prompt_id"]

    for job_id in (alice_job, admin_job):
        picked = _pick_job_for(worker_id)
        assert picked is not None and picked.id == job_id
        assert dispatch.mark_running(job_id, worker_id)
        assert dispatch.mark_done(job_id, worker_id, [f"{job_id}.png"])

    admin_queue_ids = _queue_ids(client.get("/comfy/api/queue").json())
    assert alice_job not in admin_queue_ids

    admin_history = client.get("/comfy/api/history").json()
    assert set(admin_history) == {admin_job}

    r = client.get(
        "/comfy/api/view",
        params={"filename": f"{alice_job}.png", "type": "output", "subfolder": alice_job},
    )
    assert r.status_code == 404

    # Admin's full-fleet audit surface (the console API) still sees both.
    listed = {j["id"] for j in client.get("/api/jobs", headers={"X-CSRF": admin_csrf}).json()}
    assert {alice_job, admin_job} <= listed


# ------------------------------------------------------------ panel bootstrap
#
# The stock frontend calls all of these before it will render a canvas, and it
# does not degrade when they 404 -- an error body where it expects a list makes
# GraphView throw and the page stays blank. What matters is the JSON *type* of
# each response, so that is what these assert.


@pytest.mark.parametrize(
    "path,expected",
    [
        ("/comfy/api/features", {}),
        ("/comfy/api/users", {"storage": "server", "migrated": False}),
        # Without the /comfy mount prefix: the frontend joins listed URLs
        # onto its own api base (/comfy); a prefixed path would double up.
        ("/comfy/api/extensions", ["/api/comfyfed-ext/comfyfed.js"]),
        ("/comfy/api/embeddings", []),
        ("/comfy/api/models", []),
        ("/comfy/api/i18n", {}),
        ("/comfy/api/global_subgraphs", {}),
        ("/comfy/api/folder_paths", {}),
    ],
)
def test_bootstrap_routes_return_the_empty_upstream_shape(client, path, expected):
    _login(client)
    r = client.get(path)
    assert r.status_code == 200
    assert r.json() == expected


def test_bootstrap_routes_require_a_session(client):
    assert client.get("/comfy/api/features").status_code == 401


def test_panel_extension_js_is_served(client):
    # The frontend fetches `/comfy/api/extensions` and dynamically imports
    # every module URL it lists; this is how ComfyFed hides the dead
    # Comfy-cloud login button without patching the pinned frontend dist.
    _login(client)
    r = client.get("/comfy/api/comfyfed-ext/comfyfed.js")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/javascript")
    body = r.text
    assert body
    assert "display:none" in body.replace(" ", "")


def test_panel_extension_js_requires_a_session(client):
    assert client.get("/comfy/api/comfyfed-ext/comfyfed.js").status_code == 401


def test_system_stats_reports_no_local_devices(client):
    _login(client)
    r = client.get("/comfy/api/system_stats")
    assert r.status_code == 200
    body = r.json()
    # The platform owns no GPU; compute lives on the workers.
    assert body["devices"] == []
    assert body["system"]["comfyfed_online_workers"] == 0


def test_get_prompt_reports_queue_remaining(client):
    csrf = _login(client)
    _register_worker(client, csrf, "w1", object_info={"KSampler": {}})

    before = client.get("/comfy/api/prompt")
    assert before.status_code == 200
    assert before.json() == {"exec_info": {"queue_remaining": 0}}

    assert _post_prompt(client).status_code == 200
    assert client.get("/comfy/api/prompt").json()["exec_info"]["queue_remaining"] == 1


def test_panel_settings_round_trip_and_persist(client):
    _login(client)

    # Never written: upstream answers `null`, not 404.
    assert client.get("/comfy/api/settings").json() == {}
    assert client.get("/comfy/api/settings/Comfy.ColorPalette").json() is None

    assert client.post("/comfy/api/settings/Comfy.ColorPalette", json="dark").status_code == 200
    assert client.post("/comfy/api/settings", json={"Comfy.Zoom": 1.25}).status_code == 200

    assert client.get("/comfy/api/settings/Comfy.ColorPalette").json() == "dark"
    assert client.get("/comfy/api/settings").json() == {
        "Comfy.ColorPalette": "dark",
        "Comfy.Zoom": 1.25,
    }

    # Written through to disk, so a restart keeps the panel's preferences --
    # per-user (final review finding #7), not the legacy global file.
    with open(
        os.path.join(client.data_dir, f"comfy_settings.{_uid()}.json"), encoding="utf-8"
    ) as f:
        assert json.load(f)["Comfy.ColorPalette"] == "dark"


def test_panel_settings_are_isolated_between_users_and_a_legacy_global_blob_is_the_fallback_default(
    client, two_users
):
    """Final review finding #7: `/comfy/api/settings` used to be one global
    blob writable by every user -- a regular user's write silently
    overwrote every other user's, admins included. Also verifies the
    upgrade-safety fallback: a user who has never written their own
    settings reads the pre-Task-4 legacy global blob if one exists, so
    nobody's editor appears to reset."""
    legacy_path = os.path.join(client.data_dir, "comfy_settings.json")
    os.makedirs(client.data_dir, exist_ok=True)
    with open(legacy_path, "w", encoding="utf-8") as f:
        json.dump({"Comfy.ColorPalette": "legacy-theme"}, f)

    # Alice has never written her own settings -- she reads the legacy blob.
    _login(client, *ALICE)
    assert client.get("/comfy/api/settings").json() == {"Comfy.ColorPalette": "legacy-theme"}

    # Alice writes her own setting -- this forks her OWN file from here on.
    assert client.post("/comfy/api/settings/Comfy.Zoom", json=2.0).status_code == 200
    assert client.get("/comfy/api/settings").json() == {
        "Comfy.ColorPalette": "legacy-theme",
        "Comfy.Zoom": 2.0,
    }

    # Bob, who has also never written his own settings, still reads the
    # legacy blob -- Alice's write did not touch it.
    _login(client, *BOB)
    assert client.get("/comfy/api/settings").json() == {"Comfy.ColorPalette": "legacy-theme"}

    # Bob's own write is independent of Alice's.
    assert client.post("/comfy/api/settings/Comfy.ColorPalette", json="bobs-theme").status_code == 200
    assert client.get("/comfy/api/settings").json() == {"Comfy.ColorPalette": "bobs-theme"}

    # Alice's settings are untouched by Bob's write.
    _login(client, *ALICE)
    assert client.get("/comfy/api/settings").json() == {
        "Comfy.ColorPalette": "legacy-theme",
        "Comfy.Zoom": 2.0,
    }


# --- Phase 3.3 §3.7: the panel only ever sees the parent ----------------------


def _split_family(uid, *, parent_status="done", child_statuses=("done", "done")):
    """A parent plus len(child_statuses) children, all panel-origin and owned
    by `uid` (children inherit both from the parent -- see split.create_children)."""
    workflow = json.dumps({"2": {"class_type": "SaveImage", "inputs": {}}})
    with db.get_session() as session:
        session.add(
            db.Job(
                id="p",
                workflow_json=workflow,
                status=parent_status,
                origin="panel",
                user_id=uid,
                split_count=len(child_statuses),
            )
        )
        for index, status in enumerate(child_statuses):
            session.add(
                db.Job(
                    id=f"c{index}",
                    workflow_json=workflow,
                    status=status,
                    origin="panel",
                    user_id=uid,
                    parent_id="p",
                    split_index=index,
                    result_files=json.dumps([f"c{index}.png"]) if status == "done" else "[]",
                )
            )
        session.commit()


def test_history_hides_children_and_merges_their_outputs(client):
    _login(client)
    _split_family(_uid())

    body = client.get("/comfy/api/history").json()
    assert list(body) == ["p"]
    images = body["p"]["outputs"]["2"]["images"]
    assert images == [
        {"filename": "c0.png", "subfolder": "c0", "type": "output"},
        {"filename": "c1.png", "subfolder": "c1", "type": "output"},
    ]


def test_history_by_prompt_id_returns_nothing_for_a_child(client):
    _login(client)
    _split_family(_uid())

    assert client.get("/comfy/api/history/c0").json() == {}
    assert list(client.get("/comfy/api/history/p").json()) == ["p"]


def test_queue_hides_children(client):
    _login(client)
    _split_family(_uid(), parent_status="running", child_statuses=("running", "queued"))

    body = client.get("/comfy/api/queue").json()
    ids = [entry[1] for entry in body["queue_running"] + body["queue_pending"]]
    assert ids == ["p"]


def test_hiding_a_parent_from_history_hides_the_whole_family(client):
    _login(client)
    _split_family(_uid())

    r = client.post("/comfy/api/history", json={"delete": ["p"]})
    assert r.status_code == 200
    assert client.get("/comfy/api/history").json() == {}


def test_view_serves_a_childs_file_through_the_child_subfolder(client):
    _login(client)
    _split_family(_uid())
    store = storage.get_store(client.data_dir)
    store.put("c1", "c1.png", io.BytesIO(b"child-bytes"))

    r = client.get("/comfy/api/view", params={"filename": "c1.png", "subfolder": "c1"})
    assert r.status_code == 200
    assert r.content == b"child-bytes"


def test_view_refuses_another_users_child_file(client):
    admin_csrf = _login(client)
    _create_user(client, admin_csrf, "alice")
    _split_family(_uid("alice"))
    store = storage.get_store(client.data_dir)
    store.put("c1", "c1.png", io.BytesIO(b"child-bytes"))

    r = client.get("/comfy/api/view", params={"filename": "c1.png", "subfolder": "c1"})
    assert r.status_code == 404


def test_history_keeps_each_child_as_the_owner_of_a_colliding_filename(client):
    """Every worker numbers `ComfyUI_00001_.png` from its own counter, so two
    children of one parent routinely produce the SAME filename -- each entry
    must keep ITS OWN child as the subfolder, or one child's image is served
    twice and the other is unreachable."""
    _login(client)
    _split_family(_uid())
    with db.get_session() as session:
        for child_id in ("c0", "c1"):
            session.get(db.Job, child_id).result_files = json.dumps(["ComfyUI_00001_.png"])
        session.commit()

    body = client.get("/comfy/api/history").json()
    assert body["p"]["outputs"]["2"]["images"] == [
        {"filename": "ComfyUI_00001_.png", "subfolder": "c0", "type": "output"},
        {"filename": "ComfyUI_00001_.png", "subfolder": "c1", "type": "output"},
    ]
