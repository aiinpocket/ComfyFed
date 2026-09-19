"""`comfyfed-mcp`：把 ComfyFed 平台包成一個 MCP server 給 AI 客戶端用。

An MCP (Model Context Protocol) server that exposes one ComfyFed platform to
an AI client (Claude Code / Claude Desktop / Cursor …) over stdio.

設計重點 / design notes
----------------------
* **`mcp` 不是硬依賴**（spec §6.1）。agent 的自更新走
  `pip install --no-deps`，硬依賴根本裝不到，所以這個模組的**模組層絕對不
  能 import `mcp`** —— 只有 `build_server()` 裡面才 lazy import，缺套件時
  `cli()` 印出 `pip install "comfyfed[mcp]"` 指引並回 2。
* 工具本體是**模組層純函式**，第一個參數吃一個 `Client`。MCP 註冊
  （`build_server`）只是薄薄一層 wrapper，所以測試不必啟動 stdio。
* **token 只出現在 `Authorization` header**：不進 log、不進任何工具回傳、
  不進 `McpSettings` 的 repr（spec §9）。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

import httpx

from . import __version__

# 所有平台請求的逾時（spec §6.3）。
TIMEOUT_SECONDS = 30.0

# `wait_for_job` 的終局狀態集合。
TERMINAL_STATUSES = frozenset({"done", "failed", "cancelled"})

# 給 AI 讀的 server 說明（spec §6.3 最後一段）。中英雙語、簡短。
INSTRUCTIONS = """\
ComfyFed：把 ComfyUI 工作送到一群共享的 GPU worker 上執行。
ComfyFed runs ComfyUI jobs on a federation of shared GPU workers.

用法順序 / How to use:
1. 先 `list_recipes`；能用配方就用 `run_recipe`（參數已驗證、workflow 由平台渲染）。
   Start with `list_recipes`; prefer `run_recipe` whenever a recipe fits.
2. 配方不夠用時才 `submit_workflow`（傳完整的 ComfyUI API-format workflow JSON）。
   Only fall back to `submit_workflow` when no recipe covers the request.
3. 送單後用 `wait_for_job` 等結果，再用 `download_results` 取檔。
   After submitting, poll with `wait_for_job`, then fetch files with `download_results`.
4. 失敗時看 `job_status` 的 `attempt_errors`（每次重試在哪台 worker 出了什麼錯）。
   On failure, read `attempt_errors` from `job_status` to see what each attempt hit.
5. 缺模型用 `request_model`（只接受 huggingface.co / civitai.com 的網址），
   再用 `model_fetch_status` 追進度。
   If a model is missing, call `request_model` (huggingface.co / civitai.com URLs
   only) and track it with `model_fetch_status`.

`platform_status` / `list_workers` 看目前艦隊有哪些 GPU、能跑多大的模型。
Use `platform_status` / `list_workers` to see what hardware is available.
"""


class SettingsError(Exception):
    """設定不全（缺 token 或網址）；訊息直接印給使用者看。"""


class ToolError(Exception):
    """平台回 4xx/5xx。訊息是 `f"{code}: {message}"`，會原樣傳給 AI 客戶端。"""


# --------------------------------------------------------------------------
# §6.2 設定解析 / settings resolution
# --------------------------------------------------------------------------


@dataclass
class McpSettings:
    platform_url: str
    # `repr=False`：token 絕不能被 dataclass 的預設 repr 印出來（spec §9）。
    token: str = field(repr=False)
    source: str = ""


_MISSING_TOKEN_HELP = (
    "找不到 API token / No API token found.\n"
    "三種給法 / three ways to supply one:\n"
    '  1. 把 console「Settings → API token」下載的 mcp.json 放到 '
    "~/.comfyfed/mcp.json\n"
    "  2. 設環境變數 COMFYFED_TOKEN_FILE=<那個 JSON 的路徑>\n"
    "  3. 設環境變數 COMFYFED_TOKEN=<token>（可搭配 COMFYFED_PLATFORM_URL）"
)

_MISSING_URL_HELP = (
    "找不到平台網址 / No platform URL found.\n"
    "給法 / supply one via: mcp.json 的 platform_url、環境變數 "
    "COMFYFED_PLATFORM_URL，或已註冊的 ~/.comfyfed/agent.json。"
)


def _read_json_file(path: Path) -> Optional[dict]:
    """讀一個 JSON 物件檔。讀不到／不是物件 → None（呼叫端決定要不要警告）。"""
    try:
        # utf-8-sig：容忍 Windows 編輯器寫進去的 BOM（同 config.AgentConfig.load）。
        with open(path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def resolve_settings(env: Mapping[str, str], home: str) -> McpSettings:
    """依 spec §6.2 的順序解析 platform_url / token。

    1. `COMFYFED_TOKEN_FILE` 指到的 JSON，否則 `<home>/.comfyfed/mcp.json`。
    2. `COMFYFED_TOKEN` / `COMFYFED_PLATFORM_URL` 覆蓋。
    3. 網址還缺 → `<home>/.comfyfed/agent.json` 的 `platforms[0].platform_url`。
    4. 還是缺 → `SettingsError`（訊息說明三種給法）。
    """
    home_path = Path(home)
    sources: list[str] = []
    platform_url = ""
    token = ""

    # 1. mcp.json（或 COMFYFED_TOKEN_FILE 指定的檔）
    token_file_env = (env.get("COMFYFED_TOKEN_FILE") or "").strip()
    token_file = Path(token_file_env) if token_file_env else home_path / ".comfyfed" / "mcp.json"
    if token_file.exists():
        data = _read_json_file(token_file)
        if data is None:
            # 讀取失敗視同不存在，但要警告 —— 使用者多半是放錯檔或存壞了。
            print(
                f"comfyfed-mcp: 忽略無法解析的 mcp.json / ignoring unreadable "
                f"mcp.json: {token_file}",
                file=sys.stderr,
            )
        else:
            platform_url = str(data.get("platform_url") or "").strip()
            token = str(data.get("token") or "").strip()
            if platform_url or token:
                sources.append("mcp.json")
    elif token_file_env:
        print(
            f"comfyfed-mcp: COMFYFED_TOKEN_FILE 指向的檔案不存在 / file not "
            f"found: {token_file}",
            file=sys.stderr,
        )

    # 2. 環境變數覆蓋
    env_token = (env.get("COMFYFED_TOKEN") or "").strip()
    env_url = (env.get("COMFYFED_PLATFORM_URL") or "").strip()
    if env_token:
        token = env_token
    if env_url:
        platform_url = env_url
    if env_token or env_url:
        sources.append("env")

    # 3. 網址仍缺 → 已註冊的 agent.json 第一個平台
    if not platform_url:
        agent_json = _read_json_file(home_path / ".comfyfed" / "agent.json") or {}
        platforms = agent_json.get("platforms")
        if isinstance(platforms, list) and platforms:
            first = platforms[0]
            if isinstance(first, dict):
                platform_url = str(first.get("platform_url") or "").strip()
                if platform_url:
                    sources.append("agent.json")

    # 4. 缺就是啟動失敗
    if not token:
        raise SettingsError(_MISSING_TOKEN_HELP)
    if not platform_url:
        raise SettingsError(_MISSING_URL_HELP)

    return McpSettings(
        platform_url=platform_url.rstrip("/"),
        token=token,
        source="+".join(dict.fromkeys(sources)) or "unknown",
    )


# --------------------------------------------------------------------------
# HTTP client
# --------------------------------------------------------------------------


class Client:
    """同步 httpx client：每個請求帶 `Authorization: Bearer`，永不帶 `X-CSRF`。

    bearer 認證本來就跳過 CSRF（spec §4.3），送 CSRF header 只會讓平台以為
    這是 cookie session。`transport` 參數是給測試注入 `httpx.MockTransport`。
    """

    def __init__(self, settings: McpSettings, transport: Any = None) -> None:
        self.settings = settings
        self._http = httpx.Client(
            base_url=settings.platform_url.rstrip("/"),
            timeout=TIMEOUT_SECONDS,
            transport=transport,
            headers={
                "Authorization": f"Bearer {settings.token}",
                "User-Agent": f"comfyfed-mcp/{__version__}",
            },
            follow_redirects=True,
        )

    # -- 錯誤對應 ---------------------------------------------------------
    @staticmethod
    def _raise_for_error(response: httpx.Response) -> None:
        """平台錯誤 → `ToolError(f"{code}: {message}")`。

        兩種方言都要吃：
        * 一般路由的 envelope `{"error": {"code", "message"}}`；
        * `/comfy/api/comfyfed/model-fetch` 的 ComfyUI 方言，`error` 是**扁平
          字串**、`message` 在同一層。
        沒有 envelope（HTML 錯誤頁、proxy 502…）→ `http_<status>: <text[:200]>`。
        """
        if response.status_code < 400:
            return
        code = ""
        message = ""
        try:
            body = response.json()
        except ValueError:
            body = None
        if isinstance(body, dict):
            err = body.get("error")
            if isinstance(err, dict):
                code = str(err.get("code") or "")
                message = str(err.get("message") or "")
            elif isinstance(err, str):
                code = err
                message = str(body.get("message") or "")
        if code:
            raise ToolError(f"{code}: {message}")
        raise ToolError(f"http_{response.status_code}: {response.text[:200]}")

    def _json(self, response: httpx.Response) -> Any:
        self._raise_for_error(response)
        if not response.content:
            return {}
        try:
            return response.json()
        except ValueError:
            raise ToolError(
                f"http_{response.status_code}: 平台回了非 JSON / non-JSON response"
            ) from None

    # -- verbs ------------------------------------------------------------
    def get(self, path: str, **kw: Any) -> Any:
        return self._json(self._http.get(path, **kw))

    def post_json(self, path: str, body: Any) -> Any:
        return self._json(self._http.post(path, json=body))

    def post_form(self, path: str, data: Mapping[str, str], files: Any = None) -> Any:
        """送表單。`files` 沒給時把 `data` 轉成 multipart 欄位。

        `(None, value)` 是 httpx 的「沒有檔名的表單欄位」寫法，送出來就是
        乾淨的 `multipart/form-data`，對上平台的 `Form(...)`（spec §6.3）。
        """
        if files is None:
            files = {k: (None, v) for k, v in data.items()}
            data = {}
        return self._json(self._http.post(path, data=dict(data), files=files))

    def download(self, path: str, dest: Path) -> Path:
        """串流下載一個檔案到 `dest`（父目錄要先存在）。"""
        with self._http.stream("GET", path) as response:
            if response.status_code >= 400:
                response.read()
                self._raise_for_error(response)
            with open(dest, "wb") as f:
                for chunk in response.iter_bytes():
                    f.write(chunk)
        return dest

    def close(self) -> None:
        self._http.close()


# --------------------------------------------------------------------------
# §6.3 工具本體（純函式，第一個參數吃 Client）/ the 12 tools
# --------------------------------------------------------------------------


def platform_status(c: Client) -> dict:
    """平台與艦隊概況：我是誰、token 何時過期、有哪些 worker 與 GPU。"""
    me = c.get("/api/auth/me")
    workers = c.get("/api/workers")
    summary = []
    for w in workers if isinstance(workers, list) else []:
        hw = w.get("hardware") or {}
        summary.append(
            {
                "name": w.get("name"),
                "status": w.get("status"),
                # agent 送上來的鍵是 `gpu_name`（hardware.collect_hardware）；
                # 舊 row 或其他來源可能只有 `gpu`，兩個都接。
                "gpu": hw.get("gpu_name") or hw.get("gpu"),
                "vram_gb": hw.get("vram_gb"),
                "model_count": w.get("model_count"),
                "unsuitable_count": len(w.get("unsuitable") or []),
            }
        )
    return {
        "platform_url": c.settings.platform_url,
        "username": me.get("username"),
        "role": me.get("role"),
        "token_expires_at": me.get("token_expires_at"),
        "workers": summary,
    }


def list_workers(c: Client) -> list:
    """列出所有 worker（含 hardware 細節）。`dynamic` 是每秒在變的即時值，去掉。"""
    workers = c.get("/api/workers")
    return [
        {k: v for k, v in w.items() if k != "dynamic"}
        for w in (workers if isinstance(workers, list) else [])
    ]


def list_recipes(c: Client) -> Any:
    """列出平台內建的配方（recipe）與每個配方接受的參數。先看這個。"""
    return c.get("/api/recipes")


def run_recipe(c: Client, recipe_id: str, params: dict) -> Any:
    """用一個配方送單。平台會驗參數並渲染 workflow，回 `{job_id, recipe_id, params}`。"""
    return c.post_json(f"/api/recipes/{recipe_id}/run", {"params": params})


def submit_workflow(
    c: Client, workflow_json: str, requirements: Optional[dict] = None
) -> Any:
    """送一份完整的 ComfyUI API-format workflow JSON（配方不夠用時才用）。"""
    data = {"workflow_json": workflow_json}
    if requirements is not None:
        data["requirements"] = json.dumps(requirements)
    return c.post_form("/api/jobs", data)


def list_jobs(c: Client, status: Optional[str] = None, limit: int = 20) -> list:
    """列出工作。`status` 可用逗號分隔（例：`queued,running`）；預設只回前 20 筆。"""
    params = {"status": status} if status else {}
    rows = c.get("/api/jobs", params=params)
    rows = rows if isinstance(rows, list) else []
    keys = ("id", "status", "origin", "progress", "created_at", "worker_id", "error")
    return [{k: row.get(k) for k in keys} for row in rows[: max(0, int(limit))]]


def job_status(c: Client, job_id: str) -> dict:
    """一張單的完整狀態，含每次重試的錯誤（`attempt_errors`）與派工理由。"""
    d = c.get(f"/api/jobs/{job_id}")
    keys = (
        "id",
        "status",
        "progress",
        "worker_id",
        "error",
        "result_files",
        "attempts",
        "attempt_errors",
        "retry_count",
        "dispatch_info",
        "receipt",
    )
    return {k: d.get(k) for k in keys}


def wait_for_job(
    c: Client,
    job_id: str,
    timeout_seconds: int = 600,
    poll_seconds: int = 3,
    sleep: Callable[[float], None] = time.sleep,
) -> dict:
    """輪詢到工作結束（done/failed/cancelled），逾時回 `{"timed_out": true, ...}`。

    經過時間用 `poll_seconds` 自行累加而不是 `time.monotonic()`：注入假的
    `sleep` 就能在測試裡走完整條逾時路徑，不必真的睡。
    """
    elapsed = 0.0
    while True:
        state = job_status(c, job_id)
        if state.get("status") in TERMINAL_STATUSES:
            return state
        if elapsed + poll_seconds > timeout_seconds:
            return {"timed_out": True, **state}
        sleep(poll_seconds)
        elapsed += poll_seconds


def _safe_filename(name: str) -> Optional[str]:
    """檔名淨化（spec §9）：含 `..`／路徑分隔符／空 → None（呼叫端跳過）。"""
    if not isinstance(name, str) or not name.strip():
        return None
    if ".." in name or "/" in name or "\\" in name:
        return None
    base = os.path.basename(name)
    if not base or base in (".", ".."):
        return None
    return base


def download_results(
    c: Client,
    job_id: str,
    dest_dir: Optional[str] = None,
    home: Optional[str] = None,
) -> dict:
    """把一張單的產出檔下載到本機，預設 `~/.comfyfed/results/<job_id>/`。"""
    detail = c.get(f"/api/jobs/{job_id}")
    names = detail.get("result_files") or []

    if dest_dir:
        target = Path(dest_dir)
    else:
        base_home = Path(home) if home else Path(_home_dir())
        target = base_home / ".comfyfed" / "results" / job_id
    target.mkdir(parents=True, exist_ok=True)

    files: list[str] = []
    skipped: list[str] = []
    for name in names:
        safe = _safe_filename(name)
        if safe is None:
            skipped.append(name)
            continue
        dest = target / safe
        c.download(f"/api/jobs/{job_id}/artifacts/{safe}", dest)
        files.append(str(dest))
    return {"job_id": job_id, "files": files, "skipped": skipped}


def cancel_job(c: Client, job_id: str) -> dict:
    """取消一張還沒結束的單。"""
    d = c.post_json(f"/api/jobs/{job_id}/cancel", {})
    return {"status": d.get("status")}


def request_model(c: Client, name: str, directory: str, url: str) -> Any:
    """請艦隊下載一個缺的模型（只接受 huggingface.co / civitai.com 的網址）。"""
    return c.post_json(
        "/comfy/api/comfyfed/model-fetch",
        {"name": name, "directory": directory, "url": url},
    )


def model_fetch_status(c: Client, job_id: str) -> Any:
    """查 `request_model` 建的下載單進度。"""
    return c.get(f"/comfy/api/comfyfed/model-fetch/{job_id}")


# 給 `build_server` 用的查表。直接寫名字（而不是在 build_server 裡 `x =
# platform_status`）是因為 wrapper 的 `def` 會把同名符號變成 build_server 的
# 區域變數，那樣再讀模組層的同名函式就會 UnboundLocalError。
_TOOL_IMPLS: dict[str, Callable[..., Any]] = {
    fn.__name__: fn
    for fn in (
        platform_status,
        list_workers,
        list_recipes,
        run_recipe,
        submit_workflow,
        list_jobs,
        job_status,
        wait_for_job,
        download_results,
        cancel_job,
        request_model,
        model_fetch_status,
    )
}


# --------------------------------------------------------------------------
# MCP 註冊（唯一 import mcp 的地方）/ MCP registration (the only mcp import)
# --------------------------------------------------------------------------


def _import_mcp_server():
    """Lazy import：`mcp` 是選配 extra，模組層不能碰它。"""
    from mcp.server.mcpserver import MCPServer  # noqa: PLC0415

    return MCPServer


def _home_dir() -> str:
    return os.path.expanduser("~")


def build_server(settings: McpSettings, client: Optional[Client] = None):
    """建一個註冊好 12 個工具的 `MCPServer`（工具名 = 模組層函式名）。"""
    MCPServer = _import_mcp_server()
    c = client if client is not None else Client(settings)
    impl = _TOOL_IMPLS

    server = MCPServer(name="comfyfed", instructions=INSTRUCTIONS, version=__version__)

    @server.tool()
    def platform_status() -> dict:
        """平台與艦隊概況：使用者、token 到期時間、每台 worker 的 GPU/VRAM。
        Platform and fleet overview: user, token expiry, per-worker GPU/VRAM."""
        return impl["platform_status"](c)

    @server.tool()
    def list_workers() -> list:
        """列出所有 worker 與其硬體／模型數。List all workers with hardware."""
        return impl["list_workers"](c)

    @server.tool()
    def list_recipes() -> list:
        """列出可用配方與參數；送單前先看這個。List recipes; call this first."""
        return impl["list_recipes"](c)

    @server.tool()
    def run_recipe(recipe_id: str, params: dict) -> dict:
        """用配方送單（平台驗參數並渲染 workflow）。Submit a job from a recipe."""
        return impl["run_recipe"](c, recipe_id, params)

    @server.tool()
    def submit_workflow(workflow_json: str, requirements: Optional[dict] = None) -> dict:
        """送一份完整 ComfyUI API-format workflow JSON（配方不夠用時）。
        Submit a raw ComfyUI API-format workflow when no recipe fits."""
        return impl["submit_workflow"](c, workflow_json, requirements)

    @server.tool()
    def list_jobs(status: Optional[str] = None, limit: int = 20) -> list:
        """列出工作，`status` 可逗號分隔。List jobs, optionally filtered by status."""
        return impl["list_jobs"](c, status, limit)

    @server.tool()
    def job_status(job_id: str) -> dict:
        """一張單的完整狀態與重試錯誤。Full job state including attempt_errors."""
        return impl["job_status"](c, job_id)

    @server.tool()
    def wait_for_job(job_id: str, timeout_seconds: int = 600, poll_seconds: int = 3) -> dict:
        """等到工作結束或逾時。Poll until the job is done/failed/cancelled or times out."""
        return impl["wait_for_job"](c, job_id, timeout_seconds, poll_seconds)

    @server.tool()
    def download_results(job_id: str, dest_dir: Optional[str] = None) -> dict:
        """把產出檔下載到本機，預設 ~/.comfyfed/results/<job_id>/。
        Download a job's result files locally."""
        return impl["download_results"](c, job_id, dest_dir)

    @server.tool()
    def cancel_job(job_id: str) -> dict:
        """取消一張還沒結束的單。Cancel a job that has not finished."""
        return impl["cancel_job"](c, job_id)

    @server.tool()
    def request_model(name: str, directory: str, url: str) -> dict:
        """請艦隊下載缺的模型（僅 huggingface.co / civitai.com）。
        Ask the fleet to fetch a missing model."""
        return impl["request_model"](c, name, directory, url)

    @server.tool()
    def model_fetch_status(job_id: str) -> dict:
        """查模型下載單的進度。Progress of a model fetch job."""
        return impl["model_fetch_status"](c, job_id)

    return server


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def cli(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="comfyfed-mcp",
        description=(
            "ComfyFed MCP server：把平台包成 AI 客戶端可呼叫的工具（stdio）。/ "
            "Expose a ComfyFed platform to an AI client over MCP stdio."
        ),
    )
    parser.add_argument(
        "--token-file",
        default=None,
        help="API token JSON（同 COMFYFED_TOKEN_FILE；預設 ~/.comfyfed/mcp.json）。",
    )
    parser.add_argument(
        "--platform-url",
        default=None,
        help="平台網址（同 COMFYFED_PLATFORM_URL）。",
    )
    parser.add_argument("--version", action="version", version=f"comfyfed-mcp {__version__}")
    args = parser.parse_args(argv)

    # 先確認 mcp 裝了沒（spec §6.1）：缺套件是 exit 2，跟「設定不全」的 1 分開，
    # 這樣使用者一眼看得出要裝東西還是要放 token。
    try:
        _import_mcp_server()
    except ImportError:
        print(
            'comfyfed-mcp 需要 mcp 套件 / requires the "mcp" package.\n'
            '  pip install "comfyfed[mcp]"',
            file=sys.stderr,
        )
        return 2

    env = dict(os.environ)
    if args.token_file:
        env["COMFYFED_TOKEN_FILE"] = args.token_file
    if args.platform_url:
        env["COMFYFED_PLATFORM_URL"] = args.platform_url

    try:
        settings = resolve_settings(env, _home_dir())
    except SettingsError as exc:
        print(f"comfyfed-mcp: {exc}", file=sys.stderr)
        return 1

    # 只印來源，不印 token。
    print(
        f"comfyfed-mcp {__version__}: {settings.platform_url} (settings: {settings.source})",
        file=sys.stderr,
    )
    build_server(settings).run("stdio")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(cli())
