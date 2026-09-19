"""`comfyfed-mcp`（spec §6）的測試 / Tests for the MCP server entry point.

這裡用 `httpx.MockTransport` 架一個假平台，逐個工具驗證「打了哪條路徑、帶了
什麼 header、回傳什麼形狀」。整份測試**不需要** `mcp` 套件（只有
`build_server` 那一條 `importorskip`），因為 `comfyfed_agent.mcp_server`
模組層刻意不 import `mcp`：agent 自更新用 `pip install --no-deps`，硬依賴
會裝不到。

The whole file must keep passing when `mcp` is absent -- only the
`build_server` test skips itself.
"""

from __future__ import annotations

import ast
import asyncio
import importlib
import json
import sys

from pathlib import Path

import httpx
import pytest

from comfyfed_agent import mcp_server


TOKEN = "cft_secret_token_value"
PLATFORM = "https://platform.example"


# --------------------------------------------------------------------------
# 假平台 / fake platform
# --------------------------------------------------------------------------


class FakePlatform:
    """記錄每個請求的假平台；`routes[(method, path)]` 回一個 httpx.Response。"""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.routes: dict[tuple[str, str], object] = {}

    def route(self, method: str, path: str, response):
        self.routes[(method, path)] = response
        return self

    def json_route(self, method: str, path: str, payload, status: int = 200):
        return self.route(method, path, httpx.Response(status, json=payload))

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        entry = self.routes.get((request.method, request.url.path))
        if entry is None:
            return httpx.Response(
                404, json={"error": {"code": "not_found", "message": request.url.path}}
            )
        if callable(entry):
            return entry(request)
        return entry

    def client(self) -> mcp_server.Client:
        settings = mcp_server.McpSettings(
            platform_url=PLATFORM, token=TOKEN, source="test"
        )
        return mcp_server.Client(settings, transport=httpx.MockTransport(self._handle))

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]

    def paths(self) -> list[str]:
        return [r.url.path for r in self.requests]


def assert_bearer(request: httpx.Request) -> None:
    """每個請求都要帶 bearer、都不准帶 CSRF header（spec §9）。"""
    assert request.headers.get("authorization") == f"Bearer {TOKEN}"
    assert "x-csrf" not in {k.lower() for k in request.headers.keys()}


# --------------------------------------------------------------------------
# §6.2 resolve_settings
# --------------------------------------------------------------------------


def _write_mcp_json(home, **data):
    d = home / ".comfyfed"
    d.mkdir(parents=True, exist_ok=True)
    (d / "mcp.json").write_text(json.dumps(data), encoding="utf-8")
    return d / "mcp.json"


def test_resolve_settings_from_mcp_json(tmp_path):
    _write_mcp_json(tmp_path, platform_url=PLATFORM, token=TOKEN)
    s = mcp_server.resolve_settings({}, str(tmp_path))
    assert s.platform_url == PLATFORM
    assert s.token == TOKEN
    assert "mcp.json" in s.source


def test_resolve_settings_from_token_file_env(tmp_path):
    other = tmp_path / "elsewhere.json"
    other.write_text(
        json.dumps({"platform_url": PLATFORM, "token": TOKEN}), encoding="utf-8"
    )
    s = mcp_server.resolve_settings(
        {"COMFYFED_TOKEN_FILE": str(other)}, str(tmp_path)
    )
    assert (s.platform_url, s.token) == (PLATFORM, TOKEN)
    # 自訂路徑要標成 token_file，不能謊稱是 ~/.comfyfed/mcp.json ——
    # 這是使用者查「撿到哪個 token」時唯一的線索。
    assert s.source == "token_file"


def test_resolve_settings_env_overrides_file(tmp_path):
    _write_mcp_json(tmp_path, platform_url="https://old.example", token="old")
    s = mcp_server.resolve_settings(
        {"COMFYFED_TOKEN": TOKEN, "COMFYFED_PLATFORM_URL": PLATFORM}, str(tmp_path)
    )
    assert (s.platform_url, s.token) == (PLATFORM, TOKEN)
    assert "env" in s.source


def test_resolve_settings_env_only(tmp_path):
    s = mcp_server.resolve_settings(
        {"COMFYFED_TOKEN": TOKEN, "COMFYFED_PLATFORM_URL": PLATFORM}, str(tmp_path)
    )
    assert s.source == "env"


def test_resolve_settings_url_from_agent_json(tmp_path):
    d = tmp_path / ".comfyfed"
    d.mkdir(parents=True)
    (d / "agent.json").write_text(
        json.dumps(
            {
                "platforms": [
                    {"platform_url": PLATFORM, "worker_id": "w1"},
                    {"platform_url": "https://second.example", "worker_id": "w2"},
                ]
            }
        ),
        encoding="utf-8",
    )
    s = mcp_server.resolve_settings({"COMFYFED_TOKEN": TOKEN}, str(tmp_path))
    assert s.platform_url == PLATFORM  # 多平台取第一個
    assert "agent.json" in s.source


def test_resolve_settings_missing_token_raises(tmp_path):
    with pytest.raises(mcp_server.SettingsError) as exc:
        mcp_server.resolve_settings({"COMFYFED_PLATFORM_URL": PLATFORM}, str(tmp_path))
    text = str(exc.value)
    assert "COMFYFED_TOKEN" in text and "mcp.json" in text


def test_resolve_settings_missing_url_raises(tmp_path):
    with pytest.raises(mcp_server.SettingsError) as exc:
        mcp_server.resolve_settings({"COMFYFED_TOKEN": TOKEN}, str(tmp_path))
    assert "COMFYFED_PLATFORM_URL" in str(exc.value)


def test_resolve_settings_bad_mcp_json_warns_but_continues(tmp_path, capsys):
    d = tmp_path / ".comfyfed"
    d.mkdir(parents=True)
    (d / "mcp.json").write_text("{not json", encoding="utf-8")
    s = mcp_server.resolve_settings(
        {"COMFYFED_TOKEN": TOKEN, "COMFYFED_PLATFORM_URL": PLATFORM}, str(tmp_path)
    )
    assert s.token == TOKEN
    assert "mcp.json" in capsys.readouterr().err


def test_settings_never_leak_token_in_repr_or_str(tmp_path):
    s = mcp_server.McpSettings(platform_url=PLATFORM, token=TOKEN, source="env")
    assert TOKEN not in repr(s)
    assert TOKEN not in str(s)


# --------------------------------------------------------------------------
# §6.3 工具 / tools
# --------------------------------------------------------------------------


ME = {
    "authenticated": True,
    "username": "alice",
    "role": "admin",
    "lang": "zh",
    "platform_url": PLATFORM,
    "csrf": None,
    "auth": "token",
    "token_expires_at": "2026-12-01T00:00:00+00:00",
}

WORKERS = [
    {
        "id": "w1",
        "name": "rig-a",
        "status": "idle",
        "hardware": {"gpu_name": "RTX 5080", "vram_gb": 16.0, "ram_gb": 64.0},
        "dynamic": {"vram_free_gb": 12.0},
        "model_count": 42,
        "unsuitable": [{"model": "x"}, {"model": "y"}],
    },
    {
        "id": "w2",
        "name": "rig-b",
        "status": "busy",
        "hardware": {},
        "dynamic": {},
        "model_count": 0,
        "unsuitable": [],
    },
]


def test_platform_status_shape_and_headers():
    fake = FakePlatform()
    fake.json_route("GET", "/api/auth/me", ME)
    fake.json_route("GET", "/api/workers", WORKERS)

    out = mcp_server.platform_status(fake.client())

    assert fake.paths() == ["/api/auth/me", "/api/workers"]
    for req in fake.requests:
        assert_bearer(req)
    assert out["platform_url"] == PLATFORM
    assert out["username"] == "alice"
    assert out["role"] == "admin"
    assert out["token_expires_at"] == ME["token_expires_at"]
    assert out["workers"] == [
        {
            "name": "rig-a",
            "status": "idle",
            "gpu": "RTX 5080",
            "vram_gb": 16.0,
            "model_count": 42,
            "unsuitable_count": 2,
        },
        {
            "name": "rig-b",
            "status": "busy",
            "gpu": None,
            "vram_gb": None,
            "model_count": 0,
            "unsuitable_count": 0,
        },
    ]
    assert TOKEN not in json.dumps(out)


def test_list_workers_strips_dynamic():
    fake = FakePlatform()
    fake.json_route("GET", "/api/workers", WORKERS)

    out = mcp_server.list_workers(fake.client())

    assert_bearer(fake.last)
    assert fake.last.url.path == "/api/workers"
    assert all("dynamic" not in w for w in out)
    assert out[0]["hardware"] == WORKERS[0]["hardware"]


def test_list_recipes_passthrough():
    payload = [{"id": "flux-t2i", "name": {"zh": "文生圖"}, "params": []}]
    fake = FakePlatform()
    fake.json_route("GET", "/api/recipes", payload)

    out = mcp_server.list_recipes(fake.client())

    assert_bearer(fake.last)
    assert out == payload


def test_run_recipe_posts_params():
    fake = FakePlatform()
    fake.json_route(
        "POST",
        "/api/recipes/flux-t2i/run",
        {"job_id": "j1", "recipe_id": "flux-t2i", "params": {"prompt": "cat"}},
        status=201,
    )

    out = mcp_server.run_recipe(fake.client(), "flux-t2i", {"prompt": "cat"})

    assert fake.last.method == "POST"
    assert fake.last.url.path == "/api/recipes/flux-t2i/run"
    assert_bearer(fake.last)
    assert json.loads(fake.last.content) == {"params": {"prompt": "cat"}}
    assert out["job_id"] == "j1"


def test_submit_workflow_multipart_with_requirements():
    fake = FakePlatform()
    fake.json_route("POST", "/api/jobs", {"job_id": "j2"})

    out = mcp_server.submit_workflow(
        fake.client(), '{"1": {}}', {"min_vram_gb": 12}
    )

    assert fake.last.url.path == "/api/jobs"
    assert fake.last.headers["content-type"].startswith("multipart/form-data")
    body = fake.last.content.decode("utf-8")
    assert 'name="workflow_json"' in body and '{"1": {}}' in body
    assert 'name="requirements"' in body and '"min_vram_gb": 12' in body
    assert out == {"job_id": "j2"}


def test_submit_workflow_without_requirements_omits_field():
    fake = FakePlatform()
    fake.json_route("POST", "/api/jobs", {"job_id": "j3"})

    mcp_server.submit_workflow(fake.client(), "{}")

    assert 'name="requirements"' not in fake.last.content.decode("utf-8")


def _job_row(job_id: str, status: str = "queued", hour: int = 0) -> dict:
    return {
        "id": job_id,
        "status": status,
        "origin": "api",
        "progress": 0.5,
        "created_at": f"2026-09-20T{hour:02d}:00:00+00:00",
        "worker_id": "w1",
        "error": None,
        "result_files": ["a.png"],
        "est_vram_gb": 12,
    }


def test_list_jobs_filters_and_truncates():
    # 平台是 created_at 升冪回的（jobs.py），所以 j4 是「剛送的那張」。
    rows = [_job_row(f"j{i}", hour=i) for i in range(5)]
    fake = FakePlatform()
    fake.json_route("GET", "/api/jobs", rows)

    out = mcp_server.list_jobs(fake.client(), status="queued,running", limit=2)

    assert fake.last.url.path == "/api/jobs"
    assert dict(fake.last.url.params) == {"status": "queued,running"}
    assert_bearer(fake.last)
    # 最新的在前，而且剛送的那張一定在裡面（切前 N 筆會變成最舊的 N 筆）。
    assert [r["id"] for r in out] == ["j4", "j3"]
    assert set(out[0]) == {
        "id",
        "status",
        "origin",
        "progress",
        "created_at",
        "worker_id",
        "error",
    }


def test_list_jobs_orders_newest_first_regardless_of_server_order():
    rows = [_job_row("old", hour=1), _job_row("new", hour=9), _job_row("mid", hour=5)]
    fake = FakePlatform()
    fake.json_route("GET", "/api/jobs", rows)

    out = mcp_server.list_jobs(fake.client(), limit=10)

    assert [r["id"] for r in out] == ["new", "mid", "old"]


def test_list_jobs_tolerates_missing_created_at():
    rows = [_job_row("a", hour=3), {**_job_row("b"), "created_at": None}]
    fake = FakePlatform()
    fake.json_route("GET", "/api/jobs", rows)

    out = mcp_server.list_jobs(fake.client())

    assert [r["id"] for r in out] == ["a", "b"]  # 缺 created_at 排最後


def test_list_jobs_bad_limit_falls_back_to_default():
    rows = [_job_row(f"j{i}", hour=i) for i in range(3)]
    fake = FakePlatform()
    fake.json_route("GET", "/api/jobs", rows)

    out = mcp_server.list_jobs(fake.client(), limit="not a number")  # type: ignore[arg-type]

    assert [r["id"] for r in out] == ["j2", "j1", "j0"]


def test_list_jobs_without_status_sends_no_param():
    fake = FakePlatform()
    fake.json_route("GET", "/api/jobs", [])

    mcp_server.list_jobs(fake.client())

    assert dict(fake.last.url.params) == {}


DETAIL = {
    "id": "j1",
    "status": "done",
    "progress": 1.0,
    "worker_id": "w1",
    "error": None,
    "result_files": ["out.png"],
    "attempts": 2,
    "attempt_errors": [{"worker_id": "w9", "error": "oom"}],
    "retry_count": 1,
    "dispatch_info": {"reason": "best_fit"},
    "receipt": {"id": "r1"},
    "workflow_json": {"big": "blob"},
}


def test_job_status_projects_detail_fields():
    fake = FakePlatform()
    fake.json_route("GET", "/api/jobs/j1", DETAIL)

    out = mcp_server.job_status(fake.client(), "j1")

    assert fake.last.url.path == "/api/jobs/j1"
    assert_bearer(fake.last)
    assert set(out) == {
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
    }
    assert out["attempt_errors"] == DETAIL["attempt_errors"]


def test_wait_for_job_polls_until_terminal():
    states = ["queued", "running", "running", "done"]
    fake = FakePlatform()

    def handler(request):
        return httpx.Response(200, json={**DETAIL, "status": states.pop(0)})

    fake.route("GET", "/api/jobs/j1", handler)
    slept: list[float] = []

    out = mcp_server.wait_for_job(
        fake.client(), "j1", poll_seconds=3, sleep=slept.append
    )

    assert out["status"] == "done"
    assert slept == [3, 3, 3]
    assert len(fake.requests) == 4


@pytest.mark.parametrize("terminal", ["done", "failed", "cancelled"])
def test_wait_for_job_terminal_statuses(terminal):
    fake = FakePlatform()
    fake.json_route("GET", "/api/jobs/j1", {**DETAIL, "status": terminal})

    out = mcp_server.wait_for_job(fake.client(), "j1", sleep=lambda _s: None)

    assert out["status"] == terminal
    assert "timed_out" not in out


def test_wait_for_job_times_out():
    fake = FakePlatform()
    fake.json_route("GET", "/api/jobs/j1", {**DETAIL, "status": "running"})
    slept: list[float] = []

    out = mcp_server.wait_for_job(
        fake.client(), "j1", timeout_seconds=9, poll_seconds=3, sleep=slept.append
    )

    assert out["timed_out"] is True
    assert out["status"] == "running"
    assert slept == [3, 3, 3]


# --------------------------------------------------------------------------
# download_results
# --------------------------------------------------------------------------


def _artifact_platform(files: list[str]) -> FakePlatform:
    fake = FakePlatform()
    fake.json_route("GET", "/api/jobs/j1", {**DETAIL, "result_files": files})

    def art(request):
        assert_bearer(request)  # 下載也走 bearer，不帶 CSRF
        return httpx.Response(200, content=b"PNGDATA")

    for name in files:
        fake.route("GET", f"/api/jobs/j1/artifacts/{name}", art)
    return fake


def test_download_results_default_home_dir(tmp_path):
    fake = _artifact_platform(["out.png", "out2.png"])

    out = mcp_server.download_results(fake.client(), "j1", home=str(tmp_path))

    target = tmp_path / ".comfyfed" / "results" / "j1"
    assert sorted(p.name for p in target.iterdir()) == ["out.png", "out2.png"]
    assert (target / "out.png").read_bytes() == b"PNGDATA"
    assert out["job_id"] == "j1"
    assert sorted(out["files"]) == sorted(str(target / n) for n in ("out.png", "out2.png"))
    assert out["skipped"] == []


def test_download_results_explicit_dest_dir(tmp_path):
    fake = _artifact_platform(["out.png"])
    dest = tmp_path / "pics"

    out = mcp_server.download_results(
        fake.client(), "j1", dest_dir=str(dest), home=str(tmp_path)
    )

    assert (dest / "out.png").exists()
    assert out["files"] == [str(dest / "out.png")]


def test_download_results_dest_dir_is_made_absolute(tmp_path, monkeypatch):
    """spec §6.3 承諾 `files` 是絕對路徑，相對的 dest_dir 也不例外。"""
    fake = _artifact_platform(["out.png"])
    monkeypatch.chdir(tmp_path)

    out = mcp_server.download_results(
        fake.client(), "j1", dest_dir="pics", home=str(tmp_path)
    )

    assert Path(out["files"][0]).is_absolute()
    assert (tmp_path / "pics" / "out.png").exists()


def test_download_results_percent_encodes_filename(tmp_path):
    """`#` 沒編碼的話 httpx 會把它當 fragment，路徑被截短而抓錯檔。

    （測試只用 `#`：`?` 在 Windows 檔名裡是非法字元，開檔就先炸了。）
    """
    fake = _artifact_platform(["a#b.png"])

    out = mcp_server.download_results(fake.client(), "j1", home=str(tmp_path))

    # 假平台是照「解碼後的 path」路由的：沒編碼就會變成 /artifacts/a 而 404。
    assert fake.paths()[-1] == "/api/jobs/j1/artifacts/a#b.png"
    assert out["skipped"] == []
    assert Path(out["files"][0]).name == "a#b.png"


@pytest.mark.parametrize(
    "evil", ["../evil.png", "sub/evil.png", "..\\evil.png", "", "."]
)
def test_download_results_rejects_traversal(tmp_path, evil):
    fake = _artifact_platform([evil])

    out = mcp_server.download_results(fake.client(), "j1", home=str(tmp_path))

    assert out["files"] == []
    assert out["skipped"] == [evil]
    # 只打了 job detail，沒有對 artifacts 發任何請求
    assert fake.paths() == ["/api/jobs/j1"]
    assert not (tmp_path / "evil.png").exists()


def test_cancel_job():
    fake = FakePlatform()
    fake.json_route("POST", "/api/jobs/j1/cancel", {"status": "cancelled"})

    out = mcp_server.cancel_job(fake.client(), "j1")

    assert fake.last.method == "POST"
    assert fake.last.url.path == "/api/jobs/j1/cancel"
    assert_bearer(fake.last)
    assert out == {"status": "cancelled"}


def test_request_model_posts_body():
    fake = FakePlatform()
    fake.json_route(
        "POST",
        "/comfy/api/comfyfed/model-fetch",
        {"job_id": "mf1", "reused": False},
        status=201,
    )

    out = mcp_server.request_model(
        fake.client(), "flux.safetensors", "checkpoints", "https://huggingface.co/a/b"
    )

    assert fake.last.url.path == "/comfy/api/comfyfed/model-fetch"
    assert_bearer(fake.last)
    assert json.loads(fake.last.content) == {
        "name": "flux.safetensors",
        "directory": "checkpoints",
        "url": "https://huggingface.co/a/b",
    }
    assert out == {"job_id": "mf1", "reused": False}


def test_model_fetch_status_passthrough():
    payload = {
        "job_id": "mf1",
        "status": "running",
        "stage": "fetching",
        "fetch_pct": 42.0,
        "fetch_model": "flux.safetensors",
        "worker_id": "w1",
        "error": None,
        "name": "flux.safetensors",
    }
    fake = FakePlatform()
    fake.json_route("GET", "/comfy/api/comfyfed/model-fetch/mf1", payload)

    out = mcp_server.model_fetch_status(fake.client(), "mf1")

    assert_bearer(fake.last)
    assert out == payload


# --------------------------------------------------------------------------
# 錯誤對應 / error mapping
# --------------------------------------------------------------------------


def test_tool_error_from_error_envelope():
    fake = FakePlatform()
    fake.json_route(
        "GET",
        "/api/workers",
        {"error": {"code": "auth.expired", "message": "token expired"}},
        status=401,
    )

    with pytest.raises(mcp_server.ToolError) as exc:
        mcp_server.list_workers(fake.client())

    assert str(exc.value) == "auth.expired: token expired"


def test_tool_error_from_flat_model_fetch_error():
    """model-fetch 這條路線的 `error` 是扁平字串（ComfyUI 方言），不是 envelope。"""
    fake = FakePlatform()
    fake.json_route(
        "POST",
        "/comfy/api/comfyfed/model-fetch",
        {"error": "model_fetch.no_worker", "message": "no worker can fetch"},
        status=400,
    )

    with pytest.raises(mcp_server.ToolError) as exc:
        mcp_server.request_model(fake.client(), "m", "checkpoints", "https://x/y")

    assert "model_fetch.no_worker" in str(exc.value)
    assert "no worker can fetch" in str(exc.value)


def test_tool_error_without_envelope_uses_http_status():
    fake = FakePlatform()
    fake.route("GET", "/api/recipes", httpx.Response(502, text="bad gateway " * 40))

    with pytest.raises(mcp_server.ToolError) as exc:
        mcp_server.list_recipes(fake.client())

    text = str(exc.value)
    assert text.startswith("http_502: ")
    assert len(text) <= len("http_502: ") + 200


def test_tool_error_never_contains_token():
    fake = FakePlatform()
    fake.json_route(
        "GET", "/api/workers", {"error": {"code": "x", "message": "y"}}, status=403
    )

    with pytest.raises(mcp_server.ToolError) as exc:
        mcp_server.list_workers(fake.client())

    assert TOKEN not in str(exc.value)


# --------------------------------------------------------------------------
# §6.1 出貨：mcp 是選配 / shipping: mcp is optional
# --------------------------------------------------------------------------


TOOL_NAMES = [
    "platform_status",
    "list_workers",
    "list_recipes",
    "run_recipe",
    "submit_workflow",
    "list_jobs",
    "job_status",
    "wait_for_job",
    "download_results",
    "cancel_job",
    "request_model",
    "model_fetch_status",
]


def test_module_has_no_module_level_mcp_import():
    """模組層（AST 的 module body）不能有任何 `mcp` 的 import。"""
    path = importlib.import_module("comfyfed_agent.mcp_server").__file__
    with open(path, "r", encoding="utf-8") as f:
        tree = ast.parse(f.read())

    imported: list[str] = []
    for node in tree.body:  # 只看 module body，函式內的 lazy import 不算
        if isinstance(node, ast.Import):
            imported += [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom):
            imported.append(node.module or "")

    assert not [m for m in imported if m == "mcp" or m.startswith("mcp.")], imported


def test_import_succeeds_without_mcp(monkeypatch):
    monkeypatch.setitem(sys.modules, "mcp", None)
    monkeypatch.setitem(sys.modules, "mcp.server", None)
    try:
        reloaded = importlib.reload(mcp_server)
        assert hasattr(reloaded, "resolve_settings")
    finally:
        monkeypatch.undo()
        importlib.reload(mcp_server)


def test_cli_returns_2_when_mcp_missing(monkeypatch, capsys, tmp_path):
    monkeypatch.setitem(sys.modules, "mcp", None)
    monkeypatch.setenv("COMFYFED_TOKEN", TOKEN)
    monkeypatch.setenv("COMFYFED_PLATFORM_URL", PLATFORM)

    rc = mcp_server.cli([])

    assert rc == 2
    err = capsys.readouterr().err
    assert 'pip install "comfyfed[mcp]"' in err
    assert TOKEN not in err


def test_cli_returns_1_without_settings(monkeypatch, capsys, tmp_path):
    for var in (
        "COMFYFED_TOKEN",
        "COMFYFED_TOKEN_FILE",
        "COMFYFED_PLATFORM_URL",
    ):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(mcp_server, "_home_dir", lambda: str(tmp_path))
    monkeypatch.setattr(mcp_server, "_import_mcp_server", lambda: object())

    rc = mcp_server.cli([])

    assert rc == 1
    assert "COMFYFED_TOKEN" in capsys.readouterr().err


def test_cli_flags_override_env(monkeypatch, tmp_path):
    """`--platform-url` / `--token-file` 蓋掉環境變數。"""
    token_file = tmp_path / "t.json"
    token_file.write_text(
        json.dumps({"platform_url": "https://ignored.example", "token": TOKEN}),
        encoding="utf-8",
    )
    for var in ("COMFYFED_TOKEN", "COMFYFED_TOKEN_FILE", "COMFYFED_PLATFORM_URL"):
        monkeypatch.delenv(var, raising=False)  # cli() 會複製 os.environ
    monkeypatch.setattr(mcp_server, "_home_dir", lambda: str(tmp_path))
    monkeypatch.setattr(mcp_server, "_import_mcp_server", lambda: object())
    seen: dict = {}

    class _Server:
        def run(self, transport):
            seen["transport"] = transport

    def _build(settings, client=None):
        seen["s"] = settings
        return _Server()

    monkeypatch.setattr(mcp_server, "build_server", _build)

    rc = mcp_server.cli(
        ["--token-file", str(token_file), "--platform-url", PLATFORM]
    )

    assert rc == 0
    assert seen["transport"] == "stdio"
    assert seen["s"].platform_url == PLATFORM
    assert seen["s"].token == TOKEN


def test_build_server_registers_twelve_tools():
    pytest.importorskip("mcp")
    settings = mcp_server.McpSettings(
        platform_url=PLATFORM, token=TOKEN, source="test"
    )
    fake = FakePlatform()
    server = mcp_server.build_server(settings, client=fake.client())

    tools = asyncio.run(server.list_tools())
    names = [t.name for t in tools]

    assert sorted(names) == sorted(TOOL_NAMES)
    assert len(names) == 12
    # 每個工具都要有說明（給 AI 讀的 description）
    assert all(t.description for t in tools)


def test_server_instructions_are_bilingual():
    assert "list_recipes" in mcp_server.INSTRUCTIONS
    assert "wait_for_job" in mcp_server.INSTRUCTIONS
    assert "request_model" in mcp_server.INSTRUCTIONS
    # 中英雙語（有 CJK 也有英文）
    assert any("一" <= ch <= "鿿" for ch in mcp_server.INSTRUCTIONS)
    assert TOKEN not in mcp_server.INSTRUCTIONS
