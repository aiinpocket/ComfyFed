# ComfyFed Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 端到端可用的最小聯邦：安裝（隨機 admin 密碼、雙語導引）→ 登入 → 發識別碼 → Agent 註冊上線（Ed25519）→ 送 workflow → WS 派工 → Agent 呼叫本機 ComfyUI 執行 → 結果與收據回傳 → React 儀表板可視。

**Architecture:** Monorepo：`server/`（FastAPI + SQLite + WS hub + 派工器）、`agent/`（多平台 WS client 包住本機 ComfyUI API）、`web/`（React SPA，由 server serve 靜態檔）。連線一律 agent→server。HTTP 請求 Ed25519 簽名、WS 握手挑戰認證、收據獨立簽章。

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2, uvicorn, PyNaCl, argon2-cffi, pytest, httpx, websockets; React 18 + TS + Vite + Mantine + react-i18next.

**Spec:** `docs/superpowers/specs/2026-09-12-comfyfed-spec.md`

## Global Constraints

- Python ≥3.12；SQLite（WAL）；資料檔預設 `./data/comfyfed.db`，金鑰 `./data/keys/`
- 無固定預設帳密：admin 密碼安裝時 `secrets.token_urlsafe(12)` 產生、argon2 雜湊、一次性顯示
- 所有 agent HTTP 端點驗 Ed25519 簽名（時間窗 ±120s＋nonce 防重放）；WS 握手做挑戰簽名
- Worker 斷線（>90s 無心跳）：其 assigned/running 任務自動回 queued
- CLI 與 UI 全部訊息雙語（zh-TW / en），安裝第一問是語言
- 每個 API 錯誤回 `{"error": {"code": str, "message": str}}`；code 穩定供前端翻譯
- commit message 英文 conventional commits；結尾附 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Repo 骨架與測試環境

**Files:**
- Create: `pyproject.toml`, `.gitignore`, `README.md`, `server/comfyfed_server/__init__.py`, `agent/comfyfed_agent/__init__.py`, `tests/__init__.py`, `tests/server/__init__.py`, `tests/agent/__init__.py`

**Interfaces:**
- Produces: 可 `pip install -e .[dev]`、`pytest` 綠燈的空專案；套件名 `comfyfed_server`、`comfyfed_agent`

- [ ] **Step 1: 寫 pyproject.toml**

```toml
[project]
name = "comfyfed"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "fastapi>=0.115", "uvicorn[standard]>=0.30", "sqlalchemy>=2.0", "alembic>=1.13",
  "pynacl>=1.5", "argon2-cffi>=23.1", "httpx>=0.27", "websockets>=13",
  "python-multipart>=0.0.9", "itsdangerous>=2.2", "psutil>=6.0", "prometheus-client>=0.20",
]
[project.optional-dependencies]
dev = ["pytest>=8", "pytest-asyncio>=0.24", "httpx>=0.27"]
[project.scripts]
comfyfed-server = "comfyfed_server.main:cli"
comfyfed-agent = "comfyfed_agent.main:cli"
[tool.setuptools.packages.find]
where = ["server", "agent"]
[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

- [ ] **Step 2: .gitignore（data/、__pycache__、node_modules、dist、*.db、.venv）＋兩個空套件 `__init__.py`＋README 一段話**
- [ ] **Step 3: `py -3.12 -m venv .venv && .venv/Scripts/pip install -e .[dev]`，跑 `pytest`（0 tests, exit 0＝collected ok）**
- [ ] **Step 4: Commit** `chore: scaffold comfyfed monorepo`

### Task 2: DB 層（models + init）

**Files:**
- Create: `server/comfyfed_server/db.py`
- Test: `tests/server/test_db.py`

**Interfaces:**
- Produces: `init_db(path: str) -> None`、`get_session() -> Session`（contextmanager）、ORM classes：
  - `Setting(key: str[PK], value: str)`
  - `Worker(id: str[PK=uuid], name: str, pubkey: str, status: str='offline', last_seen: datetime|None, disabled: bool=False, created_at, hardware: str='{}', dynamic: str='{}')`——hardware=靜態檔案 JSON（gpu_name, vram_gb, cpu, cpu_cores, ram_gb, agent_version），dynamic=心跳動態 JSON（free_vram_gb, free_ram_gb, free_disk_gb）
  - `RegisterToken(token: str[PK], worker_name: str, created_at, used: bool=False)`
  - `Job(id: str[PK=uuid], workflow_json: str, status: str='queued', worker_id: str|None, progress: float=0, created_at, started_at|None, finished_at|None, error: str|None, result_files: str='[]')`
  - `Receipt(id: str[PK=uuid], job_id, worker_id, gpu_seconds: float, platform_sig: str, worker_sig: str|None, created_at)`
  - `LoginAttempt(id: int[PK], at: datetime, ok: bool)`

- [ ] **Step 1: 失敗測試**

```python
# tests/server/test_db.py
from comfyfed_server import db
def test_init_creates_tables(tmp_path):
    db.init_db(str(tmp_path / "t.db"))
    with db.get_session() as s:
        s.add(db.Setting(key="platform_url", value="http://x")); s.commit()
        assert s.get(db.Setting, "platform_url").value == "http://x"
def test_worker_defaults(tmp_path):
    db.init_db(str(tmp_path / "t.db"))
    with db.get_session() as s:
        w = db.Worker(id="w1", name="n", pubkey="pk"); s.add(w); s.commit()
        assert (w.status, w.disabled) == ("offline", False)
```

- [ ] **Step 2: `pytest tests/server/test_db.py -v` → FAIL (no module)**
- [ ] **Step 3: 實作 db.py＋Alembic**：SQLAlchemy 2 DeclarativeBase；module-level `_engine`；`init_db` 建引擎（`sqlite+pysqlite`、`PRAGMA journal_mode=WAL`）後**程式化執行 `alembic upgrade head`**（`alembic.config.Config` 指到 repo 內 `server/alembic/`；不用 create_all）；`alembic init` 產生環境＋手寫 initial migration（含所有表與預設值）；`get_session` 用 `sessionmaker`＋contextmanager。Worker 表另含 `backend: str=''`（cuda/rocm/mps/cpu）、`torch_version: str=''`、`node_classes: str='[]'`（JSON list）；Job 表含 `requirements: str='{}'`、`required_nodes: str='[]'`
- [ ] **Step 4: pytest → PASS**
- [ ] **Step 5: Commit** `feat(server): sqlite schema and session management`

### Task 3: 安裝導引（bootstrap，雙語、隨機密碼、平台金鑰）

**Files:**
- Create: `server/comfyfed_server/bootstrap.py`, `server/comfyfed_server/i18n.py`, `server/comfyfed_server/security.py`
- Test: `tests/server/test_bootstrap.py`

**Interfaces:**
- Consumes: Task 2 的 `db`
- Produces:
  - `security.hash_password(pw) -> str` / `security.verify_password(pw, hashed) -> bool`（argon2）
  - `security.load_platform_keys(data_dir) -> (SigningKey, VerifyKey)`（不存在則產生並落地 `data/keys/platform.key`，權限 0600）
  - `bootstrap.ensure_installed(data_dir, lang: str|None, url: str|None, interactive: bool) -> InstallResult(admin_password: str|None, first_run: bool)`——首跑：語言→platform_url→產隨機密碼（`secrets.token_urlsafe(12)`）→寫 settings（`admin_password_hash`、`platform_url`、`lang`）；非首跑回 `first_run=False`
  - `i18n.t(key, lang) -> str`：dict 字典，鍵含 `install.choose_lang / install.enter_url / install.admin_password_notice / ...`，zh-TW 與 en 都齊

- [ ] **Step 1: 失敗測試**

```python
def test_first_run_generates_password(tmp_path):
    r = bootstrap.ensure_installed(str(tmp_path), lang="zh-TW", url="http://h:8388", interactive=False)
    assert r.first_run and len(r.admin_password) >= 12
    with db.get_session() as s:
        h = s.get(db.Setting, "admin_password_hash").value
        assert security.verify_password(r.admin_password, h)
def test_second_run_no_password(tmp_path):
    bootstrap.ensure_installed(str(tmp_path), lang="en", url="http://h", interactive=False)
    r2 = bootstrap.ensure_installed(str(tmp_path), lang=None, url=None, interactive=False)
    assert not r2.first_run and r2.admin_password is None
def test_platform_keys_persist(tmp_path):
    sk1, _ = security.load_platform_keys(str(tmp_path))
    sk2, _ = security.load_platform_keys(str(tmp_path))
    assert bytes(sk1) == bytes(sk2)
def test_i18n_both_languages():
    assert i18n.t("install.admin_password_notice", "zh-TW") != i18n.t("install.admin_password_notice", "en")
```

- [ ] **Step 2: pytest → FAIL**
- [ ] **Step 3: 實作三個模組**（interactive=True 時用 input() 走雙語問答；金鑰用 `nacl.signing.SigningKey.generate()`，hex 存檔）
- [ ] **Step 4: pytest → PASS**
- [ ] **Step 5: Commit** `feat(server): bilingual install bootstrap with random admin password and platform keys`

### Task 4: Web 認證（session、登入退避、CSRF、改密碼）

**Files:**
- Create: `server/comfyfed_server/auth.py`, `server/comfyfed_server/app.py`
- Test: `tests/server/test_auth.py`

**Interfaces:**
- Consumes: Task 3 `security`, `db`
- Produces:
  - `app.create_app(data_dir) -> FastAPI`（呼叫 ensure_installed(non-interactive 假設已裝)、掛 routers）
  - Routes：`POST /api/auth/login {password}`→ set signed session cookie（itsdangerous, HttpOnly, SameSite=Lax）＋回 `{csrf: str}`；`POST /api/auth/logout`；`POST /api/auth/change-password {old, new}`（需 header `X-CSRF` 相符）；`GET /api/auth/me` → `{authenticated: bool, lang: str}`
  - 依賴 `require_admin`（cookie 驗證失敗 401 `{"error":{"code":"auth.required"}}`）
  - 登入退避：連續失敗 n 次後需等 `2^(n-3)` 秒（查 LoginAttempt 最近 10 分鐘），太快回 429 `auth.too_many_attempts`

- [ ] **Step 1: 失敗測試**（TestClient：錯密碼 401；對密碼 200 拿 cookie+csrf；me 200；無 csrf 改密碼 403；有 csrf 改密碼 200 且舊密碼失效；連錯 4 次第 5 次 429）
- [ ] **Step 2: FAIL → Step 3: 實作 → Step 4: PASS**
- [ ] **Step 5: Commit** `feat(server): session auth with backoff, csrf, password change`

### Task 5: Worker 憑證發放與註冊

**Files:**
- Create: `server/comfyfed_server/workers.py`
- Test: `tests/server/test_workers.py`

**Interfaces:**
- Consumes: `require_admin`, `security.load_platform_keys`, `db`
- Produces:
  - `POST /api/workers/tokens {name}`（admin）→ `{bundle: {platform_url, platform_pubkey, register_token}}`（token=`secrets.token_urlsafe(24)` 存 RegisterToken）
  - `POST /api/agent/register {token, name, pubkey}`（無簽名，一次性 token 即憑證）→ 驗 token 未用→建 Worker→token 標記 used→回 `{worker_id, certificate}`；certificate=平台私鑰對 `worker_id + "|" + pubkey` 的簽名 hex
  - `GET /api/workers`（admin）→ list `{id,name,status,last_seen,disabled}`
  - `POST /api/workers/{id}/disable`（admin, csrf）
  - token 重複使用 → 409 `register.token_used`

- [ ] **Step 1: 失敗測試**（發 token→register 成功且回 certificate 可用平台 pubkey 驗簽；同 token 二次 register 409；list 出現該 worker）
- [ ] **Step 2: FAIL → Step 3: 實作 → Step 4: PASS**
- [ ] **Step 5: Commit** `feat(server): worker token issuance and ed25519 registration`

### Task 6: Agent 端身分與註冊 client

**Files:**
- Create: `agent/comfyfed_agent/identity.py`, `agent/comfyfed_agent/config.py`
- Test: `tests/agent/test_identity.py`

**Interfaces:**
- Consumes: server TestClient（測試中以 `create_app` 直接掛給 httpx transport）
- Produces:
  - `config.AgentConfig.load(path) / .save()`：JSON `{platforms: [{platform_url, platform_pubkey, worker_id, certificate, signing_key_hex}], comfy_url: "http://127.0.0.1:8188", whitelist_extra: []}`
  - `identity.register(bundle: dict, name: str, cfg_path: str, client: httpx.Client) -> PlatformEntry`：自產 SigningKey→POST register→驗 certificate（用 bundle 的 platform_pubkey）→寫入 config

- [ ] **Step 1: 失敗測試**（in-memory server；register 後 config 檔含 worker_id 與 signing_key；憑證驗簽通過；偽平台簽名→raises `CertificateInvalid`）
- [ ] **Step 2: FAIL → Step 3: 實作 → Step 4: PASS**
- [ ] **Step 5: Commit** `feat(agent): identity bundle registration with key pinning`

### Task 7: 簽名請求層（agent 簽、server 驗、防重放）

**Files:**
- Create: `agent/comfyfed_agent/signing.py`, Modify: `server/comfyfed_server/workers.py`（加 `verify_agent` dependency）
- Test: `tests/server/test_signed_requests.py`

**Interfaces:**
- Produces:
  - agent：`signing.signed_headers(entry, method, path, body: bytes) -> dict`（`X-Worker-Id`, `X-Ts`(unix), `X-Nonce`(16B hex), `X-Sig`=sign(`{method}\n{path}\n{ts}\n{nonce}\n` + body)）
  - server：`verify_agent` dependency → 回 Worker；驗：worker 存在且未停用、|ts-now|≤120、nonce 未見過（in-memory TTL set）、簽名對其 pubkey 有效；失敗 401 `agent.bad_signature` / 409 `agent.replay`
  - 測試端點 `POST /api/agent/ping` → `{ok: true}`

- [ ] **Step 1: 失敗測試**（正簽 200；改 body 401；重放同 nonce 409；ts 偏 300s 401；disabled worker 403）
- [ ] **Step 2: FAIL → Step 3: 實作 → Step 4: PASS**
- [ ] **Step 5: Commit** `feat: ed25519 signed agent requests with replay protection`

### Task 8: Job 佇列與派工核心（含斷線重派）

**Files:**
- Create: `server/comfyfed_server/jobs.py`, `server/comfyfed_server/dispatch.py`
- Test: `tests/server/test_jobs.py`

**Interfaces:**
- Consumes: `db`, `require_admin`, `verify_agent`
- Produces:
  - `POST /api/jobs`（admin, csrf，**multipart**：`workflow_json` 欄位＋零或多個 `assets` 檔案）→ `{job_id}`（status=queued）；伺服端呼叫 `assess.extract` 偵測 workflow 引用的輸入素材（LoadImage/LoadImageMask 節點的 `image` 欄位字串值）——引用了但未附的檔 → 400 `jobs.missing_assets`（回缺檔清單）；附檔存 `data/job_inputs/<job_id>/<filename>`；新增 Alembic migration 加 `Job.input_assets: str='[]'`（JSON list of filenames）；`GET /api/agent/jobs/{id}/inputs/{filename}`（signed，僅 assigned worker）供 agent 下載；requirements JSON 選填：`{min_vram_gb?: float, min_free_disk_gb?: float, gpu_name_contains?: str}` 存 `Job.requirements: str='{}'`（Task 2 的 Job 表加此欄）；`GET /api/jobs?status=`（admin）；`GET /api/jobs/{id}`
  - 新模組 `server/comfyfed_server/assess.py`——**自動任務評估引擎**（使用者不需手填需求）：
    - `assess.extract(workflow: dict) -> JobNeeds(nodes: set, models: set, est_vram_gb: float|None, assets: set)`——assets=LoadImage/LoadImageMask 節點 inputs 的 `image` 字串值（**任務輸入素材，如角色形象參考圖**；與模型分開處理：模型走庫存判定，素材隨任務附檔）：nodes=各 node 的 class_type；models=掃描 inputs 中的模型欄位（欄位名 ∈ {ckpt_name, unet_name, clip_name, clip_name1, clip_name2, vae_name, lora_name, model_name, control_net_name, style_model_name, upscale_model_name}，值為 str 且以 .safetensors/.ckpt/.pt/.sft/.gguf 結尾）；est_vram_gb=max(引用模型大小，查各 worker 回報庫存取最大已知值)×1.15（取最大單一模型而非加總：ComfyUI 順序載入/卸載，峰值由最大模型主導），查無任何大小→None（不做 VRAM 判定）
    - `assess.verdict(worker, needs, requirements_override: dict) -> Verdict(kind: "eligible"|"eligible_after_fetch"|"ineligible", reasons: list[str], missing_models: list[str], warnings: list[str])`：缺節點/backend 不符/**est_vram > vram_gb ＋ ram_gb**/override 不符→ineligible（reasons 用穩定 code 如 `missing_nodes:IPAdapter`、`vram:40.0>8+16`）；**vram_gb < est_vram ≤ vram_gb＋ram_gb → 仍 eligible，附非阻斷 warning `vram_offload:25.49>15.9`**（ComfyUI 把權重卸載到系統 RAM 串流執行，慢但跑得動──2026-09-12 實機驗證：15.9GB 顯卡跑得動 22.17GB 的 flux1-dev；ram_gb 取 hardware.ram_gb，缺則退 dynamic.free_ram_gb，都沒有就不判硬缺口）；僅缺模型且聯邦內其他 worker 庫存有＋free_disk 夠→eligible_after_fetch；全過→eligible
  - Job 表欄位改：`required_nodes: str='[]'`, `required_models: str='[]'`, `est_vram_gb: float|None`, `requirements: str='{}'`（=進階覆寫，預設空）
  - `dispatch.pick_job_for` 只派 verdict=eligible（Phase 1；eligible_after_fetch 標記於 job 供 UI 顯示「僅缺模型，待模型分發開通」）。**帶 warning 的 eligible 照派**──warning 只說明「會怎麼跑」，不是拒絕理由；Phase 1 不因 warning 調整派工優先序。
  - `GET /api/jobs/{id}/assessment`（admin）→ 每個 worker 的三態判定＋原因＋**warnings**（前端翻譯 reason codes；warnings 以黃字/淡色附註呈現，不是錯誤）
  - `dispatch.pick_job_for(worker_id) -> Job|None`：原子性把「最舊且 worker_meets 通過」的 queued job 改 assigned＋綁 worker（跳過不符合的，不阻塞後面的 job）
  - `dispatch.requeue_stale(now) -> list[str]`（回傳被退回的 job id，`len()` 即舊的計數）：worker last_seen 距今 >90s 的 assigned/running job → queued、worker_id=None、progress=0；worker.status='offline'
  - `dispatch.mark_running/mark_done(job_id, result_files)/mark_failed(job_id, error)`

- [ ] **Step 1: 失敗測試**（submit→queued；pick 原子（兩次 pick 不同 job 或第二次 None）；requeue_stale 把 91s 未心跳 worker 的 running job 退回 queued 並可被另一 worker pick——**這是使用者明確要求的斷線重派**）
- [ ] **Step 2: FAIL → Step 3: 實作 → Step 4: PASS**
- [ ] **Step 5: Commit** `feat(server): job queue with atomic dispatch and stale-worker requeue`

### Task 9: Agent WS 通道（心跳、派工推送、進度回報）

**Files:**
- Create: `server/comfyfed_server/agentws.py`, Modify: `app.py`
- Test: `tests/server/test_agent_ws.py`

**Interfaces:**
- Produces（WS `/api/agent/ws`，JSON 訊息，`type` 欄位）：
  - 握手：server 送 `{"type":"challenge","nonce"}` → agent 回 `{"type":"auth","worker_id","sig"}`（sign(nonce)）→ server 回 `{"type":"ready"}`；失敗即關閉 code 4401
  - 握手成功後 agent 立即送 `{"type":"hello","hardware":{gpu_name,vram_gb,cpu,cpu_cores,ram_gb,agent_version},"backend":"cuda|rocm|mps|cpu","torch_version":str,"node_classes":[...]}`——node_classes 取自本機 ComfyUI `GET /object_info` 的鍵集合（=真實安裝節點含 custom nodes），依 agent 端 node_policy 過濾後上報；server 存 Worker.hardware/backend/torch_version/node_classes（硬體採集：`nvidia-smi --query-gpu=name,memory.total`、`psutil`、`shutil.disk_usage(comfy 模型目錄)`；backend 偵測：nvidia-smi 成功→cuda、否則試 rocm-smi、`platform.system()=="Darwin"`→mps、fallback cpu）
  - agent→server：`{"type":"heartbeat","state":"idle|busy","progress":float,"job_id":str|None,"dynamic":{free_vram_gb,free_ram_gb,free_disk_gb}}`（server 更新 last_seen/status/dynamic/job.progress）
  - agent→server：`{"type":"inventory","models":[{"name":"diffusion_models/x.safetensors","size":123}]}`——上線後與每 10 分鐘掃描 ComfyUI models 目錄（相對路徑＋bytes）；server 存 `Worker.model_inventory: str='[]'`（Task 2 Worker 表加此欄）——評估引擎與未來 P2P tracker 的資料源；`{"type":"job_done","job_id","result_files":[names]}`；`{"type":"job_failed","job_id","error"}`
  - server→agent：`{"type":"job","job_id","workflow_json","input_assets":[filenames]}`（僅對 state=idle 者推）
  - server 背景迴圈每 5s：`requeue_stale()`＋為每個 idle 連線 `pick_job_for` 並推送
- [ ] **Step 1: 失敗測試**（TestClient websocket：未簽名關閉 4401；簽名握手 ready；送 heartbeat 後 DB last_seen 更新且 status=online；enqueue job 後 idle 連線收到 job 訊息；回 job_done 後 job status=done）
- [ ] **Step 2: FAIL → Step 3: 實作 → Step 4: PASS**
- [ ] **Step 5: Commit** `feat(server): authenticated agent websocket with heartbeat and push dispatch`

### Task 10: 結果上傳與收據

**Files:**
- Create: `server/comfyfed_server/receipts.py`, Modify: `agentws.py`
- Test: `tests/server/test_receipts.py`

**Interfaces:**
- Produces:
  - `storage.ArtifactStore` 抽象（`put(job_id, filename, stream) -> str`、`open(job_id, filename) -> IO`、`url(job_id, filename) -> str`）；Phase 1 實作 `LocalStore(data/artifacts/)`；建構由 settings `artifact_store=local` 決定（預留 s3，Phase 2 實作 presigned 直傳）
  - `POST /api/agent/jobs/{id}/artifacts`（signed, multipart）→ `ArtifactStore.put`；限已 assigned 給該 worker 的 job
  - job_done 處理時：計 `gpu_seconds = finished-started`，建 Receipt＋`platform_sig = sign(f"{job_id}|{worker_id}|{gpu_seconds:.1f}")`；WS 推 `{"type":"receipt","receipt_id","payload","platform_sig"}` 給 agent；agent 回 `{"type":"receipt_ack","receipt_id","worker_sig"}` → 存入 Receipt.worker_sig
  - `GET /api/reports/contributions?from=&to=`（admin）→ 按 worker 彙總 `{worker_id, name, jobs, gpu_seconds}`（時間區間篩選——使用者要求）
- [ ] **Step 1: 失敗測試**（artifact 上傳落地；receipt 兩簽俱全且平台簽可驗；report 區間過濾正確）
- [ ] **Step 2: FAIL → Step 3: 實作 → Step 4: PASS**
- [ ] **Step 5: Commit** `feat(server): artifacts upload and dual-signed receipts with contribution report`

### Task 11: Agent 執行器（ComfyUI client、白名單、多平台 busy 廣播）

**Files:**
- Create: `agent/comfyfed_agent/comfy.py`, `agent/comfyfed_agent/whitelist.py`, `agent/comfyfed_agent/runner.py`, `agent/comfyfed_agent/main.py`
- Test: `tests/agent/test_runner.py`（mock ComfyUI：本測試自架 FastAPI 假 `/prompt`,`/history`）

**Interfaces:**
- Produces:
  - `whitelist.allowed_classes(policy: str, comfy_url: str, custom: list) -> set`：policy=`installed`（預設）→ 本機 `/object_info` 鍵集合；`official_only` → 內建常數 `OFFICIAL_NODE_CLASSES`（官方 nodes 快照）∩ installed；`custom` → 自訂清單 ∩ installed
  - `whitelist.check(workflow: dict, allowed: set) -> None|raises NodeNotAllowed(node_class)`（雙保險：平台派工已比對過交集，agent 端仍再驗一次——不信任平台的防禦縱深）
  - `comfy.run_workflow(comfy_url, workflow, on_progress) -> list[Path]`：POST /prompt→輪詢 /history→下載 outputs 到暫存
  - `comfy.upload_input(comfy_url, filename, content: bytes) -> None`：POST ComfyUI `/upload/image`（multipart，overwrite=true）——把任務附帶的輸入素材（參考圖等）放進本機 ComfyUI input 目錄
  - `runner.AgentLoop(config)`：對每個 platform 開 WS；收 job（訊息含 `input_assets` 清單）→全平台廣播 busy→白名單→**逐一下載 input assets（signed GET `/api/agent/jobs/{id}/inputs/{f}`）→ upload_input 到本機 ComfyUI**→run_workflow（進度回 WS）→上傳 artifacts→job_done→收 receipt→ack→廣播 idle；單一併發（一次一 job）
  - `cli()`：`comfyfed-agent register <bundle.json>`、`comfyfed-agent run`
- [ ] **Step 1: 失敗測試**（白名單擋未知節點；mock comfy 跑通回檔案；AgentLoop 對兩個 mock 平台：A 派工時 B 收到 busy 心跳）
- [ ] **Step 2: FAIL → Step 3: 實作 → Step 4: PASS**
- [ ] **Step 5: Commit** `feat(agent): job runner with node whitelist and multi-platform busy broadcast`

### Task 12: React SPA（雙語、登入、儀表板、任務、worker 管理、設定）

**Files:**
- Create: `web/`（Vite react-ts scaffold）、`web/src/i18n/{zh-TW,en}.json`、pages：`Login.tsx, Dashboard.tsx, Jobs.tsx, Workers.tsx, Reports.tsx, Settings.tsx`、`web/src/api.ts`
- Test: `web/src/i18n.test.ts`（vitest：兩語系 key 集合一致）

**Interfaces:**
- Consumes: Task 4/5/8/10 的 REST（`api.ts` 封裝，帶 credentials 與 X-CSRF）
- Produces: `npm run build` 產 `web/dist`；頁面功能：
  - Login（錯誤碼→i18n 訊息）；右上語言切換（localStorage）
  - Dashboard：worker 卡片（online/offline/busy、進度條、last_seen、**硬體摘要：GPU 型號＋VRAM、RAM、磁碟可用**）＋佇列摘要；5s 輪詢 `GET /api/workers`、`GET /api/jobs?status=queued,assigned,running`
  - Jobs：貼上/上傳 workflow JSON 送出（需求**全自動評估**；「進階」摺疊區才有手動覆寫欄）；貼上後前端即時解析 LoadImage 引用的輸入檔名並逐一顯示附檔欄位（**角色形象參考圖等隨任務上傳**，缺檔不能送出、雙語提示）；任務表（狀態、進度、結果檔下載連結）；queued 任務點開顯示**評估明細**：每個 worker 的三態判定＋白話原因（「只缺模型 X──等模型分發功能」「缺 IPAdapter 節點」「VRAM 不足：需約 18GB／僅 12GB」）
  - Workers：新增（輸入名稱→顯示 bundle JSON＋下載按鈕）、停用
  - Reports：日期區間選擇→貢獻表
  - Settings：改密碼、platform_url、預設語言
- [ ] **Step 1: scaffold（`npm create vite@latest web -- --template react-ts`；裝 mantine、react-i18next）＋i18n key 一致性 vitest（先寫測試、跑 FAIL、補齊字典、PASS）**
- [ ] **Step 2: 實作 api.ts 與六頁（Mantine AppShell；所有文案走 t()）**
- [ ] **Step 3: `npm run build` 成功；vitest PASS**
- [ ] **Step 4: Commit** `feat(web): bilingual react console (login, dashboard, jobs, workers, reports, settings)`

### Task 13: 整線：static serve、CLI、端到端煙霧測試

**Files:**
- Modify: `server/comfyfed_server/main.py`（cli：`comfyfed-server install`（互動雙語導引，結尾大字顯示一次性 admin 密碼）、`comfyfed-server run --host --port`；app mount `web/dist` 於 `/`）
- Test: `tests/test_e2e.py`

**Interfaces:**
- Consumes: 全部
- Produces: 一條命令可跑的平台＋一條命令可跑的 agent

- [ ] **Step 1: e2e 失敗測試**（單製程內：create_app＋mock ComfyUI＋真 AgentLoop（thread）：admin 登入→發 token→agent register→WS 上線→submit job→джob done→artifact 存在→receipt 雙簽→report 有數字）
- [ ] **Step 2: FAIL → Step 3: 實作 cli 與 mount → Step 4: PASS＋手動 `comfyfed-server install` 走一遍雙語導引截圖留檔**
- [ ] **Step 5: Commit** `feat: cli entrypoints, spa serving, end-to-end smoke test`

### Task 14: Prometheus /metrics 端點

**Files:**
- Create: `server/comfyfed_server/metrics.py`, Modify: `app.py`, `agentws.py`, `dispatch.py`
- Test: `tests/server/test_metrics.py`

**Interfaces:**
- Consumes: `db`、dispatch/agentws 的事件點
- Produces: `GET /metrics`（Prometheus 文字格式，無需登入但可用 settings `metrics_public=false` 關閉改需 admin）：
  - `comfyfed_worker_up{worker}`、`comfyfed_worker_free_vram_gb{worker}`、`comfyfed_worker_free_ram_gb{worker}`、`comfyfed_worker_free_disk_gb{worker}`（心跳時 set）
  - `comfyfed_jobs_queued`（gauge，抓取時查 DB）、`comfyfed_job_wait_seconds`／`comfyfed_job_run_seconds`（histogram，job 開跑/完成時 observe）、`comfyfed_ws_reconnects_total{worker}`（counter）

- [ ] **Step 1: 失敗測試**（TestClient GET /metrics 含 `comfyfed_jobs_queued`；心跳後 worker gauge 出現；job 完成後 histogram count ≥1）
- [ ] **Step 2: FAIL → Step 3: 實作（prometheus-client registry；custom collector 查 queued 數）→ Step 4: PASS**
- [ ] **Step 5: Commit** `feat(server): prometheus metrics endpoint`

### Task 15: Agent 版本檢查與簽章自動更新

**Files:**
- Create: `agent/comfyfed_agent/update.py`, Modify: `agent/comfyfed_agent/main.py`, `server/comfyfed_server/workers.py`
- Test: `tests/agent/test_update.py`

**Interfaces:**
- Produces:
  - server：`GET /api/agent/version` → `{latest: "0.1.0", min_supported: "0.1.0", wheel_url: str|None, sha256: str|None, platform_sig: str|None}`（值來自 settings，admin 可在 Settings 頁維護；wheel 檔放 `data/releases/` 由平台 serve）
  - agent：`update.check(entry, current: str) -> UpdateDecision(action: "ok"|"update"|"blocked")`；current < min_supported → blocked（雙語訊息退出）；有新版且 config `auto_update: true`（預設）→ 下載 wheel → 驗 SHA256 → 驗 `platform_sig`（平台公鑰對 sha256 簽名）→ `pip install --no-deps <wheel>` → `os.execv` 自我重啟；驗證失敗→不安裝、警告、照舊版續跑
- [ ] **Step 1: 失敗測試**（版本比對三態；壞簽章拒裝；mock wheel 流程走到 pip 呼叫（monkeypatch subprocess））
- [ ] **Step 2: FAIL → Step 3: 實作 → Step 4: PASS**
- [ ] **Step 5: Commit** `feat(agent): signed self-update with min-supported version gate`

### Task 16: 文件

**Files:**
- Modify: `README.md`（雙語：安裝平台、開 DDNS/固定 IP 注意事項＋反向代理 TLS 範例（Caddyfile 兩行）、新增 worker 流程、安全模型摘要、白名單說明）
- [ ] **Step 1: 撰寫 → Step 2: Commit** `docs: bilingual setup guide`

## Self-Review 紀錄

- 規格覆蓋：安裝隨機密碼（T3/T13）、雙語 CLI＋UI（T3/T12/T13）、SQLite＋Alembic 遷移（T2）、DDNS/固定 IP=platform_url 設定＋文件（T3/T12/T16）、簽名協議＋防重放（T5-T7,T9）、斷線重派（T8/T9）、busy 廣播（T11）、收據與區間報表（T10/T12）、node policy＋節點交集派工＋backend 比對（T2/T8/T9/T11）、/metrics（T14）、ArtifactStore 抽象（T10）、agent 簽章自動更新（T15）。Phase 2 項目（模型 manifest、Comfy 面板、P2P、S3 presigned 實作）依規格明確排除。
- 型別一致性：`verify_agent`、`pick_job_for`、`requeue_stale`、bundle/certificate 欄位在 T5/T6/T7/T9 均沿用同名。
- 無占位符：各任務含測試碼或明確斷言清單與實作要點。
