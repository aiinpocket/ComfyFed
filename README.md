# ComfyFed

[English version →](README.en.md)

## 把朋友的顯卡串成一台大機器

ComfyFed 讓一群認識的人把各自的顯卡接在一起，誰有空就幫誰算圖。你不需要自己買一張頂級卡，也不需要學 ComfyUI 怎麼裝、節點怎麼接：打開瀏覽器，挑一支範本，改幾個字，按下 Run，剩下的事交給聯邦裡正閒著的機器。圖或影片跑完直接在網頁上看、下載。

整個圈子採邀請制。只有管理員發出的一次性連結可以加入，出圖的人和出算力的人互相看得到誰做了什麼。它為熟人圈設計，適合家人、同事、社團、工作室。

### 能做什麼

內建的工作流編輯器附 11 支現成範本，每支畫布上都貼了紅色便條，標出「只要改這裡」。沒碰過 ComfyUI 的人也能照著做出成品：

| 範本 | 做什麼 |
| --- | --- |
| 文生圖 | 用中文打一段想法，AI 先幫你寫成英文提示詞再生圖（預設是武俠場景，換掉就能畫任何題材） |
| 角色立繪 | 直式版文生圖，專門出角色定裝照 |
| 參考圖生影片 | 給一張照片、用中文寫鏡頭，讓照片裡的人動起來，自帶聲音 |
| NSFW 圖生影片 | 同上，但整條流程無審查：給一張成年人照片、用中文寫成人情節 |
| 首尾幀生影片 | 給第一格和最後一格，中間動作自動補出來 |
| 多影片串接 | 兩段影片接成一段，畫面聲音都接好 |
| 圖片開場影片 | 一張圖當片頭卡幾秒，接著播影片 |
| 影片截段 | 從影片裡剪出想要的片段 |
| 圖片放大 | 小圖放大成高解析度 |
| 圖生提示詞 | 上傳參考圖，自動寫出好用的英文提示詞 |
| 文字生提示詞 | 貼一段中文想法，整理成結構化英文提示詞 |

點開範本會複製一份到你自己的畫布，原始範本永遠改不壞。跑完的結果和紀錄都在主控台的「工作」頁。

### 為什麼值得架一套

- **一行指令入隊。** 管理員在主控台按「新增 worker」，拿到一行安裝指令，貼到那台電腦執行就完成。缺 Python、缺 ComfyUI 都會自動裝好，並設成開機自動啟動。不需要 sudo，不需要系統管理員權限。
- **不用開任何連接埠。** worker 只會主動連出去找平台，藏在家用 NAT 後面照常運作。
- **人在用電腦時自動讓路。** agent 偵測到你正在使用這台機器就暫停接新工作，你離開之後自動恢復。跑到一半的工作照常跑完。
- **算力貢獻有憑有據。** 每個工作跑完，worker 和平台各簽一次名產生收據。雙方都簽過的紀錄誰也改不了，Reports 頁直接看排行榜和分潤試算。
- **模型檔在成員間互傳。** 新機器缺的模型，圈子裡有人在線就能直接補齊，比大家各自去外面重抓快得多。路由器支援的話會自動開埠，不支援就維持區網分享。
- **缺模型自動補。** 平台掛保證的模型會自動下載，單一工作預設上限 20 GB，可調可關。
- **每人一個帳號。** 一般使用者只看得到自己的工作與作品，管理員看全體、管額度、管分帳。
- **AI 也能下單。** 附 MCP server，Claude Code、Claude Desktop、Cursor 這類工具可以用自然語言直接送單、等結果、抓檔案回本機。詳見 [MCP 指南](docs/MCP.zh.md)。
- **全程簽章。** 每次註冊、每個 API 呼叫、每條 WebSocket 連線都經過 Ed25519 簽章與防重放驗證。worker 還能設定節點白名單，別人送來的工作流在你機器上跑不了不該跑的東西。

### 兩種架法，同一份程式、同一支 agent

伺服器只有一份實作（`cloud/`，一個 Cloudflare Worker）。差別只在它跑在哪裡：

| | 自架（本地） | Cloudflare 雲端版 |
| --- | --- | --- |
| 跑在哪 | 你自己的電腦或 VM（Docker 或 Node.js），用 Miniflare 跑同一份 Worker | Cloudflare Workers，無伺服器 |
| 資料庫 / 檔案 | 本機 SQLite / 本機磁碟 | D1 / R2 |
| 網址 | 自備 DDNS 或固定 IP，TLS 自己接反向代理 | 部署完就有 `*.workers.dev` 網址，TLS 自動 |
| 費用 | 主機與頻寬 | 免費方案內可 $0 |
| 產出檔上限 | 受磁碟限制 | 100 MB，設 `R2_S3_*` 後約 5 GB |
| 更新方式 | `docker pull` 後重啟 | push GitHub 自動部署 |

兩邊跑的是同一份伺服器程式、同一套聯邦協議、同一支 `comfyfed-agent`。朋友的顯卡要接進來，步驟完全相同，`bundle.json` 裡的 `platform_url` 決定它連去哪裡。

---

## 安裝

以下依序是：架平台（A 或 B 擇一）、接 worker（C）、平台設定（D）。

### A. 自架（一台自己的電腦或 VM）

自架跑的是**和雲端版完全同一份程式**：Cloudflare 的 Worker 執行環境（Miniflare／workerd）在你的機器上跑，資料庫與檔案存在本機的 `data` 目錄。不需要 Python、不需要另外裝資料庫。

**需求**：Docker；或 Node.js 22 以上。

**Docker（建議）**

```bash
docker run -d --name comfyfed --restart unless-stopped \
  -p 8388:8388 -v comfyfed-data:/data \
  ghcr.io/aiinpocket/comfyfed:latest
```

第一次啟動會在 log 印出一組 **setup token**：

```bash
docker logs comfyfed
```

打開 `http://<這台機器>:8388`，輸入 token 並建立管理員密碼，就完成了。token 也存在 `/data/selfhost.json`，管理員建立後就不再需要。

**不用 Docker**

```bash
git clone https://github.com/aiinpocket/ComfyFed.git
cd ComfyFed/web && npm ci
cd ../cloud && npm ci
npm run selfhost -- --data-dir ./data --url https://your-domain.example
```

第一次執行會先建置主控台與 Worker（幾分鐘），之後每次啟動只要幾秒。setup token 一樣印在終端機。

**對外網址與 TLS**

伺服器只需要一個大家連得到的網址，DDNS 或固定 IP 都行；`--url` 把它記進平台設定（也可以之後在主控台 Settings 改）。建議前面放一層反向代理處理 HTTPS，Caddy 兩行搞定：

```
your-domain.example {
    reverse_proxy 127.0.0.1:8388
}
```

nginx 記得帶 `Upgrade` 和 `Connection` 標頭，agent 走的是 WebSocket 長連線。

**升級**：`docker pull ghcr.io/aiinpocket/comfyfed:latest` 再重啟容器（不用 Docker 的話 `git pull` 後重新執行 `npm run selfhost`）。資料庫 migration 會在啟動時自動套用；agent 的新版也會跟著這次升級一起發佈，worker 端不用碰（見下方「agent 更新」）。

**備份**：整個 `data` 目錄（Docker 的 `comfyfed-data` volume）。裡面的 `selfhost.json` 是平台的簽章金鑰與 setup token，請一併保管。

**參數**

| 參數 | 預設 | 說明 |
| --- | --- | --- |
| `--data-dir` | `./data` | 資料庫、上傳檔、產出物、金鑰的存放目錄 |
| `--port` | `8388` | 監聽埠 |
| `--host` | `0.0.0.0` | 監聽位址 |
| `--url` | 無 | 平台對外網址；第一次給就寫進設定，之後改請走主控台 Settings |
| `--check` | 關 | 啟動、打一次 `/api/ping` 就結束，用來確認安裝正常 |

Docker 版的這些參數都已經填好（`/data`、`8388`），改埠請改 `-p`。

**誠實註記**：Cloudflare 把 Miniflare 定位成開發工具而不是正式環境產品。對「幾個朋友、一台機器」的規模它完全夠用，換來的是自架與雲端零重複程式碼；它不是拿來扛大流量的。

### B. Cloudflare 雲端版

**需求**：Cloudflare 帳號（免費方案即可）、Node.js 20 以上。

```bash
git clone https://github.com/aiinpocket/ComfyFed.git
cd ComfyFed/cloud
npm install
npm run setup:cloudflare
```

這一個指令會依序：登入 Cloudflare（沒登入會跳瀏覽器）、建立 D1 資料庫與 R2 bucket（已存在就沿用）、把 `database_id` 寫進 `wrangler.jsonc`、產生並設定 `SETUP_TOKEN` 與 `PLATFORM_ED25519_SEED` 兩個 secret（已存在會問你要不要換）、建置主控台、套用 migration、部署。結束時印出網址（`https://comfyfed-cloud.<帳號>.workers.dev`）和 setup token。

打開網址，輸入 setup token 與想用的管理員密碼（至少 8 碼），就可以登入了。重跑同一個指令等於重新部署，是安全的。

**接 GitHub 自動部署（建議）**

先把改好的 `cloud/wrangler.jsonc` commit 進你的 repo，然後 Cloudflare Dashboard → Workers & Pages → 你的 Worker → Settings → Builds → 連接 repo：

| 欄位 | 值 |
| --- | --- |
| Root directory | `/cloud` |
| Build command | `npm run ci-build` |
| Deploy command | `npm run deploy` |
| Branch | `main` |

設好之後每次 push 就自動測試、建置、套 migration、部署。任何一個測試紅燈就不會上線。Node 版本由 `cloud/.node-version` 釘在 22。

**選填參數**

| 參數 | 在哪設 | 說明 |
| --- | --- | --- |
| `R2_S3_ACCOUNT_ID` `R2_S3_ACCESS_KEY_ID` `R2_S3_SECRET_ACCESS_KEY` `R2_S3_BUCKET` | `npx wrangler secret put` | 四個都設之後，agent 直接把產出檔 PUT 進 R2，單檔上限從 100 MB 拉到約 5 GB。**會跑影片範本就一定要設**。金鑰從 Dashboard → R2 → Manage API Tokens 取得 |
| 自訂網域 | Dashboard → Domains & Routes | 掛好之後記得把主控台 Settings 的 `platform_url` 改成新網域 |
| `npm run seed-official` | 命令列 | 把 ComfyUI 官方範本庫灌進 R2，主控台「從範本開始」才有東西選 |
| `npm run setup:cloudflare -- --yes` | 命令列 | 非互動：沿用既有 secret、不問問題 |

手動一步一步做（自己建 D1、自己設 secret）的流程仍在 [cloud/README.md](cloud/README.md)。

### agent 更新（兩種架法相同）

- **每次部署就是一次 agent 發佈**：建置時會把 agent 打包成 wheel 一起帶上平台，平台第一次被問到版本時自動簽章發佈。worker 端每次啟動都會檢查並自我更新，不再需要手動上傳 wheel。
- **主控台一鍵更新**：Workers 頁裡版本落後的 worker 會有「更新」按鈕（也有「全部更新」）。閒置中的 worker 立刻更新並自動重連；正在跑工作的會等做完再更新；機器擁有者在 `agent.json` 關掉 `auto_update` 的會回報「已略過」。0.1.18 以前的 agent 不認得這個指令，在那台機器重啟一次 agent 就會在啟動時自動更新。

### C. 接一台 worker

不論平台架在本地或 Cloudflare，步驟一樣。

**一行指令（推薦）**

管理員登入主控台 → Workers → 新增 → 輸入名稱，畫面會給三條指令，各附複製鈕。到要貢獻算力的機器上貼對應的那條：

```powershell
irm "<平台網址>/install.ps1?token=<一次性 token>" | iex
```

```bash
curl -fsSL "<平台網址>/install.sh?token=<一次性 token>" | bash
```

Windows cmd 也有對應版本。腳本會裝 Python、裝或偵測 ComfyUI、註冊、設開機自啟，全程不需 sudo。重跑同一行是安全的，已註冊的機器會跳過註冊、只升級 agent。既有的 `agent.json` 不會被動到。

**手動安裝（進階）**

主控台 Workers 頁的「手動安裝」摺疊區可以下載 `bundle.json`：

```bash
pip install -e .            # 在 repo 根目錄；根目錄的 pyproject.toml 就是 agent
comfyfed-agent register bundle.json
comfyfed-agent run
```

**agent.json 選填參數**

設定檔在 `~/.comfyfed/agent.json`（一行安裝的 Windows 機器在 `%LOCALAPPDATA%\ComfyFed\`）。改完要重啟 agent。ComfyUI 位址與資料夾會自動偵測，只有偵測不到時才需要手填。

| 鍵 | 預設 | 說明 |
| --- | --- | --- |
| `comfy_url` | 自動偵測 | 本機 ComfyUI 網址 |
| `models_dir` | 自動偵測 | 模型庫根目錄，自動下載與 P2P 只會落在這裡 |
| `comfy_output_dir` / `comfy_input_dir` | 自動偵測 | 工作跑完清理暫存檔用 |
| `node_policy` | `installed` | 節點白名單策略 |
| `whitelist_extra` | `[]` | 額外允許的節點類別 |
| `auto_update` | `true` | 啟動時檢查平台發布的新版並自我更新 |
| `hash_models` | `true` | 掃描模型時算 sha256，P2P 與自動下載都靠它 |
| `auto_fetch_models` | `true` | 缺模型時自動下載平台掛保證的檔案 |
| `max_fetch_gb` | `20` | 單一工作自動下載的總量上限 |
| `pause_when_active` | `true` | 有人在用電腦時暫停接新工作 |
| `idle_minutes` | `15` | 輸入靜止幾分鐘後算閒置 |
| `peer_serve` | `false` | 對其他 worker 分享模型檔。一行安裝時探到路由器肯開埠會自動打開 |
| `peer_listen_port` | 無 | 分享用的埠，安裝器預設探 8850 |
| `peer_bind_host` | `0.0.0.0` | 分享服務綁哪個介面 |
| `peer_advertise_host` | 自動偵測區網 IP | 對外通告的位址，自己轉埠時填這個 |
| `peer_nat_traversal` | `auto` | 自動請路由器開埠（NAT-PMP → UPnP）。`off` 完全不碰路由器 |
| `peer_upload_limit_mbps` | `20` | 有人在用電腦或手動暫停時的上傳限速（Mbps） |
| `peer_upload_limit_idle_mbps` | `0` | 閒置時的上傳限速，`0` 不限速 |

**命令列**

| 指令 | 做什麼 |
| --- | --- |
| `comfyfed pause` / `resume` | 手動暫停或恢復接單 |
| `comfyfed status` | 看目前狀態與原因 |
| `comfyfed stop` | 中斷手上工作並結束（等同 Ctrl-C） |
| `comfyfed-agent check-registration` | 確認平台是否仍接受這台機器 |
| `comfyfed-agent p2p-probe` | 先測路由器肯不肯開埠 |

一行安裝之後 `comfyfed` 在 PATH 上；手動安裝時同一支指令叫 `comfyfed-agent`。

### D. 平台設定（主控台 Settings，管理員）

| 設定 | 預設 | 說明 |
| --- | --- | --- |
| `platform_url` | 安裝時填的 | 對外網址，寫進每張註冊 bundle。換網域後要改 |
| `lang` | `en` | 介面語言 |
| `object_info_mode` | `union` | 編輯器節點清單取所有 worker 的聯集或交集 |
| `upload_max_file_mb` | `50` | 單檔上傳上限 |
| `upload_user_quota_gb` | `5` | 每人檔案總量 |
| `split_batches` | 開 | 多張圖的工作自動拆給多台 worker 平行跑 |
| `nsfw_check_api_key` | 空 | 填入 Anthropic API key 後啟用送單前的內容閘 |

同一頁還可以產生 API token（供 MCP 與腳本使用）。Users 頁可以替每個帳號個別覆寫額度。

---

## 專案結構

- `agent/` — Python worker agent（`comfyfed-agent`／`comfyfed`／`comfyfed-mcp`）。repo 裡唯一的 Python，根目錄的 `pyproject.toml` 就是它。
- `cloud/` — 伺服器，一個 Cloudflare Worker（TypeScript）。Cloudflare 與自架（Miniflare／Docker）跑的都是這一份；`cloud/scripts/` 有建置、`selfhost`、`setup:cloudflare` 等腳本。
- `cloud/packaged/` — 隨建置打包進平台的資料：內建工作流範本（`templates/`）與一行安裝腳本（`installers/`）。
- `web/` — 主控台（React），建置時打包進 Worker 的 assets。
- `tests/` — agent 的 pytest；伺服器的測試在 `cloud/test/`（vitest，跑在 Miniflare 裡），主控台的在 `web/`。
- `docs/` — 本文件、MCP 指南與設計規格（`docs/superpowers/specs/`）。

## 文件

- [自架技術指南](docs/SELF-HOSTING.zh.md) ｜ [English](docs/SELF-HOSTING.en.md)
- [Cloudflare 雲端版指南](cloud/README.md)
- [用 AI 驅動 ComfyFed（MCP）](docs/MCP.zh.md) ｜ [English](docs/MCP.en.md)
- 範本要用的模型下載清單：自架指南的「模型下載」一節

## 授權

[AGPL-3.0](LICENSE)
