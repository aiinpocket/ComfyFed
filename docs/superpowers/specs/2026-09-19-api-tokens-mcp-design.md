# API token ＋ MCP 入口 ＋ 配方 設計

日期：2026-09-19。狀態：使用者定案（「照這順序做：API token 認證 → MCP server → skill 文件 → console 拆送單入口；MCP 讀 worker 設定檔知道 server 在哪；使用者登入後下載一個 30 天 token 交給 AI 驅動 MCP」）。

## 1. 問題

中控網頁把 ComfyUI 的複雜度原樣搬到瀏覽器：使用者要自己選範本、自己湊模型、自己看派工。今天（2026-09-19）連平台作者本人都連撞三個牆（下載鈕行為、模型組合不相容、卡單）。要讓一般人用，入口必須變成「對 AI 描述需求」；AI 需要一個可程式化、可長期驅動的入口與憑證。

## 2. 目標

1. **API token**：登入的使用者可以在 console 產生一個 30 天有效的 bearer token，下載成設定檔交給 AI。token 在 session 能用的每一條 API 上等價於 session（CSRF 不適用）。可列出、可撤銷；改密碼即全部失效。
2. **MCP server**：隨 agent 套件出貨的 `comfyfed-mcp` 指令（stdio 傳輸）。自動從 `~/.comfyfed/mcp.json`（console 下載的檔）或 `~/.comfyfed/agent.json` 找到平台網址；工具集涵蓋：看平台／worker、列配方、跑配方、送原始工作流、查／等／取消 job、下載結果、要求下載模型、查下載進度。
3. **配方（recipe）**：平台端一組「實測可跑」的固定工作流＋少數參數。AI 只挑配方、填參數，不組節點圖。第一個配方 = 今天在 RTX 5080 跑通的 Flux 文生圖。
4. **Skill 文件**：告訴 AI 客戶端怎麼裝、怎麼用、失敗怎麼看。
5. **console 定位**：拆掉 Jobs 頁的送單表單，console 只剩營運面（jobs／workers／收據／設定）。
6. 兩棧 parity；agent 既有 wire 不變；agent 版本 0.1.15（多一個 console_script 與 optional extra）。

## 3. 非目標

- 不做 OAuth／不做 token 自動續期／不做 per-token 權限範圍（token = 該使用者的全部權限）。
- 不做 SSE／streamable-http 傳輸；stdio only。
- 不做 AI 自由生成工作流的「驗證」；`submit_workflow` 是進階入口，責任在呼叫端。
- 不改 panel（`/comfy/...`）的 cookie 認證；panel WebSocket、`/comfy` 靜態檔仍 cookie-only。
- 不做配方的線上編輯／上傳；配方是套件內檔案，改配方 = 發版。

## 4. API token

### 4.1 資料

表 `api_tokens`（Alembic 新 head；D1 `0013_api_tokens.sql`）：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` TEXT PK | uuid hex | |
| `user_id` TEXT NOT NULL | 擁有者（`users.id`） | |
| `name` TEXT NOT NULL DEFAULT '' | 使用者取的標籤，≤ 64 字 | |
| `token_hash` TEXT NOT NULL UNIQUE | 明文的 sha256 hex | 明文永不落地 |
| `prefix` TEXT NOT NULL | 明文前 12 字（`cft_` + 8）供辨識 | |
| `epoch` INTEGER NOT NULL | 建立時的 `users.session_epoch` | 改密碼 → epoch +1 → token 全失效 |
| `created_at` DATETIME NOT NULL | | |
| `expires_at` DATETIME NOT NULL | `created_at + 30 天` | |
| `last_used_at` DATETIME NULL | 最多每 5 分鐘更新一次 | |
| `revoked_at` DATETIME NULL | | |

明文格式：`cft_` + 32 bytes `secrets.token_urlsafe`（43 字）。常數 `API_TOKEN_TTL_DAYS = 30`、`API_TOKEN_MAX_ACTIVE_PER_USER = 10`、`API_TOKEN_PREFIX = "cft_"`。

### 4.2 端點（皆需 **cookie session**＋CSRF；bearer 不能管理 token）

- `POST /api/auth/tokens` body `{"name": "..."}`（可省）→ `201 {"id","name","token","prefix","created_at","expires_at"}`。`token` 只在這一次回應出現。超過 10 個有效 token → `409 {"error":{"code":"auth.too_many_tokens"}}`。`name` > 64 字 → 400 `auth.bad_token_name`。
- `GET /api/auth/tokens` → `[{"id","name","prefix","created_at","expires_at","last_used_at","revoked_at","active": bool}]`（只列自己的；`active` = 未撤銷且未過期）。
- `DELETE /api/auth/tokens/{id}` → `200 {"revoked": true}`；不是自己的或不存在 → 404 `auth.token_not_found`；已撤銷 → 200 idempotent。

### 4.3 認證解析

`Authorization: Bearer cft_...` 在下列地方等價於 session（使用者身分、角色皆來自 `users` 列，即時讀）：Python `require_user`／`require_admin`／`require_csrf_user`／`require_csrf`；cloud `resolveAuthedSession` 餵的四個 middleware。順序：**有 `Authorization` header 就只看 header**（不回退 cookie；避免混用時的混淆）；header 格式錯、找不到、已撤銷、已過期、epoch 不符、使用者停用 → 401 `auth.unauthorized`（與 cookie 失敗同碼，不區分原因）。bearer 請求 **跳過 CSRF**（CSRF 防的是瀏覽器跨站帶 cookie；header 不會被跨站帶）。

`GET /api/auth/me` 以 bearer 呼叫：`{"authenticated":true, "username","role","lang","platform_url", "csrf": null, "auth":"token", "token_expires_at": ...}`；cookie 呼叫多一個 `"auth":"session"`。

例外（**只收 cookie**，bearer 一律 401）：`POST /api/auth/tokens`、`GET /api/auth/tokens`、`DELETE /api/auth/tokens/{id}`、`POST /api/auth/change-password`、`POST /api/auth/logout`、`POST /api/auth/login`（本來就不需要）。實作上這些 route 用獨立的 `require_csrf_session`（Python）／`requireCsrfSession`（cloud）依賴，只讀 cookie。

`last_used_at`：命中時若為 NULL 或早於 5 分鐘前才寫回（`API_TOKEN_TOUCH_SECONDS = 300`）。

### 4.4 console（Settings 頁新區塊「API token / AI 存取」）

- 輸入名稱 → 「產生」→ 顯示明文一次（等寬、可複製）＋「下載設定檔」按鈕：下載 `comfyfed-mcp.json`，內容 `{"platform_url": <me.platform_url>, "token": "...", "expires_at": "..."}`（`application/json`，前端用 Blob 產生，不經伺服器）。
- 清單：名稱、前綴、建立、到期、最後使用、狀態（有效／已撤銷／已過期）、「撤銷」鈕（confirm）。
- 說明文字：把檔案放到 `~/.comfyfed/mcp.json`，或用 `COMFYFED_TOKEN`／`COMFYFED_TOKEN_FILE` 環境變數。
- i18n zh-TW／en 鍵對齊。

## 5. 配方（recipe）

### 5.1 檔案格式

套件內 `server/comfyfed_server/recipes/<id>.json`；cloud 為 byte-parity 副本 `cloud/src/core/recipes/<id>.json`（vitest 比對兩份逐位元相同，同 `comfyfed_ext.ts` 的做法）。

```json
{
  "id": "flux-t2i",
  "title": {"zh-TW": "Flux 文生圖", "en": "Flux text-to-image"},
  "description": {"zh-TW": "...", "en": "..."},
  "params": [
    {"name": "prompt", "type": "string", "required": true, "description": {"zh-TW": "...", "en": "..."}},
    {"name": "width", "type": "integer", "default": 768, "min": 256, "max": 2048, "step": 16},
    {"name": "height", "type": "integer", "default": 768, "min": 256, "max": 2048, "step": 16},
    {"name": "steps", "type": "integer", "default": 8, "min": 1, "max": 50},
    {"name": "guidance", "type": "number", "default": 3.5, "min": 0, "max": 20},
    {"name": "seed", "type": "integer", "default": -1, "min": -1, "max": 4294967295, "description": {"zh-TW": "-1 = 隨機", "en": "-1 = random"}}
  ],
  "required_models": ["flux1-dev.safetensors", "clip_l.safetensors", "t5xxl_fp16.safetensors", "ae.safetensors"],
  "workflow": { ...ComfyUI API-format 節點圖，參數位置寫成 {"$param": "prompt"} ... }
}
```

參數型別：`string`／`integer`／`number`／`boolean`／`enum`（`"values": [...]`）。渲染：深走 `workflow`，遇到 `{"$param": "<name>"}` 物件就換成該參數值（型別保留）；`seed == -1` 由伺服器換成 `secrets.randbelow(2**32)`。驗證失敗 → 400 `recipes.bad_params`，`message` 列出第一個錯的參數與原因。

### 5.2 端點（`require_user`；run 為 `require_csrf_user`，bearer 可）

- `GET /api/recipes` → `[{"id","title","description","params","required_models"}]`（不含 `workflow`）。
- `GET /api/recipes/{id}` → 同上一筆＋`workflow`；404 `recipes.not_found`。
- `POST /api/recipes/{id}/run` body `{"params": {...}}` → 渲染後走與 `POST /api/jobs` 完全相同的建單路徑（同 `origin="console"`、同 signature／requirements 推導、同派工），回 `201 {"job_id","recipe_id","params"}`（`params` 為套用預設與隨機 seed 後的實際值）。

### 5.3 第一個配方 `flux-t2i`

今天在 POKAI-HOME 跑通的圖：`UNETLoader flux1-dev.safetensors`、`DualCLIPLoader clip_l + t5xxl_fp16, type flux`、`VAELoader ae.safetensors`、`CLIPTextEncode(prompt)`、`FluxGuidance(guidance)`、`BasicGuider`、`KSamplerSelect euler`、`BasicScheduler simple/steps/denoise 1`、`RandomNoise(seed)`、`EmptySD3LatentImage(width,height,1)`、`SamplerCustomAdvanced`、`VAEDecode`、`SaveImage filename_prefix "comfyfed_recipe"`。

## 6. MCP server

### 6.1 出貨

- 模組 `agent/comfyfed_agent/mcp_server.py`；`[project.scripts]` 加 `comfyfed-mcp = "comfyfed_agent.mcp_server:cli"`；`[project.optional-dependencies]` 加 `mcp = ["mcp>=2.0,<3"]`。**`mcp` 不是硬依賴**（agent 自更新用 `pip install --no-deps`，硬依賴裝不到）；`cli()` 先嘗試 `from mcp.server.mcpserver import MCPServer`，失敗時印出 `pip install "comfyfed[mcp]"` 指引並 exit 2。
- 版本 0.1.15（`agent/comfyfed_agent/__init__.py` 與 `pyproject.toml`）。protocol 不變（5）。

### 6.2 設定解析（純函式 `resolve_settings(env, home) -> McpSettings{platform_url, token, source}`）

順序：
1. `COMFYFED_TOKEN_FILE` 環境變數指到的 JSON；否則 `~/.comfyfed/mcp.json` 若存在 → 讀 `platform_url`、`token`。
2. `COMFYFED_TOKEN` 環境變數覆蓋 token；`COMFYFED_PLATFORM_URL` 覆蓋網址。
3. 網址仍缺 → `~/.comfyfed/agent.json` 的 `platforms[0].platform_url`（多平台時取第一個；`COMFYFED_PLATFORM_URL` 可指定）。
4. token 缺 → 啟動失敗，stderr 說明三種給法；網址缺 → 同。

`mcp.json` 讀取失敗（非 JSON／缺欄）視同不存在但 stderr 警告。

### 6.3 工具（全部同步 httpx，逾時 30 s；回傳 JSON 可序列化 dict；平台錯誤 → 拋 `ToolError(f"{code}: {message}")`）

| 工具 | 參數 | 呼叫 | 回傳 |
|---|---|---|---|
| `platform_status` | — | `GET /api/auth/me`、`GET /api/workers` | `{platform_url, username, role, token_expires_at, workers:[{name,status,gpu,vram_gb,model_count,unsuitable_count}]}` |
| `list_workers` | — | `GET /api/workers` | 原樣列表（去掉 `dynamic`） |
| `list_recipes` | — | `GET /api/recipes` | 原樣 |
| `run_recipe` | `recipe_id: str, params: dict` | `POST /api/recipes/{id}/run` | `{job_id, recipe_id, params}` |
| `submit_workflow` | `workflow_json: str, requirements: dict | None` | `POST /api/jobs`（multipart） | `{job_id}` |
| `list_jobs` | `status: str | None, limit: int = 20` | `GET /api/jobs?status=` | 截前 `limit` 筆，每筆 `{id,status,origin,progress,created_at,worker_id,error}` |
| `job_status` | `job_id` | `GET /api/jobs/{id}` | `{id,status,progress,worker_id,error,result_files,attempts,attempt_errors,retry_count,dispatch_info,receipt}` |
| `wait_for_job` | `job_id, timeout_seconds: int = 600, poll_seconds: int = 3` | 輪詢 `job_status` | 終局（done/failed/cancelled）就回同 `job_status`；逾時回 `{"timed_out": true, ...最後狀態}` |
| `download_results` | `job_id, dest_dir: str | None` | `GET /api/jobs/{id}/artifacts/{file}` | `{job_id, files:[abs paths]}`；預設 `~/.comfyfed/results/<job_id>/`；檔名經 basename 淨化 |
| `cancel_job` | `job_id` | `POST /api/jobs/{id}/cancel` | `{status}` |
| `request_model` | `name, directory, url` | `POST /comfy/api/comfyfed/model-fetch` | `{job_id, reused}`；400 錯誤碼原樣轉成 ToolError |
| `model_fetch_status` | `job_id` | `GET /comfy/api/comfyfed/model-fetch/{id}` | 原樣 |

server 名稱 `comfyfed`，`instructions` 給 AI 一段中英雙語摘要：先 `list_recipes`，能用配方就用配方；`submit_workflow` 只在配方不夠用時；送單後用 `wait_for_job`；失敗看 `attempt_errors`；缺模型用 `request_model`（只接受 huggingface.co／civitai.com 網址）。

### 6.4 測試

`tests/agent/test_mcp_server.py`：`resolve_settings` 的四條路徑；每個工具用 `httpx.MockTransport` 假平台驗證路徑、header（`Authorization: Bearer`、無 `X-CSRF`）、回傳形狀；`download_results` 寫檔到 `tmp_path`；平台 4xx → ToolError 含錯誤碼；`mcp` 缺時 `cli()` exit 2。工具函式與 MCP 註冊分離（`build_server(settings) -> MCPServer`，工具本體是模組層純函式接一個 `Client` 物件），測試不需要啟動 stdio。

## 7. Skill 與文件

- `docs/skills/comfyfed/SKILL.md`：frontmatter `name: comfyfed`、`description`；內容：安裝（`pip install "comfyfed[mcp]"`）、取得 token（console Settings → 下載 `mcp.json` 放 `~/.comfyfed/`）、在 Claude Code／Claude Desktop／Cursor 註冊（`claude mcp add comfyfed -- comfyfed-mcp` 與 JSON 片段）、工具使用順序、常見錯誤（401 → token 過期／撤銷；`model_fetch.no_worker`；`recipes.bad_params`）。
- `docs/MCP.zh.md`／`docs/MCP.en.md`：同內容的使用者文件。`docs/SELF-HOSTING.{zh,en}.md` 加「API token」與「配方」小節、指向 MCP 文件。

## 8. console 拆送單入口

`web/src/pages/Jobs.tsx` 移除 `SubmitPanel` 與其測試；頁首加一行提示（i18n）：「送單請透過 AI（MCP）或 ComfyUI 面板；這裡只看狀態。」`api.submitJob` 保留（MCP 文件與 e2e 仍引用其形狀；不刪 API）。

## 9. 安全

- token 明文只存在於回應與使用者下載的檔；伺服器只存 sha256。
- token 不能產 token、不能改密碼、不能登出（§4.3）。
- 改密碼 → epoch 變 → 舊 token 全失效（與 session 同機制）。
- `download_results` 只寫到目的目錄內（basename 淨化，拒 `..`／分隔符）。
- MCP 不會把 token 印進 log 或工具回傳。

## 10. 測試

- server：`test_auth.py`（建／列／撤／上限／名稱長度；bearer 通過 `GET /api/jobs`、跳過 CSRF 的 `POST /api/jobs`；撤銷／過期／改密碼後 401；bearer 打 token 管理端點 401；`/api/auth/me` 形狀）、`test_recipes.py`（列、取、驗證錯誤、run 建單且 workflow 已渲染、seed -1 隨機、參數預設）、`test_mcp_server.py`（§6.4）。
- cloud：`auth.spec.ts`／`recipes.spec.ts` 對應；`recipes_parity.spec.ts` 比對 JSON 檔逐位元。
- web：`Settings.test.tsx`（產生→顯示一次→下載檔內容→列出→撤銷）、`Jobs.test.tsx`（無 SubmitPanel、有提示）。
- e2e：`tests/test_e2e.py` 加一段：以 bearer 跑 `flux-t2i` 配方到假 worker 收到的 push 內 workflow 含渲染後的 prompt。

## 11. 部署

Alembic 新 head；D1 `0013_api_tokens.sql`；push main → 手動 `npm run deploy`（Workers Builds 不可靠）；agent 0.1.15 wheel 發佈（R2 put ＋ console 登入態 POST `agent-release`）。
