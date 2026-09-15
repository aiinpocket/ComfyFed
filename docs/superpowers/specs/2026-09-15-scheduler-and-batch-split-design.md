# 排程優化與批次拆分（Phase 3.3）設計規格

**日期**：2026-09-15
**狀態**：已定案（使用者 2026-09-15 核准「先做 A + B1；B1 必須保證結果前後一致，否則只做 A」；一致性已實測通過，見 §3.1）
**範圍**：A = 依 worker 特性派工（速度學習、模型熱快取親和、整體配對）；B1 = 單一 job 的 batch 拆給多台 worker 同時跑。B2（DAG 分割）不在本 spec。
**上游規格**：`docs/superpowers/specs/2026-09-12-comfyfed-spec.md`（§7 任務生命週期、收據定義）。本 spec 兩個技術棧（`server/` Python、`cloud/` Workers）都要實作，行為逐項對齊。

---

## 1. 現況與問題

派工在 `dispatch.assign_jobs`（Python）/ `assignJobs`（TS）：每 5 秒一個 tick，queued job 依 `created_at` 由舊到新，逐一對所有 idle worker 用 `assess.verdict` 篩資格，合格者排序鍵為 `(有警告, 重工作→-free_vram / 輕工作→(非弱後端, free_vram), name, id)`，取第一名原子 claim，一台 worker 一個 tick 最多拿一件。

問題：

1. 沒有「這台 worker 跑這種工作多快」的概念，只看 free VRAM。
2. 沒有模型熱快取概念：換 checkpoint 每次重載 5 到 30 秒。
3. 逐 job 貪婪：前面的輕工作會先搶走最大的卡，後面的重工作只能等下一個 tick。
4. 一件 job 只能落在一台 worker；`batch_size=4` 的圖有 4 台 idle 也只用一台。

## 2. 方案 A：依 worker 特性派工

### 2.1 工作簽章（signature）

送件時（`jobs.create_job` / `routes/jobs.ts` 與 `/comfy/api/prompt` 共用路徑）由 `assess.signature(workflow, needs)` 計算，存入新欄位 `jobs.signature`（TEXT，可為 NULL：舊資料列）。

簽章 = sha256（hex 前 16 碼）of canonical JSON：

```json
{
  "nodes": [["KSampler", 1], ["CLIPTextEncode", 2], ...],   // (class_type, 出現次數) 依 class_type 排序
  "models": ["flux1-dev.safetensors", ...],                  // = required_models（已排序）
  "steps": 24,                                               // 所有 KSampler/KSamplerAdvanced/BasicScheduler `steps` 字面值加總；找不到為 0
  "mpx": 3,                                                  // 所有 EmptyLatentImage/EmptySD3LatentImage 的 width*height 加總，除以 262144 取整（0.25 MPx 級距）
  "batch": 2                                                 // 同上節點 batch_size 加總；找不到為 1
}
```

`steps`/`mpx`/`batch` 只讀字面值（int），連到別的節點的輸入視為 0/1。同一張圖改 prompt 文字或 seed 不改簽章；改解析度、步數、模型會改。

### 2.2 統計資料

新表 `worker_job_stats`：

| 欄位 | 型別 | 說明 |
|---|---|---|
| worker_id | TEXT PK 之一 | |
| signature | TEXT PK 之一 | |
| ewma_seconds | REAL | 指數移動平均，α = 0.3 |
| samples | INTEGER | 已納入樣本數 |
| updated_at | DATETIME | |

新欄位 `workers.speed_index`（REAL，預設 1.0）：相對全隊的速度係數，1.0 = 平均；2.0 = 兩倍快。

新欄位 `workers.warm_models`（TEXT JSON array，預設 `[]`）：這台 worker 最近一次被指派的 job 的 `required_models`。在 claim 成功時寫入（不等 job 完成，因為載入發生在開始執行時）。

新欄位 `jobs.dispatch_info`（TEXT JSON，預設 `{}`）：claim 時寫入本次選擇的依據，供 console 顯示：

```json
{"predicted_seconds": 41.2, "basis": "signature" | "speed_index" | "fleet_default" | "none",
 "load_seconds": 12.0, "fetch_seconds": 0, "candidates": 3}
```

### 2.3 更新規則（job_done 帶有效 `exec_seconds` 時）

只在 `job_done`（完成收據）且 `exec_seconds` 有效時更新；failed/cancelled 不更新。

1. `stats[w][sig]`：無列 → 插入 `ewma = exec, samples = 1`；有列 → `ewma = 0.3*exec + 0.7*ewma, samples += 1`。
2. `speed_index[w]`：先算「隊伍參考值」`R(sig)` = 其他 worker（排除 w）該簽章 `ewma × speed_index` 的中位數；若沒有其他 worker 的資料則不更新。否則 `ratio = R(sig) / exec`，`speed_index = clamp(0.3*ratio + 0.7*speed_index, 0.1, 10)`。
3. 兩個技術棧都用同一組常數：`EWMA_ALPHA = 0.3`、`SPEED_MIN = 0.1`、`SPEED_MAX = 10`。

### 2.4 成本模型

對每個 (queued job j, idle worker w) 且 `verdict ∈ {eligible, eligible_after_fetch}`：

```
predicted_exec(j, w):
  1. stats[w][sig(j)] 存在                       → ewma；basis = "signature"
  2. 否則任一 worker 有 sig(j) 的資料             → R(sig) / speed_index[w]；basis = "speed_index"
  3. 否則有任何統計資料                           → 全部 stats 列 ewma 的中位數 / speed_index[w]；basis = "fleet_default"
  4. 否則                                         → 60；basis = "none"

load_seconds(j, w) = Σ size_gb(m) × LOAD_SEC_PER_GB(1.5)  for m in required_models(j) − warm_models(w)
                     （size 來自 w 的 model_inventory；找不到 size 視為 0）
fetch_seconds(j, w) = total_fetch_bytes / FETCH_BYTES_PER_SEC(50e6)   （只有 eligible_after_fetch 才 > 0）

light_penalty(j, w)（僅 is_light 的 job，即無 required_models 且無 est_vram）
                    = (backend ∉ {mps, cpu} ? 60 : 0) + free_vram_gb(w) × 5
warn_penalty(j, w)  = verdict.warnings 非空 ? 1_000_000 : 0

cost(j, w) = predicted_exec + load_seconds + fetch_seconds + light_penalty + warn_penalty
             + legacy_tiebreak(j, w)
legacy_tiebreak     = is_light ? free_vram_gb/1000 : (1000 - free_vram_gb)/1e6   （只用來打破完全相等）
```

分層規則保留：某 job 若有任何 tier 1（eligible）候選，tier 2（eligible_after_fetch）候選對該 job 一律視為不可用（cost = ∞）。這與現行「已經有模型的一定贏過要下載的」語意一致，既有測試不需推翻。

### 2.5 整體配對

一個 tick：

1. `requeue_stale`（不變）。
2. 取 queued jobs（`created_at ASC`，**排除 `split_count > 0` 的父 job**，見 §3），最多取 `min(64, 8 × idle 數)` 件，另外把等待超過 `STARVE_SECONDS = 300` 的一律納入。
3. 對每對 (j, w) 算 verdict 與 cost；不合格為 ∞。
4. 目標函數：最小化 Σ `(cost(j, w) − AGE_WEIGHT(1.0) × wait_seconds(j) − BIG(1e9))` over 被指派的配對。`BIG` 讓「多派一件」永遠優於「少派」；`wait_seconds` 讓等得久的優先；等待超過 `STARVE_SECONDS` 的再減 `1e8`，確保只要有合格 worker 一定本 tick 派出。
5. 以 Hungarian（Kuhn–Munkres，O(n³)，n = max(N, M)，方陣以 0 補齊）求解；∞ 的配對永不採用。**（2026-09-16 實作修訂）** 「∞」在實作中不是寫死的哨兵常數，而是動態算出的禁用格值 `M = (n+1) × range + 1`（`range` 為本次成本矩陣中有限值的極差），確保它必然大於任何一條可行配對路徑的總成本，Hungarian 才不會被寫死的哨兵值在極端輸入下誤判為可行。
6. 依結果逐一原子 claim（`WHERE status='queued'`，rowcount≠1 則跳過）；寫 `dispatch_info`、`workers.warm_models`。
7. 推送 `job` frame 的流程（含 `fetch_models` 重算）不變。

決定性：cost 相等時以 `(job.created_at, job.id, worker.name, worker.id)` 打破，兩棧結果一致；測試以固定 fixture 驗證同一輸入兩棧得到同一配對。

### 2.6 回填

Python：Alembic 新版本加欄位/表；`app` 啟動時若 `worker_job_stats` 為空且 `settings.stats_backfilled` 未設，對最近 500 筆 `kind='completed' AND billable=1` 的收據依 `created_at` 順序重放 §2.3（簽章缺的 job 先由 `workflow_json` 補算並寫回 `jobs.signature`），完成後設 `stats_backfilled=1`。
Cloud：D1 migration `0009_scheduler.sql`；回填在 Hub DO 第一次 tick 時做同樣的事（同一個 settings 旗標）。

## 3. 方案 B1：批次拆分

### 3.1 一致性依據（實測）

ComfyUI `comfy/sample.py::prepare_noise` 對 batch 用單一 generator 一次產生整批雜訊；當 latent 帶 `batch_index`（核心節點 `LatentFromBatch` 會設定），改為逐片產生並只保留指定片。2026-09-15 在本機 ComfyUI 0.34.5 / torch 2.12.1 實測：

- 純雜訊層：`prepare_noise(full)[i] == prepare_noise(slice, noise_inds=[i])` 對 5 種 shape 全部 `torch.equal` 為真（逐位元相同）。
- 端到端：Flux dev、512×512、4 步、seed 424242，`batch_size=2` 的第 2 張 vs `LatentFromBatch(batch_index=1)` 單獨跑：平均像素差 0.47/255（max 22、2.8% 像素差 >2），對照組不同張為 17.7/255。同一個人、同一構圖；差異屬 batch=2 與 batch=1 kernel 路徑的浮點雜訊，與「同一 job 落在不同 GPU」本來就存在的差異同等級。

結論：拆分保證與整批跑「同 seed 同構圖」。文件必須寫明「非逐位元一致，差異等同跨機器差異」。

### 3.2 可拆判定（`assess.split_plan(workflow) -> SplitPlan | None`，送件時計算）

全部條件成立才可拆：

1. 圖中**恰好一個**「批次來源」節點：`class_type ∈ {EmptyLatentImage, EmptySD3LatentImage}` 且 `inputs.batch_size` 為字面 int ≥ 2。
2. 圖中**沒有其他**節點帶 `batch_size` 輸入（不論值）。
3. 圖中每個節點的 `class_type` 都在 `SPLIT_SAFE_CLASSES` 白名單（逐元素或與 batch 無關的核心節點）：
   - 載入：`CheckpointLoaderSimple, UNETLoader, DualCLIPLoader, TripleCLIPLoader, CLIPLoader, VAELoader, LoraLoader, LoraLoaderModelOnly, ControlNetLoader, UpscaleModelLoader, CLIPVisionLoader, StyleModelLoader, CLIPSetLastLayer`
   - 條件：`CLIPTextEncode, CLIPTextEncodeSDXL, CLIPTextEncodeFlux, ConditioningCombine, ConditioningConcat, ConditioningSetArea, ConditioningSetAreaPercentage, ConditioningZeroOut, ConditioningSetTimestepRange, FluxGuidance, ControlNetApply, ControlNetApplyAdvanced`
   - 模型調整：`ModelSamplingFlux, ModelSamplingSD3, ModelSamplingDiscrete`
   - 取樣：`KSampler, KSamplerAdvanced, SamplerCustom, SamplerCustomAdvanced, RandomNoise, KSamplerSelect, BasicScheduler, BasicGuider, CFGGuider, DisableNoise`
   - Latent/影像：`EmptyLatentImage, EmptySD3LatentImage, VAEDecode, VAEDecodeTiled, VAEEncode, VAEEncodeForInpaint, SetLatentNoiseMask, LatentUpscale, LatentUpscaleBy, ImageScale, ImageScaleBy, ImageUpscaleWithModel, ImageInvert, ImageCrop, ImagePadForOutpaint, LoadImage, LoadImageMask, SaveImage, PreviewImage`
   - 任何不在名單的節點（含所有自訂節點、`ImageBatch`、`LatentBatch`、`RepeatLatentBatch`、`RebatchLatents`、影片節點）→ 不可拆。
4. 白名單以外的路徑不存在：所有 `KSampler*/SamplerCustom*` 的 latent 輸入沿 LATENT 邊往上追，最終都到達該批次來源（中間只允許白名單內會保留 latent dict 的節點）。
5. job `requirements.split !== false`，且平台設定 `split_batches`（預設 `true`）為真。
6. **（2026-09-16 實作修訂）** 圖中每一個 `SaveImage`／`PreviewImage` 節點都必須追得到該批次來源當祖先（沿所有 `inputs` 連結往上走，不限欄位、不限 slot，只避免循環）；否則視為不可拆。理由：條件 1-5 只約束「沿 latent 鏈能追到取樣器」的節點，擋不住一段完全由白名單節點組成、卻與批次來源無關的側支（例如單獨的 `LoadImage -> VAEEncode -> VAEDecode -> SaveImage`）——這種側支會在每個子任務裡各自渲染一次，造成輸出重複。

`SplitPlan = {source_node_id: str, batch_size: int}`，存入 `jobs.split_plan`（TEXT JSON，NULL = 不可拆）。

### 3.3 子 job 生成（`split.child_workflow(workflow, plan, start, length) -> dict`）

1. 深拷貝 workflow。
2. 新增節點 id `"cfsplit"`（若已存在則 `"cfsplit_1"`…）：
   `{"class_type": "LatentFromBatch", "inputs": {"samples": [source_node_id, 0], "batch_index": start, "length": length}}`
3. 所有原本引用 `[source_node_id, 0]` 的輸入改為 `["cfsplit", 0]`。來源節點本身的 `batch_size` **不改**（EmptyLatent 幾乎零成本，且 `LatentFromBatch` 需要整批 shape 才能算對片）。
4. `required_nodes` = 父的 + `"LatentFromBatch"`；`required_models`、`est_vram_gb`、`requirements`、`input_assets`、`origin`、`user_id`、`signature` 承襲父 job。`created_at` = 父的 `created_at`（保住在佇列中的位置）。

分片：k 個子 job，範圍連續：前 `B mod k` 個子 job 長度 `ceil(B/k)`，其餘 `floor(B/k)`；`split_index` 0..k-1。

### 3.4 資料模型

新欄位（jobs）：`parent_id TEXT NULL`、`split_index INTEGER NULL`、`split_count INTEGER NOT NULL DEFAULT 0`（父 job 的子數，0 = 非父）、`split_plan TEXT NULL`。

父 job 狀態由子 job 推導（`split.refresh_parent(parent_id)`，每次子 job 狀態/進度改變後呼叫，回傳父 job 是否改變與新狀態）：

| 子 job 狀態 | 父 job |
|---|---|
| 全部 queued | queued |
| 任一 assigned、無 running | assigned（`worker_id` = NULL） |
| 任一 running | running；`started_at` = 最早子 started_at；`progress` = 子 progress 平均 |
| 全部 done | done；`finished_at` = 最晚子 finished_at |
| 任一 failed | failed；`error` = 該子 error（前綴 `子任務 N/k：`）；其他未終止的子 job 以 `cancel_job(reason="sibling failed")` 取消 |
| 任一 cancelled（非因 sibling failed） | cancelled；其他子 job 一併取消 |

**（2026-09-16 實作修訂）** 串聯取消（不論由父 job 取消觸發、或由某個子 job failed/cancelled 觸發）對每個被牽連的子 job 寫入的欄位與直接呼叫 `cancel_job` 完全相同（`status`、`error`、`last_worker_id`、`worker_id`、`finished_at`），且 WS 層會對每一個受影響 job 目前的持有者各自推送一次 `job_cancelled`（不只推給觸發取消的那個 job 的 worker）。

父 job 的 `result_files` 欄位保持 `[]`；對外輸出改由 `split.parent_outputs(parent)` 組出 `[(child_id, filename), ...]`，依 `split_index` 再依子 `result_files` 順序，因此與整批一次跑的輸出順序一致。

### 3.5 派工中的拆分決策（tick 第 2 步與第 3 步之間）

```
consumed = 0
for j in queued（舊到新）:
    E = 對 j 合格的 idle worker 集合（verdict 過）
    if j 不可拆（split_plan NULL）:
        if E 非空: consumed += 1
        continue
    S = |E| − consumed            # 還沒被前面 job 預定走的合格 worker 數
    k = min(batch_size, S)
    if k >= 2:
        split j 成 k 個子 job（同一交易：插入子 job、父 job split_count = k）
        consumed += k
    elif E 非空:
        consumed += 1
```

拆分後重新讀取 queued 清單（子 job 取代父 job）再做 §2.5 的配對。當 tick 沒把所有子 job 都派出（verdict 重算或 claim 競爭），剩下的子 job 是普通 queued job，下個 tick 繼續派。

`consumed` 是估計而非精確保留（前面的 job 未必真的用掉 j 的合格 worker），寧可少拆不多拆：k 上限另外受 `MAX_SPLIT = 8` 限制。

### 3.6 取消、重試、失聯

- 取消父 job（console、`/comfy/api/interrupt`、`/queue` delete）→ 對每個未終止的子 job 執行 `cancel_job` 並推送 `job_cancelled` 給持有者；父 job 為 cancelled。**（2026-09-16 實作修訂）** 這個「執行 `cancel_job`」對每個子 job 寫入的欄位與直接呼叫 `cancel_job` 完全相同（`status`/`error`/`last_worker_id`/`worker_id`/`finished_at`），WS 層對每一個受影響 job 目前的持有者各自推送一次 `job_cancelled`。
- 取消子 job（console 直接對子操作）→ 父與其他子一併取消，寫入欄位與推送規則同上。
- 子 job 的 worker 失聯 → 現行 `requeue_stale` 讓子 job 回 queued，父 job 依 §3.4 重算（可能從 running 退回 assigned/queued，面板收到 `job_requeued(parent)`）。
- 重試（`retry`）父 job → 父 job 回 queued、`split_count = 0`、**`split_plan = NULL`**（重試一律不再拆，整包在一台 worker 跑，避免兩代子 job 混在一起）；舊子 job 不動（終止狀態，歷史保留），`parent_id` 仍指向父。所有以父 job 推導的函數（`refresh_parent`、`parent_outputs`、console 的 `children`）只在 `split_count > 0` 時看子 job；`split_count == 0` 的 job 一律當普通 job 處理（用自己的 `result_files`）。

### 3.7 對外呈現

- 收據：每個子 job 各自一張（現行流程不變）；父 job 沒有收據。console `GET /api/jobs/{id}` 對父 job 回 `receipt: null`、新增 `children: [{id, split_index, status, worker_id, progress, gpu_seconds, error}]` 與 `gpu_seconds_total`（子 billable 收據加總）。報表（`/api/reports/*`）以收據為準，不受影響。
- console `GET /api/jobs` 預設只列 `parent_id IS NULL` 的 job；父 job 多帶 `split_count`。加 `?include_children=1` 可列全部。
- 面板（`/comfy/api/*`）：`/history`、`/queue`、`executed`、`progress` 事件都只看父 job；子 job 對面板不可見（`parent_id IS NULL` 過濾），`panelws` 不對帶 `parent_id` 的 job 發事件，改為子 job 每次狀態變更後對父 job 發對應事件。`job_outputs(parent)` 產生 `{"filename", "subfolder": <child_id>, "type": "output"}`，`/view` 以 subfolder 找到子 job（同 user、同 origin 授權檢查照舊）。
- Web UI：任務列表父 job 顯示「拆分 ×k」徽章與整體進度；任務詳細頁列出子 job 表（序號、worker、狀態、進度、GPU 秒）與 `dispatch_info`（預估秒數與依據）。i18n zh-TW/en。
- 設定：`split_batches`（bool，預設 true）加入平台設定 API 與設定頁；job `requirements.split`（bool）可對單一 job 關閉。

## 4. 不做的事（YAGNI）

- 不改 agent（協定不變；`LatentFromBatch` 是核心節點，agent 端 node policy `installed` 已允許）。
- 不做 B2 DAG 分割。
- 不做 fetch 頻寬量測（用常數 50 MB/s）。
- 不做跨 tick 的預留（reservation）；`consumed` 估計已足夠。
- 不做多 job 同時在一台 worker（ComfyUI 本身序列執行）。

## 5. 錯誤處理

- 統計更新失敗（DB 例外）只記 log，不影響 job_done 主流程與收據。
- Hungarian 輸入含 NaN/負值 → 以 ∞ 處理；矩陣全 ∞ → 不派任何工作。
- 拆分交易失敗 → 父 job 維持原狀（`split_count` 仍 0），本 tick 當作不可拆處理，下個 tick 重試。
- 子 job 的 workflow 重寫若找不到任何引用來源節點的輸入（理論上被 §3.2 條件 4 擋掉）→ 不拆，log WARNING。
- 舊 agent（protocol 任何版本）都能執行子 job：子 job 只是多一個核心節點。

## 6. 測試

- 純函數單元測試（兩棧）：簽章穩定性、EWMA/speed_index 更新（含只有一台 worker 時不更新 speed_index）、成本模型每一項、Hungarian（含長方矩陣、∞、決定性打破）、split_plan 每個否決條件、child_workflow 重寫與分片、refresh_parent 每一列狀態表。
- 派工整合測試（兩棧既有 `test_dispatch.py` / `dispatch.spec.ts`）：既有測試的期望更新為新演算法但保留「乾淨贏過警告」「有模型贏過要下載」「輕工作留大卡」等語意；新增「熱快取親和贏過 VRAM 較大但要重載」「歷史速度快者贏」「兩件重工作兩台卡各派一件而非同一台」。
- 端到端（`cloud/test/e2e.spec.ts` 與 Python fake-agent 測試）：兩台假 worker、送 `batch_size=4` 的圖 → 產生 2 個子 job 各 2 張、父 job 依序拿到 4 個輸出、面板 history 只看到父、收據兩張、`split_batches=false` 時不拆。
- 一致性測試不進 CI（需 GPU）；§3.1 的實測腳本保留在 `docs/superpowers/specs/` 旁的附註中說明如何重跑。

## 7. 文件

`docs/SELF-HOSTING.zh.md` / `.en.md` 新增「派工與批次拆分」章節：演算法摘要、`split_batches` 設定、一致性說明（同 seed 同構圖、非逐位元、與跨機差異同級）、`requirements.split=false` 的用法。
