"""配方（recipe）：把一張跑得通的 workflow 包成「幾個參數」的送單入口。

A recipe is a packaged, parameterised ComfyUI workflow. The point is the MCP
server (and any other non-expert caller): an AI agent should be able to ask
for "a picture of a red fox, 1024x1024" without holding a whole API-format
node graph in its head, and without ComfyFed having to trust whatever graph it
would otherwise invent.

檔案格式（spec §5.1）：`comfyfed_server/recipes/<id>.json`，package data，用
`importlib.resources` 定位（同 `templates.py` 的 `templates_data/`；`recipes/`
沒有 `__init__.py`，它是資料目錄不是子套件 -- 同名的本模組 `recipes.py` 依
Python 的 import 順序永遠優先，namespace package 不會把它蓋掉）。

每個檔案是：

    {"id", "title"/{zh-TW,en}, "description", "params": [...],
     "required_models": [...], "workflow": {API-format 節點圖}}

`workflow` 裡凡是可調的位置，檔內寫成 `{"$param": "<name>"}` 標記，**不寫
字面值** -- 渲染時整個物件被換成該參數的值（型別保留）。這樣「配方檔」與
「這次要跑的值」永遠是分開的兩件事，檔案本身不會偷偷夾帶預設值。

`params` 型別：`string`／`integer`／`number`／`boolean`／`enum`（`values`），
可帶 `default`／`required`／`min`／`max`／`step`（值必須是 `step` 的倍數）。
驗證失敗一律 `RecipeError("recipes.bad_params", ...)`，訊息點名第一個出錯的
參數，再由路由翻成 400 的 `{"error": {"code", "message"}}` 信封。

端點（spec §5.2）走 `require_user`；`run` 走 `require_csrf_user`，所以 Task 1
的 bearer token 也能送單（bearer 跳過 CSRF）。`run` 不自己建單：渲染完就交給
`jobs.create_job_from_workflow`，與 console 的 `POST /api/jobs` 是同一條建單
路徑（同 `origin="console"`、同 signature／requirements 推導、同派工），兩個
入口不可能漂移。
"""

from __future__ import annotations

import json
import logging
import os
import secrets
from functools import lru_cache
from importlib import resources
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import auth, jobs

logger = logging.getLogger(__name__)

_DATA_DIRNAME = "recipes"

#: `seed` 的哨兵值：使用者要「隨機」時送 -1，伺服器換成一個真的隨機值，並把
#: 換好的值回報給呼叫端（回應的 `params`），這樣同一張圖才重現得出來。
_RANDOM_SEED_SENTINEL = -1
_SEED_SPACE = 2**32


class RecipeError(Exception):
    """配方層的錯誤，帶著要送進錯誤信封的 `code`／`message`。

    只有 `recipes.bad_params`（使用者給錯參數，400）與 `recipes.bad_recipe`
    （配方檔本身壞了，500）兩種來源 -- 路由端據此決定狀態碼。
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _bad_params(message: str) -> RecipeError:
    return RecipeError("recipes.bad_params", message)


def _error(status_code: int, code: str, message: str = "") -> HTTPException:
    """同 jobs.py／auth.py 的錯誤信封（`app.py` 的 handler 會轉成
    `{"error": {"code", "message"}}`）。"""
    return HTTPException(status_code=status_code, detail={"code": code, "message": message or code})


def recipes_dir() -> str:
    """打包進 wheel 的 `recipes/` 目錄的檔案系統路徑。

    與 `templates.templates_dir()` 一樣透過 `importlib.resources` 對*套件*
    解析，source checkout 與安裝好的 wheel 才會給出同一個答案。
    """
    return str(resources.files(__package__).joinpath(_DATA_DIRNAME))


@lru_cache(maxsize=1)
def load_recipes() -> dict[str, dict]:
    """`{recipe_id: 配方檔內容}`，依檔名 stem 建索引。

    配方是 package data，程序存活期間不會變，所以讀一次就快取（`lru_cache`）。
    壞掉／讀不到的檔案直接跳過（一個手改壞的 JSON 不該讓整個 `/api/recipes`
    掛掉），但**每一次跳過都留一行 log**：這個模組最現實的故障模式是
    `recipes/*.json` 沒被打包進 wheel，而那個症狀是 `GET /api/recipes` 安靜地
    回 `[]`、AI 端下結論說「這個平台沒有配方」。沒有 log 就沒有人會發現。
    """
    directory = recipes_dir()
    try:
        filenames = sorted(os.listdir(directory))
    except OSError:
        logger.warning(
            "recipes: no recipe directory at %s -- none will be served "
            "(packaging problem? see pyproject package-data)", directory,
        )
        return {}

    loaded: dict[str, dict] = {}
    for filename in filenames:
        if not filename.endswith(".json"):
            continue
        path = os.path.join(directory, filename)
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            logger.exception("recipes: skipping unreadable/malformed recipe %s", path)
            continue
        if not isinstance(data, dict):
            logger.warning("recipes: skipping %s -- top level is not a JSON object", path)
            continue
        recipe_id = data.get("id") or filename[: -len(".json")]
        loaded[str(recipe_id)] = data
    if not loaded:
        logger.warning("recipes: %s contains no usable recipe files", directory)
    return loaded


def public_view(recipe: dict, include_workflow: bool) -> dict:
    """端點回傳的形狀（spec §5.2）。

    清單不帶 `workflow`：節點圖比其他所有欄位加起來還大好幾倍，而挑配方的人
    只需要看得懂的那幾個欄位；要圖的人再打單筆端點。

    回傳的容器是淺複本：`load_recipes()` 的結果被 `lru_cache` 全程重用，讓
    呼叫端拿到指向快取的同一個 list 遲早會有人就地改到它，而那會污染整個
    process 的配方定義。
    """
    view = {
        "id": recipe.get("id"),
        "title": dict(recipe.get("title") or {}),
        "description": dict(recipe.get("description") or {}),
        "params": list(recipe.get("params") or []),
        "required_models": list(recipe.get("required_models") or []),
    }
    if include_workflow:
        view["workflow"] = dict(recipe.get("workflow") or {})
    return view


def _check_number_range(spec: dict, name: str, value) -> None:
    minimum = spec.get("min")
    maximum = spec.get("max")
    if minimum is not None and value < minimum:
        raise _bad_params(f"{name}: must be >= {minimum} (got {value}).")
    if maximum is not None and value > maximum:
        raise _bad_params(f"{name}: must be <= {maximum} (got {value}).")

    step = spec.get("step")
    if step:
        # 以 min 為原點算倍數：解析度類的參數（width/height）min 本來就是
        # step 的倍數，但把原點寫死成 0 會在別的配方上給出錯誤答案。
        origin = minimum if minimum is not None else 0
        offset = value - origin
        if isinstance(step, int) and isinstance(offset, int):
            off_grid = offset % step != 0
        else:
            off_grid = abs((offset / step) - round(offset / step)) > 1e-9
        if off_grid:
            raise _bad_params(f"{name}: must be a multiple of {step} (got {value}).")


def _coerce(spec: dict, name: str, value):
    """單一參數的型別／範圍檢查，回傳要用的值。"""
    kind = spec.get("type", "string")

    if kind == "string":
        if not isinstance(value, str):
            raise _bad_params(f"{name}: expected a string.")
        return value

    if kind == "boolean":
        if not isinstance(value, bool):
            raise _bad_params(f"{name}: expected true or false.")
        return value

    if kind == "integer":
        # `bool` 是 `int` 的子類 -- True 當成 1 傳進 steps 是打字錯誤，不是
        # 一個合理的步數，所以明文擋掉。
        if isinstance(value, bool) or not isinstance(value, int):
            raise _bad_params(f"{name}: expected an integer.")
        _check_number_range(spec, name, value)
        return value

    if kind == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise _bad_params(f"{name}: expected a number.")
        _check_number_range(spec, name, value)
        return value

    if kind == "enum":
        values = spec.get("values") or []
        if value not in values:
            allowed = ", ".join(repr(v) for v in values)
            raise _bad_params(f"{name}: must be one of [{allowed}].")
        return value

    raise RecipeError("recipes.bad_recipe", f"{name}: unknown parameter type {kind!r}.")


def validate_params(recipe: dict, params: dict) -> dict:
    """套預設、驗型別／範圍／enum，回傳「這次實際要用的」完整參數。

    回傳的 dict 是解析完的結果：預設值已填、`seed == -1` 已換成真的隨機值，
    所以呼叫端（渲染、回應的 `params`）拿到的就是跑這張圖的全部事實。
    """
    specs = recipe.get("params") or []
    by_name = {str(spec.get("name")): spec for spec in specs if isinstance(spec, dict)}

    given = dict(params or {})
    unknown = sorted(set(given) - set(by_name))
    if unknown:
        known = ", ".join(sorted(by_name))
        raise _bad_params(f"{unknown[0]}: unknown parameter (known: {known}).")

    resolved: dict[str, Any] = {}
    for name, spec in by_name.items():
        if name in given:
            value = given[name]
        elif "default" in spec:
            value = spec["default"]
        elif spec.get("required"):
            raise _bad_params(f"{name}: required.")
        else:
            # 宣告了、沒給、也沒有 default：配方檔的 bug（作者漏了 default），
            # 但那是**這一次請求**沒辦法完成的原因，所以回 400 點名該參數，而
            # 不是讓它一路漏到渲染階段變成 500 -- 一個合法的請求永遠不該因為
            # 配方作者的疏忽收到 5xx。
            raise _bad_params(
                f"{name}: no value given and the recipe declares no default."
            )
        resolved[name] = _coerce(spec, name, value)

    if resolved.get("seed") == _RANDOM_SEED_SENTINEL:
        resolved["seed"] = secrets.randbelow(_SEED_SPACE)
    return resolved


def _render(value, params: dict):
    if isinstance(value, dict):
        if set(value.keys()) == {"$param"}:
            name = value["$param"]
            if name not in params:
                raise RecipeError(
                    "recipes.bad_recipe",
                    f"workflow references undeclared parameter {name!r}.",
                )
            return params[name]
        return {key: _render(item, params) for key, item in value.items()}
    if isinstance(value, list):
        return [_render(item, params) for item in value]
    return value


def render_workflow(recipe: dict, params: dict) -> dict:
    """深走 `workflow`，把每個 `{"$param": name}` 換成 `params[name]`。

    回傳的是一份新的結構，配方檔的快取副本不會被就地改寫（同一個 process
    的下一次 run 還要拿到原封不動的標記）。
    """
    return _render(recipe.get("workflow") or {}, params)


class RunRequest(BaseModel):
    params: dict = {}


def create_router(data_dir: str) -> APIRouter:
    r = APIRouter()

    def _get(recipe_id: str) -> dict:
        recipe = load_recipes().get(recipe_id)
        if recipe is None:
            raise _error(404, "recipes.not_found", f"No such recipe: {recipe_id}")
        return recipe

    @r.get("/api/recipes")
    def list_recipes(user: auth.SessionUser = Depends(auth.require_user)):
        return [public_view(recipe, False) for _id, recipe in sorted(load_recipes().items())]

    @r.get("/api/recipes/{recipe_id}")
    def get_recipe(recipe_id: str, user: auth.SessionUser = Depends(auth.require_user)):
        return public_view(_get(recipe_id), True)

    @r.post("/api/recipes/{recipe_id}/run")
    async def run_recipe(
        recipe_id: str,
        body: RunRequest,
        user: auth.SessionUser = Depends(auth.require_csrf_user),
    ):
        recipe = _get(recipe_id)
        try:
            params = validate_params(recipe, body.params)
            workflow = render_workflow(recipe, params)
        except RecipeError as exc:
            status = 400 if exc.code == "recipes.bad_params" else 500
            raise _error(status, exc.code, exc.message)

        job_id = await jobs.create_job_from_workflow(
            None, user, workflow, {}, [], data_dir
        )
        # 201：這個端點的產物是一筆新的 job（`POST /api/jobs` 歷史上回 200，
        # 不動它以免既有 console／e2e 破）。
        return JSONResponse(
            status_code=201,
            content={"job_id": job_id, "recipe_id": recipe_id, "params": params},
        )

    return r
