# ComfyFed Phase 1.5 — 內嵌 ComfyUI 工作流編輯器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** 使用者不需自備 ComfyUI 即可在平台網頁上以官方 ComfyUI 前端拉工作流，按 Queue 直接派入聯邦。

**Architecture:** Agent 回傳完整 `/object_info`（簽名 POST、gzip、hash 去重）→ 平台存檔並合成**在線 worker 聯集**；平台在 `/comfy/api/*` 實作 ComfyUI 相容 API（prompt/queue/history/view/upload/ws），把官方前端的每個動作映射到聯邦 job 生命週期；官方前端靜態包 pinned 下載、serve 於 `/comfy`（admin session 保護）。

**Spec:** `docs/superpowers/specs/2026-09-12-comfyfed-spec.md`（§9 Phase 1.5）

**參考實作（本機就有，讀它對齊 API 形狀）：** `D:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\server.py`（真 ComfyUI 的路由與 WS 訊息格式權威來源）；前端包：pypi `comfyui-frontend-package` 或 GitHub Comfy-Org/ComfyUI_frontend releases。

## Global Constraints
- 承 Phase 1 全部：錯誤 envelope、雙語 i18n、conventional commits＋`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`、pytest+vitest 全綠才 commit。
- ComfyUI 相容層路徑一律 `/comfy/api/...`，不得與既有 `/api/...` 衝突；`/comfy` 全域需 admin session（未登入 302 到 `/`）。
- Worker object_info 檔存 `data/object_info/<worker_id>.json.gz`，DB 僅存 hash（`Worker.object_info_hash` 新欄位，Alembic migration）。

### Task 1: Agent 完整 object_info 回報＋平台儲存
- agent runner：hello 後與每 10 分鐘，取本機 `GET /object_info` 全文 → sha256 → 若與上次不同：gzip 後簽名 `POST /api/agent/object_info`（body=gzip bytes，header `X-OI-Hash`）；平台驗簽（verify_agent）存檔＋更新 `Worker.object_info_hash`。心跳夾 `object_info_hash` 供平台偵測漂移（平台 hash 不符時在 WS 回 `{"type":"want_object_info"}` 觸發重傳）。
- Migration：`Worker.object_info_hash: str default ''`。
- 測試：mock comfy object_info → agent 上傳一次、hash 未變不重傳、變更後重傳；平台落檔正確、簽名必要。

### Task 2: ComfyUI 相容 API 核心（object_info 聯集、prompt→job、queue/history/view）
- 新 `server/comfyfed_server/comfyapi.py` router（prefix `/comfy/api`，全部 require_admin session）：
  - `GET /comfy/api/object_info`：讀所有**在線且未停用** worker 的 object_info 檔 → dict 聯集（同名 node 以任一為準，記錄來源 worker 數）；無在線 worker → 空 dict＋header `X-ComfyFed-No-Workers: 1`。
  - `POST /comfy/api/prompt` `{prompt, client_id?}`：прompt=workflow dict → 走既有 jobs 建立流程（assess.extract、input_assets 需已在 staging，見 Task 3 upload）→ 回 `{prompt_id: job_id, number: 佇列位置, node_errors: {}}`。
  - `GET /comfy/api/queue`：ComfyUI 格式 `{queue_running: [...], queue_pending: [...]}`（由 jobs status 映射，條目形狀對齊 server.py）。
  - `GET /comfy/api/history` 與 `GET /comfy/api/history/{prompt_id}`：done/failed jobs → ComfyUI history 形狀（`{prompt: [...], outputs: {node_id: {images: [{filename, subfolder:"", type:"output"}]}}, status: {...}}`；outputs 的 node_id 可用 SaveImage 節點 id 或固定 "save"——對齊前端讀法，以 server.py 為準）。
  - `GET /comfy/api/view?filename=&type=&subfolder=`：type=output → 從該 job artifacts serve（filename 需屬於某 done job 的 result_files；用 filename→job 索引）；type=input → staging 檔。
  - 測試：object_info 聯集（兩 worker 不同節點集）；prompt 建 job；queue/history 形狀含必要鍵；view 授權與 404。
### Task 3: 上傳與 WS 進度轉發
- `POST /comfy/api/upload/image`（multipart `image`，overwrite）→ 存 staging `data/comfy_staging/<session 無關，直接檔名>`（sanitize；同名覆寫）→ 回 `{name, subfolder:"", type:"input"}`；Task 2 的 prompt 建 job 時，workflow 引用的 LoadImage 檔名從 staging 複製為該 job 的 input_assets（複製非搬移）。
- `GET /comfy/api/ws?clientId=`：WS（session cookie 驗證）；平台把聯邦 job 進度轉成 ComfyUI 訊息流：job assigned/running → `{"type":"status","data":{"status":{"exec_info":{"queue_remaining":N}}}}`＋`{"type":"progress","data":{"value":int(progress*100),"max":100,"prompt_id":job_id}}`（來源＝agent 心跳），done → `{"type":"executed","data":{"prompt_id":job_id,"output":{...同 history outputs...}}}`＋`{"type":"executing","data":{"node":null,"prompt_id":job_id}}`。訊息形狀以 server.py 為準。
- 測試：upload 落 staging＋prompt 引用成功；WS 收到 progress 與 executed（模擬 job 生命週期）。

### Task 4: 前端掛載、fetch-comfy-ui、Console 整合、e2e、docs
- `comfyfed-server fetch-comfy-ui [--version pinned]`：從 pypi `comfyui-frontend-package`（pinned 版本常數＋SHA256 常數）下載 wheel → 解出 `comfyui_frontend_package/static/` → 放 `data/comfy_frontend/`；已存在則 no-op；雙語輸出。
- app.py：`/comfy` StaticFiles(html=True) 掛 `data/comfy_frontend`（缺→ `/comfy` 回雙語提示頁「請先執行 fetch-comfy-ui」）；admin session gate（middleware 或 dependency；未登入 302 `/`）。
- Console Jobs 頁：主 CTA「開啟工作流編輯器」（新分頁 `/comfy`），貼 JSON 收進「進階」摺疊；i18n 兩語系；vitest key parity 照舊。
- e2e：mock worker（沿用既有 e2e 模式）→ 上傳 object_info → `/comfy/api/object_info` 有節點 → `/comfy/api/prompt` → dispatch → job_done → `/comfy/api/history/{id}` outputs 含檔名 → `/comfy/api/view` 拿得到 bytes。
- README：新章節（兩語）——內嵌編輯器怎麼開、fetch-comfy-ui、與自備 ComfyUI 的關係。

## Self-Review
- 覆蓋 spec §Phase 1.5 全點：官方前端 pinned 下載（T4）、admin 保護（T4）、object_info 聯集與 agent 全量回報（T1/T2）、prompt→job（T2）、upload→附檔管線（T3）、WS 進度（T3）、Console 整合（T4）。
- 風險：前端相容細節（訊息形狀）——已指定以本機真 ComfyUI server.py 為權威對齊來源；e2e 兜底。

### Task 5: 收據計費修正——實際執行秒數（使用者定案 2026-09-12）
- agent comfy.run_workflow：偵測 prompt 進入 /queue queue_running 的時刻（首次出現）與完成時刻，回傳 exec_seconds；runner job_done 訊息夾 `exec_seconds`。
- server agentws job_done 處理：receipt gpu_seconds = min(exec_seconds, (finished_at-started_at) 牆鐘)（exec 缺失→牆鐘 fallback＋log）；收據 payload 格式不變。
- 測試：mock comfy 佇列先 pending 再 running（模擬前面有別的工作）→ exec_seconds 顯著小於牆鐘且 receipt 用 exec；缺 exec_seconds fallback。README 已知限制段更新（兩語）。

### Task 6: 結果檔雜湊驗證＋worker 端任務檔案清除（使用者定案 2026-09-12）
- agent 上傳 artifact 時附 X-Artifact-SHA256（檔案 sha256 hex）；平台重算比對，不符→400 artifact.hash_mismatch；回應 {"stored","sha256"}；平台以新 migration `Job.result_hashes: str='{}'`（JSON {filename: sha256}）存雜湊並在 GET /api/jobs/{id} 露出。agent 比對回應雜湊==本地雜湊才視為上傳成功；不符或 400 重試一次，仍失敗→job_failed("artifact upload failed")。
- agent 清除：job 結束（成功或失敗）後一律刪除本次 job 的 agent 端暫存（下載的 input assets 副本、/view 拉回的輸出副本）；AgentConfig 新增選填 `comfy_output_dir: str|None`、`comfy_input_dir: str|None`（load/save），有設定時：成功且雜湊確認後，刪 ComfyUI output 目錄中本次 job 的輸出檔（依 history 的 filename/subfolder 組路徑，只刪確認存在且屬於本次的檔）與 input 目錄中本次上傳的 asset 檔；未設定→略過並 log。清除動作 defensive try/except，絕不因清除失敗影響 job_done 回報。
- 測試：上傳附錯 hash→400 且 agent 重試；正確流程 result_hashes 落庫＋回應 hash；agent 暫存清除（mock 檔案存在→job 後不存在）；comfy_output_dir 設定時對應檔被刪、未設定時不動。README 兩語：磁碟清理段。
- Spec §7 worker 端執行 bullet 同步補述。
