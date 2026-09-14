"""Atomic job dispatch, stale-worker requeue, and job status transitions."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import update

from . import assess, db, metrics

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


def assign_jobs(
    idle_worker_ids: list[str],
    fetchable_models: Optional[dict[str, int]] = None,
    peer_only_models: Optional[frozenset[str]] = None,
) -> list[tuple[str, db.Job]]:
    """Rank idle workers per queued job and atomically claim the best pair.

    For each queued job, oldest first, every still-unassigned idle worker's
    `assess.verdict` is evaluated and the best eligible one picked, in two
    tiers:

    1. Directly eligible (`verdict.kind == "eligible"`) candidates, ranked
       exactly as before Phase 2.1 Task 4:
       a. eligible with no warnings beats eligible-with-warnings (e.g. the
          `vram_offload` note) -- a clean run beats one that will offload.
       b. tie-break by largest free VRAM, from the worker's `dynamic`
          heartbeat snapshot (see `_free_vram_gb`) -- or, for a "light" job
          (see below), by the light-job preference instead.
       c. stable tie-break by worker name, so results are deterministic when
          ranking is otherwise a wash.
    2. Only when tier 1 has NO candidates at all: `eligible_after_fetch`
       candidates, ranked by (has_warnings, total_fetch_bytes ASC -- smallest
       download first, then the SAME job-class VRAM key tier 1 uses, then
       name). A worker that already has everything always wins over one that
       would have to download something first, however big or small; fetch
       ranking only decides among candidates where NOBODY already has it.

    `fetchable_models` is passed straight through to `assess.verdict` (name
    -> size_bytes from the signed manifest, `model_manifest.entries()`'s
    shape) -- None (the default) means "nothing fetchable", the exact
    pre-Task-4 behavior, so any other caller (tests) that doesn't pass it
    gets tier 1 only, unchanged. `peer_only_models` (Phase 3.1 P2P,
    `model_manifest.peer_only_names`'s shape) is likewise passed straight
    through -- see `assess.verdict`'s protocol>=4-for-peer-only gate.

    The winning candidate's `fetch_models` push payload (the manifest entries
    for its missing models) is deliberately NOT part of this function's
    return value -- `assign_jobs` keeps its original `(worker_id, job)` tuple
    shape (a lot of existing tests unpack it that way) and `agentws.
    dispatch_tick` recomputes the verdict for the one (worker, job) pair it
    actually pushes to, right before sending the frame. See dispatch_tick's
    docstring for that seam.

    Each worker is claimed for at most one job per call: once a worker wins a
    job it drops out of the candidate pool for every later job this tick.
    The claim itself is atomic: the `WHERE status == "queued"` re-check in
    the same UPDATE statement means
    a job someone else claimed a moment ago (rowcount 0) is skipped rather
    than double-assigned.

    Returns the (worker_id, job) pairs actually claimed, for the caller
    (`agentws.dispatch_tick`) to push over each worker's connection.
    """
    if not idle_worker_ids:
        return []

    with db.get_session() as session:
        workers = {
            w.id: w
            for w in session.query(db.Worker).filter(db.Worker.id.in_(idle_worker_ids)).all()
        }
        if not workers:
            return []

        all_workers = session.query(db.Worker).all()

        queued_jobs = (
            session.query(db.Job)
            .filter(db.Job.status == "queued")
            .order_by(db.Job.created_at.asc())
            .all()
        )

        available_worker_ids = set(workers.keys())
        assignments: list[tuple[str, db.Job]] = []

        for job in queued_jobs:
            if not available_worker_ids:
                break

            requirements_override = {}
            try:
                requirements_override = json.loads(job.requirements or "{}")
            except (TypeError, ValueError):
                requirements_override = {}

            needs = assess.needs_from_job(job)
            is_light = not needs.models and not (needs.est_vram_gb or 0)

            candidates = []
            fetch_candidates = []
            for candidate_id in available_worker_ids:
                worker = workers[candidate_id]
                v = assess.verdict(
                    worker, needs, requirements_override, all_workers, fetchable_models, peer_only_models
                )
                if v.kind not in ("eligible", "eligible_after_fetch"):
                    continue
                if is_light:
                    # Zero-model work (e.g. stitching finished clips into a
                    # video) needs no GPU at all -- 合併影片這類零模型工作交給
                    # 弱 GPU／Mac，把大卡留給模型任務. Clean beats warned as
                    # always, then a weak-backend (mps/cpu) worker beats a
                    # real GPU, then SMALLEST free VRAM first (weakest GPU
                    # among the rest), so the biggest cards stay free for
                    # jobs that actually need them.
                    job_class_key = (
                        worker.backend not in ("mps", "cpu"),
                        _free_vram_gb(worker),
                    )
                else:
                    # (-free_vram,): sorts largest free VRAM first.
                    job_class_key = (-_free_vram_gb(worker),)

                if v.kind == "eligible":
                    candidates.append((bool(v.warnings), *job_class_key, worker.name, candidate_id))
                else:
                    # eligible_after_fetch: only ever consulted when NO worker
                    # is directly eligible (see below) -- ranked clean-before-
                    # warned same as tier 1, then SMALLEST total download size
                    # first, then the same job-class VRAM key, then name.
                    total_fetch_bytes = sum(
                        (fetchable_models or {}).get(name, 0) for name in v.missing_models
                    )
                    fetch_candidates.append(
                        (bool(v.warnings), total_fetch_bytes, *job_class_key, worker.name, candidate_id)
                    )

            # Tier 2 (fetch-then-run) is only ever considered when tier 1
            # (already has everything) is completely empty -- a worker that
            # can run right now always beats one that must download first.
            active_candidates = candidates or fetch_candidates
            if not active_candidates:
                continue

            active_candidates.sort()
            best_worker_id = active_candidates[0][-1]

            # Atomic claim: only succeeds if the job is still queued. If
            # another process/thread beat us to it, rowcount is 0 and we
            # move on to the next job rather than assigning one that's no
            # longer actually up for grabs.
            result = session.execute(
                update(db.Job)
                .where(db.Job.id == job.id, db.Job.status == "queued")
                .values(status="assigned", worker_id=best_worker_id)
            )
            if result.rowcount != 1:
                session.rollback()
                continue

            session.commit()
            session.refresh(job)
            assignments.append((best_worker_id, job))
            available_worker_ids.discard(best_worker_id)

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

            worker.status = "offline"
            # Phase 3.1 P2P: a seeder endpoint only means anything while the
            # worker is actually reachable -- clear it here so a stale
            # worker is never handed out as a grant's seeder (see
            # agentws._handle_hello, which is the only place peer_url gets
            # set again, on the agent's next hello).
            worker.peer_url = None
            metrics.get_metrics().worker_up.labels(worker=worker.name).set(0)

        session.commit()

    return requeued


def cancel_job(job_id: str, *, reason: str) -> Optional[str]:
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
    return True


def mark_failed(job_id: str, worker_id: str, error: str, resolve_warn_level=None) -> bool:
    """Fail an assigned/running job of `worker_id`. Returns whether it acted."""
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
    return True
