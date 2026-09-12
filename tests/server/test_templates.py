"""The packaged workflow-template library and the routes that serve it.

The frontend's template browser is unforgiving: it fetches fixed paths and
reads fixed field names out of `index.json`, and anything it cannot parse
renders as an empty browser rather than an error. So these tests pin the URL
shapes and the schema, not just "a file comes back".
"""

import gzip
import json
import os

import pytest
from fastapi.testclient import TestClient

from comfyfed_server import app as app_module
from comfyfed_server import bootstrap, comfyapi, db, templates


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


# --- package data ------------------------------------------------------


def test_package_data_is_locatable_via_importlib_resources():
    """A wheel install has no repo layout to fall back on."""
    root = templates.templates_dir()
    assert os.path.isfile(os.path.join(root, "index.json"))
    for name in templates.TEMPLATE_NAMES:
        assert os.path.isfile(os.path.join(root, f"{name}.json"))
        assert os.path.isfile(os.path.join(root, f"{name}-1.webp"))
    assert templates.asset_names() == ["amyntas_ref.png"]
    assert os.path.isfile(os.path.join(templates.assets_dir(), "amyntas_ref.png"))


def test_index_json_has_the_fields_the_frontend_reads():
    with open(os.path.join(templates.templates_dir(), "index.json"), encoding="utf-8") as f:
        index = json.load(f)

    assert isinstance(index, list) and index
    category = index[0]
    # `moduleName == "default"` is what makes the frontend resolve workflows
    # and thumbnails through `/comfy/templates/...` instead of the
    # custom-node API; `isEssential`/`category` give the sidebar a home for it.
    assert category["moduleName"] == "default"
    assert category["title"] and category["type"]
    assert category["isEssential"] is True
    assert category["category"]

    names = [t["name"] for t in category["templates"]]
    assert names == list(templates.TEMPLATE_NAMES)
    for entry in category["templates"]:
        assert entry["title"]
        assert entry["description"]
        assert entry["mediaType"] == "image"
        assert entry["mediaSubtype"] == "webp"
        assert isinstance(entry["tags"], list) and entry["tags"]
        assert isinstance(entry["models"], list) and entry["models"]


@pytest.mark.parametrize("name", templates.TEMPLATE_NAMES)
def test_template_workflow_is_annotated_ui_format(name):
    with open(os.path.join(templates.templates_dir(), f"{name}.json"), encoding="utf-8") as f:
        workflow = json.load(f)

    # UI (graph) format, not API format: the browser hands this straight to
    # the canvas.
    assert workflow["version"] == 0.4
    assert isinstance(workflow["nodes"], list) and workflow["nodes"]
    assert isinstance(workflow["links"], list) and workflow["links"]

    notes = [n for n in workflow["nodes"] if n["type"] in ("Note", "MarkdownNote")]
    assert len(notes) >= 3
    # Every note is bilingual: zh-TW for the novice reading it, English so an
    # operator sharing a screenshot is not stuck.
    for note in notes:
        text = note["widgets_values"][0]
        assert any("一" <= ch <= "鿿" for ch in text), note["id"]
        assert sum(ch.isascii() and ch.isalpha() for ch in text) > 100, note["id"]

    # Every stage of the graph is boxed and titled.
    titles = [g["title"] for g in workflow["groups"]]
    assert len(titles) == 4
    assert all(t.strip() for t in titles)

    # Link endpoints resolve.
    node_ids = {n["id"] for n in workflow["nodes"]}
    for link_id, src, _src_slot, dst, _dst_slot, _wire in workflow["links"]:
        assert src in node_ids and dst in node_ids, link_id


@pytest.mark.parametrize("name", templates.TEMPLATE_NAMES)
def test_templates_only_reference_packaged_assets(name):
    with open(os.path.join(templates.templates_dir(), f"{name}.json"), encoding="utf-8") as f:
        workflow = json.load(f)

    packaged = set(templates.asset_names())
    for node in workflow["nodes"]:
        if node["type"] != "LoadImage":
            continue
        assert node["widgets_values"][0] in packaged


# --- routes ------------------------------------------------------------


def test_index_workflow_and_thumbnail_are_served(client):
    _login(client)

    r = client.get("/comfy/templates/index.json")
    assert r.status_code == 200
    assert "application/json" in r.headers["content-type"]
    assert [t["name"] for t in r.json()[0]["templates"]] == list(templates.TEMPLATE_NAMES)

    r = client.get("/comfy/templates/comfyfed-wuxia-t2i.json")
    assert r.status_code == 200
    assert r.json()["version"] == 0.4

    r = client.get("/comfy/templates/comfyfed-wuxia-t2i-1.webp")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/webp"
    assert r.content[:4] == b"RIFF"


def test_missing_and_traversing_template_paths_404(client):
    _login(client)
    assert client.get("/comfy/templates/nope.json").status_code == 404
    assert client.get("/comfy/templates/..%2F..%2Fcomfyfed.db").status_code == 404


def test_templates_require_a_session(client):
    r = client.get("/comfy/templates/index.json", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == "/"


def test_workflow_templates_api_answers_empty(client):
    _login(client)
    r = client.get("/comfy/api/workflow_templates")
    assert r.status_code == 200
    assert r.json() == {}


def test_workflow_templates_api_requires_auth(client):
    assert client.get("/comfy/api/workflow_templates").status_code == 401


# --- staging seed + object_info injection -------------------------------


def test_create_app_seeds_template_assets_into_staging(client):
    staged = os.path.join(comfyapi.staging_dir(client.data_dir), "amyntas_ref.png")
    assert os.path.isfile(staged)


def test_seed_staging_does_not_clobber_an_existing_file(tmp_path):
    staging = str(tmp_path / "comfy_staging")
    os.makedirs(staging)
    target = os.path.join(staging, "amyntas_ref.png")
    with open(target, "wb") as f:
        f.write(b"mine")

    assert templates.seed_staging(staging) == []
    with open(target, "rb") as f:
        assert f.read() == b"mine"


def _register_worker_with(client, csrf, object_info):
    r = client.post("/api/workers/tokens", json={"name": "w"}, headers={"X-CSRF": csrf})
    token = r.json()["bundle"]["register_token"]
    reg = client.post(
        "/api/agent/register", json={"token": token, "name": "w", "pubkey": "ab" * 32}
    )
    worker_id = reg.json()["worker_id"]

    from comfyfed_server import workers as workers_module

    path = workers_module.object_info_path(client.data_dir, worker_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(gzip.compress(json.dumps(object_info).encode()))

    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.status = "online"
        worker.object_info_hash = "h"
        session.commit()
    return worker_id


def test_object_info_offers_staged_images_in_upload_dropdowns(client):
    csrf = _login(client)
    _register_worker_with(
        client,
        csrf,
        {
            "LoadImage": {
                "input": {"required": {"image": [["worker_local.png"], {"image_upload": True}]}},
                "output": ["IMAGE", "MASK"],
            },
            "LoadImageMask": {
                "input": {
                    "required": {
                        "image": ["COMBO", {"options": ["worker_local.png"], "image_upload": True}]
                    }
                },
            },
            "CLIPTextEncode": {
                "input": {"required": {"text": ["STRING", {"multiline": True}]}},
            },
        },
    )

    with open(os.path.join(comfyapi.staging_dir(client.data_dir), "uploaded.png"), "wb") as f:
        f.write(b"x")

    body = client.get("/comfy/api/object_info").json()

    legacy = body["LoadImage"]["input"]["required"]["image"][0]
    assert legacy == ["worker_local.png", "amyntas_ref.png", "uploaded.png"]

    combo = body["LoadImageMask"]["input"]["required"]["image"][1]["options"]
    assert combo == ["worker_local.png", "amyntas_ref.png", "uploaded.png"]

    # Nodes with no upload widget are untouched.
    assert body["CLIPTextEncode"]["input"]["required"]["text"] == ["STRING", {"multiline": True}]


def test_object_info_injection_does_not_duplicate_or_poison_the_cache(client):
    csrf = _login(client)
    _register_worker_with(
        client,
        csrf,
        {"LoadImage": {"input": {"required": {"image": [["amyntas_ref.png"], {"image_upload": True}]}}}},
    )

    first = client.get("/comfy/api/object_info").json()
    second = client.get("/comfy/api/object_info").json()

    # Already present in the worker's own list -> merged, not duplicated, and
    # the second (cache-hit) request must not have grown the list again.
    assert first["LoadImage"]["input"]["required"]["image"][0] == ["amyntas_ref.png"]
    assert second == first
