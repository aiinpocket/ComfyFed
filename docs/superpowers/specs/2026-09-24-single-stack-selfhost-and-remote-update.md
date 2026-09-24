# 單一後端棧、一鍵架站、遠端更新 agent

日期：2026-09-24
狀態：已實作（含 §6，2026-09-24）
延伸：`2026-09-23-cross-backend-dispatch-design.md`

## 0. 背景

2026-09-24 的客觀評估點出三個結構性問題：

1. **平台端安裝太難**（4/10）：Cloudflare 版要 wrangler、D1、R2、secrets 四段手動；自架版要 Python、DDNS、TLS 反向代理。
2. **agent 版本要手動發佈**：push 不會發 wheel，worker 停在舊版是常態；主控台看得到「過舊」卻沒有按鈕可以處理。
3. **兩套後端（Python `server/` 與 TS `cloud/`）逐函數對齊**，每個功能做兩遍。

擁有者的決定：先把平台端安裝做簡單、主控台要能強制 agent 更新、後端收斂成一種語言。

## 1. 決定：後端只留 TypeScript，自架跑同一份 Worker

- **正式環境**已經是 `cloud/`（Cloudflare Workers）。agent 必須是 Python（它包著 ComfyUI、
  MPS shim 是 ComfyUI custom node），所以「同一語言」指的是**伺服器端只有一份實作**：
  `cloud/src`。Python `server/` 停止接收新功能，等自架路徑驗證完成後整個移除
  （§6）。
- **自架 = 用 Miniflare 跑同一份打包好的 Worker**。Miniflare 是 Cloudflare 自己的
  `workerd` 封裝（`wrangler dev`、vitest pool 都用它），D1 → 本機 SQLite、R2 → 本機
  目錄、Durable Object → 本機 SQLite，全部可持久化到 `--data-dir`。一份程式碼、一套
  測試（vitest 本來就在 Miniflare 裡跑），自架與雲端行為一致。
  - 誠實註記：Cloudflare 把 Miniflare 定位成開發工具，不是正式環境產品。對「熟人圈
    一台機器」的規模這是可接受的取捨；換來的是零重複程式碼。
- 兩條安裝路徑都是**一個指令**：
  - Cloudflare：`npm run setup:cloudflare`（§4）。
  - 自架：`docker run … ghcr.io/aiinpocket/comfyfed` 或 `npm run selfhost`（§3）。

## 2. 遠端更新 agent

### 2.1 wheel 隨每次部署自動發佈

現況：`POST /api/workers/agent-release` 要 admin 手動上傳 wheel、平台簽章後才更新
`agent_*` 設定。改成建置時就把 wheel 打進 Worker 的 assets：

- `cloud/scripts/build.mjs` 新增步驟 (e)：`buildAgentWheel()`（`build-wheel.mjs`）
  直接用 Node 把 `agent/comfyfed_agent/` 打成 PEP 427 wheel
  `comfyfed-<version>-py3-none-any.whl`（純 Python、`py3-none-any`；zip 用
  `node:zlib` 的 raw deflate，不加依賴），版本取自 `agent/comfyfed_agent/__init__.py`
  的 `__version__`，並斷言它等於 `pyproject.toml` 的 `version`。`Requires-Dist` 取自
  `pyproject.toml` 的 `[project] dependencies`（§6 之後 pyproject 只描述 agent，所以
  就是 agent 真正需要的四個套件；§6 之前暫放在 `[tool.comfyfed] agent-dependencies`）。
  entry points 與 pyproject 的 `comfyfed`／`comfyfed-agent`／`comfyfed-mcp` 相同。
- 輸出到 `cloud/assets/agent/<wheel>` 與 `cloud/assets/agent/release.json`
  （`{"version","filename","sha256"}`）。`/agent/*` 不在 `run_worker_first`，由
  ASSETS 直接服務；wheel 本來就是公開下載（安裝腳本在拿到任何憑證前就要抓）。
- Worker 端 `core/agent_release.ts`：`ensureBundledAgentRelease(env)` 讀
  `ASSETS /agent/release.json`（每個 isolate 只查一次），若其版本**高於**目前
  `agent_latest` 設定，就用平台金鑰簽 `{version}|{sha256}` 並寫入五個 `agent_*`
  設定（`agent_wheel_url = /agent/<filename>`；`min_supported` 照既有政策不自動
  上調）。`GET /api/agent/version` 與 `GET /api/workers` 進入時呼叫它，所以任何一台
  agent 開機檢查、或任何人開 Workers 頁，都會讓新版生效。手動 `agent-release`
  端點保留，發更高版本時照樣勝出。

效果：push 到 main → Workers Builds 打包 wheel → 部署 → 下一次 agent 重啟即自動更新；
不再有「平台是新的、wheel 是舊的」。

### 2.2 主控台按鈕：立刻更新

- **協議**：平台 → agent `{"type": "update_agent"}`；agent → 平台
  `{"type": "update_ack", "status": s, "detail": d}`，`s ∈ {updating, deferred,
  up_to_date, declined, failed}`。
- **agent（0.1.18 起）**：收到 `update_agent` → 在執行緒跑 `update.check`：
  - 沒新版 → `up_to_date`。
  - `auto_update` 為 false → `declined`（機器擁有者的設定勝過遠端管理員；平台在
    別人的機器上不是 root）。
  - 正在跑工作 → `deferred`，記下 decision，該工作結束（成功、失敗或取消）後再套用。
  - 閒置 → `updating`，`apply_update(restart=noop)` 成功後以 `RESTART_EXIT_CODE`
    （75）結束程序，交給 launchd／systemd／launcher.ps1 重新拉起。這條路徑不能在
    執行緒裡 `SystemExit`（那只會殺掉執行緒），所以 `AgentLoop` 增加 `exit_code`
    屬性，`main._cmd_run` 在事件圈結束後以它 `sys.exit`。
  - 下載或簽章驗證失敗 → `failed`，繼續用舊版。
- **Hub DO** `/internal/update_worker`（POST `{worker_id}`）：找該 worker 的 socket，
  沒有 → 409 `workers.offline`；有 → 送出 `update_agent`，等 `update_ack` 最多 15 秒
  （pending map，webSocketMessage 收到就 resolve），逾時回 `{status: "sent"}`。
- **路由** `POST /api/workers/:id/update`（admin + CSRF）：先看 worker 列的
  `hardware.agent_version`，低於 `REMOTE_UPDATE_MIN_AGENT = "0.1.18"` → 409
  `workers.agent_too_old`（訊息：這台的 agent 太舊、不認得遠端更新，請在該機器重啟
  一次 agent，它會在啟動時自動更新）；否則轉呼叫 DO 並回傳 DO 的結果。
- **Workers 頁**：每列（admin）多一顆「更新」按鈕，只在 `agent_version < latest`
  且 online 時可按；上方多一顆「全部更新」對所有符合條件的 worker 逐台呼叫。結果
  以 notification 呈現各狀態的中英文說明。

## 3. 自架執行環境（`cloud/scripts/selfhost.mjs`）

```
npm run selfhost -- --data-dir ./data --port 8388 --url https://fed.example.com
```

1. 需要 `dist-selfhost/index.js`（`wrangler deploy --dry-run --outdir dist-selfhost`
   產生的正式打包）與 `assets/`；缺的話自動先跑 `npm run build` 與 dry-run。
2. `<data-dir>/selfhost.json`（0600）：第一次執行產生 `SETUP_TOKEN`（印出一次）與
   `PLATFORM_ED25519_SEED`；之後沿用。
3. `new Miniflare({...})`：`modules` 指向打包結果、`compatibilityDate/Flags` 與
   `wrangler.jsonc` 相同、`d1Databases {DB}`、`r2Buckets {STORE}`、
   `durableObjects {HUB: {className: "Hub", useSQLite: true}}`、`assets`（目錄、
   `run_worker_first`、`not_found_handling` 與 wrangler.jsonc 相同）、
   `bindings {MODE: "selfhost", SETUP_TOKEN, PLATFORM_ED25519_SEED}`、三個
   `*Persist` 都指到 `<data-dir>/state/…`。
4. 套用 `migrations/*.sql`：自維護 `d1_migrations(name, applied_at)` 表，依檔名排序
   套用未做過的（用 `D1Database.exec`），和 `wrangler d1 migrations apply` 同語意。
5. `--url` 給了且 `settings.platform_url` 未設 → 寫入（安裝 bundle 與 wheel URL 都靠它）。
6. 印出網址與（首次）setup token；SIGINT／SIGTERM → `dispose()`。

包裝：`cloud/Dockerfile`（multi-stage，runtime `node:22-slim`，`VOLUME /data`、
`EXPOSE 8388`）與 `.github/workflows/selfhost-image.yml`（push main → 推
`ghcr.io/aiinpocket/comfyfed:latest`）。TLS 仍建議 Caddy 或 `cloudflared tunnel`。

## 4. Cloudflare 一鍵架站（`cloud/scripts/setup-cloudflare.mjs`）

`npm run setup:cloudflare [--name comfyfed] [--yes]`：

1. `wrangler whoami`，未登入就 `wrangler login`。
2. `wrangler d1 create <name>`（已存在 → `d1 list --json` 取 id）→ 改寫 `wrangler.jsonc`
   的 `database_id`（只動那一行，保留註解）。
3. `wrangler r2 bucket create comfyfed-store`（已存在則略過）。
4. 產生 `SETUP_TOKEN`、`PLATFORM_ED25519_SEED` → `wrangler secret put`（已存在時
   詢問；`--yes` 保留舊值）。setup token 印出一次。
5. `npm run build` → `npm run deploy`；印出 workers.dev 網址與下一步（開網址輸入
   setup token；要接 GitHub 自動部署就 commit `wrangler.jsonc`）。

## 5. 文件

- README 的〈安裝〉A／B 兩段改寫成兩個一行指令；C（接 worker）與 D 不變。
- `docs/SELF-HOSTING.*`：〈快速開始〉改成自架＝Miniflare；〈發布 agent 新版本〉改成
  「隨部署自動」+ 主控台按鈕；Python 伺服器先標為停止維護，§6 完成後改為已移除。
- `cloud/README.md` 對應更新。

## 6. Python `server/` 的移除（已完成，2026-09-24）

自架路徑（§3）驗證完成、擁有者確認後，同日執行：

- `server/comfyfed_server/templates_data/` → `cloud/packaged/templates/`、
  `server/comfyfed_server/installers/` → `cloud/packaged/installers/`（git rename）；
  `cloud/scripts/build.mjs` 改從 `cloud/packaged/` 讀。`recipes/` 與 `panel_ext/comfyfed.js`
  只保留 `cloud/src/core/` 裡本來就有的那一份。
- 刪除 `server/`（含 alembic）與 `tests/server/`。伺服器測試只剩 `cloud/test/`（vitest）。
- `pyproject.toml` 縮成只描述 agent：`[project] dependencies` 是 agent 的四個套件，
  也是 `build-wheel.mjs` 寫進 wheel `Requires-Dist` 的唯一來源；`[project.scripts]`
  只剩 `comfyfed`／`comfyfed-agent`／`comfyfed-mcp`；`packages.find` 指向 `agent/`。
- `cloud/vitest.config.ts` 拿掉讀 `../server/…` 的 parity 檢查（`comfyfed.js` 與三支
  recipe 的逐位元比對）——沒有第二份可以比了；對應的 parity 測試一併移除。
- `tests/agent/test_identity.py` 拿掉對 server 的 import，只驗 agent 對 TypeScript
  伺服器的 `POST /api/agent/register` 契約。
- 文件（README、`docs/SELF-HOSTING.*`、`cloud/README.md`）改成只描述現存的單一伺服器。

## 7. 測試

- `cloud/test/agent_release.spec.ts`：bundled release 寫入設定並可驗簽；較低版本不
  降級；手動發佈更高版本勝出；沒有 release.json 時不動。
- `cloud/test/build-wheel.spec`（Node 端）：wheel 可被 Python `zipfile` 讀、RECORD
  雜湊正確、METADATA 版本正確（實際用本機 `python3 -m pip install --dry-run` 驗一次）。
- `cloud/test/hub-update.spec.ts` + `workers-update.spec.ts`：offline 409、太舊 409、
  ack 各狀態、逾時 `sent`。
- `tests/agent/test_update_message.py`：五種 ack、deferred 在工作結束後套用、exit code 75。
- `web/src/pages/Workers.test.tsx`：按鈕可見性與呼叫。
- 自架：`selfhost.mjs` 以 `--check` 模式啟動、`/api/ping`、`/api/setup` 走完、
  migrations 二次執行冪等；Docker 建置在 CI。
