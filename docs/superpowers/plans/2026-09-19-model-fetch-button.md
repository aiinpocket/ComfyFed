# 面板「下載」鈕改派 worker（model_fetch job）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 面板「缺少模型」卡片的「下載」鈕不再讓瀏覽器下載到使用者電腦，而是建一張 `kind=model_fetch` 的任務，由聯邦派給開了 auto_fetch 的 worker 下載、驗證、回報雜湊。

**Architecture:** 新的 job kind 完全重用既有 `eligible_after_fetch` 派工鏈：建單時把「平台簽章的 manifest 項目」存在 `jobs.fetch_entry`，dispatch tick 把它合併進 `fetchable_models`/`manifest_by_name`，agent 收到 `kind=model_fetch` push 後只做 fetch 不跑 workflow，`job_done` 帶 `fetched_models` 讓平台學雜湊，收據非計費。平台沒有已知雜湊的模型以「未驗證來源」項目派工（url 進簽章、白名單網域、size 由 HEAD 取得）。面板端用官方擴充機制攔鈕。

**Tech Stack:** Python 3.11 / FastAPI / SQLAlchemy 2.x / Alembic / httpx / PyNaCl（`server/`、`agent/`）；Cloudflare Workers / Hono / D1 / Durable Object（`cloud/`）；React 18 + Mantine + i18next（`web/`）；pytest、vitest。

**Spec:** `docs/superpowers/specs/2026-09-19-model-fetch-button-design.md` — 具約束力，每個任務開工前重讀對應章節。

## Global Constraints

- 兩棧 parity（`server/` 與 `cloud/` 同一輸入同一結果；`panel_ext/comfyfed.js` 與 `cloud/src/core/comfyfed_ext.ts` byte parity，有 vitest 把關）。
- agent 版本 **0.1.14**（`agent/comfyfed_agent/__init__.py` 與根 `pyproject.toml` 兩處），hello `protocol: 5`。
- 新常數：`_MIN_UNVERIFIED_FETCH_PROTOCOL = 5`（py `assess.py`）／`MIN_UNVERIFIED_FETCH_PROTOCOL = 5`（ts `assess.ts`）。
- 未驗證項目簽章 payload 逐字：`f"{name}|{directory}|{url}|{size_bytes}|unverified"`。已驗證項目維持 `f"{name}|{directory}|{sha256}|{size_bytes}"`。
- url 白名單：origin 為 `https://huggingface.co` 或 `https://civitai.com`（用 URL 解析後的 origin 小寫比對，不是字串前綴）。
- HEAD 逾時 10 秒、follow redirects；401/403 → `model_fetch.gated`。
- 面板輪詢 2 秒。
- 所有使用者可見字串 zh-TW 先、en 後。
- 測試指令：repo root `.venv/Scripts/python.exe -m pytest tests/agent tests/server -q`；`cloud/` 內 `npx vitest run --no-file-parallelism` 與 `npx tsc --noEmit`；`web/` 內 `npm test -- --run` 與 `npx tsc --noEmit`。**子代理不得在背景跑 pytest；每個任務只跑自己的測試檔，全套由 controller 前景跑。**
- 全部在 `main`，每個任務自己 commit，訊息結尾：
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

## File Structure

新建：

| 檔案 | 責任 |
|---|---|
| `server/comfyfed_server/model_fetch.py` | 純函式：白名單判定、HEAD 取 size、未驗證項目簽章、建單判定序列（§5.1）、狀態 dict（§5.2） |
| `server/alembic/versions/c4d5e6f7a8b9_model_fetch.py` | `jobs.kind`、`jobs.fetch_entry` |
| `cloud/migrations/0011_model_fetch.sql` | 同上（D1） |
| `cloud/src/core/model_fetch.ts` | `model_fetch.py` 的 port |
| `tests/server/test_model_fetch.py` | 純函式與端點測試 |
| `cloud/test/model_fetch.spec.ts` | 同上 |

修改：

| 檔案 | 改動 |
|---|---|
| `server/comfyfed_server/db.py` | `Job.kind`、`Job.fetch_entry` |
| `server/comfyfed_server/jobs.py` | `_job_dict` 多帶 `kind`、`fetch_entry` |
| `server/comfyfed_server/assess.py` | `unverified_models` 參數＋protocol 5 門檻 |
| `server/comfyfed_server/dispatch.py` | `assign_jobs(..., unverified_models)` 透傳 |
| `server/comfyfed_server/agentws.py` | tick 合併 job fetch_entry、push 帶 `kind`、job_done 學雜湊、非計費收據、不進統計 |
| `server/comfyfed_server/comfyapi.py` | 掛 `POST/GET /comfy/api/comfyfed/model-fetch` |
| `server/comfyfed_server/panel_ext/comfyfed.js` | 攔鈕、POST、輪詢、橫幅 |
| `cloud/src/core/comfyfed_ext.ts` | byte parity 副本 |
| `cloud/src/core/assess.ts`、`dispatch.ts`、`model_manifest.ts`、`db/queries.ts`、`do/hub.ts`、`routes/comfyapi.ts`、`routes/jobs.ts` | 對應 port |
| `agent/comfyfed_agent/fetcher.py`、`runner.py`、`__init__.py`、根 `pyproject.toml` | 未驗證項目、model_fetch 流程、protocol 5、0.1.14 |
| `web/src/pages/Jobs.tsx`、`JobDetail.tsx`、`i18n/zh-TW.json`、`i18n/en.json` | kind 標籤與詳情 |
| `docs/SELF-HOSTING.zh.md`、`.en.md` | 新節 |
| `tests/test_e2e_panel.py` | e2e |

---

### Task 1: server — `model_fetch.py` 純函式（白名單、簽章、HEAD）

**Files:**
- Create: `server/comfyfed_server/model_fetch.py`
- Test: `tests/server/test_model_fetch.py`

**Interfaces:**
- Produces:
  - `TRUSTED_ORIGINS: frozenset[str] = {"https://huggingface.co", "https://civitai.com"}`
  - `def is_trusted_url(url: str) -> bool`
  - `class HeadError(Exception)` with `.code` in `{"gated", "size_unknown"}`
  - `def head_size_bytes(url: str, *, client_factory=httpx.Client) -> int` — raises `HeadError`
  - `def unverified_payload(name, directory, url, size_bytes) -> str`
  - `def sign_unverified_entry(signing_key, *, name, directory, url, size_bytes) -> dict` → `{"name","directory","url","backup_url":None,"sha256":None,"size_bytes","unverified":True,"sig"}`
  - `def is_unverified_entry(entry: dict) -> bool`

- [ ] **Step 1: 寫失敗測試** `tests/server/test_model_fetch.py`

```python
import httpx
import pytest
from nacl.signing import SigningKey

from comfyfed_server import model_fetch


@pytest.mark.parametrize("url,ok", [
    ("https://huggingface.co/Comfy-Org/x/resolve/main/ae.safetensors", True),
    ("https://HUGGINGFACE.co/a/b", True),
    ("https://civitai.com/api/download/models/123", True),
    ("https://huggingface.co.evil.com/x", False),
    ("http://huggingface.co/x", False),
    ("https://storage.googleapis.com/x", False),
    ("not a url", False),
    ("", False),
])
def test_is_trusted_url(url, ok):
    assert model_fetch.is_trusted_url(url) is ok


def test_unverified_payload_shape():
    assert (
        model_fetch.unverified_payload("ae.safetensors", "vae", "https://huggingface.co/x", 335)
        == "ae.safetensors|vae|https://huggingface.co/x|335|unverified"
    )


def test_sign_unverified_entry_verifies_with_platform_key():
    key = SigningKey.generate()
    entry = model_fetch.sign_unverified_entry(
        key, name="ae.safetensors", directory="vae", url="https://huggingface.co/x", size_bytes=335
    )
    assert entry["unverified"] is True and entry["sha256"] is None and entry["backup_url"] is None
    key.verify_key.verify(
        model_fetch.unverified_payload("ae.safetensors", "vae", "https://huggingface.co/x", 335).encode(),
        bytes.fromhex(entry["sig"]),
    )
    assert model_fetch.is_unverified_entry(entry)
    assert not model_fetch.is_unverified_entry({"name": "x", "sha256": "ab" * 32, "size_bytes": 1})


def _client(handler):
    return lambda **kw: httpx.Client(transport=httpx.MockTransport(handler), **kw)


def test_head_size_bytes_follows_redirect_and_reads_content_length():
    def handler(request):
        if request.url.path == "/a":
            return httpx.Response(302, headers={"location": "https://cdn.example/b"})
        return httpx.Response(200, headers={"content-length": "12345"})
    assert model_fetch.head_size_bytes("https://huggingface.co/a", client_factory=_client(handler)) == 12345


@pytest.mark.parametrize("status", [401, 403])
def test_head_size_bytes_gated(status):
    handler = lambda r: httpx.Response(status)
    with pytest.raises(model_fetch.HeadError) as exc:
        model_fetch.head_size_bytes("https://huggingface.co/a", client_factory=_client(handler))
    assert exc.value.code == "gated"


@pytest.mark.parametrize("resp", [
    httpx.Response(404),
    httpx.Response(200),
    httpx.Response(200, headers={"content-length": "0"}),
    httpx.Response(200, headers={"content-length": "abc"}),
])
def test_head_size_bytes_size_unknown(resp):
    with pytest.raises(model_fetch.HeadError) as exc:
        model_fetch.head_size_bytes("https://huggingface.co/a", client_factory=_client(lambda r: resp))
    assert exc.value.code == "size_unknown"


def test_head_size_bytes_network_error_is_size_unknown():
    def handler(r):
        raise httpx.ConnectError("boom")
    with pytest.raises(model_fetch.HeadError) as exc:
        model_fetch.head_size_bytes("https://huggingface.co/a", client_factory=_client(handler))
    assert exc.value.code == "size_unknown"
```

- [ ] **Step 2: 跑測試確認失敗** `.venv/Scripts/python.exe -m pytest tests/server/test_model_fetch.py -q` → ImportError。

- [ ] **Step 3: 實作** `server/comfyfed_server/model_fetch.py`

```python
"""Panel "Download" button -> `kind=model_fetch` job (spec 2026-09-19 §5-§6).

Pure helpers only; the HTTP route lives in `comfyapi.py` and the dispatch/
job_done wiring in `agentws.py`. Trust model: a worker downloads only
platform-signed entries. A model the platform has no learned/curated hash
for is dispatched as an *unverified-source* entry -- the url itself is in
the signed payload, the url's origin must be in `TRUSTED_ORIGINS`, and the
worker reports the real sha256 on completion so the platform learns it.
"""
from __future__ import annotations

from urllib.parse import urlsplit

import httpx

TRUSTED_ORIGINS: frozenset[str] = frozenset({"https://huggingface.co", "https://civitai.com"})
_HEAD_TIMEOUT_SECONDS = 10.0


def is_trusted_url(url: str) -> bool:
    if not isinstance(url, str) or not url:
        return False
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    if parts.scheme.lower() != "https" or not parts.hostname:
        return False
    origin = f"{parts.scheme.lower()}://{parts.hostname.lower()}"
    if parts.port not in (None, 443):
        return False
    return origin in TRUSTED_ORIGINS


class HeadError(Exception):
    """`code` is "gated" (401/403) or "size_unknown" (anything else)."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(detail or code)
        self.code = code


def head_size_bytes(url: str, *, client_factory=httpx.Client) -> int:
    try:
        with client_factory(timeout=httpx.Timeout(_HEAD_TIMEOUT_SECONDS), follow_redirects=True) as client:
            resp = client.head(url)
    except httpx.HTTPError as exc:
        raise HeadError("size_unknown", str(exc)) from exc
    if resp.status_code in (401, 403):
        raise HeadError("gated", f"HTTP {resp.status_code}")
    if not (200 <= resp.status_code < 300):
        raise HeadError("size_unknown", f"HTTP {resp.status_code}")
    raw = resp.headers.get("content-length")
    try:
        size = int(raw) if raw is not None else 0
    except ValueError:
        size = 0
    if size <= 0:
        raise HeadError("size_unknown", "no Content-Length")
    return size


def unverified_payload(name: str, directory: str, url: str, size_bytes: int) -> str:
    return f"{name}|{directory}|{url}|{size_bytes}|unverified"


def sign_unverified_entry(signing_key, *, name: str, directory: str, url: str, size_bytes: int) -> dict:
    sig = signing_key.sign(unverified_payload(name, directory, url, size_bytes).encode()).signature.hex()
    return {
        "name": name,
        "directory": directory,
        "url": url,
        "backup_url": None,
        "sha256": None,
        "size_bytes": size_bytes,
        "unverified": True,
        "sig": sig,
    }


def is_unverified_entry(entry: dict) -> bool:
    return isinstance(entry, dict) and entry.get("unverified") is True
```

- [ ] **Step 4: 跑測試通過。**
- [ ] **Step 5: Commit** `feat(server): model_fetch helpers — trusted origins, HEAD size, unverified entry signature`

---

### Task 2: server — DB 欄位、migration、job dict

**Files:**
- Create: `server/alembic/versions/c4d5e6f7a8b9_model_fetch.py`
- Modify: `server/comfyfed_server/db.py`（`class Job`，在 `split_plan` 之後）
- Modify: `server/comfyfed_server/jobs.py:201-236`（`_job_dict`）
- Test: `tests/server/test_db.py`、`tests/server/test_jobs.py`

**Interfaces:**
- Produces: `Job.kind: str`（default `"prompt"`）、`Job.fetch_entry: Optional[str]`；`_job_dict(job)["kind"]`、`["fetch_entry"]`（dict 或 None）。

- [ ] **Step 1: 查目前 alembic head**：`.venv/Scripts/python.exe -c "from alembic.script import ScriptDirectory; from alembic.config import Config; c=Config('server/alembic.ini'); c.set_main_option('script_location','server/alembic'); print(ScriptDirectory.from_config(c).get_current_head())"`，把結果填進 `down_revision`。
- [ ] **Step 2: 失敗測試**（`tests/server/test_db.py` 末尾）

```python
def test_job_has_kind_and_fetch_entry_defaults(db_session):
    job = db.Job(workflow_json="{}")
    db_session.add(job); db_session.commit()
    assert job.kind == "prompt" and job.fetch_entry is None
```
（`db_session` fixture 名稱以該檔既有 fixture 為準。）`tests/server/test_jobs.py`：

```python
def test_job_dict_carries_kind_and_parsed_fetch_entry():
    job = db.Job(workflow_json="{}", kind="model_fetch", fetch_entry='{"name":"a"}')
    d = jobs._job_dict(job)
    assert d["kind"] == "model_fetch" and d["fetch_entry"] == {"name": "a"}
```

- [ ] **Step 3: 實作**。migration：

```python
"""jobs.kind + jobs.fetch_entry (panel download button -> model_fetch job)."""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "c4d5e6f7a8b9"
down_revision: Union[str, Sequence[str], None] = "<目前 head>"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("jobs") as batch:
        batch.add_column(sa.Column("kind", sa.String(), nullable=False, server_default="prompt"))
        batch.add_column(sa.Column("fetch_entry", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("jobs") as batch:
        batch.drop_column("fetch_entry")
        batch.drop_column("kind")
```

`db.Job` 新增：

```python
    # 2026-09-19 model_fetch: "prompt"（既有一切）或 "model_fetch"（面板下載鈕
    # 建的純下載單，workflow_json="{}"，fetch_entry 存簽章 manifest 項目）。
    kind: Mapped[str] = mapped_column(String, default="prompt", server_default="prompt")
    fetch_entry: Mapped[Optional[str]] = mapped_column(String, nullable=True)
```

`_job_dict` 加 `"kind": job.kind or "prompt"`、`"fetch_entry": json.loads(job.fetch_entry) if job.fetch_entry else None`。

- [ ] **Step 4: 跑** `tests/server/test_db.py tests/server/test_jobs.py` 通過。
- [ ] **Step 5: Commit** `feat(server): jobs.kind + jobs.fetch_entry`

---

### Task 3: server — assess／dispatch 的 `unverified_models` 門檻

**Files:**
- Modify: `server/comfyfed_server/assess.py`（`_eligible_after_fetch`、`verdict`、`partition_fleet_fetchable` 各加 `unverified_models: frozenset[str] | None = None`）
- Modify: `server/comfyfed_server/dispatch.py:87-91`、`:220-231`（透傳）
- Test: `tests/server/test_assess.py`

**Interfaces:**
- Produces: `assess._MIN_UNVERIFIED_FETCH_PROTOCOL = 5`；`verdict(worker, needs, override, all_workers, fetchable_models, peer_only_models, unverified_models)`；`partition_fleet_fetchable(missing, fetchable, online, peer_only, unverified)`；`dispatch.assign_jobs(idle_ids, fetchable_models, peer_only_models, unverified_models)`。

- [ ] **Step 1: 失敗測試**（比照該檔既有 `peer_only_models` protocol-4 測試的 fixture 寫法）

```python
def test_unverified_model_requires_protocol_5(make_worker):
    w4 = make_worker(protocol=4, auto_fetch=True, free_disk_gb=100, max_fetch_gb=30)
    w5 = make_worker(protocol=5, auto_fetch=True, free_disk_gb=100, max_fetch_gb=30)
    needs = assess.JobNeeds(models={"ae.safetensors"}, nodes=set())
    fetchable = {"ae.safetensors": 335_000_000}
    unv = frozenset({"ae.safetensors"})
    assert assess.verdict(w4, needs, {}, [w4], fetchable, None, unv).kind == "ineligible"
    assert assess.verdict(w5, needs, {}, [w5], fetchable, None, unv).kind == "eligible_after_fetch"
    fetchable_set, unfetchable = assess.partition_fleet_fetchable({"ae.safetensors"}, fetchable, [w4], None, unv)
    assert unfetchable == {"ae.safetensors"}
```

- [ ] **Step 2: 跑確認失敗（TypeError）。**
- [ ] **Step 3: 實作**：在 `_MIN_PEER_FETCH_PROTOCOL` 旁加 `_MIN_UNVERIFIED_FETCH_PROTOCOL = 5`；`_eligible_after_fetch` 在 peer-only 檢查後加：

```python
    unverified_models = unverified_models or frozenset()
    if any(name in unverified_models for name in missing_models):
        if _worker_protocol(worker) < _MIN_UNVERIFIED_FETCH_PROTOCOL:
            return False
```
`verdict` 與 `partition_fleet_fetchable` 把參數往下傳；`dispatch.assign_jobs` 簽名加 `unverified_models: Optional[frozenset[str]] = None` 並傳給 `assess.verdict`。所有既有呼叫端不變（預設 None）。

- [ ] **Step 4: 跑** `tests/server/test_assess.py tests/server/test_dispatch.py` 通過。
- [ ] **Step 5: Commit** `feat(server): unverified-source fetch entries need agent protocol 5`

---

### Task 4: server — `POST/GET /comfy/api/comfyfed/model-fetch`

**Files:**
- Modify: `server/comfyfed_server/model_fetch.py`（加判定序列）
- Modify: `server/comfyfed_server/comfyapi.py`（`create_router` 內、`/features` 之前掛兩條路由）
- Test: `tests/server/test_model_fetch.py`（用 `tests/server/test_comfyapi.py` 既有的 `client`/登入 fixture 與 worker 建立 helper）

**Interfaces:**
- Produces（`model_fetch.py`）:
  - `class FetchRequestError(Exception)`: `.code`（`bad_request|already_present|untrusted_url|gated|size_unknown|no_worker`）、`.message`（zh-TW / en）
  - `def create_fetch_job(*, name, directory, url, user_id, data_dir, head=head_size_bytes) -> tuple[str, bool]` → `(job_id, reused)`
  - `def fetch_status(job_id: str) -> dict | None`
- Consumes: Task 1 helpers；`agentws._fetch_progress`（`{job_id: {"stage","fetch_pct","fetch_model"}}`）；`model_manifest.entries(data_dir)`；`jobs._live_workers`、`jobs._online_enabled_workers`；`assess.model_inventory(worker)`；`assess.partition_fleet_fetchable`；`security.load_platform_keys`；`fetcher._is_safe_relative_path` 邏輯（在 server 端重寫同等 `_safe_relative(s)`: 非空時不得含 `..` 片段、不得以 `/`、`\` 或磁碟代號開頭）。

- [ ] **Step 1: 失敗測試**（每個分支一個）

```python
def _post(client, **body):
    return client.post("/comfy/api/comfyfed/model-fetch", json=body)

BODY = dict(name="ae.safetensors", directory="vae", url="https://huggingface.co/Comfy-Org/x/resolve/main/ae.safetensors")

def test_model_fetch_bad_request(logged_in_client):
    for bad in ({}, {**BODY, "name": "../x"}, {**BODY, "directory": "../vae"}, {**BODY, "url": 5}):
        r = _post(logged_in_client, **bad); assert r.status_code == 400 and r.json()["error"] == "model_fetch.bad_request"

def test_model_fetch_already_present(logged_in_client, register_worker):
    register_worker(models=[{"name": "ae.safetensors", "directory": "vae", "size": 0.3}], status="offline")
    r = _post(logged_in_client, **BODY); assert r.json()["error"] == "model_fetch.already_present"

def test_model_fetch_untrusted_url(logged_in_client, register_worker):
    register_worker(protocol=5, auto_fetch=True, free_disk_gb=100)
    r = _post(logged_in_client, **{**BODY, "url": "https://evil.example/x"}); assert r.json()["error"] == "model_fetch.untrusted_url"

def test_model_fetch_gated_and_size_unknown(logged_in_client, register_worker, monkeypatch):
    register_worker(protocol=5, auto_fetch=True, free_disk_gb=100)
    monkeypatch.setattr(model_fetch, "head_size_bytes", lambda url, **k: (_ for _ in ()).throw(model_fetch.HeadError("gated")))
    assert _post(logged_in_client, **BODY).json()["error"] == "model_fetch.gated"
    monkeypatch.setattr(model_fetch, "head_size_bytes", lambda url, **k: (_ for _ in ()).throw(model_fetch.HeadError("size_unknown")))
    assert _post(logged_in_client, **BODY).json()["error"] == "model_fetch.size_unknown"

def test_model_fetch_no_worker(logged_in_client, register_worker, monkeypatch):
    register_worker(protocol=4, auto_fetch=True, free_disk_gb=100)   # protocol too old for unverified
    monkeypatch.setattr(model_fetch, "head_size_bytes", lambda url, **k: 335_000_000)
    r = _post(logged_in_client, **BODY); assert r.status_code == 400 and r.json()["error"] == "model_fetch.no_worker"

def test_model_fetch_creates_then_reuses(logged_in_client, register_worker, monkeypatch):
    register_worker(protocol=5, auto_fetch=True, free_disk_gb=100, max_fetch_gb=30)
    monkeypatch.setattr(model_fetch, "head_size_bytes", lambda url, **k: 335_000_000)
    r1 = _post(logged_in_client, **BODY); assert r1.status_code == 201 and r1.json()["reused"] is False
    r2 = _post(logged_in_client, **BODY); assert r2.status_code == 200 and r2.json() == {"job_id": r1.json()["job_id"], "reused": True}
    with db.get_session() as s:
        job = s.get(db.Job, r1.json()["job_id"])
        assert job.kind == "model_fetch" and job.workflow_json == "{}" and json.loads(job.required_models) == ["ae.safetensors"]
        entry = json.loads(job.fetch_entry); assert entry["unverified"] is True and entry["size_bytes"] == 335_000_000 and entry["url"] == BODY["url"]
        assert job.origin == "panel" and job.user_id
    st = logged_in_client.get(f"/comfy/api/comfyfed/model-fetch/{r1.json()['job_id']}").json()
    assert st["status"] == "queued" and st["name"] == "ae.safetensors" and st["stage"] is None

def test_model_fetch_uses_verified_manifest_entry_when_known(logged_in_client, register_worker, monkeypatch):
    # curated RealESRGAN_x4plus.pth has guide sha256 -> manifest entry exists with zero holders
    register_worker(protocol=3, auto_fetch=True, free_disk_gb=100, max_fetch_gb=30)
    r = _post(logged_in_client, name="RealESRGAN_x4plus.pth", directory="upscale_models", url="https://evil.example/ignored")
    assert r.status_code == 201
    with db.get_session() as s:
        entry = json.loads(s.get(db.Job, r.json()["job_id"]).fetch_entry)
    assert entry.get("unverified") is not True and len(entry["sha256"]) == 64

def test_model_fetch_status_404_for_prompt_jobs(logged_in_client, make_prompt_job):
    jid = make_prompt_job()
    assert logged_in_client.get(f"/comfy/api/comfyfed/model-fetch/{jid}").status_code == 404

def test_model_fetch_requires_login(client):
    assert _post(client, **BODY).status_code in (401, 403)
```
fixture 名稱（`logged_in_client`、`register_worker`、`make_prompt_job`）以 `test_comfyapi.py` 現有 helper 為準，沒有就在本檔以同樣方式建。

- [ ] **Step 2: 跑確認失敗（404）。**
- [ ] **Step 3: 實作** `model_fetch.py` 追加：

```python
import json
import re
from typing import Optional

from . import assess, db, jobs, model_manifest, security

_ACTIVE_STATUSES = ("queued", "dispatched", "running")
_MESSAGES = {
    "bad_request": "請求格式錯誤：需要 name、directory、url / bad request: name, directory, url required",
    "already_present": "模型已在聯邦內，請重新整理面板 / model already present in the federation, reload the panel",
    "untrusted_url": "來源網域不在白名單（僅允許 huggingface.co、civitai.com）/ url origin not allowlisted (huggingface.co, civitai.com only)",
    "gated": "此模型為受限模型，需登入來源網站，無法由 worker 自動下載 / gated model: the source requires a login, workers cannot fetch it",
    "size_unknown": "無法取得檔案大小，無法派工下載 / could not determine file size, cannot dispatch a fetch",
    "no_worker": "目前沒有可下載的 worker（需在線、開啟 auto_fetch_models、agent ≥ 0.1.14、磁碟與 max_fetch_gb 足夠）/ no worker can fetch right now (online, auto_fetch_models on, agent >= 0.1.14, enough disk and max_fetch_gb)",
}


class FetchRequestError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code
        self.message = _MESSAGES[code]


def _safe_relative(path: str) -> bool:
    if path == "":
        return True
    if not isinstance(path, str) or path.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", path):
        return False
    return all(part not in ("", ".", "..") for part in re.split(r"[\\/]", path))


def _safe_name(name) -> bool:
    return isinstance(name, str) and 0 < len(name) < 256 and not re.search(r"[\\/]", name) and name not in (".", "..")


def _fleet_has_model(name: str) -> bool:
    with db.get_session() as session:
        for w in jobs._live_workers(session):
            if name in assess.model_inventory(w):
                return True
    return False


def _active_fetch_job_id(name: str) -> Optional[str]:
    with db.get_session() as session:
        rows = (
            session.query(db.Job)
            .filter(db.Job.kind == "model_fetch", db.Job.status.in_(_ACTIVE_STATUSES))
            .order_by(db.Job.created_at.asc())
            .all()
        )
        for job in rows:
            if json.loads(job.required_models or "[]") == [name]:
                return job.id
    return None


def create_fetch_job(*, name, directory, url, user_id: Optional[str], data_dir: str, head=None) -> tuple[str, bool]:
    head = head or head_size_bytes
    if not (_safe_name(name) and isinstance(directory, str) and _safe_relative(directory) and isinstance(url, str)):
        raise FetchRequestError("bad_request")
    if _fleet_has_model(name):
        raise FetchRequestError("already_present")
    existing = _active_fetch_job_id(name)
    if existing:
        return existing, True

    manifest_entries = model_manifest.entries(data_dir)
    by_name = {e["name"]: e for e in manifest_entries}
    unverified: frozenset[str] = frozenset()
    if name in by_name:
        entry = by_name[name]
    else:
        if not is_trusted_url(url):
            raise FetchRequestError("untrusted_url")
        try:
            size_bytes = head(url)
        except HeadError as exc:
            raise FetchRequestError(exc.code) from exc
        signing_key, _ = security.load_platform_keys(data_dir)
        entry = sign_unverified_entry(signing_key, name=name, directory=directory, url=url, size_bytes=size_bytes)
        unverified = frozenset({name})

    fetchable = {name: int(entry["size_bytes"])}
    with db.get_session() as session:
        online = jobs._online_enabled_workers(session)
    peer_only = model_manifest.peer_only_names([entry]) if not unverified else frozenset()
    _ok, blocked = assess.partition_fleet_fetchable({name}, fetchable, online, peer_only, unverified)
    if blocked:
        raise FetchRequestError("no_worker")

    with db.get_session() as session:
        job = db.Job(
            workflow_json="{}",
            kind="model_fetch",
            fetch_entry=json.dumps(entry),
            required_models=json.dumps([name]),
            required_nodes="[]",
            origin="panel",
            user_id=user_id,
        )
        session.add(job)
        session.commit()
        return job.id, False


def fetch_status(job_id: str) -> Optional[dict]:
    from . import agentws  # local import: agentws imports jobs which is fine, avoid cycles at module load
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        if job is None or job.kind != "model_fetch":
            return None
        progress = agentws._fetch_progress.get(job_id) or {}
        entry = json.loads(job.fetch_entry or "{}")
        return {
            "job_id": job.id,
            "status": job.status,
            "stage": progress.get("stage"),
            "fetch_pct": progress.get("fetch_pct"),
            "fetch_model": progress.get("fetch_model"),
            "worker_id": job.worker_id,
            "error": job.error,
            "name": entry.get("name"),
        }
```
若 `agentws` 匯入造成循環，改成 `agentws` 提供 `def fetch_progress_for(job_id) -> dict` 並在 `comfyapi.py` 路由層組 dict。

`comfyapi.py` 路由（`create_router` 內，`data_dir` 已在閉包）：

```python
    @r.post("/comfyfed/model-fetch")
    def model_fetch_create(body: dict = Body(...), user: auth.SessionUser = Depends(auth.require_user)) -> Response:
        try:
            job_id, reused = model_fetch.create_fetch_job(
                name=body.get("name"), directory=body.get("directory", ""), url=body.get("url"),
                user_id=user.uid, data_dir=data_dir,
            )
        except model_fetch.FetchRequestError as exc:
            return JSONResponse(status_code=400, content={"error": f"model_fetch.{exc.code}", "message": exc.message})
        return JSONResponse(status_code=200 if reused else 201, content={"job_id": job_id, "reused": reused})

    @r.get("/comfyfed/model-fetch/{job_id}")
    def model_fetch_status(job_id: str) -> Response:
        status = model_fetch.fetch_status(job_id)
        if status is None:
            return JSONResponse(status_code=404, content={"error": "model_fetch.not_found", "message": "找不到下載任務 / fetch job not found"})
        return JSONResponse(content=status)
```
（注意 `body` 若非 dict 要當 bad_request；`directory` 缺省 `""`。）

- [ ] **Step 4: 跑** `tests/server/test_model_fetch.py tests/server/test_comfyapi.py` 通過。
- [ ] **Step 5: Commit** `feat(server): POST/GET /comfy/api/comfyfed/model-fetch`

---

### Task 5: server — dispatch tick 合併、push `kind`、job_done 學雜湊、非計費收據

**Files:**
- Modify: `server/comfyfed_server/agentws.py`（`dispatch_tick` ~1860-1935、`_handle_job_done` 837-875、`_create_and_push_receipt`、`_record_job_stats` 呼叫處）
- Test: `tests/server/test_agent_ws.py`

**Interfaces:**
- Consumes: Task 2 欄位、Task 3 `assign_jobs(..., unverified_models)`、`model_manifest.record_hash`、`model_fetch.is_unverified_entry`。
- Produces: push frame `{"type":"job","job_id","workflow_json":"{}","input_assets":[],"kind":"model_fetch","fetch_models":[entry]}`；`job_done` 接受 `fetched_models: [{name, directory, size_bytes, sha256}]`；receipt `kind="model_fetch", billable=False, basis="model_fetch", gpu_seconds=0`。

- [ ] **Step 1: 失敗測試**（比照該檔既有 fetch_models push 與 receipt 測試的 harness）

```python
async def test_model_fetch_job_is_pushed_with_kind_and_unverified_entry(ws_harness, make_model_fetch_job):
    jid, entry = make_model_fetch_job("ae.safetensors", unverified=True)
    frame = await ws_harness.connect_and_dispatch(protocol=5, auto_fetch=True, free_disk_gb=100)
    assert frame["kind"] == "model_fetch" and frame["workflow_json"] == "{}" and frame["fetch_models"] == [entry]

async def test_model_fetch_not_pushed_to_protocol_4(ws_harness, make_model_fetch_job):
    make_model_fetch_job("ae.safetensors", unverified=True)
    assert await ws_harness.connect_and_dispatch(protocol=4, auto_fetch=True, free_disk_gb=100) is None

async def test_real_manifest_entry_wins_over_job_entry(ws_harness, make_model_fetch_job, prime_manifest):
    prime_manifest("RealESRGAN_x4plus.pth")   # learned hash + curated url
    jid, job_entry = make_model_fetch_job("RealESRGAN_x4plus.pth", unverified=True)
    frame = await ws_harness.connect_and_dispatch(protocol=5, auto_fetch=True, free_disk_gb=100)
    assert frame["fetch_models"][0].get("unverified") is not True and frame["fetch_models"][0]["sha256"]

async def test_job_done_learns_hash_and_mints_unbilled_receipt(ws_harness, make_model_fetch_job):
    jid, entry = make_model_fetch_job("ae.safetensors", unverified=True)
    await ws_harness.connect_and_dispatch(protocol=5, auto_fetch=True, free_disk_gb=100)
    await ws_harness.send({"type": "job_done", "job_id": jid, "result_files": [], "exec_seconds": 0,
                           "fetched_models": [{"name": "ae.safetensors", "directory": "vae", "size_bytes": entry["size_bytes"], "sha256": "ab" * 32},
                                              {"name": "not-in-job", "directory": "", "size_bytes": 1, "sha256": "cd" * 32}]})
    with db.get_session() as s:
        rows = s.query(db.ModelHash).all()
        assert [(r.name if hasattr(r, "name") else r.source_key) for r in rows]  # one row, ae only
        assert len(rows) == 1 and rows[0].sha256 == "ab" * 32
        rec = s.query(db.Receipt).filter_by(job_id=jid).one()
        assert rec.kind == "model_fetch" and rec.billable is False and rec.basis == "model_fetch" and rec.gpu_seconds == 0
        assert s.get(db.Job, jid).status == "done"
```
（`db.ModelHash` 欄位名以 `db.py` 為準。）

- [ ] **Step 2: 跑確認失敗。**
- [ ] **Step 3: 實作**。`dispatch_tick`：在 `manifest_entries` 建好之後（不論 `_data_dir`），加：

```python
    unverified_models: frozenset[str] = frozenset()
    if has_queued_work:
        try:
            with db.get_session() as session:
                fetch_jobs = session.query(db.Job).filter(db.Job.status == "queued", db.Job.kind == "model_fetch").all()
                job_entries = [json.loads(j.fetch_entry) for j in fetch_jobs if j.fetch_entry]
            unv = set()
            for entry in job_entries:
                name = entry.get("name")
                if not name or name in manifest_by_name:
                    continue  # verified manifest entry always wins
                manifest_by_name[name] = entry
                fetchable_models[name] = int(entry.get("size_bytes") or 0)
                if model_fetch.is_unverified_entry(entry):
                    unv.add(name)
            unverified_models = frozenset(unv)
        except Exception:
            logger.exception("agentws: failed to merge model_fetch job entries")
```
`assign_jobs(idle_worker_ids, fetchable_models, peer_only_models, unverified_models)`；`_fetch_models_for_push` 內部呼叫 `assess.verdict` 也要傳 `unverified_models`（多加參數）。push frame：`if job.kind == "model_fetch": frame["kind"] = "model_fetch"`。

`_handle_job_done`：在 `if done:` 區塊最前面加

```python
        _learn_fetched_models(worker_id, job_id, message.get("fetched_models"))
```
```python
def _learn_fetched_models(worker_id: str, job_id: Optional[str], fetched) -> None:
    if not job_id or not isinstance(fetched, list):
        return
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        if job is None or job.kind != "model_fetch":
            return
        allowed = set(json.loads(job.required_models or "[]"))
    for item in fetched:
        if not isinstance(item, dict):
            continue
        name, size_bytes, sha256 = item.get("name"), item.get("size_bytes"), item.get("sha256")
        if name not in allowed or not isinstance(size_bytes, int) or isinstance(size_bytes, bool) or size_bytes <= 0 \
                or not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256):
            logger.warning("agentws: ignoring malformed fetched_models item from %s for job %s: %r", worker_id, job_id, item)
            continue
        try:
            model_manifest.record_hash(worker_id, name, size_bytes, sha256)
        except Exception:
            logger.exception("agentws: record_hash failed for %s", name)
```
`_record_job_stats` 呼叫前：`if job_kind != "model_fetch"`（用一次 session 讀 kind，或讓 `_learn_fetched_models` 回傳 kind）。`_create_and_push_receipt`：讀到 `job` 後 `if job.kind == "model_fetch": gpu_seconds, basis, kind, billable = 0.0, "model_fetch", "model_fetch", False` 並跳過 protocol 違規 log；其餘路徑不變。找到該函式裡實際建立 `db.Receipt(...)` 的地方把 `kind/billable/basis` 套上（既有失敗收據已有這三欄的寫法，照抄）。

- [ ] **Step 4: 跑** `tests/server/test_agent_ws.py -q` 通過。
- [ ] **Step 5: Commit** `feat(server): dispatch model_fetch jobs, learn fetched hashes, unbilled model_fetch receipts`

---

### Task 6: agent 0.1.14 — 未驗證項目、model_fetch 流程、protocol 5

**Files:**
- Modify: `agent/comfyfed_agent/fetcher.py`（`_validate_entry_shape`、`_verify_entry_signature`、`_download_one`、`fetch_and_verify_models` 回傳值）
- Modify: `agent/comfyfed_agent/runner.py:336`（protocol 5）、`handle_job` 1187-1300
- Modify: `agent/comfyfed_agent/__init__.py`、根 `pyproject.toml`（0.1.14）
- Test: `tests/agent/test_fetcher.py`、`tests/agent/test_runner.py`

**Interfaces:**
- Produces: `fetch_and_verify_models(...) -> list[dict]`（每項 `{name, directory, size_bytes, sha256}`）；`job_done` 多帶 `fetched_models`；hello `protocol: 5`。

- [ ] **Step 1: 失敗測試** `test_fetcher.py`（沿用該檔的 `_signed_entry`/mock transport helper）：

```python
def _unverified_entry(key, name="ae.safetensors", directory="vae", url="https://huggingface.co/x/ae.safetensors", size_bytes=5):
    payload = f"{name}|{directory}|{url}|{size_bytes}|unverified"
    return {"name": name, "directory": directory, "url": url, "backup_url": None, "sha256": None,
            "size_bytes": size_bytes, "unverified": True, "sig": key.sign(payload.encode()).signature.hex()}

async def test_unverified_entry_downloads_checks_size_and_returns_sha(tmp_path, platform_key, mock_client):
    entry = _unverified_entry(platform_key)
    client = mock_client({entry["url"]: b"hello"})
    out = await fetcher.fetch_and_verify_models(entries=[entry], platform_pubkey_hex=platform_key.verify_key.encode().hex(),
        models_dir=str(tmp_path), max_fetch_gb=1, cancel_event=asyncio.Event(), report_progress=_noop, client_factory=client)
    assert out == [{"name": "ae.safetensors", "directory": "vae", "size_bytes": 5, "sha256": hashlib.sha256(b"hello").hexdigest()}]
    assert (tmp_path / "vae" / "ae.safetensors").read_bytes() == b"hello"

async def test_unverified_entry_size_mismatch_fails_and_cleans_part(tmp_path, platform_key, mock_client):
    entry = _unverified_entry(platform_key, size_bytes=99)
    with pytest.raises(fetcher.FetchError):
        await fetcher.fetch_and_verify_models(entries=[entry], ..., client_factory=mock_client({entry["url"]: b"hello"}))
    assert not list(tmp_path.rglob("*"))

async def test_unverified_entry_with_wrong_signature_rejected(tmp_path, platform_key):
    entry = _unverified_entry(platform_key); entry["url"] = "https://huggingface.co/x/other"
    with pytest.raises(fetcher.FetchError, match="簽章"):
        await fetcher.fetch_and_verify_models(entries=[entry], ...)

async def test_unverified_entry_never_tries_peer_or_backup(tmp_path, platform_key, mock_client, monkeypatch):
    called = []
    monkeypatch.setattr(fetcher, "_fetch_via_peer", lambda **kw: called.append("peer") or False)
    entry = _unverified_entry(platform_key); entry["backup_url"] = "https://huggingface.co/x/backup"
    await fetcher.fetch_and_verify_models(entries=[entry], ..., platform_entry=object(), client_factory=mock_client({entry["url"]: b"hello"}))
    assert called == []

async def test_verified_entries_still_require_sha256(...):  # 既有 malformed sha 測試保持通過即可
```
`test_runner.py`：

```python
async def test_model_fetch_job_skips_workflow_and_reports_fetched_models(runner_harness, monkeypatch):
    ran = []
    monkeypatch.setattr(runner.comfy, "run_workflow", lambda *a, **k: ran.append(1))
    monkeypatch.setattr(runner.fetcher, "fetch_and_verify_models",
        _async(lambda **kw: [{"name": "ae.safetensors", "directory": "vae", "size_bytes": 5, "sha256": "ab" * 32}]))
    await runner_harness.handle_job({"job_id": "j1", "workflow_json": "{}", "input_assets": [], "kind": "model_fetch", "fetch_models": [{"name": "ae.safetensors"}]})
    done = runner_harness.sent("job_done")[0]
    assert ran == [] and done["exec_seconds"] == 0 and done["result_files"] == [] and done["fetched_models"][0]["sha256"] == "ab" * 32

async def test_model_fetch_job_without_fetch_models_is_done_immediately(runner_harness):
    await runner_harness.handle_job({"job_id": "j2", "workflow_json": "{}", "input_assets": [], "kind": "model_fetch"})
    assert runner_harness.sent("job_done")[0]["fetched_models"] == []

def test_hello_protocol_is_5(...): assert hello["protocol"] == 5
```

- [ ] **Step 2: 跑確認失敗。**
- [ ] **Step 3: 實作**：
  - `_validate_entry_shape`：`if entry.get("unverified") is True: sha256_ok = entry.get("sha256") is None`（size 檢查不變；並要求 `url` 為非空 str）。
  - `_verify_entry_signature`：`unverified` → payload `f"{name}|{directory}|{url}|{size_bytes}|unverified"`。
  - `_download_one`：對 unverified 不用 `backup`（`backup = None`）；`_finalize_download` 在 `expected_sha256 is None` 時跳過 sha 比對但**必做** size 比對（確認現有 size mismatch 分支對 unverified 也會觸發）。`_download_one` 回傳實際 `digest.hexdigest()`（若目前回 None，改成回 digest；已驗證項目回它驗過的 sha）。
  - `fetch_and_verify_models`：`is_unverified = entry.get("unverified") is True`；unverified 跳過 `_fetch_via_peer`；收集 `results.append({"name": entry["name"], "directory": entry.get("directory") or "", "size_bytes": int(entry["size_bytes"]), "sha256": digest})`（peer 路徑成功時 sha 就是 entry 的 sha256）；函式結尾 `return results`（`if not entries: return []`）。
  - `runner.handle_job`：`is_model_fetch = job_msg.get("kind") == "model_fetch"`；`fetched = await fetcher.fetch_and_verify_models(...)`（沒有 fetch_models 時 `fetched = []`）；fetch 區塊後：
    ```python
                if is_model_fetch:
                    success = True
                    exec_seconds = 0.0
                    fetched_models = fetched
                else:
                    ...既有 workflow 路徑...
    ```
    `send_job_done` 加 `fetched_models: Optional[list] = None` 參數，非 None 時放進訊息。確認 model_fetch 路徑不會執行 `whitelist.check`、`_download_input`、`run_workflow`、輸出清理。
  - protocol 5、版本 0.1.14。

- [ ] **Step 4: 跑** `tests/agent -q` 通過。
- [ ] **Step 5: Commit** `feat(agent): 0.1.14 — unverified-source fetch entries, model_fetch jobs, protocol 5`

---

### Task 7: 面板擴充（攔鈕→POST→輪詢→橫幅）＋ cloud parity 副本

**Files:**
- Modify: `server/comfyfed_server/panel_ext/comfyfed.js`（檔尾追加）
- Modify: `cloud/src/core/comfyfed_ext.ts`（整段 `COMFYFED_EXT_JS` 換成新檔內容；注意反引號與 `${` 需照該檔既有逃逸方式）
- Test: `cloud/test/comfyfed-ext.spec.ts`（既有 parity 測試）；`tests/server/test_static_mount.py` 或 `test_comfyapi.py` 中對 `/comfy/api/comfyfed-ext/comfyfed.js` 的內容斷言加 `"missing-model-download" in body`

**Interfaces:**
- Consumes: Task 4 端點；`window.app.graph`（ComfyUI 前端全域）；按鈕 `[data-testid="missing-model-download"]`、容器 `[data-testid="missing-model-actions"]`。

- [ ] **Step 1: 失敗測試**：server 側 `test_comfyfed_extension_js_intercepts_download_button(client)`：`assert b'missing-model-download' in client.get("/comfy/api/comfyfed-ext/comfyfed.js").content`。cloud parity 測試改完 JS 後自然失敗直到副本同步。
- [ ] **Step 2: 實作** 追加到 `comfyfed.js`：

```js
// 中文：接管官方前端「缺少模型」卡片的「下載」鈕。官方實作是瀏覽器端 <a download>，
// 會把模型抓到使用者自己的電腦；ComfyFed 的模型只該落在 worker 上，所以改成
// POST /comfy/api/comfyfed/model-fetch 讓平台派一台 worker 去抓，再輪詢進度。
// English: Take over the stock "Download" button on the missing-models card.
// Upstream does a browser-side <a download> to the user's own machine; in
// ComfyFed models live on workers, so we POST a model_fetch job and poll it.
(() => {
  const API = "api/comfyfed/model-fetch";
  const POLL_MS = 2000;
  const BANNER_ID = "comfyfed-model-fetch-banner";
  const T = {
    starting: "下載中 0% / Fetching 0%",
    pct: (p) => `下載中 ${p}% / Fetching ${p}%`,
    ready: "已就緒 / Ready",
    unknown: "無法辨識模型 / Could not identify model",
    done: (n) => `模型 ${n} 已下載到 worker，請重新整理以載入 / Model ${n} landed on a worker, reload to use it`,
    failed: (n, e) => `模型 ${n} 下載失敗：${e || ""} / Fetch of ${n} failed: ${e || ""}`,
    reload: "重新整理 / Reload",
  };

  function collectModels() {
    const out = new Map();
    const walk = (graph) => {
      if (!graph) return;
      for (const node of graph._nodes || graph.nodes || []) {
        for (const m of (node.properties && node.properties.models) || []) {
          if (m && typeof m.name === "string" && !out.has(m.name)) out.set(m.name, { name: m.name, url: m.url, directory: m.directory || "" });
        }
        if (node.subgraph) walk(node.subgraph);
      }
    };
    try { walk(window.app && window.app.graph); } catch (e) { /* 面板尚未就緒 */ }
    return out;
  }

  function banner(text, { error = false, reload = false } = {}) {
    let el = document.getElementById(BANNER_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = BANNER_ID;
      el.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999;padding:8px 16px;font:14px system-ui;display:flex;gap:12px;align-items:center;";
      document.body.appendChild(el);
    }
    el.style.background = error ? "#7f1d1d" : "#14532d";
    el.style.color = "#fff";
    el.textContent = text;
    if (reload) {
      const b = document.createElement("button");
      b.textContent = T.reload;
      b.onclick = () => location.reload();
      el.appendChild(b);
    }
    const x = document.createElement("button");
    x.textContent = "×";
    x.onclick = () => el.remove();
    el.appendChild(x);
  }

  async function poll(jobId, button, name) {
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      let st;
      try { st = await (await fetch(`${API}/${jobId}`, { credentials: "same-origin" })).json(); } catch (e) { continue; }
      if (st.status === "done") { button.textContent = T.ready; banner(T.done(name), { reload: true }); return; }
      if (st.status === "failed" || st.status === "cancelled") {
        button.disabled = false; button.textContent = button.dataset.comfyfedLabel; banner(T.failed(name, st.error), { error: true }); return;
      }
      if (st.stage === "fetching_models" && typeof st.fetch_pct === "number") button.textContent = T.pct(Math.floor(st.fetch_pct));
    }
  }

  async function requestFetch(model, button) {
    button.dataset.comfyfedLabel = button.textContent;
    button.disabled = true;
    button.textContent = T.starting;
    let resp, body;
    try {
      resp = await fetch(API, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: model.name, directory: model.directory || "", url: model.url || "" }) });
      body = await resp.json();
    } catch (e) { body = { message: String(e) }; }
    if (!resp || !resp.ok) {
      button.disabled = false; button.textContent = button.dataset.comfyfedLabel;
      banner(T.failed(model.name, body && body.message), { error: true });
      return;
    }
    poll(body.job_id, button, model.name);
  }

  function modelForButton(button, models) {
    const label = button.getAttribute("aria-label") || button.textContent || "";
    let best = null;
    for (const m of models.values()) if (label.includes(m.name) && (!best || m.name.length > best.name.length)) best = m;
    return best;
  }

  document.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;
    const single = target.closest('[data-testid="missing-model-download"]');
    const all = !single && target.closest('[data-testid="missing-model-actions"] button');
    if (!single && !all) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const models = collectModels();
    if (single) {
      const m = modelForButton(single, models);
      if (!m) { banner(T.unknown, { error: true }); return; }
      requestFetch(m, single);
      return;
    }
    const buttons = document.querySelectorAll('[data-testid="missing-model-download"]');
    for (const b of buttons) { const m = modelForButton(b, models); if (m) requestFetch(m, b); }
  }, true);
})();
```
把整份新 `comfyfed.js` 內容複製進 `comfyfed_ext.ts` 的樣板字串（依該檔既有逃逸規則處理 `` ` `` 與 `${`；parity 測試會比對正規化後內容）。

- [ ] **Step 3: 跑** server 測試檔＋`cloud/` `npx vitest run test/comfyfed-ext.spec.ts` 通過。
- [ ] **Step 4: Commit** `feat(panel): download button dispatches a worker fetch instead of a browser download`

---

### Task 8: cloud twin（migration、queries、model_fetch.ts、assess、dispatch、routes、hub）

**Files:**
- Create: `cloud/migrations/0011_model_fetch.sql`、`cloud/src/core/model_fetch.ts`、`cloud/test/model_fetch.spec.ts`
- Modify: `cloud/src/db/queries.ts`（`JobRow` 加 `kind`、`fetchEntry`；`insertJob` 加 `kind`、`fetchEntry`；新 `getQueuedModelFetchJobs(db)`、`findActiveModelFetchJob(db, name)`）
- Modify: `cloud/src/core/assess.ts`（`MIN_UNVERIFIED_FETCH_PROTOCOL = 5`，`verdict`/`partitionFleetFetchable`/`eligibleAfterFetch` 加 `unverifiedModels?: ReadonlySet<string>`）
- Modify: `cloud/src/core/dispatch.ts`（`assignJobs` 透傳）
- Modify: `cloud/src/routes/comfyapi.ts`（兩條路由，掛在 `/comfy/api/features` 之前）
- Modify: `cloud/src/routes/jobs.ts`（job JSON 帶 `kind`、`fetch_entry`）
- Modify: `cloud/src/do/hub.ts`（dispatch tick 合併、push `kind`、`handleJobDone` 學雜湊＋跳過 stats、`createAndPushReceipt` model_fetch 非計費；`GET` 狀態需要的 `fetchProgress` 讀取：新增 DO 內部路由 `/internal/fetch_progress/:jobId` 或把 progress 也寫進 `jobs.progress`——選前者，比照既有 `/internal/kick_worker` 的寫法）
- Test: `cloud/test/model_fetch.spec.ts`、`assess.spec.ts`、`dispatch.spec.ts`、`hub.spec.ts`、`comfyapi.spec.ts`、`migration.spec.ts`

**Interfaces:**
- Produces（`model_fetch.ts`）: `TRUSTED_ORIGINS`、`isTrustedUrl(url)`, `headSizeBytes(url, fetchImpl = fetch): Promise<number>`（throw `HeadError{code}`）, `unverifiedPayload(...)`, `signUnverifiedEntry(seedHex, {...}): Promise<ManifestEntry>`, `isUnverifiedEntry(e)`, `createFetchJob(env, {name, directory, url, userId}, head?): Promise<{jobId, reused}>`（throw `FetchRequestError{code,message}`）, `fetchStatus(env, jobId)`。
- 端點與訊息與 Task 4 逐字相同；signing 用 `ed25519` 既有 helper（見 `model_manifest.ts` 的 entry 簽法）。

- [ ] **Step 1: migration**

```sql
-- 2026-09-19 panel download button -> model_fetch job.
ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'prompt';
ALTER TABLE jobs ADD COLUMN fetch_entry TEXT;
```
- [ ] **Step 2: 失敗測試** `model_fetch.spec.ts`：port Task 1＋Task 4 的每個案例（`headSizeBytes` 用假的 `fetchImpl` 回 `new Response(null,{status,headers})`；路由用該專案 `comfyapi.spec.ts` 既有的 app/登入/worker helper）。`hub.spec.ts`：push 帶 `kind`＋entry、protocol 4 不派、真 manifest 優先、job_done 學雜湊＋非計費收據（port Task 5 四案）。`assess.spec.ts`：protocol 5 門檻。`migration.spec.ts`：新欄存在。
- [ ] **Step 3: 實作**，逐檔 port Task 1/3/4/5 的邏輯（同名、同訊息、同判定順序）。hub tick 合併程式碼位置在建 `manifestByName` 之後（`hub.ts` ~1840-1880），`fetchModelsForPush` 內 `verdict` 呼叫也要傳 `unverifiedModels`。收據：`mintReceipt(jobId, workerId, 0, "model_fetch", false, "model_fetch", now)`。
- [ ] **Step 4: 跑** `cloud/`：`npx tsc --noEmit` 與 `npx vitest run --no-file-parallelism` 全綠。
- [ ] **Step 5: Commit** `feat(cloud): model_fetch jobs — endpoint, dispatch merge, learned hashes, unbilled receipts`

---

### Task 9: web console — kind 標籤與詳情

**Files:**
- Modify: `web/src/api.ts`（`Job` 型別加 `kind: "prompt" | "model_fetch"`、`fetch_entry?: {...} | null`）
- Modify: `web/src/pages/Jobs.tsx`（狀態欄旁顯示 `kind === "model_fetch"` 的 Badge「模型下載」；該列 VRAM 欄顯示 `—`）
- Modify: `web/src/pages/JobDetail.tsx`（`kind === "model_fetch"` 時多一個區塊：模型名、directory、url、`unverified` 標記、完成後從 receipt 顯示非計費）
- Modify: `web/src/i18n/zh-TW.json`、`en.json`（`jobs.kind_model_fetch: "模型下載" / "Model fetch"`、`jobs.fetch_entry_title`、`jobs.fetch_unverified: "未驗證來源（落地後學習雜湊）" / "Unverified source (hash learned on landing)"`）
- Test: `web/src/pages/Jobs.test.tsx`、`JobDetail.test.tsx`

- [ ] **Step 1: 失敗測試**：Jobs 列表 render 一筆 `kind: "model_fetch"` job → 出現「模型下載」；JobDetail render 帶 `fetch_entry` 的 job → 出現模型名與「未驗證來源」。
- [ ] **Step 2: 實作。**
- [ ] **Step 3: 跑** `web/`：`npm test -- --run`、`npx tsc --noEmit`。
- [ ] **Step 4: Commit** `feat(web): show model_fetch jobs in console`

---

### Task 10: e2e、文件

**Files:**
- Modify: `tests/test_e2e_panel.py`（新測試 `test_panel_download_button_dispatches_model_fetch_job`，用該檔既有的假 agent WS harness）
- Modify: `docs/SELF-HOSTING.zh.md`、`docs/SELF-HOSTING.en.md`（新節「面板的『下載』鈕 / The panel's Download button」）

- [ ] **Step 1: e2e**：登入 → 註冊假 worker（hello protocol 5、auto_fetch true、free_disk_gb 100、max_fetch_gb 30，庫存空）→ monkeypatch `model_fetch.head_size_bytes` 回 5 → `POST /comfy/api/comfyfed/model-fetch` 201 → 假 agent 收到 `kind=model_fetch` push（斷言 `fetch_models[0].unverified is True`、簽章可用平台公鑰驗過 §6 payload）→ 假 agent 送心跳 `stage=fetching_models fetch_pct=50` → `GET` 狀態 `fetch_pct == 50` → 假 agent 送 `job_done` 帶 `fetched_models` → `GET` 狀態 `done` → `/api/jobs/{id}` `kind == "model_fetch"`、receipt `billable false`；`db.ModelHash` 有該 sha。
- [ ] **Step 2: 文件**：說明行為、白名單、HEAD、未驗證項目、protocol 5／agent ≥ 0.1.14、非計費、完成後要重新整理面板。
- [ ] **Step 3: 跑** `.venv/Scripts/python.exe -m pytest tests/test_e2e_panel.py -q`。
- [ ] **Step 4: Commit** `test(e2e)+docs: panel download button model_fetch flow`

---

### Task 11: 發版（controller 親自執行）

- [ ] 全套測試：`.venv/Scripts/python.exe -m pytest tests -q`；`cloud/` vitest＋tsc；`web/` vitest＋tsc。
- [ ] `.venv/Scripts/python.exe -m build --wheel`（產出 `dist/comfyfed-0.1.14-py3-none-any.whl`）。
- [ ] `git push origin main`（Cloudflare Workers Builds 自動部署；deploy script 會 `wrangler d1 migrations apply --remote`）。
- [ ] 等雲端部署完成後，以 admin session `POST https://comfyfed-cloud.aiinpocket.com/api/workers/agent-release?filename=comfyfed-0.1.14-py3-none-any.whl`（`--data-binary @wheel`、`X-CSRF`），驗 `GET /api/agent/version` 為 0.1.14。
- [ ] 重啟本機 agent（`comfyfed stop` 後由監督者拉起，或 `comfyfed-agent` 服務重啟）→ log 顯示自更新到 0.1.14、hello protocol 5。
- [ ] live：面板開預設 z_image_turbo 工作流 → 按 `ae.safetensors` 下載鈕 → 觀察 fetching → done → 重新整理 → 模型出現。
