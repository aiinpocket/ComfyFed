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
- Workflow ＝可執行內容 ⇒ Agent 端強制 **node class 白名單**（預設僅 ComfyUI 官方內建節點），拒絕含未知節點的 workflow。
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
- 派工：平台推給「online 且 idle」的 worker（WS push）；worker 接單後對**其他已註冊平台**廣播 busy。
- Worker 端執行：收 job → 白名單檢查 → POST 本機 ComfyUI `/prompt` → 輪詢 history/進度 → 上傳產物（圖/影片）→ 回報完成 → 雙方簽收據。

## 8. 模型分發（Phase 2+，方向已定案）

- 平台簽名的**雜湊清單（manifest）**：`{檔名, SHA256, 分塊雜湊(64MB), 大小, 來源}`；worker 只認清單不認連結，逐塊驗證。
- **P2P 限聯邦成員**：心跳夾本地模型庫存 → 平台當 tracker；worker 憑註冊金鑰互認直連（HTTP Range 分塊互拉為 MVP；NAT 打洞／平台中繼為 fallback）；上傳頻寬計入收據帳本。

## 9. 分階段

- **Phase 1（本計畫）**：平台核心＋Agent 核心端到端可用——安裝→登入→發識別碼→worker 註冊上線→送 workflow→派工執行→結果回傳→收據入帳→儀表板可視。
- **Phase 2**：模型 manifest＋平台中繼下載；ComfyUI 相容 API 面板（原生 Comfy 前端直連平台）；`/object_info` 能力交集。
- **Phase 3**：成員間 P2P 分塊傳輸；貢獻報表進階（分潤試算）；多管理員。

## 10. 技術棧（定案）

- 平台：Python 3.12、FastAPI、SQLAlchemy 2、uvicorn、PyNaCl（Ed25519）、argon2-cffi、pytest
- Agent：Python 3.12 單套件（同 repo `agent/`）、httpx、websockets、PyNaCl
- 前端：React 18 + TypeScript + Vite + react-i18next（元件庫用 Mantine）
- Repo：單一 monorepo `ComfyFed/`，`server/`＋`agent/`＋`web/`
