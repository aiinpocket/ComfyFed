# 面板「下載」鈕改派 worker 下載（model_fetch job）設計

日期：2026-09-19。狀態：已核准（使用者選定：來源白名單＋事後學雜湊；任何登入使用者可觸發，套 worker 主權門檻）。

## 1. 問題

ComfyUI 官方前端 1.52.7 右側欄「缺少模型」卡片的「下載 {model}」／「全部下載」鈕，實作是 `missingModelMetadata` 模組的 `downloadModel()`：非 Desktop 環境直接 `openUrlInNewTab(url, name)`，建 `<a href=url download=name target=_blank>` 並 click，**由瀏覽器把模型檔下載到使用者自己的電腦**，從頭到尾不打任何伺服器端點。ComfyFed 是聯邦：模型只該落在 worker 磁碟，這顆鈕的行為與設計相反。

既有緩解只有「官方範本送出前拔掉 `models[].url/hash`」（`templates.py` / `templates.ts`），但下列來源仍把 `url` 帶進瀏覽器，鈕照樣出現：

1. 前端 bundle 內建的預設工作流（`loadDefaultWorkflow` = z_image_turbo，三個 HuggingFace url 直接烤在 `settingStore-*.js`），不經伺服器。
2. 「我的範本」（`my_` 前綴）與 userdata 工作流，伺服器原樣回傳。
3. 使用者自己拖進面板的 JSON／PNG。

按鈕出現條件（前端）：模型項目同時有 `url`、`directory`，且 url 通過 HuggingFace／Civitai 白名單。

## 2. 目標

- 「下載」鈕的語意變成「請聯邦派一台合適的 worker 去抓這個模型」，面板顯示下載進度，完成後提示重新整理。
- 不 patch 釘死版本的前端 dist；只用 `GET /comfy/api/extensions` 的擴充機制（`panel_ext/comfyfed.js`，cloud 為 byte-parity 副本 `core/comfyfed_ext.ts`）。
- 兩棧 parity：`server/`（FastAPI）與 `cloud/`（Workers）行為逐項一致。
- 信任模型：worker 只下載**平台簽章**的項目。平台沒有已知雜湊的模型（本案主因）允許以「未驗證來源」項目派工，但 url 必須是白名單網域，落地後 worker 回報實際 SHA-256，平台學為共識雜湊，之後就是普通的內容定址項目。

## 3. 非目標（YAGNI）

- 不做下載進度的 WebSocket 推播（面板輪詢 2 秒）。
- 不做 Civitai／HuggingFace 需登入的 token 轉交；受限模型（HEAD 回 401/403）直接拒絕並提示。
- 不做「全部下載」以外的批次 API：全部下載 = 逐一送出單模型請求。
- 不新增 GCS 備援與 P2P 種子給未驗證項目（沒有雜湊就沒有內容定址）。

## 4. 資料模型

`jobs` 新增兩欄（Alembic 新 head 接在目前 head 之後；D1 `0011_model_fetch.sql`）：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `kind` | TEXT NOT NULL DEFAULT `'prompt'` | `prompt`（既有一切）或 `model_fetch` |
| `fetch_entry` | TEXT NULL | `model_fetch` 專用：建單時簽好的 manifest 項目 JSON（§6） |

`model_fetch` job 的其他欄位：`workflow_json="{}"`、`required_models=[name]`、`required_nodes=[]`、`est_vram_gb=NULL`、`signature=NULL`、`split_plan=NULL`、`origin="panel"`、`user_id`=按鈕者、`input_assets=[]`。

`receipts.kind` 新值 `model_fetch`（`billable=0`、`basis="model_fetch"`、`gpu_seconds=0`）。報表已有 unbilled 分列機制，無需改。

## 5. 端點（兩棧，掛在 `/comfy/api/comfyfed/`，`require_user`）

### 5.1 `POST /comfy/api/comfyfed/model-fetch`

Body：`{"name": str, "directory": str, "url": str}`。

判定順序（第一個命中即回）：

| 順序 | 條件 | 回應 |
|---|---|---|
| 1 | body 缺欄／非字串／`name` 含路徑分隔或 `..`／`directory` 不過 `_is_safe_relative_path` | 400 `model_fetch.bad_request` |
| 2 | 任何**已註冊**（含離線／停用）worker 的庫存已有 `name` | 400 `model_fetch.already_present`「模型已在聯邦內，請重新整理面板」 |
| 3 | 已有 `kind=model_fetch`、`status IN (queued, dispatched, running)`、`required_models=[name]` 的單 | 200 `{"job_id": 既有, "reused": true}` |
| 4 | 名稱已在簽章 manifest（`model_manifest.entries()`，curated／已學雜湊／peer-only） | 用該項目（已驗證，含 sha256）當 `fetch_entry` |
| 5 | 否則 url 必須以 `https://huggingface.co/` 或 `https://civitai.com/` 開頭（大小寫不敏感比對 origin） | 否則 400 `model_fetch.untrusted_url` |
| 6 | HEAD url（follow redirects，10 秒）：401/403 → 400 `model_fetch.gated`「此模型為受限模型，需登入來源網站，無法由 worker 自動下載」；其他非 2xx／逾時／無 `Content-Length` → 400 `model_fetch.size_unknown` | 取 `size_bytes` |
| 7 | 沒有任何 online、enabled、`auto_fetch`、protocol ≥ 5、`max_fetch_gb ≥ size`、`free_disk_gb > 1.2×size` 的 worker | 400 `model_fetch.no_worker`，message 列出原因（沿用 `assess` 的 reason 字串） |
| 8 | 通過 | 建單，201 `{"job_id": id, "reused": false}` |

第 4 步命中時第 7 步的 protocol 門檻沿用既有（≥3；peer-only ≥4）。

錯誤 body 形狀：`{"error": <code>, "message": <zh-TW / English>}`，與 `jobs.py` 的 `_error` 一致。

### 5.2 `GET /comfy/api/comfyfed/model-fetch/{job_id}`

任何登入使用者可讀（單子本身不含機密）。回 `{"job_id", "status", "stage": "fetching_models"|null, "fetch_pct": float|null, "fetch_model": str|null, "worker_id", "error", "name"}`。`stage/fetch_pct` 來自既有的 fetch progress 快取（`agentws._fetch_progress` / hub `fetchProgress`）。404 若不存在或 `kind != model_fetch`。

## 6. 簽章項目（fetch_entry）

兩種形狀，agent 以 `unverified` 欄位區分：

- 已驗證（既有）：`{name, directory, url, backup_url, sha256, size_bytes, peer?, sig}`，`sig` = Ed25519 over `f"{name}|{directory}|{sha256}|{size_bytes}"`。
- **未驗證來源（新）**：`{name, directory, url, backup_url: null, sha256: null, size_bytes, unverified: true, sig}`，`sig` = Ed25519 over `f"{name}|{directory}|{url}|{size_bytes}|unverified"`。

url 進簽章：未驗證項目的信任來源就是「平台核可了這個 url」，所以 url 不可被中途替換。舊 agent（protocol ≤ 4）拿到未驗證項目會因 `_validate_entry_shape` 拒收（sha256 為 null），不會誤抓——但派工端本來就不會派給它（§7）。

## 7. 派工

- 兩棧 dispatch tick 建 `fetchable_models` / `manifest_by_name` 時，**額外**把每張 queued `model_fetch` job 的 `fetch_entry` 合併進去：真 manifest 已有同名 → 真 manifest 優先（已驗證項目永遠贏）；否則用 job 的項目。`unverified_models` 集合（新）比照 `peer_only_models` 傳進 `assess.verdict` / `partition_fleet_fetchable`，對含未驗證項目的候選加一道 `protocol ≥ 5` 門檻（常數 `_MIN_UNVERIFIED_FETCH_PROTOCOL = 5`，cloud 同名）。
- `model_fetch` job 走既有 `assess.verdict`：`required_models=[name]`、無 nodes、無 VRAM 估計，所以某 worker 已有該模型 → `eligible`（push 不帶 `fetch_models`，agent 直接 done）；全缺 → `eligible_after_fetch`（push 帶 `fetch_models=[entry]`）。
- push frame 多帶 `"kind": "model_fetch"`（`prompt` 單不帶，舊 agent 忽略未知欄位）。
- 輕量任務規則（零模型單優先 cpu/mps）不適用：此單有 `required_models`。

## 8. Agent（0.1.14，hello `protocol: 5`）

- `fetcher._validate_entry_shape`：`unverified is True` 時允許 `sha256=None`，`size_bytes` 仍必須為正整數。
- `fetcher._verify_entry_signature`：`unverified` 用 §6 的新 payload。
- `fetcher._download_one`：未驗證項目**不比對 sha256、必須比對 size_bytes**，不嘗試 peer、不嘗試 backup；回傳實際 digest。`fetch_and_verify_models` 回傳 `list[{name, directory, size_bytes, sha256}]`（每個項目一筆；已驗證項目回它驗過的 sha256）。既有呼叫端忽略回傳值即可。
- `runner.handle_job`：`job_msg.get("kind") == "model_fetch"` 時，fetch 階段結束（或根本沒有 `fetch_models`）後**不執行 workflow**，`refresh_model_inventory` 後直接 `job_done`，`exec_seconds=0`、`result_files=[]`，多帶 `"fetched_models": [...]`。心跳規則不變：整段 fetch 都帶 `stage=fetching_models`，`started_at` 永不設 → 永不計費。
- `auto_fetch_models=false` 卻收到 → 既有禮貌 `job_failed`。取消 → 既有流程刪 `.part`。

## 9. 伺服器收 job_done（兩棧）

- `fetched_models` 每筆：`name` 必須在 job 的 `required_models`、`sha256` 為 64 hex、`size_bytes` 正整數 → `model_manifest.record_hash(worker_id, name, size_bytes, sha256, chunk_sha256s=None)`；形狀不對的筆數丟棄並 warning。只有 `kind=model_fetch` 且 transition 真的套用（worker 擁有該單）才學。
- 收據：`kind=model_fetch` → `kind="model_fetch"`, `billable=False`, `basis="model_fetch"`, `gpu_seconds=0`；不進 `_record_job_stats` / `stats.recordCompletion`（signature 為 NULL）。
- 面板 WS：`model_fetch` 單不發 `executed` 事件（沒有輸出節點）；`fetching_models` 進度事件沿用既有推播（panel 的 prompt_id 對映不存在時本就靜默）。

## 10. 面板擴充（`panel_ext/comfyfed.js` ＋ `core/comfyfed_ext.ts` byte parity）

- `document.addEventListener("click", handler, true)`（capture）：目標命中 `[data-testid="missing-model-download"]` 或 `[data-testid="missing-model-actions"] button` 時 `preventDefault()`＋`stopImmediatePropagation()`。
- 解析模型：從 `window.app.graph` 遞迴收集所有節點（含 subgraph）`properties.models[]` 的 `{name, url, directory}`；單鈕用其 `aria-label` 含哪個 `name` 來配對（i18n 字串為「下載 {model}」／「Download {model}」，`name` 為子字串），配不到 → 顯示「無法辨識模型」；全部下載 = 對每個「缺少」的項目逐一 POST（缺少集合＝卡片上所有帶下載鈕的列）。
- POST 成功 → 鈕文字改「下載中 0%」、`disabled`；每 2 秒 GET 狀態更新百分比；`done` → 鈕改「已就緒」並在頁面頂端顯示橫幅「模型 {name} 已下載到 worker，請重新整理以載入」＋「重新整理」鈕（沿用既有 no-workers banner 的樣式）；`failed/cancelled` → 鈕還原、顯示錯誤（用既有 Errors 面板不可行，直接用同一橫幅樣式顯示紅字）。
- 400 → 鈕還原、橫幅顯示 `message`。
- 所有字串 zh-TW 先、en 後（house style）。

## 11. Console（web）

- Jobs 列表：`kind=model_fetch` 顯示標籤「模型下載 / Model fetch」，不顯示 VRAM 欄；`JobDetail`：顯示模型名、directory、來源 url、是否 `unverified`、完成後的 sha256（從 job 的 `fetch_entry` 與收據）。
- `/api/jobs` 回傳多帶 `kind`、`fetch_entry`（既有 `_job_dict` / cloud `jobRow`）。
- i18n `zh-TW.json` / `en.json` 兩份鍵對齊。

## 12. 測試

- server pytest：`test_comfyapi.py` 新增 §5.1 每個分支（bad_request、already_present、reused、manifest hit、untrusted_url、gated、size_unknown、no_worker、201）與 §5.2；`test_agent_ws.py`：model_fetch 單的 push 帶 `kind`＋未驗證 `fetch_models`、job_done 學雜湊、非計費收據；`test_model_manifest.py`：未驗證簽章 payload；`test_assess.py`：`unverified_models` 的 protocol 5 門檻；`test_dispatch.py`：真 manifest 優先於 job 項目。
- agent pytest：`test_fetcher.py` 未驗證項目 size 檢查／sha 回報／不比對 sha／不試 peer；`test_runner.py` model_fetch 不跑 workflow、job_done 帶 `fetched_models`。
- cloud vitest：對應每一項（`comfyapi.spec.ts`、`hub.spec.ts`、`model_manifest.spec.ts`、`assess.spec.ts`、`dispatch.spec.ts`、`comfyfed-ext.spec.ts` parity）。
- web vitest：Jobs／JobDetail 的 kind 呈現。
- e2e（`tests/test_e2e_panel.py`）：假 agent 收到 `kind=model_fetch` push → 回 `job_done` 帶 `fetched_models` → `GET model-fetch/{id}` 為 done → receipts 出現 `model_fetch` 非計費 → `model_hashes` 有該雜湊。
- live：對 `https://comfyfed-cloud.aiinpocket.com` 的面板，用預設 z_image_turbo 工作流按 `ae.safetensors` 的下載鈕（約 335 MB），觀察本機 agent 下載→done→重新整理後模型出現。

## 13. 發版

- agent 0.1.14（`agent/comfyfed_agent/__init__.py`＋根 `pyproject.toml`）；`python -m build --wheel`；cloud 以 `POST /api/workers/agent-release` 發佈（需 admin session）；本機 agent 啟動時自更新（或手動重啟觸發）。
- cloud 走 Cloudflare Workers Builds：push `main` 即部署；D1 migration `0011` 需 `wrangler d1 migrations apply --remote`（或既有的部署後 apply 慣例）。
- `docs/SELF-HOSTING.zh.md` / `.en.md`：新增「面板下載鈕」一節說明行為、白名單、protocol 5 門檻。
