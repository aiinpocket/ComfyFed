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
| Receipt（收據） | 任務完成後雙方簽章的憑證（誰、何時、幾 GPU 秒），分潤與問責的地基。 |

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
  - 解析 workflow → ①node class 集合 ②**引用的模型檔清單**（掃描 loader 節點的 ckpt_name/unet_name/clip_name/vae_name/lora_name 等欄位）③**VRAM 粗估**（引用模型檔大小加總×係數，模型大小查聯邦庫存）
  - worker 心跳夾**本地模型庫存**（檔名＋大小；雜湊 Phase 2 補），平台隨時知道誰有什麼
  - 每個 worker 對每個 job 得出三態判定：
    - `eligible`——節點✓ backend✓ VRAM✓ 模型全有 → 直接派
    - `eligible_after_fetch`——**只缺模型**且聯邦內其他成員有、且磁碟裝得下 → 可派（先補模型再開工：Phase 2 平台中繼、Phase 3 P2P；Phase 1 此類顯示「僅缺模型，待模型分發功能開通」）
    - `ineligible(reasons)`——缺節點安裝／backend 不符／VRAM 不足等**硬缺口** → 不派，UI 明列原因（「worker-A 缺 IPAdapter 節點」「worker-B VRAM 估需 18GB 僅 12GB」）
  - 派工優先序：eligible ＞ eligible_after_fetch（省頻寬）；全部 ineligible 才留佇列＋標示原因。
- Worker 端執行：收 job → 白名單檢查 → POST 本機 ComfyUI `/prompt` → 輪詢 history/進度 → 上傳產物（圖/影片）→ 回報完成 → 雙方簽收據。

## 8. 模型分發（Phase 2+，方向已定案）

- 平台簽名的**雜湊清單（manifest）**：`{檔名, SHA256, 分塊雜湊(64MB), 大小, 來源}`；worker 只認清單不認連結，逐塊驗證。
- **P2P 限聯邦成員**：心跳夾本地模型庫存 → 平台當 tracker；worker 憑註冊金鑰互認直連（HTTP Range 分塊互拉為 MVP；NAT 打洞／平台中繼為 fallback）；上傳頻寬計入收據帳本。

## 9. 分階段

- **Phase 1（本計畫）**：平台核心＋Agent 核心端到端可用——安裝→登入→發識別碼→worker 註冊上線→送 workflow→派工執行→結果回傳→收據入帳→儀表板可視。
- **Phase 2**：模型 manifest＋平台中繼下載；ComfyUI 相容 API 面板（原生 Comfy 前端直連平台）；`/object_info` 能力交集。
- **Phase 3**：成員間 P2P 分塊傳輸；貢獻報表進階（分潤試算）；多管理員。

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
