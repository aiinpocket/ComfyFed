# ComfyFed 系統規格書

**日期**：2026-09-12
**狀態**：已定案（與使用者逐項確認）
**定位**：開源的 ComfyUI 分散式渲染聯邦平台——「熟人圈算力共享」：一個管理平台（Console）派工給多台 Worker；一台 Worker 可同時效力於多個平台，主人自主決定借給誰。

## 1. 核心概念

| 術語 | 定義 |
|---|---|
| Platform（平台） | 管理端：任務佇列、派工、帳本、Web UI。不需要 GPU。 |
| Worker | 有 GPU 的機器，跑一個輕量 Agent，包住本機 ComfyUI 的 API。 |
| Identity Bundle（識別碼） | 平台簽發的 JSON：`{platform_url, platform_pubkey, register_token}`。register_token 一次性。 |
| Job | 一份 ComfyUI workflow JSON ＋參數，整包在單一 worker 上執行。 |
| Receipt（收據） | 任務完成後雙方簽章的憑證（誰、何時、幾 GPU 秒），分潤與問責的地基。**GPU 秒＝實際執行秒數（2026-09-12 使用者定案）**：agent 量測自己的 prompt 在本機 ComfyUI `queue_running` 中的實際執行區間，`job_done` 回報 `exec_seconds`；平台取 `min(exec_seconds, 派工至完成牆鐘)` 入帳。**排隊等待、本地任務、其他平台的工作一律不計**——一台 worker 多平台共享時，busy 牆鐘計費會把等待時間重複算給每個平台，分潤必錯。 |

## 2. 信任模型（定案）

- **熟人圈邀請制**：worker 只認手動發放識別碼的平台；無公開註冊。
- 技術手段保證「任務未被篡改、來源可追責」；社會手段（熟人圈）保證「任務善意」。
- Workflow ＝可執行內容 ⇒ Agent 端強制 **node policy**：`installed`（預設，允許本機 ComfyUI 實際安裝的所有節點——來源為本機 `/object_info`，主人裝了什麼就信什麼）／`official_only`（保守模式）／自訂清單。拒絕含 policy 外節點的 workflow。
- Worker 主權：可一鍵停用某平台、設資源上限、審閱歷史任務（本地保留 workflow＋prompt＋平台簽名）。

## 3. 網路與部署（定案）

- 平台可用 **固定 IP 或 DDNS**（兩者皆支援）：平台只需在安裝時記錄自己的公開 URL（`platform_url` 設定，之後可在 UI 修改）；識別碼裡帶這個 URL。
- **連線方向一律 worker → platform**（outbound WebSocket），家用 NAT 免設定。平台永不主動連 worker。
- 傳輸層 TLS（生產環境擺在反向代理後面，如 Caddy/nginx；開發環境允許 http）。

## 4. 安全（定案）

### 4.1 平台 Web 端
- **安裝時隨機產生 admin 密碼**（`secrets.token_urlsafe`，一次性顯示於安裝導引），**無任何固定預設帳密**；首次登入後可在 UI 變更。密碼以 argon2 雜湊存放。
- Session cookie（HttpOnly、SameSite=Lax、簽名）；登入失敗指數退避（防爆破）；所有變更操作走 POST＋CSRF token。原則：「足夠但不造成使用者困擾」——單一管理員密碼登入即可，不搞 2FA/複雜 RBAC（開源使用者自架，KISS）。

### 4.2 平台 ↔ Worker
- 安裝時平台產生 **Ed25519 平台金鑰對**。
- Worker 首次執行：自產 Ed25519 金鑰對 → 用一次性 token 註冊 → 交換公鑰（雙方 key pinning）→ token 作廢 → 平台回發簽名的成員憑證。
- 之後所有 HTTP 請求由 worker 簽名（headers: worker-id, timestamp, nonce, ed25519 signature over method+path+body；時間窗±120s＋nonce 防重放）；WebSocket 在握手時做挑戰簽名認證，通過後通道視為可信。
- 收據（receipt）獨立簽章存底（傳輸信任≠存證信任）。

## 5. 資料庫（定案）

**SQLite**（單檔、隨平台安裝零設定）。WAL 模式。SQLAlchemy 2.x ORM。
主要表：`settings`（含 admin 密碼雜湊、平台金鑰、platform_url、語言預設）、`workers`、`register_tokens`、`jobs`、`job_events`、`receipts`、`login_attempts`。

## 6. 介面（定案）

- **前端：React SPA**（Vite + TypeScript），平台 FastAPI 直接 serve 打包後的靜態檔。
- **i18n：繁體中文＋英文**，含 Web UI 與安裝導引（CLI 安裝精靈第一步選語言，之後訊息雙語擇一顯示；UI 右上角可切換，偏好存 localStorage＋settings 預設）。react-i18next；後端 CLI 用簡單字典。
- 頁面：登入、儀表板（worker 清單＋狀態＋進度、任務佇列）、任務送出（上傳/貼上 workflow JSON＋參數）、Worker 管理（新增→下載識別碼、停用）、貢獻報表（時間區間篩選）、設定（platform_url、改密碼、語言）。
- 任務進度：worker 心跳夾 `{state, progress%, current_job}`（30 秒），平台 UI 即時顯示；無法取得精確百分比時以「已完成鏡數＋當前耗時/平均耗時」估算——與已驗證的監控邏輯一致。

## 7. 任務生命週期（定案）

```
queued → assigned → running → done
                  ↘ failed（可重試）
worker 斷線（>90s 無心跳）→ assigned/running 的任務自動回 queued 重派其他活 worker
```
- 派工：平台推給「online 且 idle **且能力符合**」的 worker（WS push）；worker 接單後對**其他已註冊平台**廣播 busy。
- **硬體與能力回報（定案，2026-09-12 架構審查後擴充）**：worker 上線握手時回報——硬體檔案（GPU 型號、VRAM 總量、CPU 型號/核心數、RAM 總量、模型目錄磁碟可用空間、agent 版本）＋**運算後端（cuda/rocm/mps/cpu）與 torch 版本**＋**已安裝節點類別清單**（取自本機 ComfyUI `/object_info`，即 custom nodes 的真實庫存）；心跳夾動態值（VRAM/RAM/磁碟可用量）。
- **自動任務評估引擎（定案）**：需求**由平台從 workflow 自動推導**，不依賴使用者手填（可進階覆寫，但預設全自動——使用者多非 IT 背景）：
  - 解析 workflow → ①node class 集合 ②**引用的模型檔清單**（掃描 loader 節點的 ckpt_name/unet_name/clip_name/vae_name/lora_name 等欄位——LoRA 與 checkpoint 同級對待，皆入庫存/判定/分發）③**VRAM 粗估**（最大單一引用模型×1.15──ComfyUI 順序載入/卸載，峰值由最大模型主導；聯邦庫存查大小）。**此估值不是硬門檻（定案，2026-09-12 實機驗證後修正）**：ComfyUI 放不進 VRAM 時會把權重卸載到系統 RAM 串流執行，慢但跑得動（實測 15.9GB 顯卡跑得動 22GB 的 flux 與 33B 影片模型），因此比較對象是 **VRAM＋系統 RAM**；估值超過 VRAM 但塞得進 VRAM＋RAM 時仍判 `eligible`，只附一則非阻斷警告 `vram_offload:<估值>><VRAM>`。④**輸入素材清單**（LoadImage/LoadImageMask 等節點的 image/audio/video 欄位——如角色固定形象參考圖）
  - **任務輸入素材隨任務走（定案，2026-09-12）**：模型靠庫存/分發，但參考圖等輸入素材是任務私有的——送任務時平台自動偵測 workflow 引用的輸入檔並要求附檔（multipart 上傳，存 `data/job_inputs/<job_id>/`）；agent 領工後以簽名請求下載附檔、POST 本機 ComfyUI `/upload/image` 放進 input 目錄，再送 `/prompt`。缺附檔的任務在送出前就被 UI 擋下，不會派出去才失敗。
  - worker 心跳夾**本地模型庫存**（檔名＋大小；雜湊 Phase 2 補），平台隨時知道誰有什麼
  - 每個 worker 對每個 job 得出三態判定：
    - `eligible`——節點✓ backend✓ VRAM✓ 模型全有 → 直接派
    - `eligible_after_fetch`——**只缺模型**且聯邦內其他成員有、且磁碟裝得下 → 可派（先補模型再開工：Phase 2 平台中繼、Phase 3 P2P；Phase 1 此類顯示「僅缺模型，待模型分發功能開通」）
    - `ineligible(reasons)`——缺節點安裝／backend 不符／**權重連 VRAM＋系統 RAM 都放不下**等**硬缺口** → 不派，UI 明列原因（「worker-A 缺 IPAdapter 節點」「worker-B 估需 40GB，VRAM 8GB＋RAM 16GB 放不下」）。VRAM 單獨不足**不再**列為硬缺口，改走上述 `vram_offload` 警告；`min_vram_gb` 進階覆寫仍是硬條件。
  - 派工優先序：eligible ＞ eligible_after_fetch（省頻寬）；全部 ineligible 才留佇列＋標示原因。
- Worker 端執行：收 job → 白名單檢查 → POST 本機 ComfyUI `/prompt` → 輪詢 history/進度 → 上傳產物（圖/影片，附 `X-Artifact-SHA256` 供平台驗雜湊，不符或被拒重試一次）→ 回報完成 → 雙方簽收據 → 清除本次 job 的檔案（成功且雜湊確認後，另刪已設定的 ComfyUI input/output 目錄中的本次任務檔，避免 worker 磁碟被塞滿）。

## 8. 模型分發（Phase 2+，方向已定案）

- 平台簽名的**雜湊清單（manifest）**：`{檔名, SHA256, 分塊雜湊(64MB), 大小, 來源}`；worker 只認清單不認連結，逐塊驗證。
- **P2P 限聯邦成員**：心跳夾本地模型庫存 → 平台當 tracker；worker 憑註冊金鑰互認直連（HTTP Range 分塊互拉為 MVP；NAT 打洞／平台中繼為 fallback）；上傳頻寬計入收據帳本。

## 9. 分階段

- **Phase 1（本計畫）**：平台核心＋Agent 核心端到端可用——安裝→登入→發識別碼→worker 註冊上線→送 workflow→派工執行→結果回傳→收據入帳→儀表板可視。
- **Phase 1.5（2026-09-12 使用者定案提前）：內嵌 ComfyUI 工作流編輯器**——「要使用者自己在別處做好 workflow 再貼 JSON」對非 IT 使用者不可用。平台內嵌**官方 ComfyUI 前端**（comfyui-frontend-package 靜態包，pinned 版本＋SHA256，`comfyfed-server fetch-comfy-ui` 下載）於 `/comfy`（admin session 保護），平台實作 ComfyUI 相容 API（`/comfy/api/*`）：`object_info`=**在線 worker 能力聯集**（agent 以簽名請求回傳完整 /object_info JSON，gzip＋hash 去重，存平台檔案系統）、`prompt`→聯邦 job、`queue`/`history`/`view`→佇列與 artifacts 映射、`upload/image`→任務附檔管線、WS 進度轉發。Console 任務頁保留貼 JSON 作為進階路徑，主按鈕改為開啟編輯器。
- **Phase 2**：模型 manifest＋自動下載（**已於 Phase 2.1 實作**：worker 惰性回報模型 SHA-256（sidecar 快取），平台以「全體回報者一致」共識學得雜湊（衝突永久標記 `model_hashes.conflict` 並排除），與 model_guide 來源合成**平台簽章的 fetch manifest**（`name|directory|sha256|size_bytes` Ed25519 簽章、URL 刻意不入簽——以雜湊釘住內容）；`eligible_after_fetch` 成為真判定（protocol 3＋worker 端 `auto_fetch_models` 選擇性開啟＋磁碟餘裕 1.2×）；派工第二層：無直接合格者時挑最小下載量的自動抓取 worker，job push 內嵌 fetch_models；agent 驗簽→官方載點（跟隨轉址）→GCS 備援→逐位元組 SHA-256 驗證→原子落地→立即重掃回報→續跑；下載期間 stage=fetching_models 貫穿所有心跳，started_at 不設——**下載時間永不計費**；console/面板顯示下載進度。雲端版完整對等。中繼下載不再需要——直連原始來源即可）；`/object_info` 能力交集模式（保守選項，**已於 Phase 1.9 提前實作** `auth`/`comfyapi` 的 `object_info_mode: union|intersection`）。
- **Phase 3**：成員間 P2P 分塊傳輸；貢獻報表進階（分潤試算）；多管理員。（**多使用者帳號系統／多管理員／分潤試算已於 Phase 3.0 實作**，見下方「Phase 3.0 addendum」：admin 建立與管理其他使用者帳號、一般使用者只看自己的 job／artifacts、`/comfy` 面板改為任何角色都能用的個人工作區、Reports 新增「使用者用量」與「分潤試算」（依 worker GPU 秒數比例試算分潤，未落地實際撥款）、既有安裝升級時原 admin 沿用同一組密碼但全員需重新登入一次、cloud 端 D1 migration 0006 對等實作。**成員間 P2P 分塊傳輸另立 Phase 3.1，已於 2026-09-14 實作**，見下方「Phase 3.1 addendum」：worker 間 HTTP Range 分塊互拉（64 MiB、逐塊驗證、`.part` 斷點續傳）、來源優先序 P2P 種子→官方載點→GCS 備援、無官方 URL 的私有模型在有在線種子時也能派工、平台簽發 Ed25519 傳輸憑證（10 分鐘效期、綁定單一檔案＋拉方＋種子、種子端 fail-closed 逐請求驗證、worker 間不互留常駐信任）、上傳頻寬入收據帳本（`p2p_upload`、不計費）、Worker 頁顯示分享狀態、Reports 新增 P2P 上傳量欄、cloud 端 D1 migration 0007 對等實作。**至此 Phase 3 全部項目皆已出貨。**「零持有者自動下載」另立 Phase 3.2，已於 2026-09-14 實作，見下方「Phase 3.2 addendum」：curated 11 個模型的 `ModelSource` 補上平台維運者背書的 sha256／size_bytes，manifest 合成在無共識列時改以 guide 雜湊簽發條目（共識一旦出現永遠優先）、送單放行的缺模型 400 只在 manifest 仍無法讓模型可取得時觸發，讓這些模型即使全聯邦零持有也能直接排隊自動下載，cloud 端 model_guide.ts 對等鏡像同值。）
- **Phase 1.9（backlog zero，2026-09-13）**：job origin 欄位＋範圍限定（面板原生控制只動面板自己送的工作）；面板任務歷史可刪除；node_errors 前端引導文案；隱藏面板內失效的 Comfy-cloud 登入按鈕；失敗／取消任務不計費（收據 0）；agent 通訊協定升級到 v2；派工優先序偏好弱 GPU／Mac 之類的機器優先接零模型需求的工作，把重活留給有模型的機器；範本快取與下載上限；一個間歇性 flake 已根治（非重跑掩蓋）；console 新增任務詳情頁（完整錯誤引導＋artifacts）；專案採用 AGPL-3.0 授權。
- **ComfyFed Cloud（2026-09-12 提出，Phase 2.0 已上線）**——平台端的 Cloudflare Workers＋D1＋R2 免自架部署形態：D1=SQLite（schema 近乎原樣）、R2=ArtifactStore 的 S3 介面（presigned 直傳、零出口費）、agent 長連 WS 由 Durable Objects（hibernation）承接、派工迴圈為 DO alarms、Ed25519 驗簽走 WebCrypto。`cloud/` 目錄的 TypeScript Workers 實作已完成並部署在 workers.dev 網域上，見 `cloud/README.md`。定位：**自架 Python 版仍是本體**（內網/離線場景＋資料自主），Cloud 版是第二部署形態；現有架構決策（outbound-only WS、S3 介面、簽章收據）已刻意為此保留可移植性。

## 9.5 架構審查補強（2026-09-12 定案，全部納入 Phase 1）

1. **維運監控**：平台暴露 `/metrics`（Prometheus 格式，prometheus-client）：worker up/狀態 gauge、動態 VRAM/RAM/磁碟 gauge、佇列深度、任務等待與執行時間 histogram、WS 重連計數——可直接接 Prometheus/Grafana 做長期效能追蹤。
2. **資料庫遷移**：Phase 1 即導入 **Alembic**；`init_db` 一律跑 `alembic upgrade head`（不是 create_all），schema 變更全走遷移腳本＋預設值——開源使用者自架升級不炸庫。
3. **產物儲存抽象**：`ArtifactStore` 介面（`put/get/url`），Phase 1 內建 `LocalStore`（存平台磁碟）；介面預留 `S3Store`（presigned URL 直傳，worker 大檔不過平台）——設定檔切換，Phase 2 實作 S3。
4. **Agent 自動更新**：平台提供 `GET /api/agent/version` → `{latest, min_supported, wheel_url, sha256, platform_sig}`；agent 啟動時比對版本——低於 min_supported 拒跑並提示、有新版依設定 `auto_update: true|false`（預設 true）下載 wheel→驗 SHA256＋平台簽章→pip 安裝→自我重啟。更新包必簽名，杜絕「平台被打穿後推毒更新」的單點（簽章私鑰離線保存選項寫入文件）。

## 10. 技術棧（定案）

- 平台：Python 3.12、FastAPI、SQLAlchemy 2、uvicorn、PyNaCl（Ed25519）、argon2-cffi、pytest
- Agent：Python 3.12 單套件（同 repo `agent/`）、httpx、websockets、PyNaCl
- 前端：React 18 + TypeScript + Vite + react-i18next（元件庫用 Mantine）
- Repo：單一 monorepo `ComfyFed/`，`server/`＋`agent/`＋`web/`

---

## Phase 1.6 addendum: official template library + missing-model guidance (2026-09-13)

User directives: (1) 官方範本要引入，但保留 ComfyFed 平台專用分類；(2) 審視原生 ComfyUI 介面中在聯邦架構下不適用的項目，拿掉或遮蔽——特別是缺模型時的「直接下載」（網頁模式下那只是瀏覽器端 `<a href>` 下載到看網頁的電腦，模型根本到不了 worker）；改為提示「因缺少 XX 模型無法執行」並提供下載連結與引導；(3) 模型鏡像從 R2 改回 GCS（bucket `comfyfed-models`，公開讀取），提示一律「官方載點（原始來源）＋備份載點（GCS）」雙連結以降低我方流量費。

Decisions of record:
- Official templates come from the PyPI `comfyui-workflow-templates` split packages (`-json` + `-media-*`; `-core` skipped), fetched by a new `fetch-comfy-templates` CLI into `data/comfy_templates_official/`, merged after ComfyFed's own categories in the served `/comfy/templates/index*.json`.
- Served official workflow JSONs get `models[].url/hash/hash_type` stripped server-side (frontend's Download button requires url+directory) — the frontend bundle itself is never patched.
- Guidance lives in a POST /prompt 400 (`prompt.missing_models`) raised when a model is missing fleet-wide — `comfyapi.missing_models_and_nodes` checks every *registered* worker's reported inventory, whatever its `status` and whether or not it is disabled (a sleeping or temporarily-disabled machine still vouches for its inventory; only a model absent from the whole fleet is a real dead end), not just workers currently online: per-model zh-TW block with 放置路徑 models/<dir>/、官方載點（flux/ae 加註需登入 HuggingFace 同意授權）、備份載點（GCS）、「10 分鐘自動掃描、不需重啟」. Zero registered workers → unchanged queueing behavior.
- Panel WS sends explicit `feature_flags` all-false (assets, node_replacements, show_signin_button, extension.manager.supports_v4/.supports_csrf_post) so Manager/Asset-Browser/sign-in UI stays dormant; incoming client feature_flags frames are consumed silently. `GET /api/folder_paths` stubbed `{}`.
- R2 (the former model-mirror custom domain) is decommissioned: worker, custom domain, bucket contents deleted 2026-09-13. Canonical mirror base: `https://storage.googleapis.com/comfyfed-models/models/`.

---

## Phase 1.7 addendum: job lifecycle & dispatch strategy (2026-09-13)

User directives: (1) 分派策略要認真設計——worker 怎麼知道哪些任務能拉？（答：維持 server 端全局能力匹配，worker 不自選；改善的是排序）；(2) 拉取後斷線→重派→原 worker 回來回報完成的處理；(3) 更好的是回報時 server 告知任務已取消，worker 立即中止並刪除本次任務檔案，省下白跑的時間。

Decisions of record:
- `cancelled` becomes a terminal job status; cancelled jobs never produce receipts (bill 0).
- Server pushes `{"type":"job_cancelled","job_id"}` (dedup per connection) whenever an authenticated agent references a job it no longer owns — busy heartbeat, progress, job_done/job_failed, artifact upload. Busy heartbeats carry job_id every 30s, so a zombied worker learns within one heartbeat.
- Blip re-adoption: `Job.last_worker_id` (migration #5) records who a stale requeue took the job from. A `job_done` from that worker while the job is still `queued` re-adopts and completes it (receipt included) — the whole run is saved. Once someone else owns it (or it's terminal), the late reporter is rejected + cancelled instead.
- Human cancellation: admin `POST /api/jobs/{id}/cancel`, console jobs-page 取消 button, and the embedded panel's native controls mapped through comfyapi (`POST /interrupt` = cancel the executing panel job; `POST /queue {"delete":[ids]}` / `{"clear":true}` = cancel queued ones).
- Origin scoping shipped in Phase 1.9: `db.Job.origin` (`"console"|"panel"`) now lets the panel's native controls act only on panel-submitted work — `POST /interrupt` and `{"clear":true}` no longer reach console-submitted jobs.
- Agent runs `handle_job` as a background task so the WS receive loop keeps reading mid-run (prerequisite for receiving job_cancelled at all); on cancel it interrupts ComfyUI (`/interrupt` when executing, `/queue` delete when locally queued), runs job-file cleanup in a cancel mode, sends no completion message, and returns to idle. One-job-at-a-time invariant unchanged.
- Dispatch ranking: per tick, oldest job first over ALL idle workers — clean-eligible beats vram_offload-warned, then most free VRAM, then name for determinism. Capability matching stays server-side (the worker never chooses).

---

## Phase 1.8b addendum: prompt-helper templates (2026-09-13)

User directive: 新手最大的問題是不會描述想要的東西。兩支範本：①上傳樣本圖＋簡單要求（如「我要圖中女生的描述」）→ AI 產出形容詞豐富的提示詞供複製；②貼上隨意文字 → 模型整理成合適提示詞。

Decisions of record:
- Generation model = full Qwen3-VL-4B（Comfy-Org/Krea-2 `qwen3vl_4b_bf16.safetensors`，8.88GB，視覺塔＋BaseGenerate）via core `TextGenerate`. 32B heretic nvfp4 重打包經實測**無法生成**（輸出逗號串——量化只保編碼用途）；klein 4B 重打包被剝掉視覺塔（文字可生成但看不見圖）。Qwen2.5-VL（qwen_image 官方 encoder）的 config 無 stop_tokens，TextGenerate 直接報錯。
- 圖生提示詞走內建模板＋` /no_think` 尾綴；文字生提示詞必須關閉內建模板、手動 `<|im_start|>` chat 包裹（否則編碼模板立即 EOS、輸出空字串）。chat 標記藏在「別動」節點，新手只碰想法欄。
- 文字結果雙路呈現：panel 內 `PreviewAny`/`SaveText` 節點即席顯示（server 端 `job_outputs` 把 .txt artifacts 讀出為 `text` payload 映射到對應節點 id），同時以 .txt artifact 回傳 console。
- 新模型入 curated registry（#10）＋GCS 鏡像。

---

## Phase 3.0 addendum: 多使用者帳號系統（multi-user, multi-admin, per-user billing）(2026-09-14)

User directives: 推進 Phase 3；admin 登入後要可以幫 user 建立帳號；每個 user 只能看到自己的 job 跟產物；只有 admin 可以看到全部人的狀況；每個 user 個別使用了多少帳單資源要可以被計算。（Phase 3 既列項中的「多管理員」「分潤試算」併入本 phase；P2P 分塊傳輸另立 Phase 3.1。）

Decisions of record:

### 資料模型（server Alembic 新遷移＋cloud D1 0006，兩端對等）
- 新表 `users`：`id`（uuid4 hex PK）、`username`（唯一；儲存前 lowercase 正規化，3–32 字元 `[a-z0-9_.-]`）、`password_hash`、`role`（`'admin'|'user'`）、`disabled`（bool，預設 false）、`session_epoch`（int，預設 0）、`created_at`。
- 資料遷移：既有 `settings.admin_password_hash` → 建立 `username='admin'`、`role='admin'` 的 user 列（沿用原 hash，**既有 admin 密碼不變**），遷移後刪除該 setting key。全新安裝由 bootstrap／cloud `/api/setup` 直接建 admin user 列。
- `jobs.user_id`（nullable TEXT）：新 job 一律蓋章提交者；既有 job 遷移時全數指到遷移出的 admin user。
- `login_attempts` 加 `username` 欄；登入退避改**per-username**計算（同公式、同視窗）。

### Session 與登入
- Cookie payload 由 `{authenticated, csrf}` 改為 `{uid, role, epoch, csrf}`。舊 payload 缺 `uid` → 一律視為未登入（升級後全員重新登入一次，不做相容映射）。
- `epoch` 必須等於該 user 當前 `session_epoch` 才有效：改密碼／被停用／重設密碼時 epoch +1 → 該 user 所有既有 session 立即失效（自己改密碼時當場重發新 cookie，本人不掉線）。**全域 session secret 不再因改密碼而輪替**（那會登出所有人）。
- `POST /api/auth/login` 收 `{username, password}`；查無此人時仍對 dummy hash 做一次驗證（防 timing 枚舉），錯誤訊息不分「無此帳號／密碼錯」。`disabled` 使用者登入直接拒絕（同一種錯誤訊息）。
- `GET /api/auth/me` 回 `{authenticated, username, role, lang, platform_url}`。
- `POST /api/auth/change-password`：任何角色皆可自改（CSRF 保護），驗舊密碼。

### 授權模型
- 依賴鏈：`require_user`（任何已登入、未停用者，回傳 `{uid, role}`）→ `require_admin`（role=='admin'）。
- Admin-only：使用者管理、workers、settings、註冊識別碼、`/api/reports/contributions`、`/api/reports/usage`、`/api/reports/payout`、`/metrics`、model manifest 管理面。
- Owner-or-admin：`GET /api/jobs/{id}`、assessment、artifacts 下載、cancel。`GET /api/jobs` 列表：admin 看全部（附 `username`），一般 user 只回自己的。`POST /api/jobs` 蓋章 `user_id`。
- **面板（/comfy）改為個人工作區（ruling）**：任何已登入 user 皆可用；`/comfy/api/queue`、`/history`、`/interrupt`、`/queue delete/clear`、`POST /history`（隱藏）、`/view`、job_outputs 一律範圍限定在「origin=='panel' 且 user_id==本人」——**admin 在面板內也只看自己的面板工作**（全視野走 console）。Console API 維持角色範圍。
- 面板 WS 進度轉發同樣只推本人 job 的事件。

### 使用者管理 API（admin-only，CSRF 保護）
- `GET /api/users`：列表（id、username、role、disabled、created_at、job 數）。
- `POST /api/users`：`{username, role, password?}`——未給密碼則產生隨機密碼（`secrets.token_urlsafe(12)`），**僅此一次**回傳明文。
- `POST /api/users/{id}/reset-password`：產新隨機密碼（一次性回傳）＋epoch+1。
- `PATCH /api/users/{id}`：`{role?, disabled?}`；**最後一名有效 admin 不可停用亦不可降級**（400）。停用即 epoch+1。
- 不提供 DELETE（jobs/receipts 引用歷史）；停用即除役。

### 帳單／報表
- `GET /api/reports/usage`（admin，from/to 同 contributions）：receipts JOIN jobs.user_id，按 user 聚合 `{user_id, username, jobs, gpu_seconds, unbilled_gpu_seconds}`；user_id 為 NULL 的歷史列歸入 `username: null` 一列不丟失。
- `GET /api/reports/my-usage`（任何登入者）：同形狀、僅本人。
- **分潤試算** `GET /api/reports/payout?pool=<float>&from&to`（admin）：以區間內 billable gpu_seconds 按 worker 聚合，`ratio = worker_seconds / total_seconds`、`amount = pool × ratio`（raw float，前端格式化）；total 為 0 時回空列表＋`total_gpu_seconds: 0`。
- `GET /api/reports/contributions` 維持不變。

### Web
- 登入頁加 username 欄；auth state 帶 `{username, role}`。
- 導覽依角色：一般 user 只見 Dashboard（自己的統計）、Jobs（自己的）、Reports（我的用量）、Settings 縮減為改密碼＋語言；Workers／Users／完整 Settings／貢獻與分潤報表為 admin-only，路由層雙重把關（非僅藏選單）。
- 新 Users 頁（admin）：列表、建帳號（一次性密碼顯示＋複製）、啟停用、角色切換、重設密碼。
- Jobs 頁 admin 檢視加「使用者」欄；Reports 頁 admin 分頁：Worker 貢獻／使用者用量／分潤試算（pool 輸入框）。
- zh-TW＋en 全量翻譯。

### Cloud 對等
- D1 migration 0006（users＋jobs.user_id＋login_attempts.username＋資料遷移 SQL）；`/api/setup` 建 admin user 列；auth／users／jobs 範圍／comfy 面板範圍／reports 三端點 byte-parity 移植；既有部署跑遷移後舊 cookie 自然失效。

---

## Phase 3.1 addendum: 成員間 P2P 分塊傳輸（2026-09-14）

User directives: 完成 Phase 3 最後一項 P2P 分塊傳輸；安全原則沿用使用者 2026-09-14 指示——**傳輸憑證必須是平台簽發、短效、單次範圍綁定**，「而不是讓他可以一直持有，不然每個 worker 都可以跑上去搗亂」；worker 之間不互留常駐信任。

Decisions of record:

### 定位與範圍（MVP＝spec §8 既定方向）
- **HTTP Range 分塊互拉**：拉方 worker 直接向種子 worker 的 HTTP 端點分塊拉檔；NAT 打洞不做（§8 列為 fallback，此處裁定：拉不到就走既有官方載點→GCS 鏈，該鏈永遠可用，平台中繼留待有真實需求再議——**私有模型（無官方 URL）僅在有可直連種子時可派**，判定透明列在 UI 原因裡，不是靜默失敗）。
- P2P 帶來的新能力：**無官方 URL 的模型也能分發**——`fetchable` 判定擴為「有簽章來源 URL **或** 有在線可直連的 P2P 種子」。

### 分塊雜湊（chunk hashes，64 MiB）
- agent 惰性雜湊器改為**單趟同時算**整檔 SHA-256＋每 64 MiB 分塊 SHA-256，sidecar 快取一併存分塊表；庫存回報攜帶分塊表（僅在整檔雜湊首次回報或變更時傳，避免心跳膨脹）。
- 平台 `model_hashes` 加 `chunk_sha256s`（JSON 陣列）。**整檔雜湊仍是唯一共識權威**（衝突偵測不變）；分塊表僅用於早期中止壞塊——最終整檔驗證永遠執行，分塊表不對即整檔重驗兜底，投毒面不變。
- 協定升級：agent protocol 4（分塊表欄位＋peer 欄位；舊 agent 照常運作、不參與 P2P）。

### 種子端（peer serving，worker 主權：預設關閉）
- `agent.json` 新增 `peer_serve: false`、`peer_listen_port`、`peer_advertise_host`（未設則不啟）。啟用時 agent 起一個僅服務模型檔的 HTTP listener（stdlib ThreadingHTTPServer，不新增依賴），握手/心跳向平台通告 peer URL。
- **每個請求都要憑證**：拉方先向平台要 grant，種子端逐請求驗證，**fail-closed**（缺憑證/驗簽失敗/過期/範圍不符一律 403，無匿名路徑）。listener 只認 `GET /peer/models/<manifest name>`＋Range，路徑正規化防穿越。
- 種子資格與 worker 停用狀態脫鉤（停用=不接工作，仍可分享模型；文件明載，worker 可用 peer_serve=false 單獨關）。

### 傳輸憑證（grant，使用者安全原則）
- 拉方（已簽名的 agent 請求）`POST /api/agent/peer-grant {name, size_bytes}` → 平台驗證拉方確缺此檔、挑一個在線種子，簽發 grant：`{grant_id, name, size_bytes, sha256, seeder_id, puller_id, expires_at}`，平台 Ed25519 簽章覆蓋全欄位（pipe-join 同 manifest 慣例，欄位含 `|` 即拒發）。
- **TTL 10 分鐘**（同雲端上傳 token 慣例）、綁死單一檔案＋單一拉方＋單一種子；TTL 內允許多個 Range 請求（分塊傳輸本質），過期重新申請（平台無狀態重發）；grant_id 供帳務對帳。
- 種子端驗：平台簽章（用已釘選的平台公鑰）＋expires＋seeder_id==自己＋name 與本地庫存相符。拉方身分不需另驗——能出示有效 grant 即代表平台已認證過拉方。

### 頻寬入帳（§8「上傳頻寬計入收據帳本」）
- `receipts` 加 `bytes`（nullable INTEGER）與 kind `p2p_upload`：種子 agent 完成一個 grant 的服務後（或連線關閉時）以簽名請求回報 `{grant_id, bytes_served}`，平台核對 grant 簽發紀錄後入帳：kind=p2p_upload、billable=false、gpu_seconds=0、bytes=實際服務量、worker=種子。分潤試算維持 GPU 秒數；貢獻報表新增「P2P 上傳量」欄（web 同步顯示）。job_id 不適用（NULL）——receipts.job_id 放寬為 nullable，僅 p2p_upload 允許 NULL。

### 拉方整合（fetcher）
- 來源優先序改為：**P2P 種子 → 官方載點 → GCS 備援**（省外部流量；P2P 失敗即刻落回，不重試多種子超過一輪）。
- 分塊拉取：逐 64 MiB Range 請求、逐塊即時驗 chunk hash（壞塊即中止換來源）、`.part` 續傳=從最後一個完整驗證塊開始（斷線/取消後重申請 grant 續拉）；完成後整檔 SHA-256 終驗（不變的鐵律）→原子落地→立即重掃回報。取消/關機中止並清理，行為與現有 fetcher 相同；下載期間計費規則不變（stage=fetching_models，永不計費）。
- 派工：`eligible_after_fetch` 的 fetchable 判定納入 P2P 種子；push 內嵌的 fetch_models 條目對 peer-only 模型 `url: null` 標 `peer: true`（sig 覆蓋 name|directory|sha256|size_bytes 不變——URL 本就不入簽）。

### 雲端對等
- cloud 對等實作 tracker／grant 簽發／p2p_upload 入帳（D1 migration 0007：model_hashes.chunk_sha256s、receipts.bytes＋job_id nullable、workers peer 欄位）。worker 間傳輸本就不經平台，Workers 平台無額外限制。

### Web／文件
- Worker 頁：P2P 分享中 badge＋通告位址；貢獻報表加 P2P 上傳量欄。zh-TW＋en。
- SELF-HOSTING 兩語新增 P2P 章節：開啟方式、防火牆/埠、安全模型（短效憑證、fail-closed、整檔驗證兜底）、種子與停用脫鉤。

---

## Phase 3.2 addendum: 零持有者自動下載（curated 雜湊入庫）（2026-09-14）

User directive（2026-09-14）：如果沒有任何一台 worker 有該模型，挑一台磁碟餘裕足夠的 worker 直接要求下載，不要跳手動下載提示；下載完立即回報清單（後者 Phase 2.1 已實作）。

Decisions of record:
- **現況根因**：fetch manifest 的 sha256 只從「持有者共識」學得——全聯邦皆缺的模型沒有可信雜湊 → 平台拒簽下載指令 → 才落到 400 手動提示。這是安全設計（不叫 worker 下載無法驗證的內容），不是缺陷；解法是給 curated registry 補上**平台維運者背書的 sha256＋size_bytes**（值取自本聯邦實測共識，2026-09-14 由 controller 從 live 共識庫固化）。
- `ModelSource` 增 `sha256`／`size_bytes`（僅 curated 11 條全填；官方範本收割條目無可信雜湊維持原樣，仍走共識路徑）。
- manifest 合成：無共識列的 curated 模型以 guide 雜湊簽發條目（**共識存在時共識優先**；guide 雜湊與後來學得的共識不一致 → 記 log、以共識為準——共識代表聯邦實際持有的位元組；衝突 tripwire 規則不變，僅限回報者間衝突）。
- 送單放行：缺模型 400（`prompt.missing_models`）僅對「manifest 不可取得」的模型觸發——curated 模型即使零持有者也能排隊，由 `eligible_after_fetch` 既有機制（auto_fetch＋磁碟 1.2×＋protocol 門檻）挑 worker 下載（來源順序不變：P2P（此情境無種子）→官方→GCS）。下載完成即回報（既有）。
- 挑 worker 準則誠實聲明：磁碟餘裕與最小下載量（既有 tier-2）；**頻寬不量測**（未實作的不寫進文件）。
- 雲端對等（model_guide.ts 鏡像同值）；文件更新（SELF-HOSTING 缺模型章節truth-update）。
