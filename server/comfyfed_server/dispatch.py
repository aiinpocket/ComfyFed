"""Atomic job dispatch, stale-worker requeue, and job status transitions."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import update

from . import assess, db, metrics

_STALE_SECONDS = 90


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _job_needs(job: db.Job) -> assess.JobNeeds:
    try:
        nodes = set(json.loads(job.required_nodes or "[]"))
    except (TypeError, ValueError):
        nodes = set()
    try:
        models = set(json.loads(job.required_models or "[]"))
    except (TypeError, ValueError):
        models = set()
    return assess.JobNeeds(nodes=nodes, models=models, est_vram_gb=job.est_vram_gb, assets=set())


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

            needs = _job_needs(job)
            v = assess.verdict(worker, needs, requirements_override, all_workers)
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


def requeue_stale(now: datetime) -> int:
    """Requeue assigned/running jobs of workers that haven't checked in recently.

    A worker is stale if `now - worker.last_seen > 90s` (or last_seen is
    unset). Its assigned/running jobs go back to queued (worker_id cleared,
    progress reset), and the worker itself is marked offline.
    """
    cutoff = now - timedelta(seconds=_STALE_SECONDS)
    count = 0
    with db.get_session() as session:
        workers = session.query(db.Worker).all()
        for worker in workers:
            if worker.last_seen is None or worker.last_seen >= cutoff:
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
                count += 1

            worker.status = "offline"
            metrics.get_metrics().worker_up.labels(worker=worker.name).set(0)

        session.commit()

    return count


def mark_running(job_id: str) -> None:
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        if job is None:
            return
        job.status = "running"
        job.started_at = _utcnow()
        wait_seconds = (job.started_at - job.created_at).total_seconds()
        session.commit()
    metrics.get_metrics().job_wait_seconds.observe(max(wait_seconds, 0.0))


def mark_done(job_id: str, result_files: list) -> None:
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        if job is None:
            return
        job.status = "done"
        job.result_files = json.dumps(result_files)
        job.finished_at = _utcnow()
        run_seconds = (job.finished_at - job.started_at).total_seconds() if job.started_at else None
        session.commit()
    if run_seconds is not None:
        metrics.get_metrics().job_run_seconds.observe(max(run_seconds, 0.0))


def mark_failed(job_id: str, error: str) -> None:
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        if job is None:
            return
        job.status = "failed"
        job.error = error
        job.finished_at = _utcnow()
        run_seconds = (job.finished_at - job.started_at).total_seconds() if job.started_at else None
        session.commit()
    if run_seconds is not None:
        metrics.get_metrics().job_run_seconds.observe(max(run_seconds, 0.0))
