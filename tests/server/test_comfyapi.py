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
from comfyfed_server import bootstrap, comfyapi, db, dispatch, storage, workers


@pytest.fixture()
def client(tmp_path):
    comfyapi.clear_object_info_cache()
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
    picked = dispatch.pick_job_for(worker_id)
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
    ],
)
def test_all_routes_require_admin_session(client, method, path):
    r = getattr(client, method)(path, follow_redirects=False)
    assert r.status_code == 401


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


# --- queue -----------------------------------------------------------------


def test_queue_shape_splits_running_and_pending(client):
    csrf = _login(client)
    queued_id = _post_prompt(client).json()["prompt_id"]
    running_id = _post_prompt(client).json()["prompt_id"]

    worker_id = _register_worker(client, csrf, "runner")
    picked = dispatch.pick_job_for(worker_id)
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
    dispatch.pick_job_for(worker_id)
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

    staged = os.path.join(client.data_dir, "comfy_staging", "ref.png")
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

    staged = os.path.join(client.data_dir, "comfy_staging", "ref.png")
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
    staged = os.path.join(client.data_dir, "comfy_staging", "ref.png")
    assert os.path.isfile(staged)

    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        assert json.loads(job.input_assets) == ["ref.png"]


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
        ("/comfy/api/extensions", []),
        ("/comfy/api/embeddings", []),
        ("/comfy/api/models", []),
        ("/comfy/api/i18n", {}),
        ("/comfy/api/global_subgraphs", {}),
    ],
)
def test_bootstrap_routes_return_the_empty_upstream_shape(client, path, expected):
    _login(client)
    r = client.get(path)
    assert r.status_code == 200
    assert r.json() == expected


def test_bootstrap_routes_require_a_session(client):
    assert client.get("/comfy/api/features").status_code == 401


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

    # Written through to disk, so a restart keeps the panel's preferences.
    with open(os.path.join(client.data_dir, "comfy_settings.json"), encoding="utf-8") as f:
        assert json.load(f)["Comfy.ColorPalette"] == "dark"
