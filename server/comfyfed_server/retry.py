"""2026-09-19 job-retry：失敗計次、門檻判定、終局訊息彙整與不適任紀錄。

模組分兩層，和 `stats.py` 同一個形狀：上半是完全不碰 DB 的純函式（計次、
門檻、`task_key`、訊息彙整），兩棧逐行對照 `cloud/src/core/retry.ts`；下半是
薄薄的 `worker_task_failures` adapter（upsert／清除／TTL 查詢）。

設計見 `docs/superpowers/specs/2026-09-19-job-retry-unsuitable-worker-design.md`。
一句話：worker 回報 `job_failed` 不再是終局 -- 同一台對同一張 job 失敗
`MAX_FAILURES_PER_WORKER_PER_JOB` 次就對那張 job 出局，job 回 `queued` 等別台
（包含現在離線／暫停、之後才上線、甚至還得先下載模型的）；累積到
`MAX_JOB_ATTEMPTS` 次、或全艦隊沒有任何一台有可能跑它，才真的終局失敗。
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Optional

from . import db

# 同一台 worker 對同一張 job 失敗這麼多次 -> 這張 job 不再派給它。
MAX_FAILURES_PER_WORKER_PER_JOB = 2
# 一張 job 所有 worker 加總的失敗次數上限；到了就終局失敗。
MAX_JOB_ATTEMPTS = 6
# (worker, task_key) 累積這麼多次失敗 -> 這台對這「類」任務算不適任。
UNSUITABLE_THRESHOLD = 2
# 不適任紀錄的有效期；過期的列不刪，只是查詢時不再生效。
UNSUITABLE_TTL_DAYS = 7
# 2026-09-19 線上實例：兩筆 9/14 之後再也沒上線的舊註冊（rtx5080-main／
# rtx5080-fresh）讓 `_any_possible_worker` 一直回 True，一張兩台在線 worker
# 都跑掛的 job 就永遠 queued 等它們。超過這麼多天沒有心跳（從未心跳就看
# created_at）的 worker 不再算「有可能」跑得動任何 job。
POSSIBLE_WORKER_STALE_DAYS = 7

# 排除理由字串（console 的 assessment 面板直接顯示，兩棧逐字相同）。
FAILED_TWICE_REASON = "failed_twice_on_job"
UNSUITABLE_REASON_PREFIX = "unsuitable:"
# `unsuitable:<task_key 前 N 字>` -- 簽章是 64 字雜湊，全寫進理由字串沒有
# 可讀性，前 12 字已足以辨識。
UNSUITABLE_KEY_CHARS = 12

# 終局訊息裡每台 worker 的錯誤截這麼長；`worker_task_failures.last_error`
# 存得長一點（下面的 500），因為它是給管理員診斷用的，不是給 job 列表顯示的。
FINAL_ERROR_CHARS = 200
LAST_ERROR_CHARS = 500


# --- 純函式層 --------------------------------------------------------------


def is_stale_worker(worker, now: datetime) -> bool:
    """這台 worker 是否已經太久沒露面，不該再被當成「有可能」的候選。

    基準 = `last_seen`，從未心跳過就退回 `created_at`（和
    `dispatch.requeue_stale` 的 `COALESCE(last_seen, created_at)` 同一個定義）。
    兩者都缺（理論上不會）視為不 stale -- 寧可多等一輪，不要因為一個空欄位
    把 job 判死。
    """
    reference = worker.last_seen or getattr(worker, "created_at", None)
    if reference is None:
        return False
    return reference < now - timedelta(days=POSSIBLE_WORKER_STALE_DAYS)


def _attempt_entries(attempts_json):
    """`jobs.attempts` 的防禦式解析，回 `{worker_id: (failures, last_error)}`。

    欄位內容是 `{worker_id: {"failures": n, "last_error": str}}` --
    per-job 的計數**跟**那台在這張 job 上的最後一個錯誤。錯誤存在
    job 自己身上而不是跨 job 累計的 `worker_task_failures`，是因為
    終局訊息會被寫進這張 job 的 `error` 給這張 job 的擁有者看：
    引用別張 job（可能是別人的）的錯誤字串既誤導診斷，錯誤訊息
    又常含檔名與路徑，那是一條很細的跨使用者外洩路徑。

    寬容兩種寫法：舊形狀的純數字（`{worker_id: n}`，這個功能第一
    版的欄位內容）照樣讀得出次數，只是沒有錯誤字串可引。
    壞掉的 JSON、不是物件、key 不是字串、值不是正整數的，一律當「沒有
    那一筆」-- `job_failed` 是唯一能把 job 從 `running` 推走的路徑，一列
    壞資料在這裡丟例外會讓那張 job 永遠卡住。
    """
    try:
        value = json.loads(attempts_json or "{}")
    except (TypeError, ValueError):
        return {}
    if not isinstance(value, dict):
        return {}

    result: dict[str, tuple[int, Optional[str]]] = {}
    for key, entry in value.items():
        if not isinstance(key, str):
            continue
        if isinstance(entry, dict):
            count = entry.get("failures")
            error = entry.get("last_error")
            if not isinstance(error, str):
                error = None
        else:
            count = entry
            error = None
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            continue
        result[key] = (count, error)
    return result


def attempts_dict(attempts_json: Optional[str]) -> dict[str, int]:
    """`{worker_id: failures}` -- 排除判定與 API 一直以來的形狀。"""
    return {key: count for key, (count, _error) in _attempt_entries(attempts_json).items()}


def attempt_errors(attempts_json: Optional[str]) -> dict[str, str]:
    """`{worker_id: last_error}`，只含真的有存到錯誤字串的那幾台。

    終局彙整訊息的唯一來源（見 `_attempt_entries`），也是 `/api/jobs*`
    新的 `attempt_errors` 欄。
    """
    return {
        key: error
        for key, (_count, error) in _attempt_entries(attempts_json).items()
        if error is not None
    }


def bump_attempts(
    attempts_json: Optional[str], worker_id: str, error: Optional[str] = None
) -> tuple[str, int, int]:
    """`worker_id` 對這張 job 再失敗一次，順手記下它這一次的錯誤。

    回 `(new_json, this_worker_failures, total)`：新的 JSON 字串（直接寫回
    `jobs.attempts`）、這台 worker 現在的失敗次數、以及所有 worker 的總
    失敗次數（拿去和 `MAX_JOB_ATTEMPTS` 比）。

    錯誤存進去之前先截 `FINAL_ERROR_CHARS` 字：它最後會進終局彙整
    訊息，而那個訊息會進 `jobs.error`，一段 CUDA traceback 可以有好幾 KB。
    不傳 `error`（或傳 None）就只加一次計數，保留舊的錯誤字串。
    """
    entries = _attempt_entries(attempts_json)
    previous_count, previous_error = entries.get(worker_id, (0, None))
    stored_error = previous_error if error is None else error[:FINAL_ERROR_CHARS]
    entries[worker_id] = (previous_count + 1, stored_error)

    payload: dict[str, dict] = {}
    for key, (count, last_error) in entries.items():
        row: dict = {"failures": count}
        if last_error is not None:
            row["last_error"] = last_error
        payload[key] = row

    total = sum(count for count, _error in entries.values())
    return json.dumps(payload), entries[worker_id][0], total


def is_excluded_for_job(attempts_json: Optional[str], worker_id: str) -> bool:
    """這台 worker 對這張 job 是不是已經出局（失敗達 `MAX_FAILURES_...`）。"""
    return attempts_dict(attempts_json).get(worker_id, 0) >= MAX_FAILURES_PER_WORKER_PER_JOB


def has_failed_job(attempts_json: Optional[str], worker_id: str) -> bool:
    """這台 worker 對這張 job 失敗過嗎（哪怕只有一次）？

    `dispatch.try_readopt` 的守衛：門檻是 1，不是
    `MAX_FAILURES_PER_WORKER_PER_JOB` -- 「斷線了又回來」的信任窗口不該給
    一台已經親口說過「這張我跑失敗了」的 worker。見那邊的說明。
    """
    return worker_id in _attempt_entries(attempts_json)


def unsuitable_reason(key: str) -> str:
    """`unsuitable:<task_key 前 12 字>` -- 兩棧逐字相同的排除理由字串。"""
    return f"{UNSUITABLE_REASON_PREFIX}{(key or '')[:UNSUITABLE_KEY_CHARS]}"


def summarize_final_error(attempt_errors: list[tuple[str, str]], total: int) -> str:
    """終局失敗時寫進 `jobs.error` 的彙整訊息。

    `attempt_errors` 是 `[(worker 顯示名, 那台的最後一個錯誤)]`，`total` 是
    總嘗試次數。zh-TW 先、en 後（平台其他雙語訊息的慣例），每台的錯誤截
    `FINAL_ERROR_CHARS` 字 -- 一段 CUDA traceback 可以有好幾 KB，六台份塞進
    一個 job 列會讓 console 的 job 列表整個爛掉。
    """
    n = len(attempt_errors)
    detail = "；".join(f"{name}: {(error or '')[:FINAL_ERROR_CHARS]}" for name, error in attempt_errors)
    return (
        f"已在 {n} 台 worker 嘗試 {total} 次全部失敗 / "
        f"failed on {n} workers after {total} attempts：{detail}"
    )


def task_key(job) -> Optional[str]:
    """這張 job 屬於哪一「類」任務 -- 不適任紀錄的分類鍵。

    1. `job.signature`（`assess.signature` 算的工作指紋：工作流結構＋需求）
       非空就是它；
    2. 否則 `kind == "model_fetch"` 的下載單用 `model_fetch:<模型名>`；
    3. 都沒有（舊的、沒補簽章的 job）-> None，代表「不分類、不記錄」。
       這條 job 照樣重試，只是不會留下跨 job 的不適任紀錄。
    """
    signature = getattr(job, "signature", None)
    if signature:
        return signature

    if getattr(job, "kind", "prompt") != "model_fetch":
        return None

    try:
        entry = json.loads(getattr(job, "fetch_entry", None) or "{}")
    except (TypeError, ValueError):
        return None
    if not isinstance(entry, dict):
        return None
    name = entry.get("name")
    if not isinstance(name, str) or not name:
        return None
    return f"model_fetch:{name}"


# --- DB adapter 層 ----------------------------------------------------------


def record_failure(
    session, worker_id: str, key: Optional[str], error: Optional[str], job_id: Optional[str],
    now: datetime,
) -> None:
    """`worker_task_failures[worker_id, key].failures += 1`（不存在就建）。

    `key` 為 None 是合法的 no-op：`task_key` 分不出類別的 job（舊的、沒簽章
    的）照樣重試，只是不留跨 job 的紀錄。不自己 commit -- 由呼叫端連同
    `jobs.attempts` 的更新一起 commit，免得留下「計次進了、attempts 沒進」
    的半套狀態。
    """
    if not key:
        return
    truncated = (error or "")[:LAST_ERROR_CHARS]
    row = session.get(db.WorkerTaskFailure, (worker_id, key))
    if row is None:
        session.add(
            db.WorkerTaskFailure(
                worker_id=worker_id,
                task_key=key,
                failures=1,
                last_error=truncated,
                last_job_id=job_id,
                updated_at=now,
            )
        )
        return
    row.failures = (row.failures or 0) + 1
    row.last_error = truncated
    row.last_job_id = job_id
    row.updated_at = now


def clear_failure(session, worker_id: str, key: Optional[str]) -> None:
    """成功跑完同類任務 -> 刪掉那一列（自動解除不適任）。不自己 commit。"""
    if not key:
        return
    row = session.get(db.WorkerTaskFailure, (worker_id, key))
    if row is not None:
        session.delete(row)


def clear_worker_failures(session, worker_id: str) -> int:
    """清掉這台 worker 的全部不適任紀錄，回傳刪了幾列。不自己 commit。"""
    rows = (
        session.query(db.WorkerTaskFailure)
        .filter(db.WorkerTaskFailure.worker_id == worker_id)
        .all()
    )
    for row in rows:
        session.delete(row)
    return len(rows)


def _is_active(row, now: datetime) -> bool:
    """達門檻、且 `updated_at` 還在 TTL 內。

    `updated_at` 是 None（理論上不會有，欄位 NOT NULL）就當過期 -- 無法證明
    它還新鮮的紀錄不該拿來擋派工。
    """
    if (row.failures or 0) < UNSUITABLE_THRESHOLD:
        return False
    if row.updated_at is None:
        return False
    return row.updated_at >= now - timedelta(days=UNSUITABLE_TTL_DAYS)


def active_unsuitable(session, now: datetime) -> frozenset[tuple[str, str]]:
    """現在生效中的 `(worker_id, task_key)` 排除集合。

    一個 dispatch tick 只查一次，整批傳給 `assess.verdict`（見
    `dispatch.assign_jobs` 的 `exclusions`）。過期的列留著不刪 -- 它是管理員
    診斷「這台過去在這類任務上翻過車」的歷史，只是不再擋派工。

    門檻與 TTL 兩個條件都下在 SQL 裡（final review Minor 3）：這張表只增不
    減，而背景迴圈每 5 秒有活可派就查一次，整表撈回來再用 Python 濾等於讓
    成本跟著「歷史」長。下了 predicate 之後成本只跟著**還生效中**的排除數
    走。`updated_at IS NULL` 的列（理論上不存在，欄位 NOT NULL）在 SQL 的
    三值邏輯裡不滿足 `>=`，自然被濾掉 -- 和 `_is_active` 一樣把無法證明新鮮
    的紀錄當過期。
    """
    cutoff = now - timedelta(days=UNSUITABLE_TTL_DAYS)
    rows = (
        session.query(db.WorkerTaskFailure.worker_id, db.WorkerTaskFailure.task_key)
        .filter(
            db.WorkerTaskFailure.failures >= UNSUITABLE_THRESHOLD,
            db.WorkerTaskFailure.updated_at >= cutoff,
        )
        .all()
    )
    return frozenset((worker_id, task_key) for worker_id, task_key in rows)


def unsuitable_rows_for_worker(
    session, worker_id: str, now: datetime, *, include_private: bool
) -> list[dict]:
    """`GET /api/workers` 每台 worker 的 `unsuitable` 陣列。

    門檻未達／TTL 已過的列照樣列出來，只是 `active: False`（console 畫成灰
    字）-- 管理員要看得到「這台失敗過一次」和「這台上個月不適任過」，那是
    決定要不要手動清除的依據。

    `include_private=False` 時 `last_error` 與 `last_job_id` 一律回 `None`
    （final review I1）：`worker_task_failures` 是**跨 job、跨使用者**累積
    的，那兩欄一個是別人 job 的 id、一個是最多 500 字的失敗原文（ComfyUI
    的錯誤字串常含檔名、LoRA/checkpoint 名稱與絕對路徑）。jobs 本身是
    owner-or-admin 才看得到（`jobs._require_owner_or_admin` 連存在與否都藏，
    回 404 不回 403），這條 API 不能從側門把同樣的東西漏給任何登入使用者。
    `task_key`（簽章雜湊）／`failures`／`updated_at`／`active` 是艦隊
    metadata，照樣回給所有人 -- 那是「這台在哪類任務上被擋著」，不是誰的私
    人資料。參數刻意設成沒有預設值的 keyword-only：新的呼叫端必須明講自己
    是哪一種讀者，忘了寫不會安靜地漏出去。
    """
    rows = (
        session.query(db.WorkerTaskFailure)
        .filter(db.WorkerTaskFailure.worker_id == worker_id)
        .order_by(db.WorkerTaskFailure.updated_at.desc(), db.WorkerTaskFailure.task_key.asc())
        .all()
    )
    return [
        {
            "task_key": row.task_key,
            "failures": row.failures or 0,
            "last_error": row.last_error if include_private else None,
            "last_job_id": row.last_job_id if include_private else None,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
            "active": _is_active(row, now),
        }
        for row in rows
    ]
