# ComfyFed Cloud

[繁體中文](#繁體中文) | [English](#english)

一般使用者導向的說明：[README.md](../README.md)（中文）｜ [README.en.md](../README.en.md)（English）。自架技術指南：[docs/SELF-HOSTING.zh.md](../docs/SELF-HOSTING.zh.md) ｜ [docs/SELF-HOSTING.en.md](../docs/SELF-HOSTING.en.md)。

---

## 繁體中文

### 這是什麼

`cloud/` 是 ComfyFed 的 **Cloudflare Workers 版本**：同一套聯邦協議（worker 註冊、Ed25519 簽章請求、WebSocket 長連線握手、雙簽收據、雙語主控台），跑在 Cloudflare 的免費方案上，不需要自己顧一台 24 小時開機的伺服器。跟自架版（根目錄 `comfyfed-server`）是**同一個 agent**——差別只在伺服器端跑在哪裡。

適合：不想自己維護主機、不想處理 TLS 憑證、想要「有人幫忙開機」的人。免費方案就夠用（見下方〈限制〉）。

### 前置需求

- 一個 Cloudflare 帳號（免費方案即可——這個專案用的是 D1 的 SQLite-backed Durable Objects，免費額度內）
- Node.js 20 以上
- 會用命令列複製貼上就好，不需要懂 Cloudflare Workers 的細節

```bash
cd cloud
npm install
npx wrangler login   # 瀏覽器跳出授權畫面，登入你的 Cloudflare 帳號
```

### 建立資源（D1 + R2）

```bash
npx wrangler d1 create comfyfed
```

指令會印出一段 `database_id`，把它貼進 `cloud/wrangler.jsonc` 的 `d1_databases[0].database_id`。repo 裡已提交著 aiinpocket 部署所用的那個 ID（database_id 是識別碼、不是憑證，可以安全進 git——Workers Builds 從 git checkout 部署，**必須**能在 repo 裡讀到它）；自己另建資料庫時把它換成你的即可：

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "comfyfed",
    "database_id": "貼上剛剛印出來的 id",
    "migrations_dir": "migrations"
  }
]
```

再建立存放 job 輸入/輸出/物件資訊快照的 R2 bucket（名稱要跟 `wrangler.jsonc` 裡的 `r2_buckets[0].bucket_name` 一致，預設是 `comfyfed-store`）：

```bash
npx wrangler r2 bucket create comfyfed-store
```

### 設定 Secrets

**`SETUP_TOKEN`（必設）**——沒有這個，`/api/setup` 永遠拒絕，等於伺服器裝好了但沒人能開第一個管理員帳號：

```bash
openssl rand -hex 32 | npx wrangler secret put SETUP_TOKEN
```

（Windows 沒有 `openssl` 的話，用 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` 也一樣。）

**`PLATFORM_ED25519_SEED`（選配，但建議設）**——這是平台簽發 worker 憑證/收據用的身分金鑰。不設的話系統會自動產生一把存進資料庫，一樣能動，但換手/搬遷資料庫時身分會跟著資料庫走而不是你手上；自己保管一把種子，將來要輪替或搬家比較乾脆：

```bash
openssl rand -hex 32 | npx wrangler secret put PLATFORM_ED25519_SEED
```

必須是 64 個小寫十六進位字元（32 bytes）。

**`R2_S3_*`（選配，只有要上傳 >100MB 產出檔時才需要）**——見下方〈限制〉，這裡先跳過。

### 首次部署

```bash
npm run ci-build   # npm ci + 打包 assets（等同 CI 的 build 指令）
npm run deploy      # 套用 D1 migrations（--remote）+ wrangler deploy
```

部署完 wrangler 會印出你的網址，長得像 `https://comfyfed-cloud.<你的帳號>.workers.dev`。

### 首次設定

打開網址，畫面會直接引導你建立管理員密碼（需要你在 secrets 設的 `SETUP_TOKEN`）：開啟 `https://your-name.workers.dev/`，主控台偵測到還沒設定過，會顯示「建立管理員密碼」畫面，輸入 `SETUP_TOKEN` 和你要用的管理員密碼（至少 8 碼）並送出即可。設定完成後畫面會回到一般登入畫面，用剛剛設的密碼登入（Dashboard / Workers / Jobs / Reports / Settings，跟自架版一模一樣）。

<details>
<summary>備用方案：用 curl 完成初次設定</summary>

網頁打不開，或想用腳本自動化時，可以直接呼叫 API：

```bash
curl -X POST https://your-name.workers.dev/api/setup \
  -H 'Content-Type: application/json' \
  -d '{"token": "剛剛設定的 SETUP_TOKEN", "password": "你要用的管理員密碼（至少 8 碼）"}'
```

回傳 `{"ok": true}` 就設定完成了，一樣打開 `https://your-name.workers.dev/` 用剛剛設的密碼登入。

</details>

### Workers Builds（接 GitHub 自動部署）

Cloudflare Dashboard → Workers & Pages → 你的 Worker → **Settings → Builds** → 連接這個 GitHub repo：

- **Root directory**：`cloud/`
- **Build command**：`npm run ci-build`（= `npm ci` → cloud 測試 → 建置（含 `../web` 主控台）→ web 測試。**測試是閘門**：任一紅燈就不會走到部署，壞掉的改動上不了線）
- **Deploy command**：`npm run deploy`（會先套用 D1 migrations 再部署；比官方預設的 `npx wrangler deploy` 多做一步，但這一步是必要的——新 migration 不會自己套用）
- **Node**：`cloud/.node-version` 釘在 22，Workers Builds 會照它選版本。

設定好之後每次 push 到你選的分支就會自動建置＋部署。不需要自己加任何 API token——Workers Builds 用你帳號的建置權杖跑 `wrangler`。

**誠實註記**：Python 端（server／agent）的 pytest 在 Workers Builds 裡跑不了（建置容器不保證有 Python），它仍是**本機 push 前**的閘門；Builds 只守 cloud＋web 兩套。

### 接一台 worker（跟自架版完全同一套 agent）

1. 主控台登入後 → **Settings**，把 `platform_url` 設成你的 `https://your-name.workers.dev`（讓核發的註冊 bundle 帶對網址）。
2. **Workers** → 新增 → 輸入名稱，下載一次性註冊 bundle（`bundle.json`）。
3. 在要貢獻算力的機器上，跟自架版完全一樣：

```bash
pip install -e .            # 在 ComfyFed 專案根目錄
comfyfed-agent register bundle.json
comfyfed-agent run
```

沒有任何「cloud 專用 agent」——同一支 `comfyfed-agent`，`bundle.json` 裡的 `platform_url` 決定它連去自架伺服器還是 Cloudflare。

### 選配

**自訂網域**：Cloudflare Dashboard → 你的 Worker → Settings → Domains & Routes → Add Custom Domain，網域要先掛在同一個 Cloudflare 帳號下。掛好後把 `platform_url`（Settings 頁）改成新網域，之後新核發的 bundle 才會帶正確網址。

**灌官方範本庫**（讓主控台的「從範本開始」有東西可選）：

```bash
npm run seed-official
```

會從 PyPI 抓 `comfyui-workflow-templates` 套件、驗證每個檔案的 hash，再上傳進你的 R2 bucket（`official_templates/` 前綴）。第一次跑要抓不少檔案，網路狀況差的話會花幾分鐘；可重複執行，會收斂到同一個結果。

### 限制

- **免費方案下單一產出檔 ≤ 100MB**（Cloudflare Workers 請求體大小上限）。預設的 `direct` 上傳模式（agent → Worker → R2）受這個限制，影片這類產出檔很容易超過。
  - 解法：設定 `R2_S3_*` 四個 secrets（`R2_S3_ACCOUNT_ID`／`R2_S3_ACCESS_KEY_ID`／`R2_S3_SECRET_ACCESS_KEY`／`R2_S3_BUCKET`，從 Cloudflare Dashboard → R2 → Manage API Tokens 取得），四個都設了之後 `/api/agent/jobs/{id}/artifacts/presign` 會自動改回傳 S3 相容的預簽章 URL，agent 直接 PUT 進 R2，完全繞過 Worker 的請求體限制，單檔上限拉高到 R2 單次 PUT 本身的上限（約 5GB）。**建議只要會跑影片範本就設定這組**，不然影片產出常常一超過 100MB 就整包上傳失敗。
- **沒有 publish-agent**：自架版某些「發布 agent 版本」的流程（簽章更新包）在 cloud 版本目前沒有對應端點；`GET /api/agent/version` 存在，但預設回傳 `latest`/`min_supported` 都是 `0.1.0`、其餘欄位皆為 `null`，要自己手動用 D1/Settings 管理版本資訊。
- Durable Object（Hub，管長連線與派工）綁的是免費方案也能用的 SQLite-backed 版本，量體很大（數十台 worker 以上）時建議留意 Cloudflare 的用量儀表板。

### 跟自架版的差異

| 項目 | 自架版（`comfyfed-server`） | Cloud 版（`cloud/`） |
| --- | --- | --- |
| 執行環境 | 你自己的機器/VM，Python 常駐行程 | Cloudflare Workers，無伺服器 |
| 資料庫 | 本機 SQLite 檔案 | Cloudflare D1（SQLite-backed） |
| 檔案儲存 | 本機檔案系統 | Cloudflare R2 |
| 長連線 | 進程內 WebSocket 管理 | Durable Object（Hub）+ hibernatable WebSocket |
| 首次安裝 | `comfyfed-server install` 互動精靈 | 開網頁即引導設定管理員密碼（`POST /api/setup`，curl 備用方案見上） |
| 部署/更新 | 自己 `git pull` + 重啟行程 | `npm run deploy`，或接 Workers Builds 自動部署 |
| TLS | 需要自己接反向代理（Caddy/nginx） | Cloudflare 自動處理 |
| 產出檔大小上限 | 無（受本機磁碟限制） | 100MB（免費方案，`direct` 模式）；設定 `R2_S3_*` 後拉高到約 5GB（R2 單次 PUT 上限），影片產出建議設定 |
| Agent | `comfyfed-agent` | 同一支 `comfyfed-agent`，只是 `platform_url` 不同 |
| 費用 | 主機/頻寬成本 | Cloudflare 免費方案額度內可 $0 運行 |

---

## English

### What this is

`cloud/` is the **Cloudflare Workers port** of ComfyFed: the same federation protocol (worker registration, Ed25519-signed requests, a WebSocket handshake, dual-signed receipts, the bilingual console) running on Cloudflare's free tier instead of a machine you keep powered on yourself. It talks to the **exact same agent** as the self-hosted version (root `comfyfed-server`) — only the server side differs.

Good fit if you'd rather not run a 24/7 host, manage TLS certificates, or babysit a process. The free plan is enough for a small friend-group federation (see Limits below).

### Prerequisites

- A Cloudflare account (free plan is fine — this project uses D1 and SQLite-backed Durable Objects, both within the free tier)
- Node.js 20+
- Comfort copy-pasting shell commands; no Cloudflare Workers expertise required

```bash
cd cloud
npm install
npx wrangler login   # opens a browser tab to authorize your Cloudflare account
```

### Create resources (D1 + R2)

```bash
npx wrangler d1 create comfyfed
```

This prints a `database_id` — paste it into `cloud/wrangler.jsonc`'s `d1_databases[0].database_id` (currently the placeholder `"TBD-set-at-deploy"`):

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "comfyfed",
    "database_id": "paste the id here",
    "migrations_dir": "migrations"
  }
]
```

Then create the R2 bucket that holds job inputs/outputs/object_info snapshots (name must match `wrangler.jsonc`'s `r2_buckets[0].bucket_name`, `comfyfed-store` by default):

```bash
npx wrangler r2 bucket create comfyfed-store
```

### Set secrets

**`SETUP_TOKEN` (required)** — without this, `/api/setup` refuses forever; the deployment would be up but nobody could ever create the first admin account:

```bash
openssl rand -hex 32 | npx wrangler secret put SETUP_TOKEN
```

(No `openssl` on Windows? `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` works just as well.)

**`PLATFORM_ED25519_SEED` (optional, but recommended)** — the platform's own signing identity, used for worker certificates and receipt counter-signatures. If unset, one is generated lazily and stored in the database — functional, but then the platform's identity travels with the database rather than something you hold; setting your own seed makes future rotation/migration cleaner:

```bash
openssl rand -hex 32 | npx wrangler secret put PLATFORM_ED25519_SEED
```

Must be 64 lowercase hex characters (32 bytes).

**`R2_S3_*` (optional, only needed for artifacts over 100MB)** — see Limits below; skip for now.

### First deploy

```bash
npm run ci-build   # npm ci + build the packaged assets (same as CI's build step)
npm run deploy      # applies D1 migrations (--remote) + wrangler deploy
```

Deployment prints your URL, something like `https://comfyfed-cloud.<your-account>.workers.dev`.

### First-run setup

Open the URL and the console walks you straight into creating the admin password (you'll need the `SETUP_TOKEN` you set in secrets): visit `https://your-name.workers.dev/`, and since the console detects setup hasn't run yet, it shows a "create admin password" screen. Enter the `SETUP_TOKEN` and the admin password you want (8+ chars) and submit. Once setup succeeds, the screen returns to the normal login form — sign in with that password (Dashboard / Workers / Jobs / Reports / Settings — identical to the self-hosted console).

<details>
<summary>Fallback: complete first-run setup with curl</summary>

If the web page isn't reachable, or you're scripting the deploy, call the API directly:

```bash
curl -X POST https://your-name.workers.dev/api/setup \
  -H 'Content-Type: application/json' \
  -d '{"token": "the SETUP_TOKEN you set above", "password": "the admin password you want (8+ chars)"}'
```

A `{"ok": true}` response means setup is done — open `https://your-name.workers.dev/` and log in with that password.

</details>

### Workers Builds (connect GitHub for automatic deploys)

Cloudflare Dashboard → Workers & Pages → your Worker → **Settings → Builds** → connect this GitHub repo:

- **Root directory**: `cloud/`
- **Build command**: `npm run ci-build`
- **Deploy command**: `npm run deploy` (applies D1 migrations before deploying — one step more than the dashboard's own default suggestion of `npx wrangler deploy`, but that step is necessary: a new migration never applies itself)

Once configured, every push to your chosen branch builds and deploys automatically.

### Register a worker (the same agent as self-hosted)

1. Log into the console → **Settings**, set `platform_url` to your `https://your-name.workers.dev` (so issued registration bundles carry the right address).
2. **Workers** → add → name it, download the one-time registration bundle (`bundle.json`).
3. On the machine contributing GPU time, exactly as with the self-hosted version:

```bash
pip install -e .            # from the ComfyFed project root
comfyfed-agent register bundle.json
comfyfed-agent run
```

There is no "cloud-specific agent" — it's the same `comfyfed-agent` binary; the `platform_url` baked into `bundle.json` is what determines whether it connects to your self-hosted server or to Cloudflare.

### Optional

**Custom domain**: Cloudflare Dashboard → your Worker → Settings → Domains & Routes → Add Custom Domain (the domain must already be on the same Cloudflare account). After attaching it, update `platform_url` on the Settings page so newly issued bundles carry the new address.

**Seed the official template library** (so the console's "start from a template" has something to show):

```bash
npm run seed-official
```

Fetches the `comfyui-workflow-templates` package from PyPI, verifies every file's hash, and uploads it into your R2 bucket (`official_templates/` prefix). The first run fetches a fair number of files and can take a few minutes on a slow connection; it's safe to re-run and will converge to the same result.

### Limits

- **100MB per artifact on the free plan** (Cloudflare Workers' request body size cap). The default `direct` upload mode (agent → Worker → R2) is subject to this, and video outputs cross it easily.
  - Workaround: set all four `R2_S3_*` secrets (`R2_S3_ACCOUNT_ID` / `R2_S3_ACCESS_KEY_ID` / `R2_S3_SECRET_ACCESS_KEY` / `R2_S3_BUCKET`, from Cloudflare Dashboard → R2 → Manage API Tokens). With all four set, `POST /api/agent/jobs/{id}/artifacts/presign` automatically switches to returning an S3-compatible presigned URL, and agents PUT straight to R2, bypassing the Worker's body-size limit entirely — the cap becomes R2's own single-PUT limit (roughly 5GB). **Recommended if you run any video templates**, since their output routinely exceeds 100MB and would otherwise fail to upload.
- **No publish-agent flow**: the self-hosted deployment's signed agent-update-publishing pipeline has no equivalent endpoint here yet. `GET /api/agent/version` exists, but defaults to `latest`/`min_supported` both `0.1.0` and every other field `null` — manage version info by hand via D1/Settings if you need it.
- The Hub Durable Object (long-lived connections + dispatch) uses the SQLite-backed flavor that's available on the free plan; at real scale (dozens-plus of workers) keep an eye on Cloudflare's usage dashboard.

### Differences from self-hosted

| Aspect | Self-hosted (`comfyfed-server`) | Cloud (`cloud/`) |
| --- | --- | --- |
| Runtime | Your own machine/VM, a long-running Python process | Cloudflare Workers, serverless |
| Database | Local SQLite file | Cloudflare D1 (SQLite-backed) |
| File storage | Local filesystem | Cloudflare R2 |
| Long-lived connections | In-process WebSocket manager | Durable Object (Hub) + hibernatable WebSockets |
| First-run setup | `comfyfed-server install` interactive wizard | The web console walks you through it (`POST /api/setup`; curl fallback above) |
| Deploy/update | `git pull` + restart the process yourself | `npm run deploy`, or Workers Builds auto-deploy |
| TLS | Bring your own reverse proxy (Caddy/nginx) | Handled automatically by Cloudflare |
| Artifact size cap | None (limited by local disk) | 100MB on the free plan (`direct` mode); raised to roughly 5GB (R2's single-PUT limit) by setting `R2_S3_*` — recommended for video output |
| Agent | `comfyfed-agent` | The same `comfyfed-agent`, only `platform_url` differs |
| Cost | Host/bandwidth costs | Can run at $0 within Cloudflare's free tier |
