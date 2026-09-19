"""2026-09-19 配方（spec §5）：檔案格式、參數驗證、渲染與三個端點。

client fixture 與 `_login` 沿用 `test_jobs.py`／`test_api_tokens.py` 的寫法；
建單結果一律回 DB（`db.get_session()` + `db.Job`）核對，不只看回應。
"""

import json
import logging
import os

import pytest
from fastapi.testclient import TestClient

from comfyfed_server import app as app_module
from comfyfed_server import bootstrap, db, recipes


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
    r = client.post("/api/auth/login", json={"username": "admin", "password": client.admin_password})
    assert r.status_code == 200
    return r.json()["csrf"]


def _bearer_headers(client, csrf):
    r = client.post("/api/auth/tokens", json={"name": "ai"}, headers={"X-CSRF": csrf})
    assert r.status_code == 201
    return {"Authorization": f"Bearer {r.json()['token']}"}


def _flux():
    return recipes.load_recipes()["flux-t2i"]


def _run(client, headers, params, recipe_id="flux-t2i"):
    return client.post(f"/api/recipes/{recipe_id}/run", json={"params": params}, headers=headers)


def _job_row(job_id):
    with db.get_session() as session:
        return session.get(db.Job, job_id)


def _has_param_marker(value) -> bool:
    """True if any `{"$param": ...}` marker survives anywhere in `value`."""
    if isinstance(value, dict):
        if set(value.keys()) == {"$param"}:
            return True
        return any(_has_param_marker(v) for v in value.values())
    if isinstance(value, list):
        return any(_has_param_marker(v) for v in value)
    return False


FOUR_MODELS = {
    "flux1-dev.safetensors",
    "clip_l.safetensors",
    "t5xxl_fp16.safetensors",
    "ae.safetensors",
}


# --- 檔案與 loader ------------------------------------------------------


def test_packaged_recipe_loads_and_declares_its_models():
    recipe = _flux()
    assert recipe["id"] == "flux-t2i"
    assert set(recipe["required_models"]) == FOUR_MODELS
    assert recipe["title"]["zh-TW"] and recipe["title"]["en"]
    assert {p["name"] for p in recipe["params"]} == {
        "prompt", "width", "height", "steps", "guidance", "seed",
    }


def test_workflow_keeps_every_parameter_as_a_marker():
    """規格重點：可調參數在檔內必須是 `{"$param": ...}`，不能寫死字面值。"""
    workflow = _flux()["workflow"]
    assert workflow["4"]["inputs"]["text"] == {"$param": "prompt"}
    assert workflow["5"]["inputs"]["guidance"] == {"$param": "guidance"}
    assert workflow["8"]["inputs"]["steps"] == {"$param": "steps"}
    assert workflow["9"]["inputs"]["noise_seed"] == {"$param": "seed"}
    assert workflow["10"]["inputs"]["width"] == {"$param": "width"}
    assert workflow["10"]["inputs"]["height"] == {"$param": "height"}
    assert workflow["13"]["inputs"]["filename_prefix"] == "comfyfed_recipe"


# --- validate_params ----------------------------------------------------


def test_validate_params_fills_defaults_and_resolves_seed():
    resolved = recipes.validate_params(_flux(), {"prompt": "x"})
    assert resolved["prompt"] == "x"
    assert resolved["width"] == 768
    assert resolved["height"] == 768
    assert resolved["steps"] == 8
    assert resolved["guidance"] == 3.5
    assert isinstance(resolved["seed"], int)
    assert 0 <= resolved["seed"] <= 2**32 - 1


def test_validate_params_keeps_an_explicit_seed():
    resolved = recipes.validate_params(_flux(), {"prompt": "x", "seed": 42})
    assert resolved["seed"] == 42


def test_validate_params_rejects_missing_required():
    with pytest.raises(recipes.RecipeError) as excinfo:
        recipes.validate_params(_flux(), {})
    assert excinfo.value.code == "recipes.bad_params"
    assert "prompt" in excinfo.value.message


@pytest.mark.parametrize(
    "bad",
    [
        {"width": 300},          # 非 16 的倍數
        {"width": 128},          # 低於 min
        {"width": 4096},         # 高於 max
        {"steps": 0},            # 低於 min
        {"steps": 3.5},          # integer 不收浮點
        {"steps": True},         # integer 不收 bool
        {"guidance": True},      # number 也不收 bool
        {"guidance": "3.5"},     # number 不收字串
        {"prompt": 7},           # string 不收數字
        {"nope": 1},             # 未知參數
    ],
)
def test_validate_params_rejects_bad_values(bad):
    params = {"prompt": "x"}
    params.update(bad)
    with pytest.raises(recipes.RecipeError) as excinfo:
        recipes.validate_params(_flux(), params)
    assert excinfo.value.code == "recipes.bad_params"
    assert list(bad)[0] in excinfo.value.message


def test_validate_params_accepts_int_for_number():
    assert recipes.validate_params(_flux(), {"prompt": "x", "guidance": 4})["guidance"] == 4


# --- render_workflow ----------------------------------------------------


def test_render_workflow_leaves_no_markers():
    recipe = _flux()
    params = recipes.validate_params(recipe, {"prompt": "a cat", "steps": 12})
    rendered = recipes.render_workflow(recipe, params)

    assert not _has_param_marker(rendered)
    assert rendered["4"]["inputs"]["text"] == "a cat"
    assert rendered["8"]["inputs"]["steps"] == 12
    assert rendered["9"]["inputs"]["noise_seed"] == params["seed"]
    # 原始配方不能被就地改寫
    assert _flux()["workflow"]["4"]["inputs"]["text"] == {"$param": "prompt"}


# --- public_view --------------------------------------------------------


def test_public_view_hides_workflow_unless_asked():
    recipe = _flux()
    assert "workflow" not in recipes.public_view(recipe, False)
    assert recipes.public_view(recipe, True)["workflow"] == recipe["workflow"]


# --- GET 端點 -----------------------------------------------------------


def test_list_requires_login(client):
    assert client.get("/api/recipes").status_code == 401


def test_list_recipes_omits_the_workflow(client):
    _login(client)
    r = client.get("/api/recipes")
    assert r.status_code == 200
    body = r.json()
    entry = next(e for e in body if e["id"] == "flux-t2i")
    assert "workflow" not in entry
    assert set(entry["required_models"]) == FOUR_MODELS
    assert entry["params"][0]["name"] == "prompt"


def test_get_recipe_includes_the_workflow(client):
    _login(client)
    r = client.get("/api/recipes/flux-t2i")
    assert r.status_code == 200
    assert r.json()["workflow"]["4"]["inputs"]["text"] == {"$param": "prompt"}


def test_get_unknown_recipe_is_404(client):
    _login(client)
    r = client.get("/api/recipes/nope")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "recipes.not_found"


# --- run ----------------------------------------------------------------


def test_run_creates_a_rendered_job(client):
    csrf = _login(client)
    r = _run(client, {"X-CSRF": csrf}, {"prompt": "a red fox", "steps": 10})
    assert r.status_code == 201
    body = r.json()
    assert body["recipe_id"] == "flux-t2i"
    assert body["params"]["prompt"] == "a red fox"
    assert body["params"]["steps"] == 10
    assert body["params"]["width"] == 768
    assert 0 <= body["params"]["seed"] <= 2**32 - 1

    job = _job_row(body["job_id"])
    assert job is not None
    assert job.status == "queued"
    assert job.origin == "console"
    stored = json.loads(job.workflow_json)
    assert stored["4"]["inputs"]["text"] == "a red fox"
    assert stored["8"]["inputs"]["steps"] == 10
    assert stored["9"]["inputs"]["noise_seed"] == body["params"]["seed"]
    assert not _has_param_marker(stored)
    assert set(json.loads(job.required_models)) == FOUR_MODELS
    assert job.signature


def test_run_without_csrf_is_rejected(client):
    _login(client)
    r = _run(client, {}, {"prompt": "x"})
    assert r.status_code == 403


def test_run_accepts_a_bearer_token(client):
    csrf = _login(client)
    headers = _bearer_headers(client, csrf)
    client.cookies.clear()

    r = _run(client, headers, {"prompt": "from ai"})
    assert r.status_code == 201
    job = _job_row(r.json()["job_id"])
    assert json.loads(job.workflow_json)["4"]["inputs"]["text"] == "from ai"


def test_run_rejects_bad_params_with_the_error_envelope(client):
    """兩個錯（缺 prompt、width 非 16 倍數）時，回報的是宣告順序上的第一個。"""
    csrf = _login(client)
    r = _run(client, {"X-CSRF": csrf}, {"width": 300})
    assert r.status_code == 400
    error = r.json()["error"]
    assert error["code"] == "recipes.bad_params"
    assert "prompt" in error["message"]


def test_run_rejects_a_non_multiple_width(client):
    csrf = _login(client)
    r = _run(client, {"X-CSRF": csrf}, {"prompt": "x", "width": 300})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "recipes.bad_params"
    assert "width" in r.json()["error"]["message"]


def test_run_rejects_zero_steps(client):
    csrf = _login(client)
    r = _run(client, {"X-CSRF": csrf}, {"prompt": "x", "steps": 0})
    assert r.status_code == 400
    assert "steps" in r.json()["error"]["message"]


def test_run_rejects_unknown_params(client):
    csrf = _login(client)
    r = _run(client, {"X-CSRF": csrf}, {"prompt": "x", "bogus": 1})
    assert r.status_code == 400
    assert "bogus" in r.json()["error"]["message"]


def test_run_missing_prompt_names_the_parameter(client):
    csrf = _login(client)
    r = _run(client, {"X-CSRF": csrf}, {})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "recipes.bad_params"
    assert "prompt" in r.json()["error"]["message"]


def test_run_unknown_recipe_is_404(client):
    csrf = _login(client)
    r = _run(client, {"X-CSRF": csrf}, {"prompt": "x"}, recipe_id="nope")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "recipes.not_found"


def test_two_runs_get_different_random_seeds(client):
    csrf = _login(client)
    seeds = {
        _run(client, {"X-CSRF": csrf}, {"prompt": "x"}).json()["params"]["seed"]
        for _ in range(6)
    }
    assert len(seeds) > 1


# --- loader 的故障模式（I2）與合成配方（I1／M2） -------------------------


@pytest.fixture()
def clean_recipe_cache():
    """`load_recipes()` 有 `lru_cache`；動過 `recipes_dir` 的測試前後都要清掉，
    否則假目錄的結果會外流到別的測試。"""
    recipes.load_recipes.cache_clear()
    yield
    recipes.load_recipes.cache_clear()


def test_packaged_recipe_resolves_through_importlib_resources(clean_recipe_cache):
    """wheel 用的就是這條路徑：`recipes_dir()` 必須指到真的存在的
    `flux-t2i.json`，而 `load_recipes()` 絕不能是空的 -- 打包漏檔時，症狀只會
    是 `GET /api/recipes` 安靜地回 `[]`。"""
    directory = recipes_dir_as_resource()
    assert os.path.isfile(os.path.join(directory, "flux-t2i.json"))
    assert "flux-t2i" in recipes.load_recipes()


def recipes_dir_as_resource() -> str:
    from importlib import resources

    return str(resources.files("comfyfed_server").joinpath("recipes"))


def test_broken_recipe_file_is_skipped_with_a_warning(tmp_path, monkeypatch, caplog, clean_recipe_cache):
    (tmp_path / "broken.json").write_text("{not json", encoding="utf-8")
    (tmp_path / "ok.json").write_text('{"id": "ok", "params": [], "workflow": {}}', encoding="utf-8")
    monkeypatch.setattr(recipes, "recipes_dir", lambda: str(tmp_path))

    with caplog.at_level(logging.WARNING, logger="comfyfed_server.recipes"):
        loaded = recipes.load_recipes()

    assert set(loaded) == {"ok"}
    assert any("broken.json" in record.getMessage() for record in caplog.records)


def test_missing_recipe_directory_is_logged(tmp_path, monkeypatch, caplog, clean_recipe_cache):
    monkeypatch.setattr(recipes, "recipes_dir", lambda: str(tmp_path / "nope"))

    with caplog.at_level(logging.WARNING, logger="comfyfed_server.recipes"):
        assert recipes.load_recipes() == {}

    assert any("no recipe directory" in record.getMessage() for record in caplog.records)


SYNTHETIC = {
    "id": "synthetic",
    "params": [
        {"name": "orphan", "type": "string"},
        {"name": "flag", "type": "boolean", "default": False},
        {"name": "mode", "type": "enum", "values": ["fast", "slow"], "default": "fast"},
        {"name": "ratio", "type": "number", "default": 1.0, "min": 0.5, "step": 0.25},
    ],
    "workflow": {"1": {"class_type": "X", "inputs": {"flag": {"$param": "flag"}}}},
}


def _synthetic(**overrides):
    recipe = json.loads(json.dumps(SYNTHETIC))
    recipe.update(overrides)
    return recipe


def test_param_without_default_or_required_is_a_400_not_a_500():
    """配方作者漏寫 default 是配方的 bug，但使用者的請求不該因此收到 5xx。"""
    with pytest.raises(recipes.RecipeError) as excinfo:
        recipes.validate_params(_synthetic(), {})
    assert excinfo.value.code == "recipes.bad_params"
    assert "orphan" in excinfo.value.message


def test_boolean_enum_and_float_step_are_validated():
    resolved = recipes.validate_params(
        _synthetic(), {"orphan": "x", "flag": True, "mode": "slow", "ratio": 1.75}
    )
    assert resolved == {"orphan": "x", "flag": True, "mode": "slow", "ratio": 1.75}

    for bad, needle in [
        ({"flag": 1}, "flag"),
        ({"mode": "medium"}, "mode"),
        ({"ratio": 1.1}, "ratio"),
        ({"ratio": 0.25}, "ratio"),
    ]:
        params = {"orphan": "x"}
        params.update(bad)
        with pytest.raises(recipes.RecipeError) as excinfo:
            recipes.validate_params(_synthetic(), params)
        assert excinfo.value.code == "recipes.bad_params"
        assert needle in excinfo.value.message


def test_unknown_param_type_is_a_recipe_fault_not_a_user_fault():
    recipe = _synthetic(params=[{"name": "weird", "type": "colour", "default": "red"}])
    with pytest.raises(recipes.RecipeError) as excinfo:
        recipes.validate_params(recipe, {})
    assert excinfo.value.code == "recipes.bad_recipe"


def test_workflow_marker_for_an_undeclared_param_is_a_recipe_fault():
    recipe = _synthetic(
        workflow={"1": {"class_type": "X", "inputs": {"a": {"$param": "nowhere"}}}}
    )
    params = recipes.validate_params(recipe, {"orphan": "x"})
    with pytest.raises(recipes.RecipeError) as excinfo:
        recipes.render_workflow(recipe, params)
    assert excinfo.value.code == "recipes.bad_recipe"


def test_public_view_does_not_hand_out_the_cached_containers():
    recipe = _flux()
    view = recipes.public_view(recipe, True)
    view["params"].append({"name": "injected"})
    view["required_models"].append("evil.safetensors")
    assert len(_flux()["params"]) == 6
    assert "evil.safetensors" not in _flux()["required_models"]


# =======================================================================
# 2026-09-20 spec §12：NSFW 預設配方（chroma-t2i／h3-t2v）＋ model_sources
# 自動下載。清單順序、nsfw_ok、衍生參數 length、missing_models、run 時的
# model_fetch_jobs。
# =======================================================================

import json as _json

from comfyfed_server import model_fetch

CHROMA_UNET = "Chroma1-HD-fp8mixed.safetensors"
CHROMA_URL = (
    "https://huggingface.co/Comfy-Org/Chroma1-HD_repackaged/resolve/main/"
    "split_files/diffusion_models/Chroma1-HD-fp8mixed.safetensors"
)
CHROMA_INVENTORY_NAME = "diffusion_models/Chroma1-HD-fp8mixed.safetensors"
CHROMA_SIZE = 9193379316


def _recipe(recipe_id):
    return recipes.load_recipes()[recipe_id]


def _node(workflow, class_type):
    """The single node of `class_type`; fails loudly when there are 0 or 2."""
    found = [n for n in workflow.values() if n["class_type"] == class_type]
    assert len(found) == 1, f"{class_type}: expected exactly one, got {len(found)}"
    return found[0]


def _nodes(workflow, class_type):
    return [n for n in workflow.values() if n["class_type"] == class_type]


def _rendered(recipe_id, params):
    recipe = _recipe(recipe_id)
    resolved = recipes.derived_params(recipe, recipes.validate_params(recipe, params))
    return recipes.render_workflow(recipe, resolved), resolved


def _register_fetch_worker(client, name="w1", models=None):
    """一台「線上、開了 auto_fetch、protocol 夠新、磁碟夠」的 worker --
    `create_fetch_job` 的 row 7 需要有人接得住這次下載才會建 job。"""
    csrf = getattr(client, "csrf", None) or _login(client)
    client.csrf = csrf
    r = client.post("/api/workers/tokens", json={"name": name}, headers={"X-CSRF": csrf})
    token = r.json()["bundle"]["register_token"]
    reg = client.post(
        "/api/agent/register", json={"token": token, "name": name, "pubkey": "ab" * 32}
    )
    worker_id = reg.json()["worker_id"]
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.status = "online"
        worker.protocol = 5
        worker.auto_fetch = True
        worker.dynamic = _json.dumps({"free_disk_gb": 500.0})
        worker.hardware = _json.dumps({"max_fetch_gb": 100})
        worker.model_inventory = _json.dumps(models or [])
        session.commit()
    return worker_id


@pytest.fixture()
def fake_head(monkeypatch):
    monkeypatch.setattr(model_fetch, "head_size_bytes", lambda url, **kw: CHROMA_SIZE)


# --- 清單順序與旗標 -----------------------------------------------------


def test_recipe_list_is_ordered_by_order_not_by_id(client):
    """AI 端把清單第一個當預設，所以順序是規格的一部分（§12.1）。字母序會
    給出 chroma -> flux -> h3，那會讓 flux 變成「第二推薦」。"""
    _login(client)
    body = client.get("/api/recipes").json()
    assert [entry["id"] for entry in body] == ["chroma-t2i", "h3-t2v", "flux-t2i"]
    assert [entry["order"] for entry in body] == [10, 20, 30]


def test_nsfw_ok_is_declared_per_recipe(client):
    _login(client)
    flags = {e["id"]: e["nsfw_ok"] for e in client.get("/api/recipes").json()}
    assert flags == {"chroma-t2i": True, "h3-t2v": True, "flux-t2i": False}


def test_single_recipe_view_carries_the_new_fields(client):
    _login(client)
    body = client.get("/api/recipes/chroma-t2i").json()
    assert body["order"] == 10 and body["nsfw_ok"] is True
    assert body["missing_models"] == [CHROMA_UNET]
    assert "workflow" in body


# --- chroma-t2i 的圖 ----------------------------------------------------


def test_chroma_recipe_renders_the_spec_model_set():
    workflow, _params = _rendered("chroma-t2i", {"prompt": "a red fox"})

    assert _node(workflow, "UNETLoader")["inputs"]["unet_name"] == CHROMA_UNET
    clip = _node(workflow, "CLIPLoader")["inputs"]
    assert clip["clip_name"] == "t5xxl_fp16.safetensors" and clip["type"] == "chroma"
    assert _node(workflow, "VAELoader")["inputs"]["vae_name"] == "ae.safetensors"
    assert set(_recipe("chroma-t2i")["required_models"]) == {
        CHROMA_UNET, "t5xxl_fp16.safetensors", "ae.safetensors",
    }


def test_chroma_recipe_matches_the_official_template_settings():
    workflow, params = _rendered("chroma-t2i", {"prompt": "a red fox"})

    tokenizer = _node(workflow, "T5TokenizerOptions")["inputs"]
    assert tokenizer["min_padding"] == 1 and tokenizer["min_length"] == 0
    assert _node(workflow, "ModelSamplingAuraFlow")["inputs"]["shift"] == 1
    assert _node(workflow, "KSamplerSelect")["inputs"]["sampler_name"] == "euler"
    scheduler = _node(workflow, "BasicScheduler")["inputs"]
    assert scheduler["scheduler"] == "beta" and scheduler["steps"] == 26
    assert scheduler["denoise"] == 1
    assert _node(workflow, "CFGGuider")["inputs"]["cfg"] == 3.5
    assert _node(workflow, "SaveImage")["inputs"]["filename_prefix"] == "comfyfed_recipe"
    assert params["width"] == 1024 and params["height"] == 1024


def test_chroma_negative_default_is_the_template_sentence():
    """負向句是配方的預設值，不是寫死在圖裡的字面值 -- 使用者要能覆蓋它。"""
    recipe = _recipe("chroma-t2i")
    negative_spec = next(p for p in recipe["params"] if p["name"] == "negative")
    assert negative_spec["default"].startswith("This low quality greyscale unfinished sketch")
    assert "excessive bloom" in negative_spec["default"]

    workflow, _params = _rendered("chroma-t2i", {"prompt": "fox"})
    texts = {n["inputs"]["text"] for n in _nodes(workflow, "CLIPTextEncode")}
    assert texts == {"fox", negative_spec["default"]}

    override, _p = _rendered("chroma-t2i", {"prompt": "fox", "negative": "blurry"})
    assert {n["inputs"]["text"] for n in _nodes(override, "CLIPTextEncode")} == {"fox", "blurry"}


def test_chroma_cfg_and_seed_flow_into_the_graph():
    workflow, params = _rendered(
        "chroma-t2i", {"prompt": "fox", "cfg": 4.5, "steps": 12, "seed": 7}
    )
    assert _node(workflow, "CFGGuider")["inputs"]["cfg"] == 4.5
    assert _node(workflow, "BasicScheduler")["inputs"]["steps"] == 12
    assert _node(workflow, "RandomNoise")["inputs"]["noise_seed"] == 7
    assert params["seed"] == 7


# --- h3-t2v 的圖與衍生的 length ----------------------------------------


@pytest.mark.parametrize("seconds,length", [
    (5, 124),    # 規格點名的範本值
    (1, 39),     # max(5, 24) = 24 -> 24 + (5 - 24 % 17) % 17 = 24 + 15
    (10, 243),   # 240 -> 240 + 3
])
def test_h3_length_is_derived_from_seconds(seconds, length):
    """`length` 不是宣告的參數，是伺服器照 §12.1 的式子算出來的衍生值
    （範本用 ComfyMathExpression 節點算，配方改由伺服器算）。"""
    workflow, params = _rendered("h3-t2v", {"prompt": "x", "seconds": seconds})
    assert params["length"] == length
    assert _node(workflow, "MiniMaxH3ImageToVideo")["inputs"]["length"] == length


def test_h3_length_lands_on_the_models_17k_plus_5_grid():
    for seconds in (1, 2, 3.5, 5, 7, 10):
        _wf, params = _rendered("h3-t2v", {"prompt": "x", "seconds": seconds})
        assert (params["length"] - 5) % 17 == 0
        assert params["length"] >= 5


def test_derived_params_leaves_other_recipes_untouched():
    flux = _flux()
    resolved = recipes.validate_params(flux, {"prompt": "x"})
    assert recipes.derived_params(flux, resolved) == resolved


def test_h3_recipe_uses_the_uncensored_encoder_and_turbo_lora():
    workflow, _params = _rendered("h3-t2v", {"prompt": "x"})

    clip = _node(workflow, "CLIPLoader")["inputs"]
    assert clip["clip_name"] == "qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors"
    assert clip["type"] == "minimax"
    assert _node(workflow, "UNETLoader")["inputs"]["unet_name"] == (
        "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
    )
    lora = _node(workflow, "LoraLoaderModelOnly")["inputs"]
    assert lora["lora_name"] == "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"
    assert lora["strength_model"] == 1
    # LoRA 必須真的在取樣路徑上：BasicGuider／BasicScheduler 吃的是 LoRA 的
    # 輸出，不是裸 UNET（範本的 ComfySwitchNode 預設走裸 UNET，配方不走那條）。
    lora_id = next(k for k, n in workflow.items() if n["class_type"] == "LoraLoaderModelOnly")
    assert _node(workflow, "BasicGuider")["inputs"]["model"] == [lora_id, 0]
    assert _node(workflow, "BasicScheduler")["inputs"]["model"] == [lora_id, 0]


def test_h3_recipe_matches_the_spec_sampler_and_output_settings():
    workflow, params = _rendered("h3-t2v", {"prompt": "x"})

    assert _node(workflow, "KSamplerSelect")["inputs"]["sampler_name"] == "res_multistep"
    scheduler = _node(workflow, "BasicScheduler")["inputs"]
    assert scheduler["scheduler"] == "simple" and scheduler["steps"] == 8
    assert scheduler["denoise"] == 1
    assert _node(workflow, "CreateVideo")["inputs"]["fps"] == 24
    save = _node(workflow, "SaveVideo")["inputs"]
    assert save["filename_prefix"] == "video/comfyfed_recipe"
    assert save["format"] == "auto" and save["codec"] == "auto"
    vaes = {n["inputs"]["vae_name"] for n in _nodes(workflow, "VAELoader")}
    assert vaes == {
        "minimax_h3_video_vae_fp16.safetensors",
        "minimax_h3_audio_vae_fp32.safetensors",
    }
    # 純文字 = MiniMaxH3ImageToVideo 不接任何影像輸入。
    assert set(_node(workflow, "MiniMaxH3ImageToVideo")["inputs"]) == {
        "clip", "vae", "prompt", "width", "height", "length",
    }
    assert params["width"] == 1280 and params["steps"] == 8


# --- 每個配方都渲染得乾淨 -----------------------------------------------


def test_every_packaged_recipe_renders_without_leftover_markers():
    for recipe_id, recipe in recipes.load_recipes().items():
        resolved = recipes.derived_params(
            recipe, recipes.validate_params(recipe, {"prompt": "x"})
        )
        rendered = recipes.render_workflow(recipe, resolved)
        assert not _has_param_marker(rendered), recipe_id
        assert rendered, recipe_id


def test_every_recipe_declares_order_and_nsfw_ok():
    for recipe_id, recipe in recipes.load_recipes().items():
        assert isinstance(recipe.get("order"), int), recipe_id
        assert isinstance(recipe.get("nsfw_ok"), bool), recipe_id


def test_every_model_source_url_is_on_the_fetch_allowlist():
    """`model_sources` 的 url 會被原樣簽進 unverified entry 送給 worker，所以
    它必須在 `model_fetch.TRUSTED_ORIGINS` 內 -- 不然 run 只會安靜地跳過。"""
    for recipe_id, recipe in recipes.load_recipes().items():
        for source in recipe.get("model_sources") or []:
            assert model_fetch.is_trusted_url(source["url"]), (recipe_id, source)
            assert source["name"] and source["directory"]


def test_chroma_model_source_is_the_spec_url():
    source = _recipe("chroma-t2i")["model_sources"][0]
    assert source == {
        "name": CHROMA_UNET,
        "directory": "diffusion_models",
        "url": CHROMA_URL,
    }


# --- missing_models -----------------------------------------------------


def test_missing_models_lists_the_chroma_unet_when_nobody_has_it(client):
    with db.get_session() as session:
        assert recipes.missing_models(session, _recipe("chroma-t2i")) == [CHROMA_UNET]


def test_missing_models_is_empty_once_a_worker_reports_it(client):
    _register_fetch_worker(
        client, models=[{"name": CHROMA_INVENTORY_NAME, "size": 9.2}]
    )
    with db.get_session() as session:
        assert recipes.missing_models(session, _recipe("chroma-t2i")) == []


def test_missing_models_ignores_disabled_and_deleted_workers(client):
    worker_id = _register_fetch_worker(
        client, models=[{"name": CHROMA_INVENTORY_NAME, "size": 9.2}]
    )
    with db.get_session() as session:
        session.get(db.Worker, worker_id).disabled = True
        session.commit()
    with db.get_session() as session:
        assert recipes.missing_models(session, _recipe("chroma-t2i")) == [CHROMA_UNET]

    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.disabled = False
        worker.deleted = True
        session.commit()
    with db.get_session() as session:
        assert recipes.missing_models(session, _recipe("chroma-t2i")) == [CHROMA_UNET]


def test_missing_models_is_empty_for_a_recipe_without_sources(client):
    with db.get_session() as session:
        assert recipes.missing_models(session, _flux()) == []
        assert recipes.missing_models(session, _recipe("h3-t2v")) == []


def test_list_reports_missing_models_per_recipe(client):
    _login(client)
    body = {e["id"]: e for e in client.get("/api/recipes").json()}
    assert body["chroma-t2i"]["missing_models"] == [CHROMA_UNET]
    assert body["flux-t2i"]["missing_models"] == []
    assert body["h3-t2v"]["missing_models"] == []


# --- run 的 model_fetch_jobs -------------------------------------------


def test_run_queues_a_model_fetch_for_a_missing_source(client, fake_head):
    _register_fetch_worker(client)
    r = _run(client, {"X-CSRF": client.csrf}, {"prompt": "a fox"}, recipe_id="chroma-t2i")
    assert r.status_code == 201, r.text
    body = r.json()

    assert len(body["model_fetch_jobs"]) == 1
    entry = body["model_fetch_jobs"][0]
    assert entry["name"] == CHROMA_UNET and entry["reused"] is False

    fetch_job = _job_row(entry["job_id"])
    assert fetch_job.kind == "model_fetch"
    assert _json.loads(fetch_job.required_models) == [CHROMA_UNET]
    signed = _json.loads(fetch_job.fetch_entry)
    assert signed["url"] == CHROMA_URL and signed["size_bytes"] == CHROMA_SIZE
    assert signed["directory"] == "diffusion_models"

    # 真正的那筆 prompt job 照常建立、照常排隊。
    prompt_job = _job_row(body["job_id"])
    assert prompt_job.status == "queued" and prompt_job.kind != "model_fetch"
    assert not _has_param_marker(_json.loads(prompt_job.workflow_json))


def test_a_second_run_reuses_the_same_fetch_job(client, fake_head):
    _register_fetch_worker(client)
    first = _run(client, {"X-CSRF": client.csrf}, {"prompt": "a"}, recipe_id="chroma-t2i").json()
    second = _run(client, {"X-CSRF": client.csrf}, {"prompt": "b"}, recipe_id="chroma-t2i").json()

    assert second["model_fetch_jobs"][0]["reused"] is True
    assert second["model_fetch_jobs"][0]["job_id"] == first["model_fetch_jobs"][0]["job_id"]


def test_run_still_succeeds_when_the_head_probe_fails(client, monkeypatch, caplog):
    """HEAD 失敗（gated／size_unknown）只是「這次下載排不出來」，不是「不准
    送單」-- job 照建，`model_fetch_jobs` 空著，理由留在 log。"""
    csrf = _login(client)
    client.csrf = csrf

    def _boom(url, **kwargs):
        raise model_fetch.HeadError("gated")

    monkeypatch.setattr(model_fetch, "head_size_bytes", _boom)
    with caplog.at_level(logging.WARNING, logger="comfyfed_server.recipes"):
        r = _run(client, {"X-CSRF": client.csrf}, {"prompt": "a"}, recipe_id="chroma-t2i")

    assert r.status_code == 201
    assert r.json()["model_fetch_jobs"] == []
    assert _job_row(r.json()["job_id"]) is not None
    assert any(CHROMA_UNET in record.getMessage() for record in caplog.records)


def test_run_is_still_refused_when_nothing_can_supply_the_model(client, monkeypatch):
    """自動下載沒有鬆開既有的建單防線：有 worker 在線、模型缺、又排不出下載
    時，`jobs.missing_models` 那道 400 照樣擋 -- 豁免只給「這次真的排出了一筆
    model_fetch job」的那些名字（§12.2）。"""
    _register_fetch_worker(client)

    def _boom(url, **kwargs):
        raise model_fetch.HeadError("gated")

    monkeypatch.setattr(model_fetch, "head_size_bytes", _boom)
    r = _run(client, {"X-CSRF": client.csrf}, {"prompt": "a"}, recipe_id="chroma-t2i")
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "jobs.missing_models"


def test_run_still_succeeds_when_no_worker_can_fetch(client, fake_head):
    """沒有任何能下載的 worker：`create_fetch_job` 回 no_worker，送單不受影響。"""
    csrf = _login(client)
    r = _run(client, {"X-CSRF": csrf}, {"prompt": "a"}, recipe_id="chroma-t2i")
    assert r.status_code == 201
    assert r.json()["model_fetch_jobs"] == []


def test_run_skips_the_fetch_when_a_worker_already_has_the_model(client, fake_head):
    _register_fetch_worker(client, models=[{"name": CHROMA_INVENTORY_NAME, "size": 9.2}])
    r = _run(client, {"X-CSRF": client.csrf}, {"prompt": "a"}, recipe_id="chroma-t2i")
    assert r.status_code == 201
    assert r.json()["model_fetch_jobs"] == []


def test_run_of_a_recipe_without_sources_reports_an_empty_list(client):
    csrf = _login(client)
    r = _run(client, {"X-CSRF": csrf}, {"prompt": "a"})
    assert r.status_code == 201
    assert r.json()["model_fetch_jobs"] == []


def test_run_h3_returns_the_derived_length_in_params(client):
    csrf = _login(client)
    r = _run(client, {"X-CSRF": csrf}, {"prompt": "a", "seconds": 5}, recipe_id="h3-t2v")
    assert r.status_code == 201
    body = r.json()
    assert body["params"]["length"] == 124
    stored = _json.loads(_job_row(body["job_id"]).workflow_json)
    assert _node(stored, "MiniMaxH3ImageToVideo")["inputs"]["length"] == 124
    assert not _has_param_marker(stored)


def test_run_still_rejects_length_as_a_user_supplied_param(client):
    """`length` 是衍生值，不是使用者能送的參數 -- 送了要被當成未知參數擋掉。"""
    csrf = _login(client)
    r = _run(client, {"X-CSRF": csrf}, {"prompt": "a", "length": 999}, recipe_id="h3-t2v")
    assert r.status_code == 400
    assert "length" in r.json()["error"]["message"]
