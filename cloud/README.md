# ComfyFed Cloud

[繁體中文](#繁體中文) | [English](#english)

一般使用者導向的說明：[README.md](../README.md)（中文）｜ [README.en.md](../README.en.md)（English）。自架技術指南：[docs/SELF-HOSTING.zh.md](../docs/SELF-HOSTING.zh.md) ｜ [docs/SELF-HOSTING.en.md](../docs/SELF-HOSTING.en.md)。

---

## 繁體中文

### 這是什麼

`cloud/` 是 ComfyFed **唯一的伺服器實作**：一個 Cloudflare Worker（TypeScript），實作整套聯邦協議（worker 註冊、Ed25519 簽章請求、WebSocket 長連線握手、雙簽收據、雙語主控台）。這份 README 講的是把它部署到 Cloudflare 免費方案上，不需要自己顧一台 24 小時開機的伺服器；自架版（`npm run selfhost`／Docker 映像）跑的是**同一份 Worker**（Miniflare）、接的是**同一個 agent**——差別只在伺服器端跑在哪裡。原本的 Python 伺服器已於 2026-09-24 移除。

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

### 一鍵架站（2026-09-24）

```bash
cd cloud
npm install
npm run setup:cloudflare            # 互動
npm run setup:cloudflare -- --yes   # 非互動：沿用既有 secret、不問問題
```

一個指令依序做完下面手動步驟的全部：`wrangler whoami`（未登入就 `wrangler login`）→ `wrangler d1 create`（已存在就從 `d1 list` 取 id）→ 把 `database_id` 寫進 `wrangler.jsonc`（只動那一行，保留註解）→ `wrangler r2 bucket create`（已存在略過）→ 產生 `SETUP_TOKEN` 與 `PLATFORM_ED25519_SEED` 並 `wrangler secret put`（已存在會問要不要換；`--yes` 保留舊值）→ `npm run build` → `npm run deploy`（含 migration）。結束時印出 workers.dev 網址與 setup token。重跑是安全的，等於重新部署。資料庫與 bucket 名稱可用 `--db-name`／`--bucket` 改，`--skip-build` 跳過建置。

想自己掌控每一步（自己建 D1、自己設 secret）的話，下面的手動流程仍然有效。

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

**誠實註記**：agent 的 pytest（repo 根目錄的 `tests/`）在 Workers Builds 裡跑不了（建置容器不保證有 Python），它仍是**本機 push 前**的閘門；Builds 只守 cloud＋web 兩套。

### 接一台 worker（跟自架版完全同一套 agent）

1. 主控台登入後 → **Workers** → 新增 → 輸入名稱，畫面會給一行安裝指令（也可以從「手動安裝」摺疊區下載一次性註冊 bundle `bundle.json`）。`platform_url` 不用先設：沒設時平台用這次請求的來源網址；只有掛了自訂網域才需要到 **Settings** 改它。
2. 在要貢獻算力的機器上，跟自架版完全一樣：

```bash
pip install -e .            # 在 ComfyFed 專案根目錄；根目錄的 pyproject.toml 就是 agent
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
- **agent 版本隨部署自動發佈（2026-09-24）**：建置時 agent 會被打成 wheel 放進 `assets/agent/`，平台第一次被問到版本（agent 開機、或有人開 Workers 頁）就自動簽章並寫入 `agent_*` 設定，不需要手動 POST wheel。`POST /api/workers/agent-release` 仍保留作為手動覆寫（較高版本勝出）。主控台 Workers 頁的「更新」／「全部更新」可以遠端叫 0.1.18 以上的 agent 立刻更新。細節見 [docs/SELF-HOSTING.zh.md〈發布 agent 新版本〉](../docs/SELF-HOSTING.zh.md#發布-agent-新版本)。
- Durable Object（Hub，管長連線與派工）綁的是免費方案也能用的 SQLite-backed 版本，量體很大（數十台 worker 以上）時建議留意 Cloudflare 的用量儀表板。

### 跟自架版的差異

同一份 Worker、同一份程式碼，差的只有底下的執行環境與儲存：

| 項目 | 自架版（`npm run selfhost`／Docker） | Cloud 版（Cloudflare） |
| --- | --- | --- |
| 執行環境 | 你自己的機器/VM，Miniflare 跑同一份 Worker | Cloudflare Workers，無伺服器 |
| 資料庫 | D1 → 本機 SQLite（`<data-dir>/state/`） | Cloudflare D1（SQLite-backed） |
| 檔案儲存 | R2 → 本機目錄（`<data-dir>/state/`） | Cloudflare R2 |
| 長連線 | Durable Object（Hub）→ 本機 SQLite | Durable Object（Hub）+ hibernatable WebSocket |
| 首次安裝 | 開網頁輸入 log 印出的 setup token | 開網頁輸入 `SETUP_TOKEN`（`POST /api/setup`，curl 備用方案見上） |
| 部署/更新 | `docker pull` + 重啟容器（或 `git pull` 後重跑 `npm run selfhost`） | `npm run deploy`，或接 Workers Builds 自動部署 |
| TLS | 需要自己接反向代理（Caddy/nginx） | Cloudflare 自動處理 |
| 產出檔大小上限 | 無（受本機磁碟限制） | 100MB（免費方案，`direct` 模式）；設定 `R2_S3_*` 後拉高到約 5GB（R2 單次 PUT 上限），影片產出建議設定 |
| Agent | `comfyfed-agent` | 同一支 `comfyfed-agent`，只是 `platform_url` 不同 |
| 費用 | 主機/頻寬成本 | Cloudflare 免費方案額度內可 $0 運行 |

---

## English

### What this is

`cloud/` is ComfyFed's **only server implementation**: one Cloudflare Worker (TypeScript) implementing the whole federation protocol (worker registration, Ed25519-signed requests, a WebSocket handshake, dual-signed receipts, the bilingual console). This README covers deploying it to Cloudflare's free tier instead of a machine you keep powered on yourself. The self-hosted edition (`npm run selfhost` / the Docker image) runs the **same Worker** under Miniflare and talks to the **exact same agent** — only where the server side runs differs. The old Python server was removed on 2026-09-24.

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

### One-command setup (2026-09-24)

```bash
cd cloud
npm install
npm run setup:cloudflare            # interactive
npm run setup:cloudflare -- --yes   # non-interactive: keep existing secrets, no prompts
```

One command runs every manual step below in order: `wrangler whoami` (falling back to `wrangler login`) → `wrangler d1 create` (an existing database is looked up via `d1 list`) → write the `database_id` into `wrangler.jsonc` (only that line; comments are kept) → `wrangler r2 bucket create` (skipped if it exists) → generate `SETUP_TOKEN` and `PLATFORM_ED25519_SEED` and `wrangler secret put` them (existing secrets prompt before being replaced; `--yes` keeps them) → `npm run build` → `npm run deploy` (migrations included). It ends by printing the workers.dev URL and the setup token. Re-running is safe and amounts to a redeploy. `--db-name` / `--bucket` change the resource names and `--skip-build` skips the build.

If you want control over each step (create D1 yourself, set the secrets yourself), the manual walkthrough below still works.

### Create resources (D1 + R2)

```bash
npx wrangler d1 create comfyfed
```

This prints a `database_id` — paste it into `cloud/wrangler.jsonc`'s `d1_databases[0].database_id` (the committed id is the original deployment's; replace it with yours):

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

1. Log into the console → **Workers** → add → name it; the page gives you a one-line install command (or download the one-time registration bundle `bundle.json` from the "manual install" section). Setting `platform_url` first is not required: when unset the platform uses the request's own origin. You only need to change it in **Settings** after attaching a custom domain.
2. On the machine contributing GPU time, exactly as with the self-hosted version:

```bash
pip install -e .            # from the ComfyFed project root; the root pyproject.toml is the agent
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
- **Agent releases are automatic per deploy (2026-09-24)**: the build packages the agent into a wheel under `assets/agent/`, and the platform signs it and writes the `agent_*` settings the first time it is asked for the agent version (an agent starting up, or someone opening the Workers page). No wheel has to be POSTed by hand. `POST /api/workers/agent-release` remains as a manual override (a higher version wins). The console's Workers page has "Update" / "Update all" buttons that tell agents 0.1.18+ to update right away. Details in [docs/SELF-HOSTING.en.md, "Publishing an agent release"](../docs/SELF-HOSTING.en.md#publishing-an-agent-release).
- The Hub Durable Object (long-lived connections + dispatch) uses the SQLite-backed flavor that's available on the free plan; at real scale (dozens-plus of workers) keep an eye on Cloudflare's usage dashboard.

### Differences from self-hosted

Same Worker, same code; only the runtime underneath and the storage differ:

| Aspect | Self-hosted (`npm run selfhost` / Docker) | Cloud (Cloudflare) |
| --- | --- | --- |
| Runtime | Your own machine/VM, the same Worker under Miniflare | Cloudflare Workers, serverless |
| Database | D1 backed by local SQLite (`<data-dir>/state/`) | Cloudflare D1 (SQLite-backed) |
| File storage | R2 backed by a local directory (`<data-dir>/state/`) | Cloudflare R2 |
| Long-lived connections | Durable Object (Hub) backed by local SQLite | Durable Object (Hub) + hibernatable WebSockets |
| First-run setup | Open the page and enter the setup token printed in the log | Open the page and enter `SETUP_TOKEN` (`POST /api/setup`; curl fallback above) |
| Deploy/update | `docker pull` + restart the container (or `git pull` and re-run `npm run selfhost`) | `npm run deploy`, or Workers Builds auto-deploy |
| TLS | Bring your own reverse proxy (Caddy/nginx) | Handled automatically by Cloudflare |
| Artifact size cap | None (limited by local disk) | 100MB on the free plan (`direct` mode); raised to roughly 5GB (R2's single-PUT limit) by setting `R2_S3_*` — recommended for video output |
| Agent | `comfyfed-agent` | The same `comfyfed-agent`, only `platform_url` differs |
| Cost | Host/bandwidth costs | Can run at $0 within Cloudflare's free tier |
