"""The packaged workflow-template library and the routes that serve it.

The frontend's template browser is unforgiving: it fetches fixed paths and
reads fixed field names out of `index.json`, and anything it cannot parse
renders as an empty browser rather than an error. So these tests pin the URL
shapes and the schema, not just "a file comes back".
"""

import gzip
import json
import os
import re

import pytest
from fastapi.testclient import TestClient

from comfyfed_server import app as app_module
from comfyfed_server import bootstrap, comfyapi, db, official_templates, templates

# Task 5: dual official/GCS-backup links. This is the single ground truth the
# anti-drift tests below check everything against -- every model filename the
# packaged workflow JSONs reference, and every download link in the "Missing
# models?" notes and the README, must trace back to one of these entries.
# The old Cloudflare R2 mirror (models.aiinpocket.com) is decommissioned;
# every mention of it anywhere under server/ or docs/ must be gone.
GCS_MODEL_BASE = "https://storage.googleapis.com/comfyfed-models/models/"
DECOMMISSIONED_MIRROR_DOMAIN = "models.aiinpocket.com"
MODEL_SOURCES = {
    "flux1-dev.safetensors": {
        "dir": "diffusion_models",
        "official": "https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/flux1-dev.safetensors",
        "gated": True,
    },
    "clip_l.safetensors": {
        "dir": "text_encoders",
        "official": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors",
        "gated": False,
    },
    "t5xxl_fp16.safetensors": {
        "dir": "text_encoders",
        "official": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp16.safetensors",
        "gated": False,
    },
    "ae.safetensors": {
        "dir": "vae",
        "official": "https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/ae.safetensors",
        "gated": True,
    },
    "minimax_h3_ref2va_pruned_int8_convrot.safetensors": {
        "dir": "diffusion_models",
        "official": "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors",
        "gated": False,
    },
    "qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors": {
        "dir": "text_encoders",
        "official": "https://huggingface.co/sakamakismile/Qwen3-VL-32B-Heretic-MiniMax-H3-NVFP4/resolve/main/qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors",
        "gated": False,
    },
    "minimax_h3_video_vae_fp16.safetensors": {
        "dir": "vae",
        "official": "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors",
        "gated": False,
    },
    "minimax_h3_audio_vae_fp32.safetensors": {
        "dir": "vae",
        "official": "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors",
        "gated": False,
    },
    "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors": {
        "dir": "loras",
        "official": "https://huggingface.co/drbaph/MiniMax-H3-Turbo-Lora-ComfyUI/resolve/main/minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors",
        "gated": False,
    },
    # Phase 1.8b Task 2, model registry entry #10 -- shared by the two
    # prompt-helper templates below.
    "qwen3vl_4b_bf16.safetensors": {
        "dir": "text_encoders",
        "official": "https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_bf16.safetensors",
        "gated": False,
    },
}
MODEL_INVENTORY = set(MODEL_SOURCES)
FLUX_GATED_CAVEAT = "（需登入 HuggingFace 並同意 FLUX.1-dev 授權）"
MISSING_MODELS_NOTE_TITLE = "⓪ 缺模型？/ Missing models?"

# Phase 1.8 Task 1 added two zero-model templates: no loaders, no "缺模型？"
# note, and a 3-group layout (①選素材 ②合併 ③輸出) instead of the 4-group
# layout the model-bearing templates use. Every assertion that only makes
# sense for a template with loaders/models is scoped to the other three via
# MODEL_BEARING_TEMPLATE_NAMES, so it keeps checking those three exactly as
# strictly as before instead of silently covering fewer templates.
ZERO_MODEL_TEMPLATE_NAMES = ("comfyfed-video-concat", "comfyfed-image-intro-video")
MODEL_BEARING_TEMPLATE_NAMES = tuple(
    n for n in ("comfyfed-wuxia-t2i", "comfyfed-character-portrait", "comfyfed-ref2v-video")
)
# Phase 1.8b Task 2 added two more model-bearing templates that share a
# single model each (rather than several) and use the same 3-group layout as
# the zero-model templates instead of the 4-group layout the three
# MODEL_BEARING_TEMPLATE_NAMES above use (they have no separate "load model"
# group, nor the "這是什麼範本" intro note those three share -- their ⓪ 缺模型？
# note plus ①②③ notes cover the same ground more compactly). They still carry
# a "缺模型？" note with the dual official/GCS-backup link format, so the
# note-format tests below run over both sets combined
# (NOTE_BEARING_TEMPLATE_NAMES) rather than skipping these two.
ONE_MODEL_TEMPLATE_NAMES = ("comfyfed-image-to-prompt", "comfyfed-text-to-prompt")
NOTE_BEARING_TEMPLATE_NAMES = MODEL_BEARING_TEMPLATE_NAMES + ONE_MODEL_TEMPLATE_NAMES
ZERO_MODEL_ALLOWED_NODE_TYPES = {
    "MarkdownNote",
    "LoadImage",
    "LoadVideo",
    "GetVideoComponents",
    "ImageBatch",
    "AudioConcat",
    "CreateVideo",
    "SaveVideo",
    "ImageScale",
    "RepeatImageBatch",
}


def _backup_url(name):
    return GCS_MODEL_BASE + MODEL_SOURCES[name]["dir"] + "/" + name


# A model link, i.e. the mirror base plus at least one path character. URL
# characters only, so prose that quotes the bare base in backticks (the
# README's "the mirror lives at `<base>/`" sentences) is not mistaken for a
# link to a file called 「，目錄結構…」.
_GCS_URL_RE = re.compile(re.escape(GCS_MODEL_BASE) + r"[A-Za-z0-9._/~%+-]+")


def _gcs_urls_in(text):
    # Trailing markdown/punctuation (`)`, `.`, etc.) never belongs to the URL.
    return [u.rstrip(").,;。）") for u in _GCS_URL_RE.findall(text)]


def _repo_root():
    return os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))


# Trees that hold no shipped prose: build artifacts, VCS metadata, review
# notes (which legitimately quote the decommissioned domain when recording
# that it WAS decommissioned), and anything not under version control.
_UNSCANNED_DIRS = {
    ".git",
    ".venv",
    "venv",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    "build",
    "dist",
    ".superpowers",
    ".egg-info",
}


def _iter_repo_text_files(*subdirs):
    """Every readable text file in the repo, or only under `subdirs`."""
    roots = [os.path.join(_repo_root(), s) for s in subdirs] or [_repo_root()]
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [
                d for d in dirnames
                if d not in _UNSCANNED_DIRS and not d.endswith(".egg-info")
            ]
            for filename in filenames:
                path = os.path.join(dirpath, filename)
                try:
                    with open(path, encoding="utf-8") as f:
                        yield path, f.read()
                except (UnicodeDecodeError, OSError):
                    continue


def test_decommissioned_mirror_domain_appears_nowhere_in_the_repo():
    """The old Cloudflare R2 mirror's domain is gone from every shipped tree.

    Widened past `server/` + `docs/` after the branch's README kept pointing
    at the dead bucket while the tables underneath already said GCS: the
    README lives at the repo root and was never scanned.
    """
    tests_root = os.path.join(_repo_root(), "tests") + os.sep
    offenders = [
        path
        for path, text in _iter_repo_text_files()
        # The test suite itself has to spell the domain out in order to guard
        # against it; everything else is shipped material.
        if DECOMMISSIONED_MIRROR_DOMAIN in text and not path.startswith(tests_root)
    ]
    assert not offenders, offenders


# "R2" alone is a false-positive magnet: the README's roadmap legitimately
# names Cloudflare R2 as a possible future artifact store, which is not a
# claim about today's model mirror. So the guard is scoped to the sections
# that actually describe the mirror -- the two 模型下載 / "Model downloads"
# headings -- where any mention of R2 is by definition the stale prose.
_MODEL_SECTION_HEADINGS = ("### 模型下載", "### Model downloads")


def _readme_text():
    with open(os.path.join(_repo_root(), "README.md"), encoding="utf-8") as f:
        return f.read()


def _readme_sections(text, headings):
    for heading in headings:
        start = text.index(heading)
        end = text.find("\n## ", start)
        next_sub = text.find("\n### ", start + len(heading))
        if next_sub != -1 and (end == -1 or next_sub < end):
            end = next_sub
        yield heading, text[start : end if end != -1 else len(text)]


def test_readme_model_download_sections_do_not_name_the_dead_r2_mirror():
    for heading, section in _readme_sections(_readme_text(), _MODEL_SECTION_HEADINGS):
        assert "R2" not in section, heading
        assert "Cloudflare" not in section, heading


def test_readme_model_download_sections_describe_the_gcs_mirror():
    for heading, section in _readme_sections(_readme_text(), _MODEL_SECTION_HEADINGS):
        assert "storage.googleapis.com/comfyfed-models" in section, heading


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
    assert templates.asset_names() == ["amyntas_ref.png", "comfyfed_sample_clip.mp4"]
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
        assert isinstance(entry["models"], list)
        if entry["name"] in ZERO_MODEL_TEMPLATE_NAMES:
            assert entry["models"] == [], entry["name"]
        else:
            assert entry["models"], entry["name"]


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

    # Every stage of the graph is boxed and titled. The three MODEL_BEARING
    # templates lay out 4 groups (load / subject / sample / output); the
    # zero-model templates collapse that to 3 (①選素材 ②合併 ③輸出); the two
    # ONE_MODEL prompt-helper templates also use a 3-group layout (①素材/想法
    # ②組裝 ③輸出) since they only have one shared loader, not a whole
    # loader-only group's worth.
    titles = [g["title"] for g in workflow["groups"]]
    expected_groups = 3 if name in ZERO_MODEL_TEMPLATE_NAMES + ONE_MODEL_TEMPLATE_NAMES else 4
    assert len(titles) == expected_groups, name
    assert all(t.strip() for t in titles)

    # Link endpoints resolve.
    node_ids = {n["id"] for n in workflow["nodes"]}
    for link_id, src, _src_slot, dst, _dst_slot, _wire in workflow["links"]:
        assert src in node_ids and dst in node_ids, link_id


def _notes_by_title(name):
    with open(os.path.join(templates.templates_dir(), f"{name}.json"), encoding="utf-8") as f:
        workflow = json.load(f)
    return {
        node["title"]: node["widgets_values"][0]
        for node in workflow["nodes"]
        if node["type"] in ("Note", "MarkdownNote")
    }


def test_subject_specific_notes_are_not_shared_between_templates():
    """Guards against the obvious authoring slip: copy a template, forget a note.

    Only the model-loader note may legitimately be identical across the two
    Flux templates -- it describes the same three loaders and says nothing
    about the subject. Every other note walks the reader through what THIS
    template makes, so sharing one verbatim means it is describing the wrong
    thing.
    """
    shareable = "① 模型載入器 / Model loaders"
    seen: dict[str, str] = {}
    for name in templates.TEMPLATE_NAMES:
        for title, text in _notes_by_title(name).items():
            if title == shareable:
                continue
            owner = seen.setdefault(text, name)
            assert owner == name, f"{name} reuses {owner}'s note verbatim: {title}"


def test_portrait_prompt_note_is_about_portraits():
    note = _notes_by_title("comfyfed-character-portrait")["② 提示詞 / Prompt"]
    assert "wuxia" not in note.lower()
    # It has to say what this template is for and where its output goes next.
    assert "定裝照" in note
    assert "reference" in note.lower()


@pytest.mark.parametrize("name", templates.TEMPLATE_NAMES)
def test_templates_only_reference_packaged_assets(name):
    with open(os.path.join(templates.templates_dir(), f"{name}.json"), encoding="utf-8") as f:
        workflow = json.load(f)

    packaged = set(templates.asset_names())
    for node in workflow["nodes"]:
        if node["type"] not in ("LoadImage", "LoadVideo"):
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

    # Only the untouched sample clip gets seeded; the pre-existing image is
    # left alone.
    assert templates.seed_staging(staging) == ["comfyfed_sample_clip.mp4"]
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


def test_object_info_offers_staged_files_by_media_kind(client):
    """Videos land in `file`/video_upload dropdowns, images in `image` ones —
    never crosswise (a staged mp4 in a LoadImage list would just fail at
    execution)."""
    csrf = _login(client)
    _register_worker_with(
        client,
        csrf,
        {
            "LoadImage": {
                "input": {"required": {"image": [["w.png"], {"image_upload": True}]}},
            },
            "LoadVideo": {
                "input": {"required": {"file": [["w.mp4"], {"video_upload": True}]}},
            },
            "LoadAudio": {
                "input": {"required": {"audio": [["w.wav"], {"audio_upload": True}]}},
            },
        },
    )
    for name in ("clip.mp4", "voice.wav"):
        with open(os.path.join(comfyapi.staging_dir(client.data_dir), name), "wb") as f:
            f.write(b"x")

    body = client.get("/comfy/api/object_info").json()

    image_options = body["LoadImage"]["input"]["required"]["image"][0]
    video_options = body["LoadVideo"]["input"]["required"]["file"][0]
    audio_options = body["LoadAudio"]["input"]["required"]["audio"][0]

    assert "clip.mp4" in video_options and "comfyfed_sample_clip.mp4" in video_options
    assert "voice.wav" in audio_options
    # No cross-contamination in any direction.
    assert not any(n.endswith((".mp4", ".wav")) for n in image_options)
    assert not any(n.endswith((".png", ".wav")) for n in video_options)
    assert not any(n.endswith((".png", ".mp4")) for n in audio_options)
    # Images (packaged amyntas_ref.png) still reach the image dropdown.
    assert "amyntas_ref.png" in image_options


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


# --- Task 8: missing-model guide ---------------------------------------


def _loader_model_filenames(workflow):
    """Every `.safetensors` widget value in the graph -- i.e. the checkpoint,
    text-encoder, VAE and LoRA files a loader node names, regardless of which
    loader type carries it."""
    names = set()
    for node in workflow["nodes"]:
        for value in node.get("widgets_values", []):
            if isinstance(value, str) and value.endswith(".safetensors"):
                names.add(value)
    return names


def _missing_models_note_text(name):
    notes = _notes_by_title(name)
    assert MISSING_MODELS_NOTE_TITLE in notes, f"{name} has no missing-models note"
    return notes[MISSING_MODELS_NOTE_TITLE]


@pytest.mark.parametrize("name", MODEL_BEARING_TEMPLATE_NAMES)
def test_missing_models_note_exists_and_is_placed_first(name):
    with open(os.path.join(templates.templates_dir(), f"{name}.json"), encoding="utf-8") as f:
        workflow = json.load(f)

    assert workflow["nodes"][0]["type"] == "MarkdownNote"
    assert workflow["nodes"][0]["title"] == MISSING_MODELS_NOTE_TITLE
    # It has to actually sit top-left of the "what this template is" note, not
    # just be first in the array.
    other_top_left = next(
        n for n in workflow["nodes"] if n.get("title") == "這是什麼範本 / What this template is"
    )
    assert workflow["nodes"][0]["pos"][1] < other_top_left["pos"][1]


@pytest.mark.parametrize("name", ONE_MODEL_TEMPLATE_NAMES)
def test_one_model_missing_models_note_exists_and_is_placed_first(name):
    """Same placement guarantee as MODEL_BEARING's note, adapted for the
    3-group layout: these two templates have no separate "這是什麼範本" intro
    note, so the reference point is the ① note instead."""
    with open(os.path.join(templates.templates_dir(), f"{name}.json"), encoding="utf-8") as f:
        workflow = json.load(f)

    assert workflow["nodes"][0]["type"] == "MarkdownNote"
    assert workflow["nodes"][0]["title"] == MISSING_MODELS_NOTE_TITLE
    other_top_left = next(
        n for n in workflow["nodes"]
        if n.get("title", "").startswith("① 用途＋紅框")
    )
    assert workflow["nodes"][0]["pos"][1] < other_top_left["pos"][1]


@pytest.mark.parametrize("name", NOTE_BEARING_TEMPLATE_NAMES)
def test_missing_models_note_mentions_every_model_the_graph_actually_uses(name):
    """Anti-drift: if a template's loaders change, its note must be updated too."""
    with open(os.path.join(templates.templates_dir(), f"{name}.json"), encoding="utf-8") as f:
        workflow = json.load(f)

    referenced = _loader_model_filenames(workflow)
    assert referenced, f"{name} has no .safetensors loader values to check against"

    note_text = _missing_models_note_text(name)
    for filename in referenced:
        assert filename in note_text, f"{name}'s missing-models note omits {filename}"


@pytest.mark.parametrize("name", NOTE_BEARING_TEMPLATE_NAMES)
def test_missing_models_note_links_are_dual_official_and_gcs_backup(name):
    note_text = _missing_models_note_text(name)

    urls = _gcs_urls_in(note_text)
    assert urls, f"{name}'s missing-models note has no GCS backup links"
    for url in urls:
        assert url.startswith(GCS_MODEL_BASE), url
        assert url.rsplit("/", 1)[-1] in MODEL_INVENTORY, url

    referenced = {
        filename for filename in MODEL_INVENTORY if filename in note_text
    }
    assert referenced, f"{name}'s missing-models note references no curated model"

    for filename in referenced:
        source = MODEL_SOURCES[filename]
        assert f"官方載點：{source['official']}" in note_text, (name, filename)
        assert f"備份載點：{_backup_url(filename)}" in note_text, (name, filename)
        if source["gated"]:
            assert f"官方載點：{source['official']}{FLUX_GATED_CAVEAT}" in note_text, (name, filename)


# --- Task 2: merged official template library --------------------------


_FLUX_CATEGORY = {
    "moduleName": "default",
    "title": "Flux",
    "templates": [{"name": "flux_dev", "mediaType": "image", "mediaSubtype": "webp"}],
}

# The shape the REAL official library uses: download metadata hangs off each
# node's `properties.models`, never a top-level `models` key. Verified against
# every one of the 550 workflow JSONs in `comfyui-workflow-templates-json`
# 0.1.74 (287 model-bearing nodes, 0 top-level `models` lists) and against the
# pinned frontend bundle, whose `getEmbeddedModels(node)` reads exactly
# `node.properties?.models` before `hasDownloadMetadata` decides whether to
# render a Download button.
_FLUX_WORKFLOW = {
    "id": "flux_dev",
    "revision": 0,
    "last_node_id": 2,
    "nodes": [
        {
            "id": 1,
            "type": "UNETLoader",
            "pos": [0, 0],
            "properties": {
                "Node name for S&R": "UNETLoader",
                "models": [
                    {
                        "name": "flux1-dev.safetensors",
                        "url": "https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/flux1-dev.safetensors",
                        "directory": "diffusion_models",
                        "hash": "h",
                        "hash_type": "SHA256",
                    }
                ],
            },
            "widgets_values": ["flux1-dev.safetensors", "default"],
        },
        {
            "id": 2,
            "type": "SaveImage",
            "pos": [400, 0],
            "properties": {"Node name for S&R": "SaveImage"},
            "widgets_values": ["ComfyUI"],
        },
    ],
    "links": [],
    "version": 0.4,
}

# A workflow using the top-level `models` key instead. The official library
# does not emit this shape, but stripping covers it as a superset, and a
# hand-authored workflow could.
_TOP_LEVEL_MODELS_WORKFLOW = {
    "version": 0.4,
    "nodes": [],
    "links": [],
    "models": [
        {
            "name": "ae.safetensors",
            "url": "https://x/y",
            "directory": "vae",
            "hash": "h",
            "hash_type": "SHA256",
        }
    ],
}


# A subgraph-based workflow: the library nests whole node graphs (with their
# own `properties.models`) under `definitions.subgraphs[]` -- the shape
# `image_z_image_turbo` ships and the one live verification caught slipping
# through a location-enumerating strip. The recursive strip must reach it.
_SUBGRAPH_WORKFLOW = {
    "id": "z_image",
    "revision": 0,
    "nodes": [{"id": 1, "type": "SaveImage", "properties": {"Node name for S&R": "SaveImage"}}],
    "links": [],
    "definitions": {
        "subgraphs": [
            {
                "id": "sg-1",
                "nodes": [
                    {
                        "id": 62,
                        "type": "CLIPLoader",
                        "properties": {
                            "Node name for S&R": "CLIPLoader",
                            "models": [
                                {
                                    "name": "qwen_3_4b.safetensors",
                                    "url": "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors",
                                    "directory": "text_encoders",
                                }
                            ],
                        },
                        "widgets_values": ["qwen_3_4b.safetensors", "lumina2", "default"],
                    }
                ],
            }
        ]
    },
    "version": 0.4,
}


def _seed_official_dir(data_dir, *, index_extra=None, localized=None, logo=None):
    official_dir = official_templates.official_dir(data_dir)
    os.makedirs(official_dir, exist_ok=True)
    with open(os.path.join(official_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump([_FLUX_CATEGORY], f)
    with open(os.path.join(official_dir, "flux_dev.json"), "w", encoding="utf-8") as f:
        json.dump(_FLUX_WORKFLOW, f)
    with open(os.path.join(official_dir, "legacy_top_level.json"), "w", encoding="utf-8") as f:
        json.dump(_TOP_LEVEL_MODELS_WORKFLOW, f)
    with open(os.path.join(official_dir, "z_image.json"), "w", encoding="utf-8") as f:
        json.dump(_SUBGRAPH_WORKFLOW, f)
    with open(os.path.join(official_dir, "flux_dev-1.webp"), "wb") as f:
        f.write(b"RIFF" + b"\x00" * 8 + b"WEBP")
    if localized is not None:
        with open(os.path.join(official_dir, "index.zh.json"), "w", encoding="utf-8") as f:
            json.dump(localized, f)
    if logo is not None:
        with open(os.path.join(official_dir, "index_logo.json"), "w", encoding="utf-8") as f:
            json.dump(logo, f)
    return official_dir


def test_index_json_merges_official_categories_after_comfyfed(client):
    _login(client)
    _seed_official_dir(client.data_dir)

    r = client.get("/comfy/templates/index.json")
    assert r.status_code == 200
    categories = r.json()
    assert len(categories) == 2
    assert [t["name"] for t in categories[0]["templates"]] == list(templates.TEMPLATE_NAMES)
    assert categories[1] == _FLUX_CATEGORY


def test_index_json_is_comfyfed_alone_when_official_dir_absent(client):
    _login(client)
    r = client.get("/comfy/templates/index.json")
    assert r.status_code == 200
    categories = r.json()
    assert len(categories) == 1
    assert [t["name"] for t in categories[0]["templates"]] == list(templates.TEMPLATE_NAMES)


def test_official_workflow_json_has_per_node_download_metadata_stripped(client):
    """The real library's shape: `nodes[].properties.models`."""
    _login(client)
    _seed_official_dir(client.data_dir)

    r = client.get("/comfy/templates/flux_dev.json")
    assert r.status_code == 200
    body = r.json()

    loader = body["nodes"][0]
    models = loader["properties"]["models"]
    assert len(models) == 1
    # name + directory survive (the missing-model panel still names the file);
    # everything hasDownloadMetadata() needs is gone.
    assert models[0] == {"name": "flux1-dev.safetensors", "directory": "diffusion_models"}
    # Nothing else about the node or the graph was disturbed.
    assert loader["properties"]["Node name for S&R"] == "UNETLoader"
    assert loader["widgets_values"] == ["flux1-dev.safetensors", "default"]
    assert body["nodes"][1] == _FLUX_WORKFLOW["nodes"][1]
    assert body["id"] == "flux_dev"
    # And no url survives anywhere in the served document.
    assert "huggingface.co" not in json.dumps(body)


def test_official_workflow_json_has_top_level_download_metadata_stripped(client):
    """Stripping stays a superset: a top-level `models` list is covered too."""
    _login(client)
    _seed_official_dir(client.data_dir)

    r = client.get("/comfy/templates/legacy_top_level.json")
    assert r.status_code == 200
    models = r.json()["models"]
    assert len(models) == 1
    assert models[0] == {"name": "ae.safetensors", "directory": "vae"}


def test_official_workflow_json_has_subgraph_download_metadata_stripped(client):
    """Model metadata nested under `definitions.subgraphs[]` is stripped too."""
    _login(client)
    _seed_official_dir(client.data_dir)

    r = client.get("/comfy/templates/z_image.json")
    assert r.status_code == 200
    body = r.json()

    loader = body["definitions"]["subgraphs"][0]["nodes"][0]
    assert loader["properties"]["models"] == [
        {"name": "qwen_3_4b.safetensors", "directory": "text_encoders"}
    ]
    # The rest of the subgraph node is untouched.
    assert loader["widgets_values"] == ["qwen_3_4b.safetensors", "lumina2", "default"]
    assert "huggingface.co" not in json.dumps(body)


@pytest.mark.parametrize("name", templates.TEMPLATE_NAMES)
def test_own_template_workflow_still_served_byte_identical(client, name):
    _login(client)
    _seed_official_dir(client.data_dir)

    packaged_path = os.path.join(templates.templates_dir(), f"{name}.json")
    with open(packaged_path, "rb") as f:
        expected = f.read()

    r = client.get(f"/comfy/templates/{name}.json")
    assert r.status_code == 200
    assert r.content == expected


def test_official_media_file_is_served(client):
    _login(client)
    _seed_official_dir(client.data_dir)

    r = client.get("/comfy/templates/flux_dev-1.webp")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/webp"


def test_localized_index_merges_when_official_localized_file_present(client):
    _login(client)
    localized_flux = {**_FLUX_CATEGORY, "title": "Flux (中文)"}
    _seed_official_dir(client.data_dir, localized=[localized_flux])

    r = client.get("/comfy/templates/index.zh.json")
    assert r.status_code == 200
    categories = r.json()
    assert len(categories) == 2
    assert [t["name"] for t in categories[0]["templates"]] == list(templates.TEMPLATE_NAMES)
    assert categories[1] == localized_flux


def test_localized_index_404s_without_official_localized_file(client):
    _login(client)
    assert client.get("/comfy/templates/index.zh.json").status_code == 404

    _seed_official_dir(client.data_dir)  # official dir present, but no index.zh.json
    assert client.get("/comfy/templates/index.zh.json").status_code == 404


def test_index_logo_json_served_from_official_dir_or_404s(client):
    _login(client)
    assert client.get("/comfy/templates/index_logo.json").status_code == 404

    logo = {"logo": "flux"}
    _seed_official_dir(client.data_dir, logo=logo)
    r = client.get("/comfy/templates/index_logo.json")
    assert r.status_code == 200
    assert r.json() == logo


def test_traversal_filenames_still_404_with_official_dir_present(client):
    _login(client)
    _seed_official_dir(client.data_dir)
    assert client.get("/comfy/templates/..%2F..%2Fcomfyfed.db").status_code == 404
    # Windows drive-relative: os.path.join(dir, "C:x.json") == "C:x.json".
    assert client.get("/comfy/templates/C:x.json").status_code == 404


def test_manifest_json_is_not_served_as_a_template(client):
    _login(client)
    official_dir = _seed_official_dir(client.data_dir)
    with open(os.path.join(official_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"meta_version": "1.0", "sub_packages": {"json": "0.1.74"}}, f)

    assert client.get("/comfy/templates/manifest.json").status_code == 404


def test_mp3_thumbnail_is_served_as_audio(client):
    _login(client)
    official_dir = _seed_official_dir(client.data_dir)
    with open(os.path.join(official_dir, "audio_tpl-1.mp3"), "wb") as f:
        f.write(b"ID3")

    r = client.get("/comfy/templates/audio_tpl-1.mp3")
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/mpeg"


def test_readme_model_downloads_section_covers_the_whole_inventory():
    readme_path = os.path.join(os.path.dirname(__file__), "..", "..", "README.md")
    with open(readme_path, encoding="utf-8") as f:
        readme = f.read()

    urls = _gcs_urls_in(readme)
    assert urls, "README has no GCS backup model links"
    for url in urls:
        assert url.startswith(GCS_MODEL_BASE), url
        assert url.rsplit("/", 1)[-1] in MODEL_INVENTORY, url

    # Every model in the shared inventory shows up at least once in the README
    # (bilingual tables both reference the same nine files).
    seen = {url.rsplit("/", 1)[-1] for url in urls}
    assert seen == MODEL_INVENTORY

    # And every model's official source link is present too.
    for filename, source in MODEL_SOURCES.items():
        assert source["official"] in readme, filename


# --- Phase 1.8 Task 1: zero-model video templates -----------------------


@pytest.mark.parametrize("name", ZERO_MODEL_TEMPLATE_NAMES)
def test_zero_model_template_json_parses(name):
    with open(os.path.join(templates.templates_dir(), f"{name}.json"), encoding="utf-8") as f:
        workflow = json.load(f)
    assert workflow["version"] == 0.4


@pytest.mark.parametrize("name", ZERO_MODEL_TEMPLATE_NAMES)
def test_zero_model_template_only_uses_the_documented_node_classes(name):
    """The zero-model selling point only holds if no loader node sneaks in."""
    with open(os.path.join(templates.templates_dir(), f"{name}.json"), encoding="utf-8") as f:
        workflow = json.load(f)

    for node in workflow["nodes"]:
        assert node["type"] in ZERO_MODEL_ALLOWED_NODE_TYPES, (name, node["id"], node["type"])


@pytest.mark.parametrize("name", ZERO_MODEL_TEMPLATE_NAMES)
def test_zero_model_template_has_no_loader_model_filenames(name):
    with open(os.path.join(templates.templates_dir(), f"{name}.json"), encoding="utf-8") as f:
        workflow = json.load(f)
    assert not _loader_model_filenames(workflow), name


@pytest.mark.parametrize("name", ZERO_MODEL_TEMPLATE_NAMES)
def test_zero_model_template_has_no_missing_models_note(name):
    notes = _notes_by_title(name)
    assert MISSING_MODELS_NOTE_TITLE not in notes, name


@pytest.mark.parametrize("name", ZERO_MODEL_TEMPLATE_NAMES)
def test_zero_model_template_links_have_slot_consistent_endpoints(name):
    """Every link's from/to slot index must land inside that node's actual
    outputs/inputs array -- catches an off-by-one before it ever reaches a
    worker."""
    with open(os.path.join(templates.templates_dir(), f"{name}.json"), encoding="utf-8") as f:
        workflow = json.load(f)

    nodes = {n["id"]: n for n in workflow["nodes"]}
    for link_id, src, src_slot, dst, dst_slot, wire in workflow["links"]:
        src_outputs = nodes[src]["outputs"]
        dst_inputs = nodes[dst]["inputs"]
        assert 0 <= src_slot < len(src_outputs), (name, link_id)
        assert 0 <= dst_slot < len(dst_inputs), (name, link_id)
        assert src_outputs[src_slot]["type"] == wire, (name, link_id)
        assert dst_inputs[dst_slot]["type"] == wire, (name, link_id)
        assert link_id in src_outputs[src_slot]["links"], (name, link_id)
        assert dst_inputs[dst_slot]["link"] == link_id, (name, link_id)


def test_zero_model_templates_say_no_model_is_needed():
    for name in ZERO_MODEL_TEMPLATE_NAMES:
        notes = _notes_by_title(name)
        combined = "\n".join(notes.values())
        assert "不需要任何模型" in combined, name


def test_zero_model_templates_flag_the_red_framed_nodes_to_edit():
    for name in ZERO_MODEL_TEMPLATE_NAMES:
        notes = _notes_by_title(name)
        combined = "\n".join(notes.values())
        assert "紅框" in combined, name
        assert "改" in combined, name


def test_video_concat_note_covers_matching_resolution_and_fps():
    notes = _notes_by_title("comfyfed-video-concat")
    combined = "\n".join(notes.values())
    assert "解析度" in combined
    assert "fps" in combined


def test_image_intro_video_note_covers_the_amount_formula():
    notes = _notes_by_title("comfyfed-image-intro-video")
    combined = "\n".join(notes.values())
    assert "amount" in combined
    assert "fps" in combined


# --- Phase 1.8b Task 2: prompt-helper templates -------------------------


@pytest.mark.parametrize("name", ONE_MODEL_TEMPLATE_NAMES)
def test_one_model_template_json_parses(name):
    with open(os.path.join(templates.templates_dir(), f"{name}.json"), encoding="utf-8") as f:
        workflow = json.load(f)
    assert workflow["version"] == 0.4


@pytest.mark.parametrize("name", ONE_MODEL_TEMPLATE_NAMES)
def test_one_model_template_has_exactly_one_curated_model(name):
    with open(os.path.join(templates.templates_dir(), f"{name}.json"), encoding="utf-8") as f:
        workflow = json.load(f)
    assert _loader_model_filenames(workflow) == {"qwen3vl_4b_bf16.safetensors"}, name


@pytest.mark.parametrize("name", ONE_MODEL_TEMPLATE_NAMES)
def test_one_model_template_links_have_slot_consistent_endpoints(name):
    """Same off-by-one guard as the zero-model templates get."""
    with open(os.path.join(templates.templates_dir(), f"{name}.json"), encoding="utf-8") as f:
        workflow = json.load(f)

    nodes = {n["id"]: n for n in workflow["nodes"]}
    for link_id, src, src_slot, dst, dst_slot, wire in workflow["links"]:
        src_outputs = nodes[src]["outputs"]
        dst_inputs = nodes[dst]["inputs"]
        assert 0 <= src_slot < len(src_outputs), (name, link_id)
        assert 0 <= dst_slot < len(dst_inputs), (name, link_id)
        assert src_outputs[src_slot]["type"] == wire, (name, link_id)
        assert dst_inputs[dst_slot]["type"] == wire, (name, link_id)
        assert link_id in src_outputs[src_slot]["links"], (name, link_id)
        assert dst_inputs[dst_slot]["link"] == link_id, (name, link_id)


def test_image_to_prompt_uses_default_template_and_links_an_image():
    with open(
        os.path.join(templates.templates_dir(), "comfyfed-image-to-prompt.json"), encoding="utf-8"
    ) as f:
        workflow = json.load(f)

    text_gen = next(n for n in workflow["nodes"] if n["type"] == "TextGenerate")
    # widgets_values tail is [..., thinking, use_default_template]; True for
    # the image recipe per the verified-live ground truth.
    assert text_gen["widgets_values"][-1] is True
    assert any(i["name"] == "image" for i in text_gen["inputs"])


def test_text_to_prompt_does_not_use_default_template_and_has_no_image_input():
    with open(
        os.path.join(templates.templates_dir(), "comfyfed-text-to-prompt.json"), encoding="utf-8"
    ) as f:
        workflow = json.load(f)

    text_gen = next(n for n in workflow["nodes"] if n["type"] == "TextGenerate")
    assert text_gen["widgets_values"][-1] is False
    assert not any(i["name"] == "image" for i in text_gen["inputs"])
    # The manual template wrapping must carry the literal Qwen3 chat tags and
    # the /no_think suppression, per the verified-live recipe. /no_think sits
    # at the HEAD of the instruction, not after the user's text: trailing it
    # behind a keyword-styled idea made the model echo "no_think" as a style
    # keyword (caught live with a mixed zh/en idea). The instruction also has
    # to say the idea may be Chinese or English — the user-facing bilingual
    # input promise.
    primitives = [n["widgets_values"][0] for n in workflow["nodes"] if n["type"] == "PrimitiveStringMultiline"]
    prefix = next(v for v in primitives if v.startswith("<|im_start|>user"))
    assert prefix.startswith("<|im_start|>user\n/no_think ")
    assert "使用者的想法可能是中文或英文" in prefix
    assert prefix.endswith("想法：")
    suffix = next(v for v in primitives if "<|im_start|>assistant" in v)
    assert suffix == "<|im_end|>\n<|im_start|>assistant\n"
    assert "/no_think" not in suffix


def test_prompt_helper_templates_save_and_preview_the_generated_text():
    for name in ONE_MODEL_TEMPLATE_NAMES:
        with open(
            os.path.join(templates.templates_dir(), f"{name}.json"), encoding="utf-8"
        ) as f:
            workflow = json.load(f)
        types = {n["type"] for n in workflow["nodes"]}
        assert "SaveText" in types, name
        assert "PreviewAny" in types, name
        save_text = next(n for n in workflow["nodes"] if n["type"] == "SaveText")
        assert save_text["widgets_values"][0] == "comfyfed_prompt"
        assert save_text["widgets_values"][1] == "txt"
