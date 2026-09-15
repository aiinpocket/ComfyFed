# ComfyFed 自架指南（技術附錄）

[English version →](SELF-HOSTING.en.md) ｜ [回一般說明 README](../README.md)

這份文件是給要動手架站、寫設定檔、看 API 細節的人看的技術文件。如果你只是想知道 ComfyFed 是什麼、能拿來做什麼，請先看根目錄的 [README.md](../README.md)。

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

不想自架？也可以用 Cloudflare 版：見 [`cloud/README.md`](../cloud/README.md)，同一套聯邦協議跑在 Cloudflare 免費方案上，不用自己顧一台開機的機器。

### 多使用者與權限

登入現在是**帳號＋密碼**（不再是單一管理員密碼）。安裝精靈產生的第一個帳號固定叫 `admin`，角色是管理員。

**建立使用者**：以管理員身分登入 Console → **Users** 頁 → 建立使用者，輸入帳號名稱、選角色（管理員／一般使用者）。不指定密碼的話系統會產生一組隨機密碼，**只在建立當下顯示一次**（有複製按鈕），請立刻轉交給對方；忘記存下來也沒關係，之後可以在同一頁按「重設密碼」再拿到一組新的一次性密碼。

**角色差異**：

- **一般使用者**：只看得到自己送出的工作與產出物（Dashboard、Jobs、Reports 都只顯示自己的資料），Settings 只留改密碼與語言；看不到 Workers 頁、看不到別人的東西。
- **管理員**：Console 端看得到全部人的工作與統計，多了 Workers、Users、完整 Settings，以及貢獻／使用者用量／分潤試算三種報表。
- 內嵌的工作流編輯器（`/comfy`）**對所有角色都是個人工作區**：不論管理員或一般使用者，在面板裡都只看得到自己在面板送出的工作——要看全體流量，一律回 Console 的「工作」頁。

Users 頁的每個帳號都可以**停用／啟用**、**切換角色**、**重設密碼**；停用後該帳號的所有既有登入立即失效，之後也無法再登入。系統不提供刪除帳號（工作與收據紀錄要保留歸屬），且**最後一名有效管理員不能被停用或降級**，避免把自己鎖在外面。

**每人用量與分潤**：Reports 頁對管理員多了「**使用者用量**」（每個帳號各自的任務數、GPU 秒數）與「**分潤試算**」（輸入分潤池金額，依區間內各 worker 貢獻的 GPU 秒數比例算出各自分到多少）兩個分頁；一般使用者登入 Reports 只會看到屬於自己的「**我的用量**」。

**升級注意事項**：從舊版升級時，原本的管理員密碼會自動變成帳號 `admin`（**密碼完全不變**，不需要重設），既有的工作與收據也會全部歸到這個帳號名下——但因為登入用的 session 格式改變了，**升級後所有人都需要重新登入一次**（含 admin 本人），舊的登入 cookie 一律視為未登入，不做任何相容映射。自架（Alembic 遷移）與 Cloud 版（D1 migration 0006）都會在升級／部署時自動跑這段資料搬遷，不需要手動介入。

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

1. 在主控台 → **Workers** → 新增，輸入名稱後系統會產生一次性的註冊 token，並直接顯示三條一行安裝指令（Windows PowerShell／Windows cmd／Linux + macOS），各附複製按鈕。
2. 在要貢獻算力的那台機器上，貼上對應那一行貼到終端機執行。**不需要系統管理員／sudo**：Windows 用一般終端機即可（有系統管理員權限會用工作排程器設自啟，沒有就自動改用使用者層級的登錄檔 Run 鍵，效果相同）；Linux／macOS 請以一般使用者執行、**不要加 sudo**（整套裝在你的家目錄，root 執行會被腳本擋下）。腳本可安全重跑：已註冊過的機器會自動跳過註冊步驟。

```powershell
# Windows（PowerShell）
irm "<你的平台網址>/install.ps1?token=<一次性 token>" | iex
```

```cmd
:: Windows（cmd）
curl -fsSL "<你的平台網址>/install.cmd?token=<一次性 token>" -o install.cmd && install.cmd && del install.cmd
```

```bash
# Linux / macOS
curl -fsSL "<你的平台網址>/install.sh?token=<一次性 token>" | bash
```

（實際指令請直接從主控台複製，網址與 token 已經幫你填好。）

這一行指令會自動完成整套安裝：缺 Python 會自動安裝（Windows 走官方安裝器、Linux 依發行版用 apt/dnf、macOS 引導 Xcode CLT／官方 pkg）；找不到本機 ComfyUI 就連 ComfyUI 一起裝（釘死 v0.35.0，依 GPU 自動選 CUDA／CPU／MPS）；裝完會用 token 自動完成 `register`，並把整組（ComfyUI + agent）設成開機自動啟動、在背景執行，不需要再手動下指令。重跑同一行指令是安全的（冪等）：已經裝過的機器會修好任務排程／服務並升級 agent，不會重灌 ComfyUI。

**解除安裝**：

- **Windows**：`schtasks /Delete /TN ComfyFedAgent /F`（非系統管理員安裝則是 `reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v ComfyFedAgent /f`），再刪除 `%LOCALAPPDATA%\ComfyFed` 資料夾。
- **Linux**：`systemctl --user disable --now comfyfed-agent comfyfed-comfyui`，再刪除 `~/.comfyfed`。
- **macOS**：`launchctl unload -w ~/Library/LaunchAgents/com.comfyfed.agent.plist`（若有安裝 ComfyUI 再加一行 `com.comfyfed.comfyui.plist`），刪掉這些 `.plist` 檔，再刪除 `~/.comfyfed`。

#### 手動安裝（進階）

一行指令背後其實就是「裝 Python 套件 + 註冊」，需要自行掌控環境（例如已經有現成的 ComfyUI、想自訂 venv）時可以照舊手動做。主控台的「手動安裝（進階）」摺疊區塊仍可下載同一份 `bundle.json`：

```bash
pip install -e .
comfyfed-agent register bundle.json
comfyfed-agent run
```

`register` 會用 bundle 裡的一次性 token 向伺服器換發正式憑證，並把設定寫到 `~/.comfyfed/agent.json`；`run` 會連上所有已註冊的平台並開始接工作。手動流程不會幫你裝 ComfyUI 或設開機自啟，這些要自己處理。

**ComfyUI 的位置與資料夾會自動偵測**：註冊（與每次啟動）時 agent 會自己找本機的 ComfyUI——先試常見的埠（8188／8000 等），找不到就掃 8000–8399 並用 `/system_stats` 指紋確認；找到後再從 `/internal/folder_paths` 推導出模型庫（`models_dir`）與 ComfyUI 真正的 output／input 資料夾，一併寫進 `agent.json`。只有在完全找不到（ComfyUI 沒開、或跑在很冷門的埠）時才需要手動在 `agent.json` 填 `comfy_url`；你手動填過的值永遠不會被自動偵測覆蓋。

**要停掉 agent**：在它的終端機按 `Ctrl-C`（Windows 上 `CTRL_BREAK` 也可以）就會優雅關機——agent 會先請求 ComfyUI 中斷正在跑的工作、清掉暫存的檔案，確認收尾完成才結束程序，不會留下半殘的工作或垃圾檔案。

### 暫停與停止 / Pause & stop

Agent 內建 BOINC 風格的閒置偵測：**預設開啟**，只要偵測到使用者正在操作這台機器（滑鼠／鍵盤有輸入），就會暫停接新工作——正在跑的工作不受影響，會照常跑完，只是不會再接新的。也可以用 CLI 從另一個終端機手動控制同一個背景中的 agent：

```bash
comfyfed pause    # 暫停接新工作（跑到一半的工作照樣跑完）
comfyfed resume   # 恢復接新工作
comfyfed status   # 顯示目前狀態（available / paused-manual / paused-active，以及是否有工作在跑）
comfyfed stop     # 請 agent 優雅結束：進行中的工作會被取消並清理（等同在它的終端機按 Ctrl-C）
```

**`stop` 不會等工作跑完**：它跑的就是 `Ctrl-C` 那一套收尾——請 ComfyUI 中斷、清掉暫存檔、然後結束程序，那個工作會由平台在逾時後重新派給別台。想讓手上的工作跑完再停，請依序：`comfyfed pause` →（用 `comfyfed status` 等到不再顯示 `busy`）→ `comfyfed stop`。

（一行安裝指令裝好之後 `comfyfed` 就在 PATH 上；手動安裝時同一支指令叫 `comfyfed-agent`，兩者相通。）

**暫停功能需要平台版本 ≥ 本版本**：`paused` 是 0.1.2 才加進心跳的狀態，舊版平台看不懂、會當成沒收到而繼續派工。agent 是新的、平台是舊的時，暫停會靜靜地沒有效果——請先把平台端升級。

閒置偵測的參數寫在 `agent.json`：`pause_when_active`（預設 `true`）控制要不要偵測使用者活動；`idle_minutes`（預設 `15`）是「連續幾分鐘沒有任何鍵盤滑鼠輸入才算閒置」——距離最後一次輸入不滿這個分鐘數就視為使用者活動中、暫停接單，滿了才恢復接單。手動改完 `agent.json` 需要重啟 agent 才會生效。

**偵測不到使用者活動時視為閒置，一律接單**：headless 機器（沒有實體螢幕/鍵盤滑鼠）或 Wayland 桌面若沒有裝 XWayland，agent 偵測不到活動訊號，這種情況一律當作「沒有人在用」，不會因為偵測失敗就把 worker 晾在一邊接不到工作。

**Windows 找不到 `comfyfed` 指令**：剛裝完的那個終端機視窗看不到新加的 PATH，屬正常現象——關閉終端機重開一個新的即可。

**macOS／Linux 找不到 `comfyfed` 指令**：安裝器把指令連到 `~/.local/bin`，但 macOS 預設的 PATH（`/etc/paths`）和精簡版 Linux 映像都不含這個目錄（安裝器偵測到時會提示）。加進去即可：

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   # bash 請改 ~/.bashrc
exec $SHELL -l
```

### 任務分派：輕量工作優先派給弱卡

伺服器派工時不是隨機挑一台 worker：完全不需要模型的輕量工作（例如影片剪接、多影片串接這類純後製任務）會優先派給沒有獨立 GPU 或 VRAM 較弱的 worker（含 Mac／CPU-only 機器），把吃模型、吃 VRAM 的算圖工作留給真正的大卡。這樣一台筆電也能幫忙分擔，不會浪費 4090 去跑剪接。

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

### 產出物雜湊驗證

worker 上傳每個產出檔時會附上該檔案的 sha256（`X-Artifact-SHA256`），伺服器收到後自己重算一次雜湊比對——不符就整個上傳被拒（`artifact.hash_mismatch`），worker 會自動重傳一次；還是不符就直接把工作標記失敗，不會讓損毀或被調包的檔案悄悄入庫。驗證通過的雜湊會存進工作紀錄的 `result_hashes`，`GET /api/jobs/{id}` 可以查到。

### 磁碟清理

worker 每跑完一個工作（不管成功或失敗）都會清掉這個工作在 agent 端暫存的資料；但真正會持續佔用磁碟空間的是**本機 ComfyUI 自己的 `input`／`output` 目錄**——每個工作的參考圖會被複製進 `input`，每次算圖的結果又會落在 `output`，長期跑下去容易把 worker 的硬碟塞滿。

如果想讓 agent 幫忙清這兩個目錄，在 `agent.json` 設定：

```json
{
  "comfy_output_dir": "D:/ComfyUI/output",
  "comfy_input_dir": "D:/ComfyUI/input"
}
```

設定後，agent 只會在**該工作成功完成、且產出物雜湊已通過平台驗證**的前提下，才刪除這個工作對應的檔案（依 ComfyUI history 回報的檔名／子目錄組路徑，只刪確認存在、且路徑安全的檔案）；沒設定就完全略過、不動任何 ComfyUI 檔案。失敗的工作一律不刪 ComfyUI 端的產出，方便你事後查原因。

### 自動下載模型（選擇性）

平台可以把工作連同「需要但這台 worker 沒有的模型」一起派下來，讓 agent 在跑工作前自己補齊，而不是直接判 `ineligible`。**預設關閉**，要自己在 `agent.json` 打開：

```json
{
  "auto_fetch_models": true,
  "max_fetch_gb": 30,
  "hash_models": true
}
```

- `auto_fetch_models`（預設 `false`）：關閉時這台 worker 永遠不會被派帶 `fetch_models` 的工作，跟舊版行為一樣。
- `max_fetch_gb`（預設 `30`）：單次工作最多願意下載的總容量（GB）；超過上限或磁碟空間不夠都會直接拒絕下載，不會下到一半才失敗。
- `hash_models`（預設 `true`）：關掉的話 agent 完全不掃描、不計算本機模型的 sha256，連帶讓伺服器無法把這台機器上的模型收進可下載清單（別人也抓不到你這邊的模型），但也就不會自動下載模型给自己了。

**Curated 模型即使全聯邦零持有也會自動下載**：平台內建下載清單那 11 個 curated 模型（見下方「模型下載」那張表）本身帶有平台維運者背書的官方 sha256／檔案大小，不需要先有任何一台 worker 實際持有、回報過雜湊才能信任——這 11 個之外的模型才需要等聯邦裡至少一台 worker 回報過雜湊、大家一致（「共識」）才能進清單，一旦有 worker 真的回報了共識雜湊，共識一律優先於內建值。只要有 worker 開了 `auto_fetch_models` 且磁碟餘裕足夠，這種「目前零持有」的 curated 模型一樣會被指派下載，不會因為沒人持有就卡住；下載完成後照上面的規則立即回報，其他候選 worker 隨即能看到「這裡也有了」。挑哪台 worker 下載的準則就是磁碟餘裕與最小下載量（既有邏輯）——**不量測頻寬**，沒有以頻寬為依據的挑選機制。

**信任模型**：下載清單由平台簽章（Ed25519），agent 收到後先驗證簽章，每個檔案下載完再核對 sha256，兩者都過才會落地到 `models_dir` 底下對應的子資料夾；簽章或雜湊對不上就直接整批拒絕、不留半殘檔案。下載一律只落在 `models_dir`，agent 端有做路徑淨化，不會被清單條目寫到 `models_dir` 之外。

**worker 自己的下載額度也會影響能不能排隊**：hello 會把 agent 設定的 `max_fetch_gb`（見上方）回報給平台，若一台 worker 的額度不夠涵蓋某工作缺的模型總量，就不會被算進「可自動下載」——跟磁碟空間不夠時一樣。所以一個新聯邦只有一台 worker 開自動下載、額度是預設的 30 GB 時，送出需要超過 30 GB curated 模型集的工作（例如 FLUX.1-dev 系列工作流約 32 GB、MiniMax-H3 系列約 40 GB）會在送出當下就拿到可行動的 400 錯誤（附上模型名稱），而不是派工後下載到一半才失敗。把至少一台在線、已開自動下載的 worker 的 `max_fetch_gb` 調高即可解除。

**如果上游重新上傳了 curated 檔案（雜湊過期）會怎樣**：agent 一律核對下載內容跟**簽章雜湊**是否一致，所以過期的內建雜湊絕不會讓錯誤的檔案被當成正確的落地——失敗是乾淨的，只是會重複發生：每次有工作需要這個模型就會重新下載、驗證失敗、工作失敗，直到滿足以下其中一項為止：（a）平台的 curated 登記表（`model_guide.py`／`model_guide.ts` 的 `SOURCES`）被更新成官方最新的雜湊；或（b）聯邦裡任何一台 worker 真的下載／放入正確的最新檔案，並透過正常的庫存掃描回報其雜湊——該台 worker 回報的雜湊會成為一筆學習到的共識紀錄，從此永遠優先於內建的 guide 值（見上方「Curated 模型即使全聯邦零持有也會自動下載」），聯邦裡其他 worker 隨即都能從它下載。恢復只需要**任何一台**worker 用任何方式拿到正確檔案（手動下載、舊備份都行）並讓它正常掃描回報即可，不會有東西被永久卡死。

下載進度會顯示在主控台的工作卡片上（`stage: "fetching_models"` 搭配百分比與目前檔名）；下載完成後模型要等到下一輪（最多 10 分鐘一次）的本機掃描才會被伺服器記錄雜湊、正式視為「這台 worker 也有了」。

**雜湊衝突是永久的，需要手動恢復**：如果兩台 worker 為同名同大小的模型回報不同 sha256（通常代表其中一份檔案損毀或被調包），伺服器會記一筆 `model_manifest: sha256 conflict for ...` 的 WARNING 並把該筆 `model_hashes` 資料標成衝突（`conflict = 1`），從此永久排除在可下載清單之外——**不會**因為重啟或之後的正常回報自動恢復。確認哪一份是正確的之後，管理員需要手動在資料庫執行：

```sql
UPDATE model_hashes SET conflict = 0 WHERE name = '...' AND size_bytes = ...;
```

這個 phase 沒有做管理介面上的解衝突按鈕，只能這樣手動處理。

### 成員間 P2P 分塊傳輸

除了「官方載點 → GCS 備援」這條鏈，worker 之間也可以直接互傳模型檔：想跑某個工作但本機缺模型的 worker，會先向平台要一張「傳輸憑證」，向在線且已有該檔的另一台 worker 以 HTTP Range 逐 64 MiB 分塊拉取，拉不到才落回官方載點鏈。這條路徑帶來一個額外能力：**沒有官方下載網址的私有模型，只要當下有在線成員分享，也能被派工**——是否可派完全透明地反映在派工判定與工作頁的不合格原因裡，不會靜默失敗。

**開啟方式（預設關閉）**：每台 worker 自己決定要不要分享模型，在 `agent.json` 設定：

```json
{
  "peer_serve": true,
  "peer_listen_port": 8850,
  "peer_advertise_host": "your-lan-or-public-ip",
  "peer_bind_host": "0.0.0.0"
}
```

- `peer_serve`（預設 `false`）：關閉時完全不啟動分享用的 HTTP 服務，也不會在握手（hello）裡通告任何 peer 位址（僅握手時通告一次，不是每次心跳都帶）。
- `peer_listen_port`：必填才會真正啟用（只設 `peer_serve: true` 沒給埠號等於沒開）。這個 listener 是 agent 內建的 stdlib HTTP server，不另外裝依賴，只服務 `GET /peer/models/<檔名>` 這一條路徑；每個連線有 30 秒的 socket timeout，避免閒置連線一直占著執行緒。
- `peer_advertise_host`（選填）：不設的話 agent 會自動偵測區網 IP 來通告；如果 worker 在 NAT 後面而其他成員需要透過固定 IP／DDNS 連進來，在這裡指定對外可連到的位址。
- `peer_bind_host`（選填，預設 `"0.0.0.0"`）：listener 綁定的介面。**如果這台機器有公網 IP**（例如租用的 GPU 機器），預設值會讓分享服務直接暴露在網際網路上——想限制在區網／VPN 內，把這裡改成區網介面 IP（例如 `192.168.1.10`）或 `127.0.0.1`（僅搭配反向代理使用）。
- **防火牆記得放行 `peer_listen_port` 這個埠**，否則平台配對到你當種子後，拉方仍然連不進來（會落回官方載點鏈，不會卡住工作，但你這份模型等於沒發揮作用）。
- **分享與「停用接單」彼此獨立**：把 worker 在 Workers 頁停用（不再接新工作）不會影響它繼續分享已有的模型；反過來，`peer_serve: false` 只關閉分享，不影響它正常接工作。兩者可以任意組合。

**安全模型**：分享模型的每一次傳輸都要憑證，沒有任何匿名路徑。

- 拉方（已通過簽章驗證的 agent 請求）向平台要一張 **Ed25519 簽發的傳輸憑證**，**10 分鐘效期**，綁死單一檔案＋單一拉方＋單一種子——不是讓任何 worker 可以長期持有憑證到處跑，過期就得重新申請。
- 種子端（分享模型的那台 worker）**每一個請求都驗證**這張憑證：平台簽章、有沒有過期、`seeder_id` 是不是自己、檔名是否與本機庫存相符，缺憑證／驗簽失敗／過期／範圍不符一律 **fail-closed 回 403**，不洩漏任何細節（連「這個檔名存不存在」都不會用 404/403 的差異洩漏出去——沒有憑證一律 403）。
- worker 之間**不互留常駐信任**——今天你把模型分享給某個成員，不代表對方之後可以不憑證再連進來；每次傳輸都要平台重新核發。
- 逐塊 hash 只用來提早中止壞塊，**最終整檔 SHA-256 驗證永遠會做**，跟一般模型下載的鐵律一樣，分塊表本身不是信任來源。
- **傳輸目前走明文 HTTP**：憑證本身只授權「誰能拉哪個檔」，不代表內容有加密——`X-ComfyFed-Grant` 這個標頭跟模型內容的位元組，都是在明文 HTTP 上傳輸的。憑證本身就是唯一的存取憑證（bearer token），10 分鐘內任何看得到這個標頭的人都能冒充拉方把檔案拉走。如果你的成員之間走的是公開網路，建議只在可信任的 LAN 或 VPN（Tailscale、WireGuard 之類）裡開啟這項功能，不要對外網開放 `peer_listen_port`。
- **通告位址由 worker 自行申報，平台不代驗**：`peer_advertise_host`／自動偵測到的 IP 不會被平台反查或探測，一個惡意 worker 理論上可以申報一個平台或其他成員內網才連得到的位址（例如 `127.0.0.1`、`169.254.169.254`、其他 worker 的內網 IP），誘使其他 agent 對那個位址發出帶 Range 的 GET 請求。回應會因為簽章/格式不符而被丟棄，不會外洩任何資料，但這仍是一個未經地址過濾的請求轉發面——`peer_url` 的信任範圍就等於「這個 worker 本身的註冊信任範圍」，不多也不少。

**頻寬入帳**：種子 worker 完成一張憑證的服務量後會回報給平台，記入收據帳本（`kind: p2p_upload`，不計費、不算 GPU 秒數），Reports 頁的貢獻報表會多一欄「P2P 上傳量」；Workers 頁也會顯示這台 worker 目前是否在分享模型，以及通告出去的位址。

### 工作自動評估

伺服器收到工作後會自動解析 workflow 需要的節點類別、模型檔案與（若已知）VRAM 需求，對每台候選 worker 給出：

- `eligible`：worker 具備所有必要節點與模型，可直接派工。
- `eligible_after_fetch`：worker 缺少的模型可以透過平台簽章的下載清單取得，且磁碟空間足夠容納——來源包含聯邦內其他 worker 已持有、回報過共識雜湊的模型，**也包含全聯邦目前零持有、但屬於 curated 清單（帶平台背書雜湊）的模型**，兩者對 worker 端是同一套下載機制。
- `ineligible`：附上白話原因，例如缺少節點類別、VRAM 不足；模型類的 `ineligible` 現在會出現在兩種情況：平台**完全不認得**這個模型（不在 curated 清單、也沒人回報過共識雜湊、無可信雜湊可簽），**或雜湊有衝突**（見上方「雜湊衝突是永久的，需要手動恢復」）——即使是眾所皆知的 curated 模型，只要它的 `model_hashes` 那筆資料處於衝突狀態，一樣會被排除。

### 內嵌工作流編輯器（`/comfy`）

不想自備 ComfyUI 也能拉工作流：平台可以直接把**官方 ComfyUI 前端**掛在 `/comfy`，你在瀏覽器裡拉好圖、按 Queue，工作就直接進聯邦排隊，跑完的圖也在同一個介面看。

前端靜態檔不隨套件安裝（那是 20 幾 MB 的 JS，API-only 的部署根本用不到），要先抓一次：

```bash
comfyfed-server fetch-comfy-ui --data-dir ./data
```

這個指令會去 PyPI 抓 `comfyui-frontend-package` 的 wheel（**版本與 sha256 都釘死在程式碼裡**，下載後先驗雜湊才解壓），把裡面的 `static/` 解到 `<data-dir>/comfy_frontend/`。已經抓過就直接跳過。抓完**要重啟伺服器**，`/comfy` 才會掛上去。

- `--version X` 可以指定別的版本，但那樣就**不驗 sha256**，也不保證跟本平台的 `/comfy/api` 相容（指令會警告你）。
- 還沒抓的時候，`/comfy` 會顯示一頁雙語說明，告訴你跑上面那行指令。
- `/comfy` 跟它的靜態檔只要求**已登入**（任何角色皆可），沒登入一律導回 `/`（Console 登入頁）。面板是**個人工作區**：每個人在面板裡只看得到自己送出的工作與產物，包含 admin 本人在面板內也只看自己那份——要看全體，去 Console 的「工作」頁。

**再抓一次官方範本庫**（選用，但建議）：前端的 wheel 只有介面，不含 ComfyUI 官方那一整包起手式工作流。要的話再跑一行：

```bash
comfyfed-server fetch-comfy-templates --data-dir ./data
```

這會從 PyPI 讀 `comfyui-workflow-templates` 這個 meta 套件的相依，抓出對應版本的 `-json` 與 `-media-*` 子套件 wheel（每個都先比對 PyPI 自己回報的 sha256 才解壓），把裡面的 `templates/` 攤平到 `<data-dir>/comfy_templates_official/`。一次大約 **475 MB**，解出來約 105 MB，請留好硬碟空間與時間。

- `--version X` 可以指定別的 release，預設抓 PyPI 上最新的。
- 抓完**要重啟伺服器**（範本目錄在啟動時才會被讀到）。之後範本瀏覽器的側邊欄就會是「ComfyFed 自己的分類在前、官方分類在後」。
- 沒跑這行也不會壞：範本瀏覽器照樣開得起來，只是裡面只有 ComfyFed 內建的範本。
- 官方範本 JSON 送到瀏覽器之前，平台會**拿掉模型的下載網址與雜湊**。那些「Download」按鈕在單機 ComfyUI 是下載到跑圖的機器上，在 ComfyFed 卻是下載到**你自己的筆電**，對聯邦一點用都沒有。按下 Run 時，只要聯邦裡**有在線、未停用、開了 `auto_fetch_models` 且磁碟餘裕足夠**的 worker，curated 模型（見下方「模型下載」那 11 個內建模型）即使全聯邦目前零持有也會直接排隊、自動指派該 worker 下載，不會被擋下來；其他模型（範本庫收錄但非 curated 的，或工作流自帶的其他模型）沒有平台背書雜湊，仍要等聯邦裡至少一台 worker 實際持有並回報過雜湊才能進下載清單——**只有這種「平台完全不認得、聯邦裡也沒人有」的模型**才會被擋下並附上「該去哪台 worker 放哪個檔」的中文指引。

抓完之後，登入 Console →「工作」頁，按主要按鈕「**開啟工作流編輯器**」就會在新分頁打開。原本貼 API JSON 的表單還在，收進同一頁的「改用貼上 API JSON」摺疊區。

⚠ **編輯器裡至少要有一台 worker 在線才會出現節點**：節點清單不是平台自己編的，預設是所有**在線且未停用** worker 回報的 `/object_info` 聯集。全部離線的話節點面板會是空的——這是正常的，不是壞掉。

Settings 頁可以把 `object_info_mode` 從預設的「聯集」切成「**交集**」：交集模式下編輯器只會顯示**所有在線 worker 都有**的節點，下拉選單看到的東西保證每台都跑得動，代價是能用的節點變少；聯集模式節點比較齊全，但混用不同機器獨有節點的圖仍可能派不出去（見下一條）。

⚠ **聯集模式下，節點清單不代表任何一台 worker 都跑得動**：`/object_info` 把全部在線 worker 的節點併成一份，所以編輯器裡看得到的節點，可能分散在不同機器上。一張混用了 A 機獨有節點與 B 機獨有節點的圖**送得出去**（會建立工作、進佇列），但派工時對每一台 worker 都不合格，於是**一直卡在佇列裡**，不會有錯誤訊息。工作頁的「不合格原因」會說明缺什麼。`/comfy/api/object_info` 的回應帶了 `X-ComfyFed-Worker-Count` 標頭，是這份清單來自幾台 worker（交集模式下則是「幾台都有」的意思）。

**取消／中斷、清空佇列、刪除歷史都是真的可以用的**：編輯器上方工具列的**取消／中斷（Cancel、Interrupt）、清空佇列（Clear queue）、刪除歷史紀錄**這幾個按鈕都有對應的後端，按下去會真的取消聯邦裡的工作（worker 端也會收到中斷通知），不再是唯讀佇列。要注意的是**這些面板操作只影響「從面板送出」的工作**（`origin == panel`）：如果你是用 Console 的「貼上 API JSON」送單，要取消請到 Console 的「工作」頁操作。反過來，**Console 的「工作」頁／任務詳情頁可以取消任何來源的工作**（面板送的、Console 送的都算），是唯一涵蓋全部工作的取消入口。

目前的相容層做到「拉圖 → 送工作 → 看結果 → 取消／清理」這條主線。編輯器裡幾個依賴單機 ComfyUI 的功能不會動：**存工作流到伺服器、Manager／自訂節點擴充、模型清單瀏覽**（模型在各個 worker 上，平台自己沒有）。工作流請用瀏覽器的匯出／匯入，或用 Console 的「貼上 API JSON」。編輯器的介面偏好（主題等）會存在 `<data-dir>/comfy_settings.json`。範本瀏覽器則是通的：預設裝的是 ComfyFed 自己的範本，跑過 `fetch-comfy-templates` 之後，ComfyUI 官方那一整包也會併進同一個側邊欄。

**跟自備 ComfyUI 的關係**：兩者不衝突，是兩個入口。內嵌編輯器是「我沒有 ComfyUI，或懶得開」的路；如果你本機已經有 ComfyUI，照樣可以在自己那邊拉好工作流、用「Save (API format)」匯出，再貼進 Console 送出。真正跑圖的一律是聯邦裡的 worker（也就是各成員自己的 ComfyUI），平台本身不裝 ComfyUI、也不跑推論——`/comfy` 只是一層把官方前端的動作翻譯成聯邦工作的相容 API。

### 範本

ComfyFed 內建十支**實戰跑過**的工作流，每一支都在畫布上用便條紙逐段標了「這個節點在幹嘛、你該改哪裡」，中英雙語。一般使用者導向的清單（每支做什麼、怎麼用）在根目錄的 [README.md](../README.md) 裡；這裡只記錄開發／維運相關的細節。

**怎麼打開**：編輯器左側工具列的**範本／Browse Templates**（或功能表 Workflow → Browse Templates；空白畫布上也會有入口）→ 側邊分類選 **ComfyFed** → 點縮圖，它就會**複製一份**到畫布上變成新的未命名工作流。**改的是副本，範本本身動不到**，改壞了關掉重開一份就好。

十支範本（對應 `server/comfyfed_server/templates_data/index.json`）：

| 名稱 | 是什麼 | 尺寸／步數 |
| --- | --- | --- |
| **武俠文生圖** | Flux 文生圖。就是 ComfyFed 第一次跑通聯邦派工用的那張圖，提示詞原封不動 | 768×768，8 步 |
| **角色立繪** | 同一條 Flux 流程的直式版，專門生單一角色的定裝照 | 896×1152，20 步 |
| **參考圖生影片** | MiniMax H3 Ref2V：一張定裝照 →「同一個人」在動的影片，自帶聲音 | 1152×640，141 格（約 6 秒），8 步（turbo LoRA） |
| **首尾幀生影片** | 給第一格與最後一格畫面加一句動作描述，MiniMax H3 補出中間的動態與聲音 | 8 步（turbo LoRA） |
| **多影片串接** | 兩段影片首尾接起來，畫面與聲音都接。零模型 | — |
| **圖片開場影片** | 一張靜態圖當片頭卡片撐幾秒，再接一段影片播放。零模型 | — |
| **影片截段** | 從一段影片剪出「第幾秒開始、剪多長」的片段。零模型 | — |
| **圖片放大** | RealESRGAN 4 倍超解析度放大一張圖 | — |
| **圖生提示詞** | 上傳一張參考圖＋簡短需求，本地 Qwen3-VL 模型幫你寫出英文提示詞 | — |
| **文字生提示詞** | 貼一段粗略想法，同一顆 Qwen3-VL 模型幫你整理成結構化英文提示詞 | — |

**改一個地方就能跑**：模型導向的四組範本（武俠文生圖／角色立繪／參考圖生影片）用紫色群組框標「只改這一區」（提示詞節點，第三支還多一個參考圖節點）；其餘六支用更精簡的三組佈局（①②③ 便條），一樣照著便條紙改就好。改完按右上角 **Run**，工作流就變成一個聯邦 job 排進佇列，跑完結果直接顯示在最右邊的輸出節點裡，Console 的「工作」頁也拿得到檔案與收據。

**附帶素材**：需要參考圖／範例輸入的範本（參考圖生影片、圖生提示詞、圖片放大等）會在啟動時把對應素材放進 `<data-dir>/comfy_staging/`，所以 `LoadImage`／`LoadVideo` 的下拉一開就選得到。要換成自己的檔案，直接在節點上傳（或把檔案拖進畫布）即可——上傳的檔案一樣進 staging，送單時才複製成那個 job 的輸入。

⚠ 需要模型的範本，其模型**必須有 worker 真的裝了**，下拉才選得到、工作才派得出去。沒有的話工作會建立成功但一直卡在佇列——原因看「工作」頁的不合格說明。零模型的六支（多影片串接、圖片開場影片、影片截段等）在全新安裝、沒有任何模型的 worker 上就能直接跑。

### 模型下載

全新安裝的 worker 沒有任何模型檔，需要模型的範本等於是廢的。模型太大不會進 git，所以下面每個檔案都給兩條路：**官方載點**（HuggingFace／原始出處，優先用這條）與 **備份載點**（我們自己的 GCS 公開鏡像 `https://storage.googleapis.com/comfyfed-models/models/`，目錄結構鏡射 ComfyUI 的 `models/` 資料夾，官方站掛掉或要登入時的退路）。下載後照「放置路徑」欄放進 worker 的 `ComfyUI/models/` 底下對應子資料夾即可。

| 檔案 | 大小 | 放置路徑 | 官方載點 | 備份載點 |
| --- | --- | --- | --- | --- |
| `flux1-dev.safetensors` | 22.17 GB | `models/diffusion_models/` | [官方](https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/flux1-dev.safetensors)（需登入 HuggingFace 並同意 FLUX.1-dev 授權） | [備份](https://storage.googleapis.com/comfyfed-models/models/diffusion_models/flux1-dev.safetensors) |
| `clip_l.safetensors` | 0.23 GB | `models/text_encoders/` | [官方](https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors) | [備份](https://storage.googleapis.com/comfyfed-models/models/text_encoders/clip_l.safetensors) |
| `t5xxl_fp16.safetensors` | 9.12 GB | `models/text_encoders/` | [官方](https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp16.safetensors) | [備份](https://storage.googleapis.com/comfyfed-models/models/text_encoders/t5xxl_fp16.safetensors) |
| `ae.safetensors` | 0.31 GB | `models/vae/` | [官方](https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/ae.safetensors)（需登入 HuggingFace 並同意 FLUX.1-dev 授權） | [備份](https://storage.googleapis.com/comfyfed-models/models/vae/ae.safetensors) |
| `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | 19.53 GB | `models/diffusion_models/` | [官方](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors) | [備份](https://storage.googleapis.com/comfyfed-models/models/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors) |
| `qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors` | 14.61 GB | `models/text_encoders/` | [官方](https://huggingface.co/sakamakismile/Qwen3-VL-32B-Heretic-MiniMax-H3-NVFP4/resolve/main/qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors) | [備份](https://storage.googleapis.com/comfyfed-models/models/text_encoders/qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors) |
| `minimax_h3_video_vae_fp16.safetensors` | 4.85 GB | `models/vae/` | [官方](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors) | [備份](https://storage.googleapis.com/comfyfed-models/models/vae/minimax_h3_video_vae_fp16.safetensors) |
| `minimax_h3_audio_vae_fp32.safetensors` | 0.56 GB | `models/vae/` | [官方](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors) | [備份](https://storage.googleapis.com/comfyfed-models/models/vae/minimax_h3_audio_vae_fp32.safetensors) |
| `minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors` | 0.91 GB | `models/loras/` | [官方](https://huggingface.co/drbaph/MiniMax-H3-Turbo-Lora-ComfyUI/resolve/main/minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors) | [備份](https://storage.googleapis.com/comfyfed-models/models/loras/minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors) |
| `qwen3vl_4b_bf16.safetensors` | 8.27 GB | `models/text_encoders/` | [官方](https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_bf16.safetensors) | [備份](https://storage.googleapis.com/comfyfed-models/models/text_encoders/qwen3vl_4b_bf16.safetensors) |
| `RealESRGAN_x4plus.pth` | 0.06 GB | `models/upscale_models/` | [官方](https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth) | [備份](https://storage.googleapis.com/comfyfed-models/models/upscale_models/RealESRGAN_x4plus.pth) |

全部裝齊約 **80.3 GB**；只跑武俠文生圖／角色立繪兩支 Flux 範本約 **31.8 GB**，只跑參考圖生影片約 **40.5 GB**，兩支提示詞小幫手範本（圖生提示詞／文字生提示詞）共用同一顆模型，只需 **8.27 GB**；圖片放大只需 RealESRGAN 的 **0.06 GB**；多影片串接／圖片開場影片／影片截段三支不需要任何模型。每支範本的畫布上也有一則「⓪ 缺模型？」便條紙（零模型範本沒有這則便條），列出該範本自己需要哪幾個檔案。

**不用重啟**：放好檔案後不必重啟 ComfyUI 或 agent——agent 每 10 分鐘會自動重掃本機模型庫存並回報平台，工作評估之後就會自動轉綠。真的等不及的話，手動重啟 agent 可以讓它立刻生效。

### 發布 agent 新版本

伺服器端有一個發布指令，會把 wheel 複製到 `<data-dir>/releases/`、算好 sha256、用平台金鑰簽章，並把 `agent_*` 設定一次寫好：

```bash
comfyfed-server publish-agent dist/comfyfed_agent-0.2.0-py3-none-any.whl \
  --min-supported 0.1.0
```

（版本號預設從 wheel 檔名解析，可用 `--latest` 覆寫；`--min-supported` 不給就等於 `--latest`，代表舊版 agent 一律擋掉。）

發布完成後，agent 啟動時會去問 `/api/agent/version`，比對版本、下載 wheel、驗 sha256 與簽章，全部通過才安裝並重啟。**簽章內容是 `{版本}|{sha256}`**──把版本綁進簽章裡，就沒辦法拿舊版本的簽章去冒充新版本，避免被降版攻擊。

**雲端版（Cloudflare Workers）發布方式**：雲端沒有 CLI，改用管理員 API——登入後把 wheel 直接 POST 上去（wheel 存進 R2 的 `releases/`，簽章與五個設定的寫法與 CLI 完全相同）：

```bash
curl -X POST "https://<你的平台網址>/api/workers/agent-release?filename=comfyfed-0.1.0-py3-none-any.whl"   -H "X-CSRF: <登入拿到的 csrf>" -b cookies.txt   --data-binary @dist/comfyfed-0.1.0-py3-none-any.whl
```

發布後主控台 Workers 頁會出現「下載 Agent 安裝包」按鈕，任何人都能從 `/api/agent/releases/<檔名>` 下載（下載本身不需登入——完整性由 `/api/agent/version` 公告的 sha256＋平台簽章把關，和自架版一致）。

⚠ **平台簽章金鑰可以離線保管**（規格建議做法）：如果不想把 `data/keys/platform.key` 放在線上主機，可以不跑 `publish-agent`，改成在離線機器上自己對 `"{版本}|{sha256}"` 簽名，再手動把 `agent_latest`／`agent_min_supported`／`agent_wheel_url`／`agent_wheel_sha256`／`agent_wheel_sig` 五個設定寫進資料庫。agent 端的驗證方式完全一樣。

### 已知限制

- **計費以實際執行秒數為準，不含排隊等待**：收據的 `gpu_seconds` 由 agent protocol 2 保證的 `exec_seconds`（從 ComfyUI `/queue` 第一次出現在 `queue_running` 算起）與牆鐘時間（`finished_at - started_at`）兩者較小值構成；只有在 agent 端量不到 `exec_seconds`（舊版 agent、或 ComfyUI `/queue` 打不到）時才退回牆鐘時間，收據的 `basis` 欄位會標明這筆是 `exec` 還是 `wall`。這是刻意的：同一台 worker 可能同時服務本機使用與多個平台，若把排隊等待也算進 GPU 時間，會讓每個平台都重複計費同一段等待，破壞未來的分潤機制——因此其他平台（或本機）佔用 worker 的那段時間，不算進這份收據。
- **失敗／取消的工作會產生「不計費」收據，方便稽核但不計入貢獻總量**：工作失敗或被取消時，系統仍會建立一筆收據（`kind` 為 `failed` 或 `cancelled`、`billable=false`），保留這段時間花在哪裡的紀錄；但只有 `kind=completed`（`billable=true`）的收據才計入 Reports 頁的貢獻總量與排行榜。

### 後續規劃（Roadmap）

**Phase 2**
- 模型 manifest 分發機制（讓 `eligible_after_fetch` 真正落地傳輸模型）
- S3 / R2 相容的產出物儲存（artifact store）

**Phase 3**（**多使用者帳號＋多管理員、分潤試算已於 Phase 3.0 實作**：admin 可建立／管理其他使用者帳號，Reports 頁提供分潤試算（輸入分潤池金額，依 worker 貢獻比例試算），見上方「多使用者與權限」；**成員間 P2P 分塊傳輸已於 Phase 3.1（2026-09-14）實作**，見上方「成員間 P2P 分塊傳輸」；下面這項仍留待後續）
- ~~成員間 P2P 分塊傳輸~~ ✅ Phase 3.1
- 分潤／收益分帳帳本（目前的分潤試算只算比例、不落地實際撥款紀錄）

**ComfyFed Cloud**（已上線）：以 Cloudflare Workers + D1 + R2 建置的雲端託管版本，不需要自己顧一台開機的機器。用法見 [`cloud/README.md`](../cloud/README.md)。

### 授權

License：[AGPL-3.0](../LICENSE)。
