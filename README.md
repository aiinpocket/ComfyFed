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

### 工作自動評估

伺服器收到工作後會自動解析 workflow 需要的節點類別、模型檔案與（若已知）VRAM 需求，對每台候選 worker 給出：

- `eligible`：worker 具備所有必要節點與模型，可直接派工。
- `eligible_after_fetch`：worker 缺少的模型可以在聯邦內其他 worker 上取得（Phase 2 才會落地實際傳輸機制），且磁碟空間足夠容納。
- `ineligible`：附上白話原因，例如缺少節點類別、VRAM 不足、缺的模型在聯邦裡也找不到等。

### 內嵌工作流編輯器（`/comfy`）

不想自備 ComfyUI 也能拉工作流：平台可以直接把**官方 ComfyUI 前端**掛在 `/comfy`，你在瀏覽器裡拉好圖、按 Queue，工作就直接進聯邦排隊，跑完的圖也在同一個介面看。

前端靜態檔不隨套件安裝（那是 20 幾 MB 的 JS，API-only 的部署根本用不到），要先抓一次：

```bash
comfyfed-server fetch-comfy-ui --data-dir ./data
```

這個指令會去 PyPI 抓 `comfyui-frontend-package` 的 wheel（**版本與 sha256 都釘死在程式碼裡**，下載後先驗雜湊才解壓），把裡面的 `static/` 解到 `<data-dir>/comfy_frontend/`。已經抓過就直接跳過。抓完**要重啟伺服器**，`/comfy` 才會掛上去。

- `--version X` 可以指定別的版本，但那樣就**不驗 sha256**，也不保證跟本平台的 `/comfy/api` 相容（指令會警告你）。
- 還沒抓的時候，`/comfy` 會顯示一頁雙語說明，告訴你跑上面那行指令。
- `/comfy` 跟它的靜態檔都要**管理員 session**，沒登入一律導回 `/`（Console 登入頁）。

**再抓一次官方範本庫**（選用，但建議）：前端的 wheel 只有介面，不含 ComfyUI 官方那一整包起手式工作流。要的話再跑一行：

```bash
comfyfed-server fetch-comfy-templates --data-dir ./data
```

這會從 PyPI 讀 `comfyui-workflow-templates` 這個 meta 套件的相依，抓出對應版本的 `-json` 與 `-media-*` 子套件 wheel（每個都先比對 PyPI 自己回報的 sha256 才解壓），把裡面的 `templates/` 攤平到 `<data-dir>/comfy_templates_official/`。一次大約 **475 MB**，解出來約 105 MB，請留好硬碟空間與時間。

- `--version X` 可以指定別的 release，預設抓 PyPI 上最新的。
- 抓完**要重啟伺服器**（範本目錄在啟動時才會被讀到）。之後範本瀏覽器的側邊欄就會是「ComfyFed 自己的分類在前、官方分類在後」。
- 沒跑這行也不會壞：範本瀏覽器照樣開得起來，只是裡面只有 ComfyFed 內建的三支範本。
- 官方範本 JSON 送到瀏覽器之前，平台會**拿掉模型的下載網址與雜湊**。那些「Download」按鈕在單機 ComfyUI 是下載到跑圖的機器上，在 ComfyFed 卻是下載到**你自己的筆電**，對聯邦一點用都沒有。真的缺模型的時候，按下 Run 會被擋下來並附上「該去哪台 worker 放哪個檔」的中文指引。

抓完之後，登入 Console →「工作」頁，按主要按鈕「**開啟工作流編輯器**」就會在新分頁打開。原本貼 API JSON 的表單還在，收進同一頁的「改用貼上 API JSON」摺疊區。

⚠ **編輯器裡至少要有一台 worker 在線才會出現節點**：節點清單不是平台自己編的，而是所有**在線且未停用** worker 回報的 `/object_info` 聯集。全部離線的話節點面板會是空的——這是正常的，不是壞掉。

⚠ **節點清單是「聯集」，不代表任何一台 worker 都跑得動**：`/object_info` 把全部在線 worker 的節點併成一份，所以編輯器裡看得到的節點，可能分散在不同機器上。一張混用了 A 機獨有節點與 B 機獨有節點的圖**送得出去**（會建立工作、進佇列），但派工時對每一台 worker 都不合格，於是**一直卡在佇列裡**，不會有錯誤訊息。工作頁的「不合格原因」會說明缺什麼。`/comfy/api/object_info` 的回應帶了 `X-ComfyFed-Worker-Count` 標頭，是這份聯集來自幾台 worker。

⚠ **編輯器上方工具列有幾顆按鈕沒有後端**：**取消／中斷（Cancel、Interrupt）、清空佇列（Clear queue）、刪除歷史紀錄**這些動作在 ComfyFed 上都沒有對應的 API，按下去只會拿到 404。Phase 1.5 的相容層是唯讀的佇列與歷史：工作一旦送出就只能等它跑完或失敗。要停掉一個工作，目前得從 Console 或直接改資料庫處理。

目前的相容層只做到「拉圖 → 送工作 → 看結果」這條主線。編輯器裡幾個依賴單機 ComfyUI 的功能不會動：**存工作流到伺服器、Manager／自訂節點擴充、模型清單瀏覽**（模型在各個 worker 上，平台自己沒有）。工作流請用瀏覽器的匯出／匯入，或用 Console 的「貼上 API JSON」。編輯器的介面偏好（主題等）會存在 `<data-dir>/comfy_settings.json`。範本瀏覽器則是通的：預設裝的是 ComfyFed 自己的範本（見下一節），跑過 `fetch-comfy-templates` 之後，ComfyUI 官方那一整包也會併進同一個側邊欄。

**跟自備 ComfyUI 的關係**：兩者不衝突，是兩個入口。內嵌編輯器是「我沒有 ComfyUI，或懶得開」的路；如果你本機已經有 ComfyUI，照樣可以在自己那邊拉好工作流、用「Save (API format)」匯出，再貼進 Console 送出。真正跑圖的一律是聯邦裡的 worker（也就是各成員自己的 ComfyUI），平台本身不裝 ComfyUI、也不跑推論——`/comfy` 只是一層把官方前端的動作翻譯成聯邦工作的相容 API。

### 範本

第一次打開編輯器不知道從哪開始，就用範本。ComfyFed 內建三支**實戰跑過**的工作流，每一支都在畫布上用便條紙逐段標了「這個節點在幹嘛、你該改哪裡」，中英雙語。

**怎麼打開**：編輯器左側工具列的**範本／Browse Templates**（或功能表 Workflow → Browse Templates；空白畫布上也會有入口）→ 側邊分類選 **ComfyFed** → 點縮圖，它就會**複製一份**到畫布上變成新的未命名工作流。**改的是副本，範本本身動不到**，改壞了關掉重開一份就好。

三支範本：

| 名稱 | 是什麼 | 尺寸／步數 |
| --- | --- | --- |
| **武俠文生圖** | Flux 文生圖。就是 ComfyFed 第一次跑通聯邦派工用的那張圖，提示詞原封不動 | 768×768，8 步（很快，適合先熟悉流程） |
| **角色立繪** | 同一條 Flux 流程的直式版，專門生單一角色的定裝照 | 896×1152，20 步 |
| **參考圖生影片** | MiniMax H3 Ref2V：一張定裝照 →「同一個人」在動的影片，**自帶聲音** | 1152×640，141 格（約 6 秒），8 步（turbo LoRA） |

**改一個地方就能跑**：每支範本都有一個紫色群組框標著「只改這一區」，裡面就是提示詞節點（第三支還多一個參考圖節點）。其他三個群組框（載入模型／取樣／輸出）照著便條紙看就好，不用動。改完按右上角 **Run**，工作流就變成一個聯邦 job 排進佇列，跑完結果直接顯示在最右邊的輸出節點裡，Console 的「工作」頁也拿得到檔案與收據。

**附帶素材**：第三支範本要一張參考圖。平台會在啟動時把 `amyntas_ref.png` 放進 `<data-dir>/comfy_staging/`，所以 `LoadImage` 的下拉一開就選得到。要換成自己的圖，直接在 `LoadImage` 節點上傳（或把檔案拖進畫布）即可——上傳的檔案一樣進 staging，送單時才複製成那個 job 的輸入。

⚠ 範本用到的模型（`flux1-dev`、MiniMax H3 那幾顆、turbo LoRA）**必須有 worker 真的裝了**，下拉才選得到、工作才派得出去。沒有的話工作會建立成功但一直卡在佇列——原因看「工作」頁的不合格說明。

### 模型下載

全新安裝的 worker 沒有任何模型檔，範本等於是廢的。模型太大不會進 git，所以下面每個檔案都給兩條路：**官方載點**（HuggingFace 原始出處，優先用這條）與 **備份載點**（我們自己的 GCS 公開鏡像 `https://storage.googleapis.com/comfyfed-models/models/`，目錄結構鏡射 ComfyUI 的 `models/` 資料夾，官方站掛掉或要登入時的退路）。下載後照「放置路徑」欄放進 worker 的 `ComfyUI/models/` 底下對應子資料夾即可。

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

全部裝齊約 **80.3 GB**；只跑武俠文生圖／角色立繪兩支 Flux 範本約 **31.8 GB**，只跑參考圖生影片約 **40.5 GB**，兩支提示詞小幫手範本（圖生提示詞／文字生提示詞）共用同一顆模型，只需 **8.27 GB**。每支範本的畫布上也有一則「⓪ 缺模型？」便條紙，列出該範本自己需要哪幾個檔案。

**不用重啟**：放好檔案後不必重啟 ComfyUI 或 agent——agent 每 10 分鐘會自動重掃本機模型庫存並回報平台，工作評估之後就會自動轉綠。真的等不及的話，手動重啟 agent 可以讓它立刻生效。

### 發布 agent 新版本

伺服器端有一個發布指令，會把 wheel 複製到 `<data-dir>/releases/`、算好 sha256、用平台金鑰簽章，並把 `agent_*` 設定一次寫好：

```bash
comfyfed-server publish-agent dist/comfyfed_agent-0.2.0-py3-none-any.whl \
  --min-supported 0.1.0
```

（版本號預設從 wheel 檔名解析，可用 `--latest` 覆寫；`--min-supported` 不給就等於 `--latest`，代表舊版 agent 一律擋掉。）

發布完成後，agent 啟動時會去問 `/api/agent/version`，比對版本、下載 wheel、驗 sha256 與簽章，全部通過才安裝並重啟。**簽章內容是 `{版本}|{sha256}`**──把版本綁進簽章裡，就沒辦法拿舊版本的簽章去冒充新版本，避免被降版攻擊。

⚠ **平台簽章金鑰可以離線保管**（規格建議做法）：如果不想把 `data/keys/platform.key` 放在線上主機，可以不跑 `publish-agent`，改成在離線機器上自己對 `"{版本}|{sha256}"` 簽名，再手動把 `agent_latest`／`agent_min_supported`／`agent_wheel_url`／`agent_wheel_sha256`／`agent_wheel_sig` 五個設定寫進資料庫。agent 端的驗證方式完全一樣。

### 已知限制

- **失敗的工作不會產生收據**：收據只在 `job_done` 時建立，所以工作跑到一半失敗（或 worker 中途離線被 requeue）所耗掉的 GPU 時間不會計入貢獻報表。這段算力目前是「沒被記帳」的。
- **計費以實際執行秒數為準，不含排隊等待**：收據的 `gpu_seconds` 取 agent 量到的實際執行秒數（`exec_seconds`，從 ComfyUI `/queue` 第一次出現在 `queue_running` 算起）與牆鐘時間（`finished_at - started_at`）兩者較小值；agent 量不到（舊版 agent、跑太快沒觀察到、或 ComfyUI `/queue` 打不到）時退回牆鐘時間。這是刻意的：同一台 worker 可能同時服務本機使用與多個平台，若把排隊等待也算進 GPU 時間，會讓每個平台都重複計費同一段等待，破壞未來的分潤機制——因此其他平台（或本機）佔用 worker 的那段時間，不算進這份收據。

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

### Artifact hash verification

Every artifact a worker uploads carries its sha256 (`X-Artifact-SHA256`); the server recomputes the hash itself over the bytes it received and compares. A mismatch rejects the whole upload (`artifact.hash_mismatch`), the agent retries once automatically, and if it still doesn't match the job is marked failed rather than letting a corrupted or swapped file quietly land in storage. A verified hash is stored in the job's `result_hashes` and is visible via `GET /api/jobs/{id}`.

### Disk cleanup

After every job — success or failure — the worker discards whatever it staged for that job in its own memory/temp state. What actually accumulates on disk over time is local ComfyUI's own `input`/`output` directories: every job's reference assets get copied into `input`, and every render lands in `output`. Left alone, that fills the worker's disk.

To have the agent clean those up too, set in `agent.json`:

```json
{
  "comfy_output_dir": "D:/ComfyUI/output",
  "comfy_input_dir": "D:/ComfyUI/input"
}
```

With these set, the agent deletes a job's files ONLY once that job succeeded AND its artifact hashes were confirmed by the platform (reconstructing each output's path from the filename/subfolder ComfyUI's history reported, and refusing to touch anything outside the configured directories). Leave them unset and the agent skips this step entirely — it never guesses where ComfyUI's folders are. A failed job's ComfyUI-side outputs are always left in place so you can inspect what happened.

### Job assessment

When a job arrives, the server automatically extracts the node classes, model files, and (when known) VRAM needs from the workflow, and rules on each candidate worker:

- `eligible`: the worker already has every required node and model — dispatch directly.
- `eligible_after_fetch`: models missing on this worker are available from another worker in the federation (actual transfer lands in Phase 2), and there's enough free disk to hold them.
- `ineligible`: with plain-language reasons, e.g. missing node classes, insufficient VRAM, or missing models that no one else in the federation has either.

### Embedded workflow editor (`/comfy`)

You don't need your own ComfyUI to build a workflow: the platform can serve
the **official ComfyUI frontend** at `/comfy`. Wire up your graph in the
browser, press Queue, and the job goes straight into the federation's queue —
the results come back in the same interface.

The static bundle is not installed with the package (it's ~24 MB of
JavaScript that an API-only deployment never touches), so fetch it once:

```bash
comfyfed-server fetch-comfy-ui --data-dir ./data
```

That downloads the `comfyui-frontend-package` wheel from PyPI — **both the
version and its sha256 are pinned in the source**, and the digest is verified
before anything is extracted — and unpacks its `static/` tree into
`<data-dir>/comfy_frontend/`. Already fetched: it's a no-op. **Restart the
server** afterwards so `/comfy` gets mounted.

- `--version X` fetches a different release, but then the sha256 check is
  **skipped** and compatibility with this platform's `/comfy/api` is not
  guaranteed (the command warns about both).
- Until you fetch it, `/comfy` serves a bilingual notice page telling you to
  run the command above.
- `/comfy` and all of its assets require an **admin session**; without one you
  are redirected to `/` (the console login).

**Then fetch the official template library** (optional, but recommended): the
frontend wheel is just the UI — it does not carry ComfyUI's official starter
workflows. One more command:

```bash
comfyfed-server fetch-comfy-templates --data-dir ./data
```

That reads the `comfyui-workflow-templates` meta package's dependencies on
PyPI, downloads the matching `-json` and `-media-*` sub-package wheels (each
verified against the sha256 PyPI itself reports before anything is extracted)
and flattens their `templates/` trees into
`<data-dir>/comfy_templates_official/`. Budget roughly **475 MB** of download
for ~105 MB on disk, and a few minutes.

- `--version X` fetches a specific release; the default is the newest on PyPI.
- **Restart the server** afterwards — the library is picked up at startup.
  The template browser's sidebar then lists ComfyFed's own categories first
  and the official ones after them.
- Skipping this breaks nothing: the browser still opens, it just contains
  only ComfyFed's three built-in templates.
- Official template JSONs have their **model download URLs and hashes
  stripped** before they reach the browser. Those "Download" buttons fetch to
  the machine running the browser, which on a stock ComfyUI is the machine
  running the graph and here is **your laptop** — useless to the federation.
  When a model really is missing, pressing Run is refused with zh-TW
  guidance naming the file and the worker folder it belongs in.

Once it's there, log into the console, go to **Jobs**, and hit the primary
**Open workflow editor** button — it opens in a new tab. The old paste-the-API-JSON
form is still on that page, tucked into the "Paste API JSON instead" section.

⚠ **Nodes only appear when at least one worker is online.** The node catalogue
is not something the platform invents: it is the union of the `/object_info`
snapshots reported by every **online, enabled** worker. With the whole fleet
offline the node panel is empty — that's expected, not a bug.

⚠ **That catalogue is a union, so it does not describe any single worker.**
Nodes visible in the editor may live on different machines. A graph mixing a
node only worker A has with one only worker B has **submits fine** — the job
is created and queued — but it is ineligible for every worker individually, so
it simply **sits in the queue forever** with no error. The Jobs page's
ineligibility reasons explain what is missing. `/comfy/api/object_info`
returns an `X-ComfyFed-Worker-Count` header saying how many workers the union
came from.

⚠ **Several toolbar buttons in the editor have no backend.** **Cancel /
Interrupt, Clear queue, and deleting history entries** have no ComfyFed API
behind them and answer **404** when clicked. The Phase 1.5 compatibility layer
exposes the queue and history read-only: once a job is submitted it runs to
completion or failure. Stopping a job means going through the console or the
database.

The compatibility layer currently covers the main line only: build a graph,
queue it, see the results. Editor features that assume a single local ComfyUI
do not work — **saving workflows to the server, Manager / custom-node
extensions, and model browsing** (models live on the workers; the platform has
none). Export/import workflows through the browser instead, or paste the API
JSON into the console. Editor UI preferences (theme and so on) persist to
`<data-dir>/comfy_settings.json`. The template browser *does* work: out of
the box it is stocked with ComfyFed's own templates (next section), and once
you have run `fetch-comfy-templates` ComfyUI's upstream gallery is merged into
the same sidebar.

**How this relates to bringing your own ComfyUI**: they are two doors into the
same federation, not alternatives. The embedded editor is for "I don't have
ComfyUI here, or don't feel like launching it". If you already run ComfyUI
locally, keep building there, export with "Save (API format)", and paste it
into the console. Either way the actual rendering happens on federation
workers — each member's own ComfyUI. The platform itself never installs
ComfyUI and never runs inference; `/comfy` is only a compatibility layer that
translates the official frontend's actions into federation jobs.

### Templates

If you open the editor and have no idea where to start, start from a template.
ComfyFed ships three **production-proven** workflows, each annotated on the
canvas with sticky notes — in Traditional Chinese and English — explaining what
every stage does and which node you are supposed to edit.

**Opening the browser**: the **Browse Templates** entry in the editor's left
toolbar (also under Workflow → Browse Templates, and on the empty-canvas
screen) → pick the **ComfyFed** category in the sidebar → click a thumbnail.
That **clones** the template into a new untitled workflow; you edit the copy,
the template itself is never touched, so if you break it, close it and take a
fresh one.

| Template | What it is | Size / steps |
| --- | --- | --- |
| **Wuxia text-to-image** | Flux text-to-image — the exact graph (and prompt) of ComfyFed's first end-to-end federation run | 768×768, 8 steps (fast; good for learning the flow) |
| **Character portrait** | The same Flux pipeline in portrait orientation, for single-character reference sheets | 896×1152, 20 steps |
| **Reference to video** | MiniMax H3 Ref2V: one reference photo → a clip of the same person moving, **with generated audio** | 1152×640, 141 frames (~6s), 8 steps via the turbo LoRA |

**Change one thing and run.** Each template has a purple group box labelled
"only edit here" containing the prompt node (the video one also has the
reference-image node). The other three groups — load models, sampling, output —
are explained by the notes and need no edits. Press **Run**: the graph becomes
a federation job, and when a worker finishes, the result renders inside the
output node on the right and is also downloadable, with its receipt, from the
console's Jobs page.

**Bundled asset**: the reference-to-video template needs a reference image. The
server seeds `amyntas_ref.png` into `<data-dir>/comfy_staging/` at startup, so
the `LoadImage` dropdown resolves out of the box. To use your own, upload it on
the `LoadImage` node (or drop the file onto the canvas) — uploads land in the
same staging area and are copied into the job's inputs at submit time.

⚠ The models these templates name (`flux1-dev`, the MiniMax H3 set, the turbo
LoRA) must actually be installed **on a worker** for the dropdowns to offer
them and for the job to be dispatchable. Otherwise the job is created but sits
in the queue; the Jobs page's ineligibility reasons say what is missing.

### Model downloads

A fresh worker has none of these files, which makes the templates dead on
arrival. They are too large for git, so every file below comes with two
links: the **official** one (its HuggingFace home — prefer this), and a
**backup** on our public GCS mirror at
`https://storage.googleapis.com/comfyfed-models/models/`, whose layout
mirrors ComfyUI's `models/` directory and which is there for when the
official source is down or gated. Download a file and drop it under the
matching subfolder of the worker's `ComfyUI/models/`.

| File | Size | Target path | Official | Backup |
| --- | --- | --- | --- | --- |
| `flux1-dev.safetensors` | 22.17 GB | `models/diffusion_models/` | [Official](https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/flux1-dev.safetensors) (requires HuggingFace login + accepting the FLUX.1-dev license) | [Backup](https://storage.googleapis.com/comfyfed-models/models/diffusion_models/flux1-dev.safetensors) |
| `clip_l.safetensors` | 0.23 GB | `models/text_encoders/` | [Official](https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors) | [Backup](https://storage.googleapis.com/comfyfed-models/models/text_encoders/clip_l.safetensors) |
| `t5xxl_fp16.safetensors` | 9.12 GB | `models/text_encoders/` | [Official](https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp16.safetensors) | [Backup](https://storage.googleapis.com/comfyfed-models/models/text_encoders/t5xxl_fp16.safetensors) |
| `ae.safetensors` | 0.31 GB | `models/vae/` | [Official](https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/ae.safetensors) (requires HuggingFace login + accepting the FLUX.1-dev license) | [Backup](https://storage.googleapis.com/comfyfed-models/models/vae/ae.safetensors) |
| `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | 19.53 GB | `models/diffusion_models/` | [Official](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors) | [Backup](https://storage.googleapis.com/comfyfed-models/models/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors) |
| `qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors` | 14.61 GB | `models/text_encoders/` | [Official](https://huggingface.co/sakamakismile/Qwen3-VL-32B-Heretic-MiniMax-H3-NVFP4/resolve/main/qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors) | [Backup](https://storage.googleapis.com/comfyfed-models/models/text_encoders/qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors) |
| `minimax_h3_video_vae_fp16.safetensors` | 4.85 GB | `models/vae/` | [Official](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors) | [Backup](https://storage.googleapis.com/comfyfed-models/models/vae/minimax_h3_video_vae_fp16.safetensors) |
| `minimax_h3_audio_vae_fp32.safetensors` | 0.56 GB | `models/vae/` | [Official](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors) | [Backup](https://storage.googleapis.com/comfyfed-models/models/vae/minimax_h3_audio_vae_fp32.safetensors) |
| `minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors` | 0.91 GB | `models/loras/` | [Official](https://huggingface.co/drbaph/MiniMax-H3-Turbo-Lora-ComfyUI/resolve/main/minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors) | [Backup](https://storage.googleapis.com/comfyfed-models/models/loras/minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors) |
| `qwen3vl_4b_bf16.safetensors` | 8.27 GB | `models/text_encoders/` | [Official](https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_bf16.safetensors) | [Backup](https://storage.googleapis.com/comfyfed-models/models/text_encoders/qwen3vl_4b_bf16.safetensors) |

Everything together is about **80.3 GB**; the two Flux templates (wuxia,
character portrait) need about **31.8 GB**; the reference-to-video template
alone needs about **40.5 GB**; the two prompt-helper templates (image-to-
prompt, text-to-prompt) share a single model and need only **8.27 GB**. Each
template's canvas also carries a "⓪ Missing models?" note listing exactly
what that template needs.

**No restart required**: once the files are in place you do not need to
restart ComfyUI or the agent — it rescans its local model inventory every 10
minutes and reports back, and the job assessment turns green on its own.
Restart the agent if you want that to happen immediately instead of waiting.

### Publishing an agent release

The server ships a publish command that copies the wheel into
`<data-dir>/releases/`, computes its sha256, signs it with the platform key,
and writes all five `agent_*` settings in one go:

```bash
comfyfed-server publish-agent dist/comfyfed_agent-0.2.0-py3-none-any.whl \
  --min-supported 0.1.0
```

(The version is parsed from the wheel filename unless you pass `--latest`.
`--min-supported` defaults to `--latest`, which locks out every older agent.)

Once published, an agent asks `/api/agent/version` at startup, compares
versions, downloads the wheel, and installs it only if both the sha256 and
the platform signature verify. **The signed payload is `{version}|{sha256}`** —
binding the version into the signature means an old release's signature
cannot be replayed to advertise a newer version, so a downgrade attack does
not work.

⚠ **The platform signing key may be kept offline** (as the spec recommends).
If you would rather not keep `data/keys/platform.key` on the live host, skip
`publish-agent`: sign `"{version}|{sha256}"` yourself on an offline machine
and set `agent_latest`, `agent_min_supported`, `agent_wheel_url`,
`agent_wheel_sha256` and `agent_wheel_sig` by hand. The agent verifies them
identically either way.

### Known limitations

- **Failed jobs produce no receipt**: receipts are written only on
  `job_done`, so GPU time burned by a job that failed part-way through (or by
  a worker that dropped off and had its job requeued) never reaches the
  contribution report. That compute is currently unaccounted for.
- **Billing is actual execution seconds, not queue wait**: a receipt's
  `gpu_seconds` is `min(exec_seconds, wall_clock)`, where `exec_seconds` is
  the agent's own measurement (from the moment ComfyUI's `/queue` first
  reports the prompt under `queue_running` to completion) and `wall_clock` is
  `finished_at - started_at`. It falls back to the wall clock when
  `exec_seconds` is missing (an older agent, a run that finished before it
  was ever observed running, or an unreachable `/queue`). This is
  deliberate: one worker can serve local use plus several platforms at once,
  and billing queue-wait as GPU time would double-charge every platform for
  the same idle stretch, breaking future revenue sharing. Time a worker
  spends queued behind other platforms' (or local) work is excluded from
  this platform's receipts.

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
