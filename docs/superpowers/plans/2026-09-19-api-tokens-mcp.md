# API token ＋ MCP 入口 ＋ 配方 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用者在 console 產生 30 天 bearer token → 交給 AI → AI 透過隨 agent 套件出貨的 `comfyfed-mcp` 驅動平台：跑配方、送單、等結果、下載、要求下載模型；console 退為營運面。

**Architecture:** 新表 `api_tokens`（sha256 存雜湊、綁 `users.session_epoch`）；兩棧的 session 收斂點（Python `require_user` 家族、cloud `resolveAuthedSession`）改為「有 `Authorization` header 就只看 bearer、跳過 CSRF」，token 管理與改密碼／登出仍 cookie-only。配方 = 套件內 JSON（`{"$param": ...}` 佔位）＋ `/api/recipes` 三條 route，`run` 渲染後走既有建單路徑。MCP = `agent/comfyfed_agent/mcp_server.py`（mcp 2.x `MCPServer`，stdio），工具本體是接 `Client` 的純函式，設定從 `mcp.json`／環境變數／`agent.json` 解析。

**Tech Stack:** FastAPI／SQLAlchemy／Alembic；Workers／Hono／D1；React／Mantine；`mcp>=2.0,<3`（optional extra）；httpx；pytest／vitest。

**Spec:** `docs/superpowers/specs/2026-09-19-api-tokens-mcp-design.md` — 具約束力。

## Global Constraints

- 常數兩棧同名同值：`API_TOKEN_TTL_DAYS = 30`、`API_TOKEN_MAX_ACTIVE_PER_USER = 10`、`API_TOKEN_PREFIX = "cft_"`、`API_TOKEN_TOUCH_SECONDS = 300`、`API_TOKEN_NAME_MAX = 64`。
- 明文 = `"cft_" + secrets.token_urlsafe(32)`；`token_hash` = sha256 hex；`prefix` = 明文前 12 字。
- 錯誤碼逐字：`auth.too_many_tokens`（409）、`auth.bad_token_name`（400）、`auth.token_not_found`（404）、`auth.unauthorized`（401，bearer 失敗與 cookie 失敗同碼）、`recipes.not_found`（404）、`recipes.bad_params`（400）。
- 有 `Authorization` header → 只看 bearer，不回退 cookie；bearer 跳過 CSRF。
- bearer 一律 401 的 route：`POST/GET /api/auth/tokens`、`DELETE /api/auth/tokens/{id}`、`POST /api/auth/change-password`、`POST /api/auth/logout`。
- 配方 JSON 兩棧逐位元相同（`server/comfyfed_server/recipes/*.json` ↔ `cloud/src/core/recipes/*.json`），vitest 強制。
- `mcp` 只能是 optional extra；`comfyfed_agent.mcp_server` 模組層**不得** import `mcp`（延遲到 `build_server`／`cli`）。
- agent 版本 0.1.15（`agent/comfyfed_agent/__init__.py`、`pyproject.toml`）；protocol 不變。
- 測試指令：Python `.venv/Scripts/python -m pytest <files> -q -p no:cacheprovider`（controller 前景跑全套；子代理只跑自己的檔；**永遠不要同時跑兩個 pytest**）；cloud `cd cloud && npx tsc --noEmit && npx vitest run <file>`；web `cd web && npx tsc --noEmit && npx vitest run <file>`。
- 每任務一 commit，直接在 `main`，訊息 trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
- 中文註解與文案用繁體台灣用語；docs 中英兩份。

## File Structure

新建：`server/alembic/versions/e6f7a8b9c0d1_api_tokens.py`、`server/comfyfed_server/api_tokens.py`、`server/comfyfed_server/recipes.py`、`server/comfyfed_server/recipes/flux-t2i.json`、`cloud/migrations/0013_api_tokens.sql`、`cloud/src/core/api_tokens.ts`、`cloud/src/core/recipes.ts`、`cloud/src/core/recipes/flux-t2i.json`、`cloud/src/routes/recipes.ts`、`agent/comfyfed_agent/mcp_server.py`、`tests/server/test_api_tokens.py`、`tests/server/test_recipes.py`、`tests/agent/test_mcp_server.py`、`cloud/test/api_tokens.spec.ts`、`cloud/test/recipes.spec.ts`、`docs/skills/comfyfed/SKILL.md`、`docs/MCP.zh.md`、`docs/MCP.en.md`。
修改：`db.py`、`auth.py`、`app.py`（掛 recipes router）、`cloud/src/db/queries.ts`、`cloud/src/lib/guard.ts`、`cloud/src/routes/auth.ts`、`cloud/src/index.ts`（掛 route）、`pyproject.toml`、`agent/comfyfed_agent/__init__.py`、`web/src/api.ts`、`web/src/pages/Settings.tsx`（＋test）、`web/src/pages/Jobs.tsx`（＋test）、i18n 兩份、`docs/SELF-HOSTING.{zh,en}.md`、`tests/test_e2e.py`。

---

### Task 1: server — `api_tokens` 表、helpers、bearer 認證、管理端點

**Files:** Create `api_tokens.py`、migration `e6f7a8b9c0d1_api_tokens.py`（down_revision `d5e6f7a8b9c0`）；Modify `db.py`、`auth.py`；Test `tests/server/test_api_tokens.py`。

**Interfaces (Produces):**
```python
# api_tokens.py
API_TOKEN_TTL_DAYS = 30; API_TOKEN_MAX_ACTIVE_PER_USER = 10; API_TOKEN_PREFIX = "cft_"
API_TOKEN_TOUCH_SECONDS = 300; API_TOKEN_NAME_MAX = 64
def generate_plaintext() -> str                       # "cft_" + token_urlsafe(32)
def hash_token(plaintext: str) -> str                 # sha256 hex
def create_token(session, user, name: str, now) -> tuple[db.ApiToken, str]  # (row, plaintext); raises TooManyTokens / BadName
def list_tokens(session, user_id: str, now) -> list[dict]     # spec §4.2 形狀，含 active
def revoke_token(session, user_id: str, token_id: str, now) -> bool  # False = 不存在/非本人
def resolve_bearer(session, header_value: str | None, now) -> Optional[db.User]  # 全部檢查（格式、hash、revoked、expires、epoch、disabled）；命中且需要時更新 last_used_at
def token_dict(row, now) -> dict
```
`db.ApiToken` model 依 spec §4.1。`auth.py`：新增 `_bearer_user(request)`；`require_user`／`require_admin`／`require_csrf_user`／`require_csrf` 改為先看 `Authorization` header（有就只走 bearer；bearer 路徑跳過 CSRF 比對）；`resolve_session_user` 不變（cookie only）；新增 `require_csrf_session`（純 cookie＋CSRF，供 token 管理／change-password／logout）；`SessionUser` 加欄位 `auth: Literal["session","token"]`、`token_expires_at: Optional[str]`。`/api/auth/me` 依 spec §4.3 加 `auth`／`token_expires_at`（cookie 時 `csrf` 照舊，token 時 `csrf: null`）。三條 token 端點依 spec §4.2。

- [ ] 失敗測試（`test_api_tokens.py`，client fixture 同 `test_auth.py`）：建 token 回 201 且 `token` 以 `cft_` 開頭、長度 47、`prefix` 為前 12 字；同一 token 第二次 GET 清單不含明文；bearer 打 `GET /api/jobs` 200；bearer `POST /api/jobs`（multipart，無 `X-CSRF`）201；bearer 打 `GET /api/auth/me` 回 `auth == "token"`、`csrf is None`；bearer 打 `POST /api/auth/tokens`、`GET /api/auth/tokens`、`DELETE ...`、`POST /api/auth/change-password`、`POST /api/auth/logout` 皆 401；撤銷後 401；把 `expires_at` 改到過去 → 401；改密碼後舊 token 401；停用使用者後 401；壞格式 header（`Bearer x`、`Basic ...`、空）401 且不回退 cookie（同請求帶有效 cookie 也 401）；第 11 個 token → 409 `auth.too_many_tokens`（撤銷一個後可再建）；名稱 65 字 → 400；`last_used_at` 首次命中後非空、5 分鐘內再命中不變。
- [ ] 實作 → 跑 `test_api_tokens.py test_auth.py test_jobs.py` → commit `feat(server): API tokens with bearer auth`。

### Task 2: server — 配方

**Files:** Create `recipes.py`、`recipes/flux-t2i.json`；Modify `app.py`（掛 router）、`pyproject.toml`（`package-data` 加 `recipes/*.json`）；Test `tests/server/test_recipes.py`。

**Interfaces (Produces):**
```python
# recipes.py
class RecipeError(Exception): code: str; message: str
def load_recipes() -> dict[str, dict]                 # id -> 檔內容（lru_cache）
def public_view(recipe: dict, include_workflow: bool) -> dict
def validate_params(recipe: dict, params: dict) -> dict   # 套預設、型別/範圍/enum 檢查，seed -1 -> 隨機；錯 -> RecipeError("recipes.bad_params", "...")
def render_workflow(recipe: dict, params: dict) -> dict   # 深走替換 {"$param": name}
def create_router(data_dir) -> APIRouter               # GET /api/recipes, GET /api/recipes/{id}, POST /api/recipes/{id}/run
```
`run` 與 `jobs.py` `POST /api/jobs` 共用同一個建單函式：把 `jobs.py` 現有建單邏輯抽成 `jobs.create_job_from_workflow(session_or_none, user, workflow: dict, requirements: dict, assets: list, data_dir) -> str`（只搬不改，`POST /api/jobs` 改呼叫它），`recipes.run` 呼叫同一個。`flux-t2i.json` 依 spec §5.3；`SaveImage.filename_prefix = "comfyfed_recipe"`；`RandomNoise.noise_seed = {"$param":"seed"}`；`EmptySD3LatentImage.width/height`；`BasicScheduler.steps`；`FluxGuidance.guidance`；`CLIPTextEncode.text`。

- [ ] 失敗測試：`GET /api/recipes` 有 `flux-t2i` 且無 `workflow`；`GET /api/recipes/flux-t2i` 有 `workflow` 且其中沒有任何 `$param` 殘留於 `render_workflow` 結果；`validate_params({"prompt":"x"})` 填滿預設、seed 為 0..2^32-1；缺 prompt → 400 `recipes.bad_params` 且 message 含 `prompt`；width 300（非 16 倍數）→ 400；steps 0 → 400；未知參數 → 400；`POST /api/recipes/flux-t2i/run`（cookie＋CSRF）→ 201，DB job 的 workflow_json 節點 4 text == prompt、`required_models` 含四個檔名；bearer（Task 1）也可 run；unknown id → 404。
- [ ] 實作 → 跑 `test_recipes.py test_jobs.py` → commit `feat(server): recipes API with flux-t2i`。

### Task 3: cloud twin（token ＋ recipes）

**Files:** Create `0013_api_tokens.sql`、`core/api_tokens.ts`、`core/recipes.ts`、`core/recipes/flux-t2i.json`（**用 `cp` 複製** Task 2 的檔案，不要重打）、`routes/recipes.ts`；Modify `db/queries.ts`（`ApiTokenRow`／`rowToApiToken`／insert/select/update）、`lib/guard.ts`（`resolveAuthedSession` 先看 `Authorization`；新 `requireCsrfSession`；`SessionUser.auth`／`tokenExpiresAt`）、`routes/auth.ts`（三條 token route、`/api/auth/me` 欄位、change-password／logout 改用 `requireCsrfSession`）、`routes/jobs.ts`（抽 `createJobFromWorkflow`）、`index.ts`；Test `api_tokens.spec.ts`、`recipes.spec.ts`（含 parity 測試：`readFileSync` 兩份 JSON 比 `Buffer.equals`）。
- [ ] port Task 1／2 測試逐案 → `npx tsc --noEmit`、`npx vitest run test/api_tokens.spec.ts test/recipes.spec.ts test/auth.spec.ts test/jobs.spec.ts` → commit `feat(cloud): API tokens + recipes`。

### Task 4: MCP server（agent 套件）

**Files:** Create `agent/comfyfed_agent/mcp_server.py`、`tests/agent/test_mcp_server.py`；Modify `pyproject.toml`（scripts `comfyfed-mcp`、extra `mcp`、version 0.1.15）、`agent/comfyfed_agent/__init__.py`（0.1.15）。

**Interfaces (Produces):**
```python
@dataclass
class McpSettings: platform_url: str; token: str; source: str   # source: "mcp.json" | "env" | "agent.json" 組合描述
class SettingsError(Exception): ...
def resolve_settings(env: Mapping[str, str], home: str) -> McpSettings   # spec §6.2 順序；home 用來找 .comfyfed/
class Client:  # httpx.Client 包裝；__init__(settings, transport=None)；每個請求帶 Authorization: Bearer；30s timeout
    def get(path, **kw) -> Any; def post_json(path, body) -> Any; def post_form(path, data, files) -> Any; def download(path, dest: Path) -> Path
class ToolError(Exception): ...   # 平台 4xx/5xx -> f"{code}: {message}"（無 envelope 時 "http_<status>: <text[:200]>"）
def platform_status(c), list_workers(c), list_recipes(c), run_recipe(c, recipe_id, params), submit_workflow(c, workflow_json, requirements=None),
    list_jobs(c, status=None, limit=20), job_status(c, job_id), wait_for_job(c, job_id, timeout_seconds=600, poll_seconds=3, sleep=time.sleep),
    download_results(c, job_id, dest_dir=None, home=None), cancel_job(c, job_id), request_model(c, name, directory, url), model_fetch_status(c, job_id)
def build_server(settings: McpSettings, client: Client | None = None) -> "MCPServer"  # 這裡才 import mcp；用 @server.tool() 註冊上面 12 個，名稱同函式名
def cli(argv=None) -> int   # 解析 --token-file/--platform-url 覆蓋 env；缺 mcp -> stderr 指引 + return 2；缺設定 -> stderr + return 1；否則 build_server(...).run("stdio")
```
`download_results` 檔名淨化：`os.path.basename`，含 `..`／`/`／`\` 或空 → 跳過並在回傳 `skipped` 列出。`wait_for_job` 終局狀態集合 `{"done","failed","cancelled"}`。

- [ ] 失敗測試（`httpx.MockTransport` 假平台；`monkeypatch` 環境變數與 `home=tmp_path`）：`resolve_settings` 四路徑＋錯誤；每個工具的 path／method／header（有 `Authorization: Bearer <token>`、沒有 `X-CSRF`）與回傳形狀；`wait_for_job` 用假 sleep 三次輪詢後 done；逾時回 `timed_out`；`download_results` 寫到 `tmp_path/.comfyfed/results/<job>/` 且拒絕 `../evil.png`；平台回 `{"error":{"code":"model_fetch.no_worker","message":"x"}}` → `ToolError` 字串含 code；`import comfyfed_agent.mcp_server` 在 `sys.modules` 沒有 `mcp` 時仍成功（`monkeypatch.setitem(sys.modules, "mcp", None)` 前先 reload）；`cli()` 在 mcp 缺時回 2；`build_server` 在有 mcp 時回傳的 server `list_tools()` 含 12 個名稱（`asyncio.run`）。
- [ ] 實作 → 跑 `tests/agent/test_mcp_server.py` → 在 dev venv `pip install -e ".[mcp]"` 後手動 `comfyfed-mcp --help` 不炸 → commit `feat(agent): comfyfed-mcp server (0.1.15)`。

### Task 5: web console（Settings token 區塊 ＋ Jobs 拆送單）

**Files:** Modify `web/src/api.ts`（`ApiToken` 型別、`createToken(name)`、`listTokens()`、`revokeToken(id)`、`submitJob` 保留）、`pages/Settings.tsx`＋`Settings.test.tsx`、`pages/Jobs.tsx`＋`Jobs.test.tsx`（移除 `SubmitPanel` 與其測試、加提示）、`i18n/zh-TW.json`、`i18n/en.json`。
- [ ] 測試：Settings 產生 → 明文顯示一次（`data-testid="api-token-plaintext"`）→ 「下載設定檔」點擊產生 Blob（mock `URL.createObjectURL`，斷言 JSON 含 `platform_url`／`token`／`expires_at`）→ 清單出現 → 撤銷（confirm）後狀態「已撤銷」；Jobs 頁沒有 `submit-panel`、有 `jobs-submit-hint`。
- [ ] → `npx tsc --noEmit`、`npx vitest run src/pages/Settings.test.tsx src/pages/Jobs.test.tsx src/i18n.test.ts` → commit `feat(web): API tokens in Settings, jobs page is read-only`。

### Task 6: docs ＋ skill ＋ e2e

**Files:** Create `docs/skills/comfyfed/SKILL.md`、`docs/MCP.zh.md`、`docs/MCP.en.md`；Modify `docs/SELF-HOSTING.{zh,en}.md`（「API token」「配方」小節＋連結）、`tests/test_e2e.py`。
- [ ] e2e：admin cookie 建 token → 以 bearer `POST /api/recipes/flux-t2i/run`（prompt 固定字串）→ 假 worker（inventory 含四個模型）收到 push，其 workflow 節點 4 text 等於 prompt → 假 worker 回 done → bearer `GET /api/jobs/{id}` done、bearer 下載 artifact 200。
- [ ] 文件依 spec §7 → 跑 `tests/test_e2e.py` → commit `docs+test(e2e): MCP skill, token and recipe docs`。

### Task 7: 發版（controller）
- [ ] 全套四棧測試 → push main → 乾淨 worktree `npm run ci-build && npm run deploy`（D1 0013）→ `python -m build` 產 0.1.15 wheel → R2 put ＋ console 登入態 POST `agent-release` → `/api/agent/version` 顯示 0.1.15 → 本機 agent venv `pip install --no-deps` wheel ＋ `pip install "mcp>=2,<3"` → 用真 token 跑一次 `comfyfed-mcp` 的 `list_recipes`／`run_recipe` 端到端。
