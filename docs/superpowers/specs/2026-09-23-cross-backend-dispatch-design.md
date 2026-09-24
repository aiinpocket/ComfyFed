# 跨後端派工：等待 vs. 立刻派、後端速度先驗、統一記憶體門檻

日期：2026-09-23
狀態：已實作（server + cloud 同步）
延伸：`2026-09-15-scheduler-and-batch-split-design.md`（成本公式 §2.4、Hungarian §2.5）

## 0. 背景與目標

2026-09-20 的「需要模型的工作只派 NVIDIA」是為了擋掉 Mac 上必然失敗的
fp8／int8 工作。同日的 MPS shim（`agent/comfyfed_agent/mps_quant_compat.py`）
讓同一套量化工作流在 Mac 上跑得起來之後，那條硬規則就只剩「慢」這個理由，
而「慢」不該用硬規則處理，該進成本。

實測（Mac mini M4 Pro 64 GB vs RTX 5080）：

| 工作 | Mac | 5080 |
|---|---|---|
| Chroma fp8 768²，一步 | ~14 s | ~1 s |
| MiniMax-H3 512×288×25f，2 步含載入 | ~100 s | — |
| MiniMax-H3 1152×640×294f，8 步（正式規格） | 小時級，記憶體 63/64 GB | ~565 s |

目標（使用者原話的翻譯）：

1. **包容各種 OS／後端**：只要活著的 worker 能跑，工作就不能卡住。
2. **有得選時做聰明的選擇**：NVIDIA 正在忙，但「等它做完再接」可能還是比
   「現在派給 Mac」快——這時候不該派。
3. **不會把機器搞掛**：Mac 的統一記憶體是 OS、模型、activation 共用的一池，
   塞到爆會 jetsam → watchdog panic（2026-09-23 15:38 實際發生）。

## 1. 資格（assess）：Mac 有 shim 就等同 cuda

`assess.verdict`：`worker.backend == "mps"` 且 hello 的
`hardware.mps_quant_compat === true`（agent 只在**正在跑的** ComfyUI 載入了
shim 時才回報 true）→ 跳過 `backend_unsupported`。沒 shim 的 Mac、ROCm、
後端不明者維持 2026-09-20 的拒絕。

## 2. 速度：後端先驗取代固定罰分

原本（2026-09-23 早上第一版）對 `mps` 上的模型工作固定加 300 秒
（`EMULATED_BACKEND_PENALTY`）。問題：它跟工作大小無關——生一張圖多 300 秒
是合理的，跑 12 秒影片多 300 秒是荒謬的低估。**刪除。**

改成讓速度差進 `predicted_seconds`：

- `scheduler.BACKEND_SPEED_PRIOR = {cuda: 1.0, rocm: 0.7, mps: 0.12, cpu: 0.03}`，
  其他／空字串 `DEFAULT_SPEED_PRIOR = 0.5`。
- `stats.effective_speed_index(rows, worker_id, backend, stored)`：worker 在
  `worker_job_stats` 裡**一列都沒有**（從沒完成過工作）→ 用先驗；有列 → 用
  存的 `speed_index`。`dispatch.assign_jobs` 與 `stats.record_completion`／回填
  都用這個，不再直接讀 `workers.speed_index`。
- 第一筆樣本：`stats.first_speed_index` 直接寫 `R(sig)/exec`（夾在
  0.1–10），沒有參考值就寫先驗。原本的 `0.3·ratio + 0.7·1.0` 會讓 Mac 第一
  件跑完停在 0.7，要再十件才收斂。第二筆起照舊 EWMA 混合。

效果：新 Mac 對某簽章的預估 = 別人的 `ewma × speed` 中位數 ÷ 0.12；跑過一次
之後就是它自己的實測。cost 裡不再有任何後端常數（`light_penalty` 除外，那
是零模型工作的既有偏好）。

## 3. 等待 vs. 立刻派（hold）

### 3.1 busy worker 的剩餘時間

`agentws.dispatch_tick`／`hub.ts` 把連線狀態為 `busy` 或 `dispatched` 的
worker 交給 `assign_jobs(busy_worker_ids=…)`。`_busy_worker_candidates`：

- 找它名下 `assigned`／`running` 的 job（多筆取最早開始的那筆）。
- `predicted = dispatch_info.predicted_seconds + load_seconds + fetch_seconds`
  （claim 當下寫的），`elapsed = now − started_at`（還沒 `started_at`，例如
  還在下載模型 → 0）。
- `scheduler.remaining_seconds(predicted, elapsed)`：
  - `predicted` 無效 → None；
  - `elapsed > predicted × OVERDUE_FACTOR(2.0)` → None（預估已經錯了，不能
    再拿它當錨）；
  - 否則 `max(predicted − elapsed, predicted × MIN_REMAINING_FRACTION(0.1))`
    ——「快好了」不能無限期地說下去。
- None → 這台不進候選，**沒有人會為它等**。

### 3.2 等的成本

`scheduler.wait_cost(job, busy, pair, predicted, queue_ahead)` =
`busy.eta + queue_ahead + cost(job, busy, pair, predicted, tier1_exists=False)`。

- `cost` 是 idle worker 付的同一個公式（含 load、fetch、warn、light），所以
  比較是同尺度的；busy 的 `warm_models` 是它正在跑那件的模型。
- `tier1_exists=False`：要下載模型的 busy worker 仍是真實選項，下載時間算在內。
- `pair` 來自對這台 busy worker 跑同一個 `assess.verdict`——不合格就是 ∞。

### 3.3 決策：`scheduler.apply_holds`

依 `created_at` 順序逐件：

1. `best_wait = min_busy wait_cost(...)`；沒有任何有限值 → 這件不管 hold。
2. 對每台 idle worker：`run_now = cost(...)`；若
   `run_now > best_wait × HOLD_MARGIN_RATIO(1.25) + HOLD_MARGIN_SECONDS(30)`
   → 該格改成 `kind = "held"`（`cost` 對非 eligible 種類回 ∞，Hungarian 永
   不選它）。只在**明顯**比較快時才等，五五波不等。
3. 若這件已經沒有任何有限的 idle 格（被 hold 光了，或本來就沒 idle 選項），
   它就是 `best_busy` 的下一件：`queue_ahead[best_busy] += predicted + load`。
   第五件等同一張卡的工作會看到前面四件，很可能就落到 Mac——這就是
   「Mac 吃溢出」的正確形式。
4. 只有「原本有 idle 選項、現在全被 hold」的才記成 `Hold`；本來就沒 idle
   選項的不算（它本來就在排隊）。

### 3.4 透明度

`_record_holds` 把 `{held_for, held_for_name, wait_seconds, run_now_seconds}`
寫進 queued job 的 `dispatch_info`（只寫有變化的列；不再 hold 時清成 `{}`；
claim 時被正常的 dispatch_info 覆蓋）。console 可以說「在等 POKAI-HOME 做完
（預估 15 分後開始）比現在派給 Mac（預估 2 小時）快」。

### 3.5 不卡住的保證

hold 只相對於「這一刻連線是 busy／dispatched、對這件合格、剩餘時間可估」
的 worker 存在，而且每個 tick 重算：

- busy worker 斷線 → 不在 `busy_worker_ids` → 下一 tick 無 hold → 派給 Mac。
- busy worker 超時 2 倍 → 剩餘時間未知 → 無 hold。
- busy worker 對這件不合格（模型、節點、記憶體）→ ∞ → 無 hold。
- 沒有 busy worker → `apply_holds` 是恆等函數 = 舊行為（既有測試全部不動）。
- 餓死保護（`STARVE_SECONDS`）仍在 `objective` 裡，只影響**合格格子**之間
  的先後；它不會、也不該把被 hold 的工作硬塞給 Mac——hold 本身就是「等比
  較快」的判斷，每 5 秒重新驗證一次。

## 4. 統一記憶體門檻（assess）

agent（Darwin）在 hello 回報 `vram_gb = 總記憶體`、`unified_memory: true`、
`gpu_name = "Apple M4 Pro"`；heartbeat 的 `free_vram_gb = free RAM`。

`assess.verdict`：`unified_memory_gb(hardware)` 非 None 時——

- `ram_gb` 視為 None（原本的「VRAM + RAM」上限會把同一池算兩次）。
- `resident = estimate_resident_gb(models, workers)` = **所有**引用模型大小總和
  × 1.15（離散 GPU 用最大單一模型 × 1.15 是因為能 offload；統一記憶體沒地
  方 offload）。
- `resident > vram_gb × UNIFIED_USABLE_FRACTION(0.85)` → 硬理由
  `memory:<resident>><usable>`。

以本次那件 H3 ref2va（20 + 15 + 8.9 + 5 + 0.6 + 1 GB ≈ 50.5 → ×1.15 = 58 GB）
對 64 GB Mac（可用 54.4）→ 拒絕。這件在 Mac 上實際把記憶體逼到 63/64 GB。

## 4b. 重連競態：hello 帶目前狀態

實測發現：Mac 正在跑第一件時，agent 因網路抖動重連，平台把剛握手的
agent 記成 idle 並在第一次心跳（最長一個心跳週期）之前又推了第二件給它。
修法：hello 多帶 `state`（idle／busy／paused）與 `job_id`；伺服器只在
`state == "busy"` 且有 `job_id` 時把連線記成 busy（`workers.status = busy`），
`paused` 記 paused，其餘一律 idle（舊 agent 沒帶欄位 = 舊行為）。agent
0.1.17 起在 hello 用和立即心跳同一個 `_effective_state`／`_job_id_for`。

## 5. 不做的事（YAGNI）

- 不做跨 tick 的預留（reservation）：hold 每 tick 重算就夠了，狀態在
  `dispatch_info` 裡只是說明用。
- 不估 running job 的真實進度：agent 的 `progress` 是時間 ramp，不可信；
  用 claim 時的預估減已跑時間。
- 不對 ROCm 開放模型工作：沒有實測。
- 不在 UI 加設定：門檻是常數，等有第二種弱後端再談。

## 6. 測試

- `tests/server/test_scheduler.py`：先驗、`remaining_seconds`、`wait_cost`、
  `apply_holds`（hold／不 hold／無 busy 恆等／busy 不合格／排隊溢出到 Mac／
  無 idle 選項不算 hold）、cost 無後端常數。
- `tests/server/test_stats.py`：`effective_speed_index`、先驗進 predict、
  `first_speed_index`；`record_completion` 與回填的期望值更新。
- `tests/server/test_assess.py`：`estimate_resident_gb`、統一記憶體拒絕／通過
  ／不重複計 RAM、離散 GPU 規則不變。
- `tests/server/test_dispatch.py`：`assign_jobs` 端到端——hold 並寫
  `dispatch_info`、busy 消失後立刻派給 Mac 並清掉 held、超時不 hold、Mac 有
  歷史且更快就直接派、不傳 `busy_worker_ids` 行為不變。
- `tests/agent/test_mps_compat.py`：Darwin 回報統一記憶體。
- cloud：同名 spec 逐一對照。
