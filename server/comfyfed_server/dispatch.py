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
_TERMINAL_STATUSES = ("done", "failed")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def pick_job_for(worker_id: str) -> Optional[db.Job]:
    """Atomically assign the oldest eligible queued job to `worker_id`.

    Jobs that are not eligible for this worker are skipped without blocking
    later (newer) jobs from being considered.
    """
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        if worker is None:
            return None

        all_workers = session.query(db.Worker).all()

        queued_jobs = (
            session.query(db.Job)
            .filter(db.Job.status == "queued")
            .order_by(db.Job.created_at.asc())
            .all()
        )

        for job in queued_jobs:
            requirements_override = {}
            try:
                requirements_override = json.loads(job.requirements or "{}")
            except (TypeError, ValueError):
                requirements_override = {}

            needs = assess.needs_from_job(job)
            v = assess.verdict(worker, needs, requirements_override, all_workers)
            # `warnings` (e.g. vram_offload) are explicitly NOT a bar to
            # dispatch: an eligible-with-warning worker runs the job, just
            # more slowly. Phase 1 does no preference ordering between a
            # clean worker and a warned one.
            if v.kind != "eligible":
                continue

            # Atomic claim: only succeeds if the job is still queued. If
            # another process/thread beat us to it, rowcount is 0 and we
            # move on to the next candidate rather than returning a job
            # that's no longer actually ours.
            result = session.execute(
                update(db.Job)
                .where(db.Job.id == job.id, db.Job.status == "queued")
                .values(status="assigned", worker_id=worker_id)
            )
            if result.rowcount != 1:
                session.rollback()
                continue

            session.commit()
            session.refresh(job)
            return job

        return None


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
                job.worker_id = None
                job.progress = 0
                requeued.append(job.id)

            worker.status = "offline"
            metrics.get_metrics().worker_up.labels(worker=worker.name).set(0)

        session.commit()

    return requeued


def _owned_job(session, job_id: Optional[str], worker_id: str, statuses) -> Optional[db.Job]:
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
    * DEBUG -- this worker's own job simply isn't in the state this call wanted
      (e.g. a repeated busy heartbeat for a job already marked running). That
      is the normal steady state: the agent heartbeats every 30s for the whole
      length of a job, and only the first one has anything to do. Logging those
      at WARNING would bury the forgery signal under hundreds of lines per job.
    """
    if not job_id:
        return None
    job = session.get(db.Job, job_id)
    if job is None:
        logger.warning("dispatch: worker %s referenced unknown job %s", worker_id, job_id)
        return None

    if job.worker_id != worker_id:
        logger.warning(
            "dispatch: worker %s may not transition job %s owned by %s (status=%s)",
            worker_id,
            job_id,
            job.worker_id,
            job.status,
        )
        return None

    if job.status not in statuses:
        log = logger.warning if job.status in _TERMINAL_STATUSES else logger.debug
        log(
            "dispatch: worker %s's job %s is %s, not %s; ignoring.",
            worker_id,
            job_id,
            job.status,
            "/".join(statuses),
        )
        return None

    return job


def mark_running(job_id: str, worker_id: str) -> bool:
    """Move an assigned job of `worker_id` to running. Returns whether it acted."""
    with db.get_session() as session:
        job = _owned_job(session, job_id, worker_id, ("assigned",))
        if job is None:
            return False
        job.status = "running"
        job.started_at = _utcnow()
        wait_seconds = (job.started_at - job.created_at).total_seconds()
        session.commit()
    metrics.get_metrics().job_wait_seconds.observe(max(wait_seconds, 0.0))
    return True


def mark_done(job_id: str, worker_id: str, result_files: list) -> bool:
    """Complete an assigned/running job of `worker_id`. Returns whether it acted."""
    with db.get_session() as session:
        job = _owned_job(session, job_id, worker_id, _OWNED_STATUSES)
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


def mark_failed(job_id: str, worker_id: str, error: str) -> bool:
    """Fail an assigned/running job of `worker_id`. Returns whether it acted."""
    with db.get_session() as session:
        job = _owned_job(session, job_id, worker_id, _OWNED_STATUSES)
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
