# 任務失敗改派＋worker 不適任紀錄 設計

日期：2026-09-19。狀態：使用者指示（「兩次指派給同一個 worker 執行失敗後，應該要改派其他台 worker 並且記錄這 worker 不適合執行此類任務，哪怕其他 worker 沒有這個模型也應該要求他下載然後執行」）。

## 1. 問題

今天 `job_failed` 是終局：worker 回報失敗，job 直接變 `failed`，發一張非計費失敗收據，結束。線上實例（2026-09-19）：一張 H3 影片單被派到 ARM 無 GPU 的 Mac mini（當時唯一在線的 worker），ComfyUI 執行失敗，job 就死在那裡；同時有一台 RTX 5080（暫停中）其實能跑。

## 2. 目標

1. 一張 job 在同一台 worker 失敗 **2 次**後，那台 worker 對這張 job 不再是候選；job 回到 `queued` 等其他 worker（包含目前離線／暫停、之後才上線的），**不因為別台沒有模型就放棄**——既有 `eligible_after_fetch`（簽章 manifest／P2P／curated）會讓有開 auto_fetch 的 worker 先下載再跑。
2. 平台記錄「worker W 不適合任務類別 K」（K = job 的 `signature`，即工作流結構＋需求的雜湊；`model_fetch` 單用 `model_fetch:<name>`）。同類別的新 job 在 7 天內不會再派給 W。W 之後若成功跑完同類別（例如管理員清除紀錄後）自動解除。
3. 有上限：同一張 job 總失敗次數達 6 次 → 終局 `failed`，錯誤訊息彙整每台 worker 的最後錯誤；或者「沒有任何一台已註冊、未停用、未刪除的 worker 有可能跑它」（全部都被排除、或全艦隊缺節點／不可抓模型）→ 立即終局。
4. 兩棧 parity；agent 不需改動（wire 不變）。

## 3. 非目標

- 不做「失敗原因分類」（OOM／缺節點／逾時各自不同策略）——一律計次。
- 不做退避延遲；requeue 立即生效，下一個 dispatch tick 就可重派（同一 worker 第一次失敗後仍可能再被派到，這是刻意的：兩次才判定）。
- 不改 agent；不改收據規則（每次失敗嘗試照樣一張非計費失敗收據）。

## 4. 資料模型

`jobs` 新欄：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `attempts` | TEXT NOT NULL DEFAULT `'{}'` | JSON `{worker_id: failures}`，每次該 worker 對這張 job 回報失敗 +1 |
| `retry_count` | INTEGER NOT NULL DEFAULT 0 | 這張 job 被 requeue 的次數（= 非終局失敗次數） |

新表 `worker_task_failures`：

| 欄位 | 型別 |
|---|---|
| `worker_id` TEXT, `task_key` TEXT | 複合主鍵 |
| `failures` INTEGER NOT NULL | 累計失敗次數（每次失敗 +1，不論哪張 job） |
| `last_error` TEXT | 最後一次錯誤（截 500 字） |
| `last_job_id` TEXT | 最後一次失敗的 job |
| `updated_at` DATETIME | 最後更新時間 |

`task_key(job)`：`job.signature` 若非空；否則 `f"model_fetch:{fetch_entry.name}"`（model_fetch 單）；兩者皆無 → `None`（不記錄）。

常數（兩棧同名同值）：`MAX_FAILURES_PER_WORKER_PER_JOB = 2`、`MAX_JOB_ATTEMPTS = 6`、`UNSUITABLE_THRESHOLD = 2`、`UNSUITABLE_TTL_DAYS = 7`。

## 5. 失敗處理（`job_failed` 收到、且 transition 真的套用時）

```
attempts[W] += 1；retry_count 不變（先）
若 task_key：worker_task_failures[W, key].failures += 1（last_error, last_job_id, updated_at 更新）
total = Σ attempts.values()
if total >= MAX_JOB_ATTEMPTS → 終局失敗
elif not any_possible_worker(job)（見 §6）→ 終局失敗
else → requeue：status=queued, worker_id=NULL, last_worker_id=W, progress=0,
       started_at=NULL, finished_at=NULL, error=E（保留供顯示，欄位語意改為「最後錯誤」），
       retry_count += 1；發 panel `job_requeued`；失敗收據照發（非計費，kind=failed）
```

終局失敗：`error` = 彙整：「已在 N 台 worker 嘗試 M 次全部失敗：<worker name>: <last error 截 200 字>；…」（zh-TW 先、en 後），然後走既有 `mark_failed` 路徑（含 split 子單連坐取消、panel `job_failed`、失敗收據）。

分批子 job：同樣先重試，只有終局失敗才觸發 `child_status_changed` 連坐。

`cancelled`（管理員取消）與 `requeue_stale`（斷線）不計入 attempts。

## 6. 派工排除

`assess.verdict` 新參數 `exclusions: frozenset[tuple[str, str]]`（`(worker_id, job_id)` 與 `(worker_id, task_key)`），tick 建一次：
- `(W, job.id)` 若 `job.attempts[W] >= MAX_FAILURES_PER_WORKER_PER_JOB` → 理由 `failed_twice_on_job`。
- `(W, key)` 若 `worker_task_failures[W,key].failures >= UNSUITABLE_THRESHOLD` 且 `updated_at` 在 `UNSUITABLE_TTL_DAYS` 內 → 理由 `unsuitable:<key 前 12 字>`。
兩者皆為 `ineligible`。console 的 assessment 面板自然顯示理由。

`any_possible_worker(job)`：對所有 live（未刪除、未停用）worker——不論 online／offline／paused——用既有 `verdict`（含 `eligible_after_fetch`，fetchable 集合取 manifest＋job 自帶 entry）跑一次，排除掉 §6 的兩類；任一 `eligible`／`eligible_after_fetch` 即 True。離線 worker 的 `dynamic`（free_disk）可能過期，照它最後回報的值判。

## 7. 自動解除與人工清除

- `job_done`（且 transition 套用）時，若 `task_key` 存在 → 刪除 `worker_task_failures[W, key]`。
- 管理員：`DELETE /api/workers/{id}/unsuitable/{task_key}`（admin＋CSRF）→ 刪一列；`DELETE /api/workers/{id}/unsuitable`（不帶 key）→ 清空該 worker 全部。
- TTL 到期的列不刪，只是不再生效（查詢時過濾）。

## 8. API／console

- `/api/jobs`、`/api/jobs/{id}` 多帶 `attempts`（dict）、`retry_count`。JobDetail 顯示「嘗試紀錄」：每台 worker 失敗次數；requeue 中的 job 顯示「上次錯誤」。
- `/api/workers` 每台多帶 `unsuitable: [{task_key, failures, last_error, last_job_id, updated_at, active: bool}]`（active = 未過 TTL 且達門檻）。Workers 頁每台 worker 加「不適任任務」區塊（key 前 12 字、次數、最後錯誤、最後 job 連結）＋ admin 的「清除」鈕。
- i18n zh-TW／en 鍵對齊。

## 9. 測試

- server：`test_retry.py`（純函式：計次、門檻、終局條件、彙整訊息、TTL）；`test_agent_ws.py`：失敗→requeue→再派給另一台→done 清除紀錄；同一台兩次失敗後不再派給它；6 次終局；無可能 worker 立即終局；子 job 重試優先於連坐；`test_assess.py`／`test_dispatch.py`：排除理由；`test_workers.py`：unsuitable 欄與 DELETE。
- cloud：對應 vitest。web：JobDetail attempts、Workers unsuitable 區塊與清除鈕。
- e2e（`tests/test_e2e.py`）：兩台假 worker，A 失敗兩次 → B（沒模型、auto_fetch）收到帶 `fetch_models` 的 push → done；A 的 `worker_task_failures` 有列、B 完成後 A 的列仍在（只清 B 自己的）。

## 10. 部署

Alembic 新 head；D1 `0012_job_retry.sql`。push main → Workers Builds 自動 migrate＋deploy。agent 無需發版。
