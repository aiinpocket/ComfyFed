"""Atomic job dispatch, stale-worker requeue, and job status transitions."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import update

from . import assess, db, metrics, scheduler, split, stats

logger = logging.getLogger(__name__)

_STALE_SECONDS = 90

# Statuses a worker is allowed to transition out of by reporting on a job.
_OWNED_STATUSES = ("assigned", "running")

# Statuses a job never leaves again. Re-transitioning one is always wrong,
# so it stays a WARNING even when the worker does own the job.
_TERMINAL_STATUSES = ("done", "failed", "cancelled")

# Statuses cancel_job is willing to act on -- anything already terminal is a
# no-op (returns None), matching _TERMINAL_STATUSES' definition of "done".
_CANCELLABLE_STATUSES = ("queued", "assigned", "running")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _free_vram_gb(worker: db.Worker) -> float:
    """Free VRAM for ranking purposes, from the same heartbeat snapshot
    `assess.verdict` reads (`worker.dynamic["free_vram_gb"]`). Missing or
    non-numeric is treated as 0 rather than raising or crashing ranking --
    an unranked worker should lose ties, not break the tick.
    """
    free_vram = assess._worker_dynamic(worker).get("free_vram_gb")
    if not isinstance(free_vram, (int, float)) or isinstance(free_vram, bool):
        return 0.0
    return float(free_vram)


def _json_list(raw) -> list:
    """JSON 陣列欄位的防禦式解析；壞掉就當空陣列，不要讓一個 tick 因為一列
    壞資料整個炸掉。"""
    try:
        value = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    return value if isinstance(value, list) else []


# §2.5 第 2 步：一個 tick 最多評估這麼多件 queued job（外加所有已餓死的），
# 免得一個塞了幾千件的佇列把 O(n^3) 的配對拖垮。
_MAX_JOBS_PER_TICK = 64
_JOBS_PER_IDLE_WORKER = 8

# Final-review C1：queued 掃描的硬上限。選取逆向計算：head 最多
# `_MAX_JOBS_PER_TICK`、餓死補頁最多又一個 `limit`，所以 2×64 = 128
# 就夠裝滿一整輪能用到的量；1024 是故意寬鬆的常數，讓餓死掃描
# 還看得到 head 後面一大段舊 job，又不至於把幾萬件的佇列整張讀進記憶體。
# 排序一律 `created_at, id`，所以 LIMIT 切掉的永遠是最新的那一端。
_QUEUED_SCAN_LIMIT = 1024


def _dispatch_info(
    predicted_seconds: float,
    basis: str,
    load_seconds: float,
    fetch_seconds: float,
    candidates: int,
) -> str:
    return json.dumps(
        {
            "predicted_seconds": round(predicted_seconds, 3),
            "basis": basis,
            "load_seconds": round(load_seconds, 3),
            "fetch_seconds": round(fetch_seconds, 3),
            "candidates": candidates,
        }
    )


def assign_jobs(
    idle_worker_ids: list[str],
    fetchable_models: Optional[dict[str, int]] = None,
    peer_only_models: Optional[frozenset[str]] = None,
) -> list[tuple[str, db.Job]]:
    """Phase 3.3 §2.5：一次把整批 queued job 和整批 idle worker 做整體配對。

    取代 Phase 2.1 的逐 job 貪婪排序。流程：

    1. 取 queued job（`created_at ASC`，排除 `split_count > 0` 的父 job），
       最多 `min(64, 8 x idle 數)` 件，另外把等待超過 `STARVE_SECONDS` 的
       一律納入 -- 餓死防護不能被上限吃掉。
    2. 對每對 (job, worker) 算 `assess.verdict`，壓成 `scheduler.PairVerdict`；
       同時用 `stats.predict` 取這對的預估執行秒數與依據。
    3. `scheduler.match` 求最小成本配對（Hungarian，∞ 的配對永不採用）。
    4. 依結果逐一原子 claim（`WHERE status='queued'`，rowcount != 1 就跳過），
       並寫入 `jobs.dispatch_info` 與 `workers.warm_models`。

    保留的既有語意（見 `scheduler.cost`）：乾淨贏過警告（warn penalty 1e6）、
    已經有模型的贏過要下載的（tier 1 存在時 tier 2 一律 ∞）、輕工作留大卡
    （light penalty）。

    決定性：jobs 先依 `(created_at, id)`、workers 先依 `(name, id)` 排序，
    Hungarian 本身在平手時取索引最小者，所以同一組輸入兩棧得到同一個配對。

    `fetchable_models` / `peer_only_models` 一如既往直接傳給 `assess.verdict`；
    `None`（預設）代表「沒有東西可下載」。回傳實際 claim 成功的
    `(worker_id, job)`，供 `agentws.dispatch_tick` 推送。
    """
    if not idle_worker_ids:
        return []

    now = _utcnow()
    # Phase 3.3 §3.4：這一輪 claim 成功、而且有父 job 的子 job（見迴圈尾端）。
    assigned_children: list[str] = []

    with db.get_session() as session:
        # `deleted == False`：admin 刪掉的 worker 永遠不該被派工，即使它的
        # socket 還在拆除中（見 `db.Worker.deleted` / `agentws.kick_worker`）。
        workers = (
            session.query(db.Worker)
            .filter(db.Worker.id.in_(idle_worker_ids), db.Worker.deleted == False)  # noqa: E712
            .all()
        )
        if not workers:
            return []

        all_workers = session.query(db.Worker).filter(db.Worker.deleted == False).all()  # noqa: E712

        # 父 job（split_count > 0）不進配對：它的工作由子 job 執行。
        queued_jobs = (
            session.query(db.Job)
            .filter(db.Job.status == "queued", db.Job.split_count == 0)
            .order_by(db.Job.created_at.asc(), db.Job.id.asc())
            .limit(_QUEUED_SCAN_LIMIT)
            .all()
        )

        # §3.5：配對之前先決定要不要拆。
        if split.create_children_for_tick(
            session, queued_jobs, workers, all_workers, fetchable_models, peer_only_models
        ):
            # 拆過之後 queued 清單變了（子 job 取代父 job -- 父 job 的
            # `split_count` 現在 > 0，這個查詢再也撈不到它），重讀一次。
            queued_jobs = (
                session.query(db.Job)
                .filter(db.Job.status == "queued", db.Job.split_count == 0)
                .order_by(db.Job.created_at.asc(), db.Job.id.asc())
                .limit(_QUEUED_SCAN_LIMIT)
                .all()
            )

        limit = min(_MAX_JOBS_PER_TICK, _JOBS_PER_IDLE_WORKER * len(workers))
        starve_cutoff = now - timedelta(seconds=scheduler.STARVE_SECONDS)
        head = queued_jobs[:limit]
        head_ids = {job.id for job in head}
        starved = [
            job
            for job in queued_jobs[limit:]
            if job.created_at is not None and job.created_at <= starve_cutoff
        ]
        # Final-review C1：餓死集合也要封頂。未封頂時，一個塞住超過
        # `STARVE_SECONDS` 的大佇列會把全部 queued job 丟進 O(n³) 的
        # Hungarian（Python 這邊直接卡住 event loop，TS 那邊卡住 DO alarm）。
        # 餓死清單已依 `created_at, id` 排序，`[:limit]` 取的就是最舊的那
        # 些——最餓的優先，剩下的下一個 tick 再排。
        selected_jobs = head + [job for job in starved if job.id not in head_ids][:limit]

        if not selected_jobs:
            return []

        workers.sort(key=lambda w: (w.name or "", w.id))

        stat_rows = stats.load_rows()
        speed_index = {
            w.id: (w.speed_index if isinstance(w.speed_index, (int, float)) else 1.0)
            for w in all_workers
        }

        job_candidates: list[scheduler.JobCandidate] = []
        worker_candidates: list[scheduler.WorkerCandidate] = []
        pairs: dict[tuple[str, str], scheduler.PairVerdict] = {}
        predictions: dict[tuple[str, str], float] = {}
        bases: dict[tuple[str, str], str] = {}

        for worker in workers:
            worker_candidates.append(
                scheduler.WorkerCandidate(
                    worker_id=worker.id,
                    name=worker.name or "",
                    backend=worker.backend or "",
                    free_vram_gb=_free_vram_gb(worker),
                    warm_models=tuple(_json_list(worker.warm_models)),
                    inventory=tuple(assess.model_inventory(worker)),
                )
            )

        for job in selected_jobs:
            try:
                requirements_override = json.loads(job.requirements or "{}")
            except (TypeError, ValueError):
                requirements_override = {}

            needs = assess.needs_from_job(job)
            is_light = not needs.models and not (needs.est_vram_gb or 0)
            job_candidates.append(
                scheduler.JobCandidate(
                    job_id=job.id,
                    signature=job.signature,
                    created_at=job.created_at or now,
                    is_light=is_light,
                    required_models=tuple(sorted(needs.models)),
                )
            )

            for worker in workers:
                v = assess.verdict(
                    worker,
                    needs,
                    requirements_override,
                    all_workers,
                    fetchable_models,
                    peer_only_models,
                )
                total_fetch_bytes = 0
                if v.kind == "eligible_after_fetch":
                    total_fetch_bytes = sum(
                        (fetchable_models or {}).get(name, 0) for name in v.missing_models
                    )
                pairs[(job.id, worker.id)] = scheduler.PairVerdict(
                    kind=v.kind,
                    has_warnings=bool(v.warnings),
                    total_fetch_bytes=total_fetch_bytes,
                )
                seconds, basis = stats.predict(stat_rows, speed_index, job.signature, worker.id)
                predictions[(job.id, worker.id)] = seconds
                bases[(job.id, worker.id)] = basis

        matched = scheduler.match(job_candidates, worker_candidates, pairs, predictions, now)

        assignments: list[tuple[str, db.Job]] = []
        for job_index, worker_index in matched:
            job = selected_jobs[job_index]
            worker = workers[worker_index]
            job_candidate = job_candidates[job_index]
            worker_candidate = worker_candidates[worker_index]
            pair = pairs[(job.id, worker.id)]

            candidate_count = sum(
                1
                for w in workers
                if pairs[(job.id, w.id)].kind in ("eligible", "eligible_after_fetch")
            )
            info = _dispatch_info(
                predictions[(job.id, worker.id)],
                bases[(job.id, worker.id)],
                scheduler.load_seconds(job_candidate, worker_candidate),
                scheduler.fetch_seconds(pair),
                candidate_count,
            )

            # 原子 claim：只有在 job 仍然 queued 的時候才成立。別的行程／執行緒
            # 搶先一步就 rowcount == 0，跳過而不是重複指派。
            result = session.execute(
                update(db.Job)
                .where(db.Job.id == job.id, db.Job.status == "queued")
                .values(status="assigned", worker_id=worker.id, dispatch_info=info)
            )
            if result.rowcount != 1:
                session.rollback()
                continue

            # §2.2：熱快取在「被指派」當下就成立（載入發生在開始執行時），
            # 所以這裡就寫，不等 job 完成。
            worker_row = session.get(db.Worker, worker.id)
            if worker_row is not None:
                worker_row.warm_models = json.dumps(list(job_candidate.required_models))

            session.commit()
            session.refresh(job)
            assignments.append((worker.id, job))
            if job.parent_id:
                assigned_children.append(job.id)

    # §3.4：子 job 被 claim 成 `assigned` 的那一刻，父 job 也要跟著從 `queued`
    # 變成 `assigned`。少了這一步，父 job 會一路停在 `queued` 直到第一個子 job
    # 的 busy 心跳把它推成 `running` —— console／面板在「兩台 worker 已經在拿
    # 圖了」的整段區間裡顯示的都是錯的狀態，而且 §3.4 表格的
    # `[... assigned] -> assigned` 那一列在正常派工流程上永遠走不到。
    #
    # 刻意放在 `with` 區塊**外面**：`child_status_changed` 會自己開一個 session，
    # 在還握著外層那個交易的時候再開一個去寫同一張表是自找死鎖
    # （`agentws` 對 `split.refresh_parent_progress` 也是同樣的理由）。同一個
    # tick 之內，所以 `dispatch_tick` 推完 job frame 時父 job 已經是 assigned。
    for child_id in assigned_children:
        split.child_status_changed(child_id)

    return assignments


def requeue_stale(now: datetime) -> list[str]:
    """Requeue assigned/running jobs of workers that haven't checked in recently.

    Returns the ids of the jobs actually requeued (so `len()` is the old
    count). The ids, not just the count, because the panel has to be told:
    a job the frontend believes is executing goes silently back to `queued`
    here, and nothing else will ever send it a done/failed event for that
    attempt -- see `agentws.dispatch_tick`.

    A worker is stale if it hasn't checked in for more than 90s. A worker that
    has never heartbeated at all (`last_seen is None`) falls back to its
    `created_at` as the clock: an agent that completed the handshake, was
    pushed a job, and then died before its first heartbeat must still have
    that job requeued rather than stranding it forever.

    A stale worker's assigned/running jobs go back to queued (worker_id
    cleared, progress reset), and the worker itself is marked offline.

    Soft-deleted workers (`db.Worker.deleted`) are swept for JOBS but never
    for METRICS. The job pass has to stay unfiltered: an admin delete kicks
    the socket (`agentws.kick_worker`) without touching that worker's
    in-flight rows, and this is the only path that ever requeues them -- skip
    a deleted worker here and its running job is stranded `assigned` forever.
    The metric pass must NOT run for them: a deleted worker never heartbeats
    again, so `reference >= cutoff` is false on every subsequent tick, and
    re-labelling `worker_up{worker=...} 0` every 5s would permanently undo
    `workers._forget_worker_metrics` and page whoever alerts on it. The
    offline/peer_url transition still happens, but only once (the
    `!= "offline"` guard below), so a deleted row stops being peer-seeder
    eligible (`peer.py`'s `status != 'offline'` filter) instead of churning
    a write every tick.
    """
    cutoff = now - timedelta(seconds=_STALE_SECONDS)
    requeued: list[str] = []
    with db.get_session() as session:
        workers = session.query(db.Worker).all()
        for worker in workers:
            reference = worker.last_seen if worker.last_seen is not None else worker.created_at
            if reference is None or reference >= cutoff:
                continue

            jobs = (
                session.query(db.Job)
                .filter(db.Job.worker_id == worker.id, db.Job.status.in_(["assigned", "running"]))
                .all()
            )
            for job in jobs:
                job.status = "queued"
                # Recorded *before* worker_id is cleared, so a job_done that
                # eventually arrives from this same worker (it merely blipped
                # offline, not truly gone) can be re-adopted -- see
                # try_readopt below.
                job.last_worker_id = worker.id
                job.worker_id = None
                job.progress = 0
                requeued.append(job.id)

            if worker.status != "offline" or worker.peer_url is not None:
                worker.status = "offline"
                # Phase 3.1 P2P: a seeder endpoint only means anything while
                # the worker is actually reachable -- clear it here so a
                # stale worker is never handed out as a grant's seeder (see
                # agentws._handle_hello, which is the only place peer_url
                # gets set again, on the agent's next hello).
                worker.peer_url = None

            if not worker.deleted:
                metrics.get_metrics().worker_up.labels(worker=worker.name).set(0)

        session.commit()

    # Phase 3.3 §3.4：子 job 被 requeue 之後父 job 可能要從 running 退回
    # assigned/queued。requeue 從不產生 failed/cancelled，所以不會串聯取消。
    for job_id in requeued:
        split.child_status_changed(job_id)

    return requeued


def cancel_job(
    job_id: str, *, reason: str, cancelled_owners: Optional[list] = None
) -> Optional[str]:
    """Move a queued/assigned/running job to `cancelled`.

    Sets `error=reason` and `finished_at`, and returns the worker_id that
    owned the job at the moment of cancellation (None if it was still
    unowned/queued) so a caller (an admin API, the ComfyUI-compat /interrupt
    or /queue-delete handlers) knows whether it needs to push `job_cancelled`
    to a live agent connection.

    Ownership is then *released* exactly the way `requeue_stale` releases it
    -- `last_worker_id = worker_id`, `worker_id = None` -- and that is load
    bearing, not tidiness. The immediate push is one-shot: it is a silent
    no-op when the owner has no live connection at that instant (a routine
    reconnect, a brief drop). With ownership cleared, every *later* thing the
    old owner says about this job -- heartbeat, progress, job_done, artifact
    upload -- lands on the not-owned path, which pushes `job_cancelled`
    again; the per-connection dedup bounds it to one push per socket and a
    reconnect starts a fresh set, so a missed notification self-heals within
    one heartbeat instead of the worker rendering to completion for nothing.
    `last_worker_id` keeps that worker identifiable as the *former* owner, so
    `_owned_job` can log its now-pointless messages at DEBUG rather than
    spending the forgery-signal WARNING on them. It does not make the job
    re-adoptable: `try_readopt` requires status `queued`, and `cancelled` is
    terminal.

    A no-op returning None for a job that's already terminal (done, failed,
    or already cancelled) or doesn't exist -- cancelling twice, or cancelling
    something that finished moments before the request landed, must not
    stomp on a real result. `_TERMINAL_STATUSES` and `_CANCELLABLE_STATUSES`
    partition the status space between them, so nothing else falls through.

    A cancelled job never gets a receipt: this function only ever flips
    `status`/`error`/`finished_at`, the same fields `mark_done`/`mark_failed`
    touch -- receipt creation lives entirely in agentws's `job_done` handling
    and is never invoked from here.

    Phase 3.3 §3.6: cancelling a CHILD job cancels the whole family -- the
    parent moves to `cancelled` and the surviving siblings are cancelled with
    it (see `split.refresh_parent`). `cancelled_owners`, when given, collects
    `(child_id, worker_id)` for each sibling that still had a live owner, so
    the caller can push `job_cancelled` to those workers too; this function's
    own return value stays exactly what it always was (the worker that owned
    `job_id` itself). Cancelling a PARENT does not cascade from here -- the
    parent has no `parent_id` -- `agentws.cancel_and_notify` walks its
    children explicitly so each one gets the full cancel-and-notify
    treatment.
    """
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        if job is None or job.status not in _CANCELLABLE_STATUSES:
            return None
        owning_worker_id = job.worker_id
        job.status = "cancelled"
        job.error = reason
        job.finished_at = _utcnow()
        if owning_worker_id is not None:
            job.last_worker_id = owning_worker_id
            job.worker_id = None
        session.commit()
    split.child_status_changed(job_id, cancelled_owners=cancelled_owners)
    return owning_worker_id


def is_terminal(status: str) -> bool:
    """Whether `status` is one a job's lifecycle never leaves.

    Public wrapper around `_TERMINAL_STATUSES` for callers outside this
    module (the admin cancel API needs it to tell a 404 apart from a 409)
    that should not reach into a private module constant.
    """
    return status in _TERMINAL_STATUSES


def try_readopt(job_id: str, worker_id: str) -> bool:
    """Restore ownership of a job to `worker_id` if it's the worker's own job
    blipping back, not someone else's.

    A job only qualifies when it is still `queued` (nobody has picked it up
    since) AND `last_worker_id == worker_id` (this is the same worker
    `requeue_stale` took it from, not merely a worker that happens to be
    guessing job ids). On a match, ownership is restored (`status=assigned,
    worker_id=worker_id`) and True is returned; the caller (agentws's
    `job_done` handling) then proceeds exactly as it would for a normal owned
    completion.

    The atomic claim mirrors `assign_jobs`'s: the `WHERE` clause re-checks
    `status == "queued"` in the same statement that flips it, so a concurrent
    dispatch_tick claiming the job first (rowcount 0) is detected rather than
    the two writers silently clobbering each other.
    """
    with db.get_session() as session:
        result = session.execute(
            update(db.Job)
            .where(
                db.Job.id == job_id,
                db.Job.status == "queued",
                db.Job.last_worker_id == worker_id,
            )
            .values(status="assigned", worker_id=worker_id)
        )
        if result.rowcount != 1:
            session.rollback()
            return False
        session.commit()
        return True


def _owned_job(
    session,
    job_id: Optional[str],
    worker_id: str,
    statuses,
    resolve_warn_level=None,
) -> Optional[db.Job]:
    """Fetch `job_id` only if `worker_id` currently owns it in one of `statuses`.

    Every worker-driven status transition goes through this gate: the agent
    WebSocket carries an authenticated worker identity, but the job_id inside
    a message is attacker-controlled, so a worker must never be able to move a
    job it doesn't own (or one already finished). Mismatches are logged and
    dropped rather than raising -- a compromised or buggy agent shouldn't be
    able to tear down the message loop.

    Log levels are deliberately split, because WARNING here is the signal that
    someone is forging job ids and it has to stay findable:

    * WARNING -- a job owned by someone else, an unknown job id, or an attempt
      to re-transition a job that has already finished. All genuinely wrong.
    * DEBUG -- a job this worker used to own that has since ended without it
      (`last_worker_id` matches and the status is terminal -- in practice a
      cancellation, which releases `worker_id`; see `cancel_job`). The worker
      is not forging anything, it is simply a message or two behind: it keeps
      heartbeating for the job until the `job_cancelled` push it triggers
      reaches it. Charging the forgery WARNING for that would put one line
      per heartbeat in the log for the rest of the run.
    * DEBUG -- this worker's own job simply isn't in the state this call wanted
      (e.g. a repeated busy heartbeat for a job already marked running). That
      is the normal steady state: the agent heartbeats every 30s for the whole
      length of a job, and only the first one has anything to do. Logging those
      at WARNING would bury the forgery signal under hundreds of lines per job.

    `resolve_warn_level`, when given, is called as `resolve_warn_level(job_id)`
    at each of the three genuinely-wrong branches above (never at a DEBUG
    branch) to get the level to log at instead of the hardcoded WARNING --
    letting a caller rate-limit repeat offenses (see agentws._resolve_warn_level)
    without this function needing to know anything about connections or LRUs.
    Defaults to None, which reproduces the unconditional-WARNING behavior
    above exactly -- every caller other than agentws (and any direct test of
    this module) is unaffected.
    """
    if not job_id:
        return None

    def _warn_level() -> int:
        return resolve_warn_level(job_id) if resolve_warn_level is not None else logging.WARNING

    job = session.get(db.Job, job_id)
    if job is None:
        logger.log(_warn_level(), "dispatch: worker %s referenced unknown job %s", worker_id, job_id)
        return None

    if job.worker_id != worker_id:
        was_ours_and_is_over = job.last_worker_id == worker_id and job.status in _TERMINAL_STATUSES
        level = logging.DEBUG if was_ours_and_is_over else _warn_level()
        logger.log(
            level,
            "dispatch: worker %s may not transition job %s owned by %s (status=%s)",
            worker_id,
            job_id,
            job.worker_id,
            job.status,
        )
        return None

    if job.status not in statuses:
        level = _warn_level() if job.status in _TERMINAL_STATUSES else logging.DEBUG
        logger.log(
            level,
            "dispatch: worker %s's job %s is %s, not %s; ignoring.",
            worker_id,
            job_id,
            job.status,
            "/".join(statuses),
        )
        return None

    return job


def mark_running(job_id: str, worker_id: str, resolve_warn_level=None) -> bool:
    """Move an assigned job of `worker_id` to running. Returns whether it acted."""
    with db.get_session() as session:
        job = _owned_job(session, job_id, worker_id, ("assigned",), resolve_warn_level)
        if job is None:
            return False
        job.status = "running"
        job.started_at = _utcnow()
        wait_seconds = (job.started_at - job.created_at).total_seconds()
        session.commit()
    metrics.get_metrics().job_wait_seconds.observe(max(wait_seconds, 0.0))
    # Phase 3.3 §3.4：子 job 動了就重算父 job（不是子 job 的話是 no-op）。
    split.child_status_changed(job_id)
    return True


def mark_done(job_id: str, worker_id: str, result_files: list, resolve_warn_level=None) -> bool:
    """Complete an assigned/running job of `worker_id`. Returns whether it acted."""
    with db.get_session() as session:
        job = _owned_job(session, job_id, worker_id, _OWNED_STATUSES, resolve_warn_level)
        if job is None:
            return False
        job.status = "done"
        job.result_files = json.dumps(result_files)
        job.finished_at = _utcnow()
        run_seconds = (job.finished_at - job.started_at).total_seconds() if job.started_at else None
        session.commit()
    if run_seconds is not None:
        metrics.get_metrics().job_run_seconds.observe(max(run_seconds, 0.0))
    # Phase 3.3 §3.4：子 job 動了就重算父 job（不是子 job 的話是 no-op）。
    # 最後一個子 job 完成時父 job 才會翻成 done。
    split.child_status_changed(job_id)
    return True


def mark_failed(
    job_id: str,
    worker_id: str,
    error: str,
    resolve_warn_level=None,
    cancelled_owners: Optional[list] = None,
) -> bool:
    """Fail an assigned/running job of `worker_id`. Returns whether it acted.

    Phase 3.3 §3.4/§3.6: failing a CHILD job also fails its parent and
    cascade-cancels the surviving siblings. `cancelled_owners`, when given,
    collects `(child_id, worker_id)` for each sibling that still had a live
    owner at that moment, so the WebSocket layer can push `job_cancelled` to
    those workers (see `split.refresh_parent`). Omitting it does not change
    what happens in the database -- the cancellations still occur, they just
    self-heal on the worker's next message instead of being pushed
    immediately (see `cancel_job`'s docstring for that mechanism).
    """
    with db.get_session() as session:
        job = _owned_job(session, job_id, worker_id, _OWNED_STATUSES, resolve_warn_level)
        if job is None:
            return False
        job.status = "failed"
        job.error = error
        job.finished_at = _utcnow()
        run_seconds = (job.finished_at - job.started_at).total_seconds() if job.started_at else None
        session.commit()
    if run_seconds is not None:
        metrics.get_metrics().job_run_seconds.observe(max(run_seconds, 0.0))
    # Phase 3.3 §3.4：子 job 失敗 -> 父 job 失敗 + 其他子 job 一起取消。
    split.child_status_changed(job_id, cancelled_owners=cancelled_owners)
    return True
