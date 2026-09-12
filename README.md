# ComfyFed

[繁體中文](#繁體中文) | [English](#english)

---

## 繁體中文

### 這是什麼

ComfyFed 是一個給熟人圈使用的 **ComfyUI 分散式渲染聯邦平台**：一台伺服器（platform）帶著多台 worker（agent），讓大家用自己的顯卡互相支援彼此的 ComfyUI 渲染工作，不需要公開服務、不需要信任陌生人的節點。

- 全程 Ed25519 簽章協議：worker 註冊、每次 API 呼叫、WebSocket 連線都經過簽章與防重放驗證
- 工作自動評估：伺服器比對 workflow 需要的節點／模型／VRAM 與每台 worker 的即時狀態，判定 `eligible`／`eligible_after_fetch`／`ineligible`
- 雙簽收據：每個工作完成後由 worker 與 platform 各自簽名，作為算力貢獻的可稽核記錄
- 雙語 Web 主控台（繁中／英文）：Dashboard、Workers、Jobs、Reports、Settings
- Prometheus `/metrics` 端點，可接 Grafana 等監控
- Agent 具備簽章驗證的自動更新機制

### 快速開始

需求：Python 3.12+。

```bash
# 於專案根目錄安裝（目前尚未發布 PyPI 套件，之後會提供 pip 套件）
pip install -e .
```

**第一次安裝伺服器**（互動精靈：選語言、輸入對外網址，並產生一次性的隨機管理員密碼）：

```bash
comfyfed-server install
```

密碼只在安裝當下印出一次，請立刻保存；資料庫、金鑰等預設存在 `./data`（可用 `--data-dir` 改變）。也可以非互動安裝：

```bash
comfyfed-server install --non-interactive --lang zh-TW --url https://your-domain.example
```

**啟動伺服器**：

```bash
comfyfed-server run --host 0.0.0.0 --port 8388
```

（`--host` 預設 `0.0.0.0`，`--port` 預設 `8388`，`--data-dir` 預設 `./data`）

**建置 Web 主控台**（Vite + React + Mantine）：

```bash
cd web
npm install
npm run build
```

### 網路架構：DDNS 或固定 IP 都可以

伺服器對外只需要一個大家都連得到的網址（DDNS 動態域名或固定 IP 均可），這個網址就是安裝精靈裡輸入的 `platform_url`，之後也會寫進發給每個 worker 的註冊 bundle 裡。

Worker（agent）只會**主動對外連線**去找伺服器，不需要對外開放任何連接埠，NAT／防火牆後面也能正常運作。

如果對外是 HTTPS，建議在伺服器前面加一層反向代理處理 TLS，再轉給 `comfyfed-server` 監聽的內部埠（例如 8388）。

**Caddy**（自動 HTTPS，兩行搞定）：

```
your-domain.example {
    reverse_proxy 127.0.0.1:8388
}
```

**nginx**（等效設定）：

```nginx
server {
    listen 443 ssl;
    server_name your-domain.example;
    location / {
        proxy_pass http://127.0.0.1:8388;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

（agent 走的是 WebSocket 長連線，proxy 記得帶上 `Upgrade`/`Connection` header。）

### 新增一台 worker

1. 在主控台 → **Workers** → 新增，輸入名稱後系統會產生一次性的註冊 bundle（`bundle.json`），下載它。
2. 在要貢獻算力的那台機器上：

```bash
pip install -e .
comfyfed-agent register bundle.json
comfyfed-agent run
```

`register` 會用 bundle 裡的一次性 token 向伺服器換發正式憑證，並把設定寫到 `~/.comfyfed/agent.json`；`run` 會連上所有已註冊的平台並開始接工作。

這台機器上需要有本機的 ComfyUI 在跑（預設抓 `http://127.0.0.1:8188`），如果 ComfyUI 跑在別的位置，可在 `agent.json` 的 `comfy_url` 欄位改掉。

### 安全模型摘要

- **一次性註冊 token**：主控台核發的每個 bundle 只能使用一次，用過即失效（伺服器端原子性檢查，同一 token 不會被搶用兩次）。
- **雙向金鑰釘選（key pinning）**：agent 首次註冊時把伺服器的 Ed25519 公鑰釘死在本地設定裡；伺服器核發的憑證（certificate）也綁定該 worker 的公鑰，之後互相驗證身分不再依賴 token。
- **簽章請求 + 防重放**：每個 API 呼叫都帶上 `X-Ts`（時間戳）、`X-Nonce`（隨機值）與 Ed25519 簽章；伺服器拒絕時間戳超過 ±120 秒的請求，也拒絕重複出現的 nonce。
- **WebSocket challenge**：agent 連上長連線時，伺服器送出隨機 nonce，agent 必須用自己的簽章金鑰簽回去才算握手成功。
- **收據雙簽**：每個工作完成後，worker 與 platform 各自簽名，形成不可單方偽造的貢獻紀錄。
- **沒有寫死的預設帳密**：管理員密碼在 `install` 時隨機產生並僅顯示一次，沒有任何內建帳號密碼。

### 節點白名單

每台 worker 可在 `agent.json` 設定 `node_policy`：

- `installed`（預設）：允許本機 ComfyUI 已安裝的所有節點類別。
- `official_only`：只允許 ComfyUI 官方核心節點（與本機已安裝節點取交集）。
- `custom`：只允許自訂清單（`whitelist_extra`，與本機已安裝節點取交集）。

之所以要有這層設定，是因為 **workflow 本身就是可執行內容**——一個惡意或設計不良的自訂節點可以在 worker 機器上執行任意程式碼。此白名單是本機端的縱深防禦（agent 執行前擋一次），伺服器端也會另外比對節點需求做派工判斷，兩層互相獨立。

### 工作自動評估

伺服器收到工作後會自動解析 workflow 需要的節點類別、模型檔案與（若已知）VRAM 需求，對每台候選 worker 給出：

- `eligible`：worker 具備所有必要節點與模型，可直接派工。
- `eligible_after_fetch`：worker 缺少的模型可以在聯邦內其他 worker 上取得（Phase 2 才會落地實際傳輸機制），且磁碟空間足夠容納。
- `ineligible`：附上白話原因，例如缺少節點類別、VRAM 不足、缺的模型在聯邦裡也找不到等。

### 後續規劃（Roadmap）

**Phase 2**
- 模型 manifest 分發機制（讓 `eligible_after_fetch` 真正落地傳輸模型）
- 相容 ComfyUI API 的操作面板
- S3 / R2 相容的產出物儲存（artifact store）

**Phase 3**
- 成員間 P2P 直接傳輸
- 分潤／收益分帳帳本
- 多管理員支援

**ComfyFed Cloud**（未來方向）：以 Cloudflare Workers + D1 + R2 建置的雲端託管版本，降低自架門檻。

### 授權

License：待定（TBD）。目前尚未選定授權條款。

---

## English

### What it is

ComfyFed is a **distributed ComfyUI rendering federation** built for a trusted circle of people: one server (the platform) coordinates multiple workers (agents), so friends can share GPU compute for each other's ComfyUI workflows without running a public service or trusting a stranger's node.

- End-to-end Ed25519 signed protocol: worker registration, every API call, and WebSocket connections are all signed and replay-protected
- Automatic job assessment: the server compares a workflow's required nodes/models/VRAM against each worker's live state and rules `eligible` / `eligible_after_fetch` / `ineligible`
- Dual-signed receipts: every completed job is signed by both the worker and the platform, forming an auditable contribution record
- Bilingual (繁中 / English) web console: Dashboard, Workers, Jobs, Reports, Settings
- Prometheus `/metrics` endpoint for Grafana-style monitoring
- Signed, verified auto-update for the agent

### Quick start

Requires Python 3.12+.

```bash
# from the repo root (no PyPI package yet; one is planned)
pip install -e .
```

**First-time server install** (interactive wizard: pick a language, enter the public URL, and get a one-time random admin password):

```bash
comfyfed-server install
```

The password is printed once at install time — save it immediately. The database and keys live under `./data` by default (override with `--data-dir`). Non-interactive install is also supported:

```bash
comfyfed-server install --non-interactive --lang en --url https://your-domain.example
```

**Run the server**:

```bash
comfyfed-server run --host 0.0.0.0 --port 8388
```

(`--host` defaults to `0.0.0.0`, `--port` to `8388`, `--data-dir` to `./data`)

**Build the web console** (Vite + React + Mantine):

```bash
cd web
npm install
npm run build
```

### Network: DDNS or a fixed IP both work

The server just needs one address everyone can reach — a dynamic DNS hostname or a fixed IP both work fine. That address is the `platform_url` you enter during install, and it's the same value baked into every worker's registration bundle.

Workers (agents) only ever make **outbound** connections to the platform — no inbound port needs to be opened, so agents behind NAT/firewalls work without any configuration.

If you're exposing the server over HTTPS, put a reverse proxy in front for TLS and forward to the internal port `comfyfed-server` listens on (e.g. 8388).

**Caddy** (automatic HTTPS, two lines):

```
your-domain.example {
    reverse_proxy 127.0.0.1:8388
}
```

**nginx** (equivalent):

```nginx
server {
    listen 443 ssl;
    server_name your-domain.example;
    location / {
        proxy_pass http://127.0.0.1:8388;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

(The agent uses a long-lived WebSocket connection, so make sure the proxy forwards the `Upgrade`/`Connection` headers.)

### Adding a worker

1. In the console, go to **Workers** → add, name it, and the platform generates a one-time registration bundle (`bundle.json`) — download it.
2. On the machine that will contribute compute:

```bash
pip install -e .
comfyfed-agent register bundle.json
comfyfed-agent run
```

`register` exchanges the bundle's one-time token for a real certificate from the platform and writes the config to `~/.comfyfed/agent.json`; `run` connects to every registered platform and starts processing jobs.

That machine needs a local ComfyUI running (defaults to `http://127.0.0.1:8188`); if yours runs elsewhere, set `comfy_url` in `agent.json`.

### Security model summary

- **One-time registration token**: each bundle issued by the console can be used exactly once (the server claims it atomically, so two concurrent registrations can't both win).
- **Mutual key pinning**: on first registration, the agent pins the platform's Ed25519 public key locally; the certificate the platform issues back is likewise bound to that worker's public key — after that, identity checks no longer depend on the token.
- **Signed requests + replay protection**: every API call carries `X-Ts` (timestamp), `X-Nonce`, and an Ed25519 signature; the server rejects requests whose timestamp is off by more than ±120 seconds and rejects any nonce it has already seen.
- **WebSocket challenge**: when an agent opens its long-lived connection, the server sends a random nonce that the agent must sign back with its own key to complete the handshake.
- **Dual-signed receipts**: on job completion, both the worker and the platform sign the receipt, so neither side can fabricate a contribution record alone.
- **No hardcoded default credentials**: the admin password is randomly generated at `install` time and shown exactly once — there is no built-in account.

### Node whitelist

Each worker sets `node_policy` in `agent.json`:

- `installed` (default): allow every node class the local ComfyUI has installed.
- `official_only`: allow only official ComfyUI core nodes (intersected with what's actually installed).
- `custom`: allow only a configured list (`whitelist_extra`, intersected with what's installed).

This exists because **a workflow is executable content** — a malicious or poorly-written custom node can run arbitrary code on the worker's machine. This whitelist is local, defense-in-depth (checked before the agent executes anything); the server independently checks node requirements for dispatch decisions, as a second, separate layer.

### Job assessment

When a job arrives, the server automatically extracts the node classes, model files, and (when known) VRAM needs from the workflow, and rules on each candidate worker:

- `eligible`: the worker already has every required node and model — dispatch directly.
- `eligible_after_fetch`: models missing on this worker are available from another worker in the federation (actual transfer lands in Phase 2), and there's enough free disk to hold them.
- `ineligible`: with plain-language reasons, e.g. missing node classes, insufficient VRAM, or missing models that no one else in the federation has either.

### Roadmap

**Phase 2**
- Model manifest distribution (to actually implement `eligible_after_fetch` transfers)
- A ComfyUI-compatible API panel
- S3/R2-compatible artifact storage

**Phase 3**
- Direct member-to-member P2P transfer
- Revenue-share ledger
- Multi-admin support

**ComfyFed Cloud** (future direction): a hosted variant built on Cloudflare Workers + D1 + R2, to lower the self-hosting barrier.

### License

License: TBD. No license has been chosen yet.
