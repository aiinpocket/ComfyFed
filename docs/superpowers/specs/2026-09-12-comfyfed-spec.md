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
- **Phase 2**：模型 manifest＋平台中繼下載；`/object_info` 能力交集模式（保守選項）。
- **Phase 3**：成員間 P2P 分塊傳輸；貢獻報表進階（分潤試算）；多管理員。
- **未來方向：ComfyFed Cloud（2026-09-12 提出）**——平台端移植 Cloudflare Workers＋D1＋R2 的免自架部署形態：D1=SQLite（schema 近乎原樣）、R2=ArtifactStore 的 S3 介面（presigned 直傳、零出口費）、agent 長連 WS 改由 Durable Objects（hibernation）承接、派工迴圈改 DO alarms、Ed25519 驗簽走 WebCrypto。價值：DDNS/固定IP/NAT/TLS 痛點全消失。定位：**自架 Python 版仍是本體**（內網/離線場景＋資料自主），Cloud 版是第二部署形態；現有架構決策（outbound-only WS、S3 介面、簽章收據）已刻意為此保留可移植性。

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
- Guidance lives in a POST /prompt 400 (`prompt.missing_models`) raised when every online worker is ineligible due to missing models: per-model zh-TW block with 放置路徑 models/<dir>/、官方載點（flux/ae 加註需登入 HuggingFace 同意授權）、備份載點（GCS）、「10 分鐘自動掃描、不需重啟」. No workers online → unchanged queueing behavior.
- Panel WS sends explicit `feature_flags` all-false (assets, node_replacements, show_signin_button, extension.manager.supports_v4/.supports_csrf_post) so Manager/Asset-Browser/sign-in UI stays dormant; incoming client feature_flags frames are consumed silently. `GET /api/folder_paths` stubbed `{}`.
- R2 (`models.aiinpocket.com`) is decommissioned: worker, custom domain, bucket contents deleted 2026-09-13. Canonical mirror base: `https://storage.googleapis.com/comfyfed-models/models/`.
