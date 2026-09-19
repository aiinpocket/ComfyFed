# 用 AI 驅動 ComfyFed（API token ＋ MCP）

[English version →](MCP.en.md) ｜ [自架指南](SELF-HOSTING.zh.md) ｜ [回一般說明 README](../README.md)

ComfyFed 附一支 **MCP server**（`comfyfed-mcp`）：把整個聯邦包成一組工具給 AI 客戶端（Claude Code／Claude Desktop／Cursor …）呼叫。使用者只要用自然語言說「畫一張什麼」，AI 就去挑配方、送單、等結果、把檔案抓回本機——不用自己開 ComfyUI、不用拼節點圖。

認證用的是一枚 **API token**：在 console 的「設定」頁產生，30 天有效，可隨時撤銷。token 在 session 能用的 API 上等價於你本人（除了「管理 token」與「改密碼／登出」這幾條，那些只收 cookie）。

---

## 1. 安裝

`mcp` 套件是**選配**，要明確裝上去：

```bash
pip install "comfyfed[mcp]"
```

**如果這台機器本來就是 worker**（跑過一鍵安裝腳本），agent 已經在一個專屬的 venv 裡，直接裝進那個 venv 就好，不要另外裝一份：

```powershell
# Windows
& "$env:LOCALAPPDATA\ComfyFed\venv\Scripts\pip.exe" install "mcp>=2.0,<3"
```

```bash
# Linux / macOS
~/.comfyfed/app/venv/bin/pip install "mcp>=2.0,<3"
```

裝好之後這兩個路徑下就有 `comfyfed-mcp`（Windows 是 `...\ComfyFed\venv\Scripts\comfyfed-mcp.exe`，Linux／macOS 是 `~/.comfyfed/app/venv/bin/comfyfed-mcp`）——等一下註冊時用完整路徑指過去。

驗證裝好了沒：

```bash
comfyfed-mcp --version
```

沒裝 `mcp` 套件時 `comfyfed-mcp` 會印出安裝指引並以 **exit 2** 結束；設定不全（沒 token／沒網址）是 **exit 1**，兩種故障一眼分得出來。

## 2. 拿一枚 API token

1. 登入 console → **設定 / Settings** → **API token／AI 存取** 區塊。
2. 填一個名稱（例如 `claude-code`）→ 按**產生**。明文 token **只顯示這一次**（`cft_` 開頭），關掉就再也看不到。
3. 按**下載設定檔**，拿到 `comfyfed-mcp.json`：

   ```json
   {"platform_url": "https://your-platform.example", "token": "cft_...", "expires_at": "..."}
   ```

4. 把它存成 **`~/.comfyfed/mcp.json`**（Windows 是 `%USERPROFILE%\.comfyfed\mcp.json`）。`comfyfed-mcp` 預設就讀這個檔。

三種給法（依序套用，後面的覆蓋前面的）：

| 給法 | 說明 |
| --- | --- |
| `~/.comfyfed/mcp.json` | 預設。console 下載的那個檔，改名放好就行 |
| `COMFYFED_TOKEN_FILE` | 指到同格式 JSON 的**別的路徑**（等同 `--token-file`） |
| `COMFYFED_TOKEN` | 直接給明文 token（覆蓋檔案裡的），可搭配 `COMFYFED_PLATFORM_URL`（等同 `--platform-url`） |

**平台網址**依序找：`mcp.json` 的 `platform_url` → `COMFYFED_PLATFORM_URL` → **已註冊過的 worker 的 `~/.comfyfed/agent.json`**（取 `platforms[0].platform_url`）。所以在一台已經是 worker 的機器上，只要有 token，網址完全不用填。

token 與網址都齊了，`comfyfed-mcp` 啟動時會往 stderr 印一行 `comfyfed-mcp <版本>: <平台網址> (settings: mcp.json)`——**只印來源，永遠不印 token**。

## 3. 註冊這個 MCP server

**Claude Code**：

```bash
claude mcp add comfyfed -- comfyfed-mcp
```

**Claude Desktop／Cursor**（設定檔的 `mcpServers` 區塊）：

```json
{
  "mcpServers": {
    "comfyfed": {
      "command": "comfyfed-mcp"
    }
  }
}
```

`comfyfed-mcp` 不在 PATH 上（例如裝在 worker 的 venv 裡）時，把 `command` 換成完整路徑；要指定別的 token 檔或別的平台時，多給 `"args": ["--token-file", "D:\\keys\\a.json"]` 或 `"args": ["--platform-url", "https://other.example"]`。傳輸固定是 **stdio**，沒有 SSE／HTTP。

## 4. 配方（recipe）

配方是平台端**實測跑得動**的固定工作流加上少數幾個參數。AI 只挑配方、填參數，不組節點圖——所以不會生出一張沒有 worker 跑得動的圖。`GET /api/recipes`（MCP 的 `list_recipes`）依固定順序回傳，**第一個就是預設配方**。

| 順序 | id | 用途 | 參數 | `nsfw_ok` |
| --- | --- | --- | --- | --- |
| 1 | **`chroma-t2i`**（預設） | 文生圖，Chroma1-HD（Flux 架構、權重本身不審查） | `prompt`（必填）、`negative`、`width`／`height`（預設 1024，256–2048，step 16）、`steps`（預設 26，1–60）、`cfg`（預設 3.5，0–20）、`seed`（-1 = 隨機） | ✅ true |
| 2 | **`h3-t2v`** | 文生影片（含音訊），MiniMax H3 ＋ 8 步 turbo LoRA、24 fps，文字編碼器用無審查的 heretic 版 | `prompt`（必填）、`seconds`（預設 5，1–10）、`width`／`height`（預設 1280×704，256–1536，step 32）、`steps`（預設 8，1–20）、`seed` | ✅ true |
| 3 | **`flux-t2i`** | 文生圖，官方 Flux.1-dev 權重（保留供對照） | `prompt`（必填）、`width`／`height`（預設 768）、`steps`（預設 8，1–50）、`guidance`（預設 3.5）、`seed` | ❌ false |

**`nsfw_ok` 是「模型本身會不會迴避露骨內容」的旗標，不是授權。** 官方 Flux dev 權重會迴避，所以 `flux-t2i` 標 false，也因此**不是**預設；預設的 `chroma-t2i` 與 `h3-t2v` 用的是不審查的權重。平台不會因為這個旗標改變任何政策，你自己的聯邦、你自己的規矩。

**預設配方第一次跑會先下載模型。** `chroma-t2i` 宣告了自動下載來源：聯邦裡沒有任何活著的 worker 持有 `Chroma1-HD-fp8mixed.safetensors`（**9.2 GB**，9 193 379 316 bytes，來自 huggingface.co 的 Comfy-Org 倉庫）時，`run_recipe` 會在建單**之前**先排一筆模型下載單，回應裡的 `model_fetch_jobs` 就不是空陣列：

```json
{"job_id": "...", "recipe_id": "chroma-t2i", "params": {...},
 "model_fetch_jobs": [{"name": "Chroma1-HD-fp8mixed.safetensors", "job_id": "...", "reused": false}]}
```

這時**先用 `model_fetch_status` 追每一筆下載的進度**（9 GB 在一般家用頻寬上可能要十幾分鐘），下載完、worker 回報庫存之後，原本那張圖才派得出去——中間它一直排在佇列裡，不是卡住。下載完成後再 `wait_for_job` 等結果就好。`list_recipes` 每一筆也有 `missing_models`，可以**事先**知道這個配方會不會先觸發下載。

`h3-t2v` 與 `flux-t2i` 沒有自動下載來源（權重太大或需要登入），模型得由管理員照[自架指南的「模型下載」](SELF-HOSTING.zh.md#模型下載)那張表放進 worker。

## 5. 工具與使用順序

| 工具 | 做什麼 |
| --- | --- |
| `platform_status` | 我是誰、token 何時到期、艦隊有哪些 GPU／VRAM |
| `list_workers` | 每台 worker 的硬體與模型數（完整版） |
| `list_recipes` | 配方清單與參數（**第一個是預設**），含 `missing_models` |
| `run_recipe` | 用配方送單 → `{job_id, recipe_id, params, model_fetch_jobs}` |
| `submit_workflow` | 送完整的 ComfyUI API-format workflow JSON（配方不夠用時才用） |
| `list_jobs` | 列出工作，最新的在前；`status` 可逗號分隔（`queued,running`） |
| `job_status` | 一張單的完整狀態，含 `attempt_errors`／`dispatch_info`／收據 |
| `wait_for_job` | 輪詢到結束（預設最多 600 秒），逾時回 `{"timed_out": true, ...}` |
| `download_results` | 把產出檔抓到本機，預設 `~/.comfyfed/results/<job_id>/` |
| `cancel_job` | 取消一張還沒結束的單 |
| `request_model` | 請艦隊下載缺的模型（**只接受 huggingface.co／civitai.com**） |
| `model_fetch_status` | 查下載單的進度 |

一般順序：

1. `platform_status` — 先確認連得上、token 還沒過期、有 worker 在線。
2. `list_recipes` — 挑配方；沒有特別理由就用第一個（預設）。
3. `run_recipe` — 送單。
4. 回應的 `model_fetch_jobs` 非空 → `model_fetch_status` 追下載進度。
5. `wait_for_job` — 等到 `done`／`failed`／`cancelled`。
6. `download_results` — 取檔。

配方真的不夠用（要特別的節點、要 img2img、要自訂流程）才用 `submit_workflow`，傳的是**完整的 API-format workflow JSON**；缺模型時用 `request_model`。

## 6. 常見錯誤

| 訊息 | 意思 | 怎麼辦 |
| --- | --- | --- |
| `auth.required`（HTTP 401） | token 過期（30 天）、已撤銷，或**改過密碼**（改密碼會讓所有 token 一起失效） | 回 console 設定頁產一枚新的，換掉 `~/.comfyfed/mcp.json` |
| `recipes.bad_params`（400） | 參數型別／範圍／step 不對，訊息會點名**第一個**出錯的參數 | 照 `list_recipes` 的 `params` 修；不要送未宣告的參數 |
| `recipes.not_found`（404） | 沒有這個配方 id | 用 `list_recipes` 回的 `id`，別自己拼 |
| `model_fetch.no_worker`（400） | 現在沒有 worker 可以下載（要在線、開 `auto_fetch_models`、agent ≥ 0.1.14、磁碟與 `max_fetch_gb` 夠） | 等有 worker 上線，或請管理員手動把模型放進 worker |
| `model_fetch.untrusted_url` / `gated` | 網域不在白名單，或來源要登入 | 只用 huggingface.co／civitai.com 的直接下載網址；受限模型請人工下載 |
| job 的 `error` 是「已在 N 台 worker 嘗試 M 次全部失敗 / failed on N workers…」 | 這張單被改派過，每台都失敗了 | 看 `job_status` 的 `attempt_errors`（每台各自的最後錯誤），通常是 VRAM 不足或缺自訂節點 |
| 工作一直 `queued` | 沒有合格的 worker（缺模型／缺節點／VRAM 不足），或正在等模型下載 | 看 `job_status` 的 `dispatch_info`；剛跑預設配方的話多半是那 9.2 GB 還在下載 |

token 只會出現在 `Authorization` header 裡：不進 log、不進任何工具的回傳值。撤銷（console 的「撤銷」鈕）立即生效，下一個請求就是 401。
