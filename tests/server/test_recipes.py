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
