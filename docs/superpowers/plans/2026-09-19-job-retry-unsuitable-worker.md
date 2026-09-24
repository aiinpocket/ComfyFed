# 任務失敗改派＋worker 不適任紀錄 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** worker 回報 `job_failed` 後不再直接終局：同一 worker 對同一 job 失敗 2 次即排除並記為「不適任此類任務」，job 回 `queued` 等其他 worker（含需先下載模型者）；總失敗 6 次或全艦隊無人可能執行才終局。

**Architecture:** 新純函式模組 `retry.py`／`retry.ts` 負責計次、門檻、終局判定與訊息彙整；`agentws`／`hub` 的 `job_failed` 路徑改為「先問 retry 該 requeue 還是終局」；`assess.verdict` 新增 `exclusions` 集合產生兩種 `ineligible` 理由；`worker_task_failures` 表記錄 (worker, task_key) 失敗，`job_done` 自動清除、admin 端點人工清除；console 顯示 attempts 與 unsuitable 並提供清除。agent 不變。

**Tech Stack:** 同 2026-09-19 model-fetch 計畫（FastAPI／SQLAlchemy／Alembic；Workers／Hono／D1／DO；React／Mantine；pytest／vitest）。

**Spec:** `docs/superpowers/specs/2026-09-19-job-retry-unsuitable-worker-design.md` — 具約束力。

## Global Constraints

- 常數兩棧同名同值：`MAX_FAILURES_PER_WORKER_PER_JOB = 2`、`MAX_JOB_ATTEMPTS = 6`、`UNSUITABLE_THRESHOLD = 2`、`UNSUITABLE_TTL_DAYS = 7`。
- 排除理由字串逐字：`failed_twice_on_job`、`unsuitable:<task_key 前 12 字>`。
- `task_key(job)`：`job.signature` 非空 → 它；否則 model_fetch 單 → `model_fetch:<fetch_entry.name>`；否則 `None`。
- `cancelled` 與 `requeue_stale` 不計入 attempts；失敗收據每次嘗試照發（非計費，既有 kind）。
- 終局訊息 zh-TW 先、en 後：`已在 {n} 台 worker 嘗試 {m} 次全部失敗 / failed on {n} workers after {m} attempts：{worker 名}: {last error 截 200 字}；…`。
- 兩棧 parity；agent 不改；測試指令與 commit 規則同前一計畫（controller 前景跑全套；子代理只跑自己的檔；trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`）。

## File Structure

新建：`server/comfyfed_server/retry.py`、`server/alembic/versions/d5e6f7a8b9c0_job_retry.py`、`cloud/migrations/0012_job_retry.sql`、`cloud/src/core/retry.ts`、`tests/server/test_retry.py`、`cloud/test/retry.spec.ts`。
修改：`db.py`（`Job.attempts`、`Job.retry_count`、`WorkerTaskFailure`）、`assess.py`（`exclusions`）、`dispatch.py`（`assign_jobs(..., exclusions)`、新 `requeue_for_retry(job_id, worker_id, error)`、`mark_failed` 加彙整訊息參數）、`agentws.py`（job_failed 分流、job_done 清除、tick 建 exclusions）、`jobs.py`（job dict）、`workers.py`（unsuitable 欄＋DELETE）、cloud 對應（`queries.ts`、`assess.ts`、`dispatch.ts`、`do/hub.ts`、`routes/jobs.ts`、`routes/workers.ts`）、`web/src/api.ts`、`pages/JobDetail.tsx`、`pages/Workers.tsx`、i18n 兩份、`docs/SELF-HOSTING.{zh,en}.md`、`tests/test_e2e.py`。

---

### Task 1: server — 資料模型與 `retry.py` 純函式

**Files:** Create `retry.py`、migration；Modify `db.py`；Test `tests/server/test_retry.py`、`test_db.py`。

**Interfaces (Produces):**
```python
MAX_FAILURES_PER_WORKER_PER_JOB = 2; MAX_JOB_ATTEMPTS = 6; UNSUITABLE_THRESHOLD = 2; UNSUITABLE_TTL_DAYS = 7
def task_key(job) -> Optional[str]
def bump_attempts(attempts_json: str, worker_id: str) -> tuple[str, int, int]   # (new_json, this_worker_failures, total)
def is_excluded_for_job(attempts_json: str, worker_id: str) -> bool             # >= MAX_FAILURES_PER_WORKER_PER_JOB
def summarize_final_error(attempt_errors: list[tuple[str, str]], total: int) -> str  # [(worker_name, last_error)]
def record_failure(session, worker_id, key, error, job_id, now) -> None         # upsert worker_task_failures
def clear_failure(session, worker_id, key) -> None
def active_unsuitable(session, now) -> frozenset[tuple[str, str]]              # (worker_id, key) with failures>=threshold and updated_at within TTL
def unsuitable_rows_for_worker(session, worker_id, now) -> list[dict]          # {task_key, failures, last_error, last_job_id, updated_at, active}
```
`db.Job` 新欄 `attempts: str = "{}"`、`retry_count: int = 0`；新 model `WorkerTaskFailure(worker_id PK, task_key PK, failures, last_error, last_job_id, updated_at)`。migration：`jobs.attempts TEXT NOT NULL DEFAULT '{}'`、`jobs.retry_count INTEGER NOT NULL DEFAULT 0`、`worker_task_failures` 表。

- [ ] 失敗測試：`bump_attempts('{}','w1') == ('{"w1": 1}',1,1)`；累加至 2 → `is_excluded_for_job` True；`summarize_final_error([("A","boom"),("B","x"*300)],6)` 含 `已在 2 台 worker 嘗試 6 次`、`A: boom`、B 的錯誤截 200 字；`record_failure` 兩次 → failures 2；`active_unsuitable` 含 (w,key)，把 `updated_at` 撥到 8 天前 → 不含；`clear_failure` 後為空；`task_key` 三分支。
- [ ] 實作；跑 `test_retry.py test_db.py`；commit `feat(server): job retry model + retry helpers`。

### Task 2: server — 派工排除與 job_failed 分流

**Files:** Modify `assess.py`（`verdict(..., exclusions: frozenset[tuple[str,str]] | None = None)`：`(worker.id, job_id)` 或 `(worker.id, task_key)` 命中 → `ineligible`，理由 `failed_twice_on_job` / `unsuitable:<key[:12]>`；`verdict` 需要 job_id 與 task_key → 加 `job_id: str | None = None, task_key: str | None = None` 參數），`dispatch.py`（`assign_jobs(..., exclusions)` 對每張 job 傳 `job_id`/`task_key`；新 `requeue_for_retry(job_id, worker_id, error) -> bool`：owned 判定同 `mark_failed`，套 §5 requeue 欄位；`mark_failed` 保持），`agentws.py`（job_failed：owned 判定後 → `retry.bump_attempts`＋`retry.record_failure` → 若 `total >= MAX_JOB_ATTEMPTS` 或 `not _any_possible_worker(job)` → `dispatch.mark_failed(..., error=summarize_final_error(...))` 既有路徑；否則 `dispatch.requeue_for_retry` → `panelws.job_requeued`；兩條路都發失敗收據。`_any_possible_worker(job)`：對 `jobs._live_workers` 全部（不限 online）用 `assess.verdict`（帶 manifest fetchable＋job 自帶 entry＋exclusions）任一 eligible/eligible_after_fetch。job_done 套用時 `retry.clear_failure(W, task_key)`。tick：`exclusions = retry.active_unsuitable(...) | {(w, job.id) for job, w if is_excluded_for_job}` 建一次），`jobs.py`（`_job_dict` 加 `attempts` dict、`retry_count`）。
**Test:** `test_assess.py`（兩種理由）、`test_dispatch.py`（`requeue_for_retry` 欄位）、`test_agent_ws.py`：A 失敗 → job queued、`retry_count 1`、`attempts {A:1}`、失敗收據 1 張、panel 收 requeued；A 再失敗 → `attempts {A:2}`，下一 tick 只派給 B；B done → `worker_task_failures[B,key]` 無、`[A,key]` failures 2；6 次 → failed 且 error 含彙整；只有 A 一台且 A 已排除 → 立即 failed；子 job 第一次失敗不連坐、終局才連坐。
- [ ] 失敗測試 → 實作 → 跑上述四檔 → commit `feat(server): retry failed jobs on other workers, record unsuitable workers`。

### Task 3: server — workers API（unsuitable 欄＋清除）

**Files:** Modify `workers.py`（`GET /api/workers` 每台加 `unsuitable`；`DELETE /api/workers/{id}/unsuitable/{task_key}` 與 `DELETE /api/workers/{id}/unsuitable`，admin＋CSRF，404 無此 worker，200 `{"cleared": n}`）；Test `test_workers.py`。
- [ ] 測試：一般使用者 403；admin 清單列出 active/inactive；清單一 key；清全部。→ 實作 → commit `feat(server): worker unsuitable list + admin clear`。

### Task 4: cloud twin

**Files:** `0012_job_retry.sql`（`ALTER TABLE jobs ADD COLUMN attempts TEXT NOT NULL DEFAULT '{}'; ALTER TABLE jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0; CREATE TABLE worker_task_failures (worker_id TEXT NOT NULL, task_key TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0, last_error TEXT, last_job_id TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (worker_id, task_key));`）、`core/retry.ts`（port Task 1）、`queries.ts`（欄位＋upsert/delete/select）、`assess.ts`（`exclusions`）、`dispatch.ts`、`do/hub.ts`（`handleJobFailed` 分流、`handleJobDone` 清除、tick exclusions、`anyPossibleWorker`）、`routes/jobs.ts`（欄位）、`routes/workers.ts`（unsuitable＋DELETE）；tests 對應每案。
- [ ] port → `npx tsc --noEmit`、全 vitest → commit `feat(cloud): retry failed jobs on other workers, record unsuitable workers`。

### Task 5: web console

**Files:** `api.ts`（`Job.attempts`, `retry_count`; `Worker.unsuitable[]`）、`JobDetail.tsx`（「嘗試紀錄 / Attempts」區塊：worker → 次數；queued 且 `retry_count>0` 顯示「上次錯誤」= `error`）、`Workers.tsx`（每台「不適任任務 / Unsuitable tasks」列表＋admin「清除」鈕呼叫 DELETE；非 active 列灰字）、i18n 兩份；tests。
- [ ] → `npm test -- --run`、`npx tsc --noEmit` → commit `feat(web): show job attempts and worker unsuitable tasks`。

### Task 6: e2e＋docs

**Files:** `tests/test_e2e.py`（§9 e2e：兩台假 worker A/B；B 無模型但 auto_fetch、protocol ≥3、manifest 有該模型（用 curated RealESRGAN 或 prime `model_hashes`）；A 失敗兩次 → B 收到帶 `fetch_models` 的 push → done；斷言 `attempts`、`retry_count 2`、A 的 unsuitable 列 active、B 無列）；`docs/SELF-HOSTING.{zh,en}.md` 新節「任務失敗會怎樣 / What happens when a job fails」。
- [ ] → 跑 `tests/test_e2e.py` → commit `test(e2e)+docs: job retry and unsuitable workers`。

### Task 7: 發版（controller）
- [ ] 全套四棧測試 → push main（Workers Builds 自動 migrate 0012＋deploy）→ 用 wrangler D1 唯讀查詢驗證 `worker_task_failures` 表存在。
