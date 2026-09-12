"""Unit tests for dispatch.py's job-lifecycle transitions that don't need a
live agent WebSocket: the `last_worker_id` migration/model, `requeue_stale`
recording it, `cancel_job`, and `try_readopt`. The WS-level integration
(job_cancelled pushes, blip re-adoption over job_done, artifact upload during
the blip window) lives in test_agent_ws.py / test_receipts.py instead, where
the fixtures for a live connection already exist.
"""

from datetime import datetime, timedelta, timezone

import pytest
from alembic import command
from alembic.config import Config

from comfyfed_server import db, dispatch, metrics


@pytest.fixture()
def _db(tmp_path):
    db.init_db(str(tmp_path / "t.db"))
    metrics.init()


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _make_worker(worker_id="w1"):
    with db.get_session() as session:
        session.add(db.Worker(id=worker_id, name=worker_id, pubkey="pk"))
        session.commit()
    return worker_id


def _make_job(job_id="j1", status="queued", worker_id=None, last_worker_id=None):
    with db.get_session() as session:
        session.add(
            db.Job(
                id=job_id,
                workflow_json="{}",
                status=status,
                worker_id=worker_id,
                last_worker_id=last_worker_id,
            )
        )
        session.commit()
    return job_id


# --- Step 1: migration + model ------------------------------------------


def test_job_last_worker_id_defaults_to_none(_db):
    job_id = _make_job()
    with db.get_session() as session:
        assert session.get(db.Job, job_id).last_worker_id is None


def test_alembic_upgrade_head_from_pre_existing_db_adds_last_worker_id(tmp_path):
    """A DB already at the previous head (migration 4, before this one) must
    upgrade to head cleanly and end up with the new nullable column."""
    db_path = str(tmp_path / "t.db")
    cfg = Config()
    cfg.set_main_option("script_location", db._alembic_dir())
    cfg.set_main_option("sqlalchemy.url", f"sqlite+pysqlite:///{db_path}")

    command.upgrade(cfg, "c3d4e5f6a7b8")  # pre-existing DB, one migration behind

    command.upgrade(cfg, "head")

    import sqlite3

    conn = sqlite3.connect(db_path)
    try:
        cols = {row[1]: row for row in conn.execute("PRAGMA table_info(jobs)").fetchall()}
    finally:
        conn.close()
    assert "last_worker_id" in cols
    # notnull column of PRAGMA table_info is 0 for nullable columns.
    assert cols["last_worker_id"][3] == 0


# --- Step 2: requeue_stale records last_worker_id ------------------------


def test_requeue_stale_records_last_worker_id_and_clears_worker_id(_db):
    worker_id = _make_worker()
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.last_seen = _utcnow() - timedelta(seconds=200)
        session.commit()
    job_id = _make_job(status="assigned", worker_id=worker_id)

    requeued = dispatch.requeue_stale(_utcnow())

    assert requeued == [job_id]
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        assert job.status == "queued"
        assert job.worker_id is None
        assert job.progress == 0
        assert job.last_worker_id == worker_id


# --- Step 3: cancel_job ---------------------------------------------------


@pytest.mark.parametrize("status", ["assigned", "running"])
def test_cancel_job_owned_job_returns_owner_and_sets_error_and_finished_at(_db, status):
    worker_id = _make_worker()
    job_id = _make_job(status=status, worker_id=worker_id)

    result = dispatch.cancel_job(job_id, reason="user requested")

    assert result == worker_id
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        assert job.status == "cancelled"
        assert job.error == "user requested"
        assert job.finished_at is not None


def test_cancel_job_queued_job_returns_none_but_still_cancels(_db):
    job_id = _make_job(status="queued")

    result = dispatch.cancel_job(job_id, reason="user requested")

    assert result is None
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        assert job.status == "cancelled"
        assert job.error == "user requested"
        assert job.finished_at is not None


@pytest.mark.parametrize("status", ["done", "failed", "cancelled"])
def test_cancel_job_is_a_no_op_on_terminal_jobs(_db, status):
    job_id = _make_job(status=status)

    assert dispatch.cancel_job(job_id, reason="too late") is None
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        assert job.status == status
        assert job.error is None


def test_cancel_job_unknown_job_is_a_no_op(_db):
    assert dispatch.cancel_job("no-such-job", reason="x") is None


def test_cancel_job_never_creates_a_receipt(_db):
    worker_id = _make_worker()
    job_id = _make_job(status="running", worker_id=worker_id)

    dispatch.cancel_job(job_id, reason="user requested")

    with db.get_session() as session:
        assert session.query(db.Receipt).count() == 0


# --- Step 4: try_readopt ---------------------------------------------------


def test_try_readopt_restores_ownership_on_matching_blip(_db):
    worker_id = _make_worker()
    job_id = _make_job(status="queued", worker_id=None, last_worker_id=worker_id)

    assert dispatch.try_readopt(job_id, worker_id) is True
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        assert job.status == "assigned"
        assert job.worker_id == worker_id


def test_try_readopt_false_when_last_worker_id_differs(_db):
    worker_id = _make_worker("w1")
    other_id = _make_worker("w2")
    job_id = _make_job(status="queued", worker_id=None, last_worker_id=other_id)

    assert dispatch.try_readopt(job_id, worker_id) is False
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        assert job.status == "queued"
        assert job.worker_id is None


def test_try_readopt_false_when_assigned_to_someone_else(_db):
    worker_id = _make_worker("w1")
    other_id = _make_worker("w2")
    job_id = _make_job(status="assigned", worker_id=other_id, last_worker_id=worker_id)

    assert dispatch.try_readopt(job_id, worker_id) is False
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        assert job.status == "assigned"
        assert job.worker_id == other_id


def test_try_readopt_false_on_terminal_job(_db):
    worker_id = _make_worker()
    job_id = _make_job(status="done", worker_id=None, last_worker_id=worker_id)

    assert dispatch.try_readopt(job_id, worker_id) is False
