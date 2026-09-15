"""Unit tests for dispatch.py's job-lifecycle transitions that don't need a
live agent WebSocket: the `last_worker_id` migration/model, `requeue_stale`
recording it, `cancel_job`, and `try_readopt`. The WS-level integration
(job_cancelled pushes, blip re-adoption over job_done, artifact upload during
the blip window) lives in test_agent_ws.py / test_receipts.py instead, where
the fixtures for a live connection already exist.
"""

import json
from datetime import datetime, timedelta, timezone

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import update

from comfyfed_server import db, dispatch, metrics, scheduler, split


@pytest.fixture()
def _db(tmp_path):
    db.init_db(str(tmp_path / "t.db"))
    metrics.init()


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _make_worker(worker_id="w1", hardware=None, dynamic=None, model_inventory=None):
    with db.get_session() as session:
        session.add(
            db.Worker(
                id=worker_id,
                name=worker_id,
                pubkey="pk",
                hardware=json.dumps(hardware or {}),
                dynamic=json.dumps(dynamic or {}),
                model_inventory=json.dumps(model_inventory or []),
            )
        )
        session.commit()
    return worker_id


def _make_job(job_id="j1", status="queued", worker_id=None, last_worker_id=None, est_vram_gb=None):
    with db.get_session() as session:
        session.add(
            db.Job(
                id=job_id,
                workflow_json="{}",
                status=status,
                worker_id=worker_id,
                last_worker_id=last_worker_id,
                est_vram_gb=est_vram_gb,
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


def test_alembic_migration_8_adds_worker_protocol_defaulting_to_1(tmp_path):
    """A DB already at the previous head (migration #7, receipt
    kind/billable/basis) must upgrade to head cleanly, backfilling every
    pre-existing worker as protocol=1 -- it predates `hello.protocol` and is
    a pre-Phase-1.9 agent until it reconnects with a fresh hello."""
    import sqlite3

    db_path = str(tmp_path / "t.db")
    cfg = Config()
    cfg.set_main_option("script_location", db._alembic_dir())
    cfg.set_main_option("sqlalchemy.url", f"sqlite+pysqlite:///{db_path}")

    command.upgrade(cfg, "f6a7b8c9d0e1")  # pre-existing DB, one migration behind

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO workers (id, name, pubkey, created_at) VALUES ('w1', 'w1', 'pk', '2026-01-01 00:00:00')"
        )
        conn.commit()
    finally:
        conn.close()

    command.upgrade(cfg, "head")

    conn = sqlite3.connect(db_path)
    try:
        cols = {row[1]: row for row in conn.execute("PRAGMA table_info(workers)").fetchall()}
        protocol = conn.execute("SELECT protocol FROM workers WHERE id = 'w1'").fetchone()[0]
    finally:
        conn.close()
    assert "protocol" in cols
    assert cols["protocol"][3] == 1  # NOT NULL
    assert protocol == 1

    command.downgrade(cfg, "f6a7b8c9d0e1")
    conn = sqlite3.connect(db_path)
    try:
        cols_after = {row[1] for row in conn.execute("PRAGMA table_info(workers)").fetchall()}
    finally:
        conn.close()
    assert "protocol" not in cols_after


def test_alembic_migration_e1f2a3b4c5d6_adds_p2p_columns(tmp_path):
    """Phase 3.1 Task 1: a DB at the previous head (d0e1f2a3b4c5, users/
    multi-user) must upgrade to head cleanly, gaining
    model_hashes.chunk_sha256s, receipts.bytes, workers.peer_url (all
    nullable) and receipts.job_id turning nullable (needed for the
    job-less p2p_upload receipt kind) -- while pre-existing rows keep
    their values."""
    import sqlite3
    import uuid

    db_path = str(tmp_path / "t.db")
    cfg = Config()
    cfg.set_main_option("script_location", db._alembic_dir())
    cfg.set_main_option("sqlalchemy.url", f"sqlite+pysqlite:///{db_path}")

    command.upgrade(cfg, "d0e1f2a3b4c5")  # pre-existing DB, one migration behind

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO workers (id, name, pubkey, created_at) VALUES "
            "('w1', 'w1', 'pk', '2026-01-01 00:00:00')"
        )
        conn.execute(
            "INSERT INTO model_hashes (name, size_bytes, sha256, first_worker_id, "
            "created_at) VALUES ('m/f.safetensors', 100, 'deadbeef', 'w1', "
            "'2026-01-01 00:00:00')"
        )
        job_id = uuid.uuid4().hex
        conn.execute(
            "INSERT INTO jobs (id, workflow_json, status, progress, created_at, "
            "result_files, requirements, required_nodes, required_models, "
            "input_assets, result_hashes, origin, panel_hidden) VALUES "
            "(:id, '{}', 'queued', 0, '2026-01-01 00:00:00', '[]', '{}', '[]', "
            "'[]', '[]', '{}', 'console', 0)".replace(":id", f"'{job_id}'")
        )
        receipt_id = uuid.uuid4().hex
        conn.execute(
            "INSERT INTO receipts (id, job_id, worker_id, gpu_seconds, "
            "platform_sig, created_at) VALUES "
            f"('{receipt_id}', '{job_id}', 'w1', 1.5, 'sig', '2026-01-01 00:00:00')"
        )
        conn.commit()
    finally:
        conn.close()

    command.upgrade(cfg, "head")

    conn = sqlite3.connect(db_path)
    try:
        worker_cols = {row[1]: row for row in conn.execute("PRAGMA table_info(workers)").fetchall()}
        hash_cols = {row[1]: row for row in conn.execute("PRAGMA table_info(model_hashes)").fetchall()}
        receipt_cols = {row[1]: row for row in conn.execute("PRAGMA table_info(receipts)").fetchall()}

        peer_url = conn.execute("SELECT peer_url FROM workers WHERE id = 'w1'").fetchone()[0]
        chunk_sha256s = conn.execute(
            "SELECT chunk_sha256s FROM model_hashes WHERE name = 'm/f.safetensors'"
        ).fetchone()[0]
        receipt_row = conn.execute(
            "SELECT job_id, bytes, worker_id, gpu_seconds FROM receipts WHERE id = ?", (receipt_id,)
        ).fetchone()

        # New p2p_upload-style row: no job_id, has bytes -- must be insertable
        # now that job_id is nullable.
        conn.execute(
            "INSERT INTO receipts (id, job_id, worker_id, gpu_seconds, "
            "platform_sig, created_at, bytes) VALUES "
            "('r2', NULL, 'w1', 0.0, 'sig', '2026-01-01 00:00:00', 12345)"
        )
        conn.commit()
        bytes_row = conn.execute("SELECT job_id, bytes FROM receipts WHERE id = 'r2'").fetchone()
    finally:
        conn.close()

    assert "peer_url" in worker_cols and worker_cols["peer_url"][3] == 0  # nullable
    assert peer_url is None

    assert "chunk_sha256s" in hash_cols and hash_cols["chunk_sha256s"][3] == 0  # nullable
    assert chunk_sha256s is None

    assert "bytes" in receipt_cols and receipt_cols["bytes"][3] == 0  # nullable
    assert receipt_cols["job_id"][3] == 0  # now nullable
    # pre-existing receipt row untouched
    assert receipt_row == (job_id, None, "w1", 1.5)
    # new job-less p2p_upload-shaped row went in fine
    assert bytes_row == (None, 12345)


def test_alembic_migration_a2b3c4d5e6f7_adds_scheduler_columns(tmp_path):
    """從前一個 head（f1a2b3c4d5e6）升上來，新欄位與新表都要在，
    而且既有資料列的預設值要正確。"""
    db_path = str(tmp_path / "t.db")
    cfg = Config()
    cfg.set_main_option("script_location", db._alembic_dir())
    cfg.set_main_option("sqlalchemy.url", f"sqlite+pysqlite:///{db_path}")

    command.upgrade(cfg, "f1a2b3c4d5e6")

    import sqlite3

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO jobs (id, workflow_json, status, progress, created_at, "
            "result_files, requirements, required_nodes, required_models, "
            "input_assets, result_hashes, origin, panel_hidden) "
            "VALUES ('old-job', '{}', 'done', 0, '2026-01-01 00:00:00', "
            "'[]', '{}', '[]', '[]', '[]', '{}', 'console', 0)"
        )
        conn.execute(
            "INSERT INTO workers (id, name, pubkey, status, disabled, deleted, created_at, "
            "hardware, dynamic, backend, torch_version, node_classes, model_inventory, "
            "object_info_hash, protocol, auto_fetch) "
            "VALUES ('old-w', 'old-w', 'pk', 'offline', 0, 0, '2026-01-01 00:00:00', "
            "'{}', '{}', '', '', '[]', '[]', '', 1, 0)"
        )
        conn.commit()
    finally:
        conn.close()

    command.upgrade(cfg, "head")

    conn = sqlite3.connect(db_path)
    try:
        job_cols = {row[1] for row in conn.execute("PRAGMA table_info(jobs)").fetchall()}
        worker_cols = {row[1] for row in conn.execute("PRAGMA table_info(workers)").fetchall()}
        stats_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(worker_job_stats)").fetchall()
        }
        row = conn.execute(
            "SELECT signature, dispatch_info, parent_id, split_index, split_count, split_plan "
            "FROM jobs WHERE id = 'old-job'"
        ).fetchone()
        worker_row = conn.execute(
            "SELECT speed_index, warm_models FROM workers WHERE id = 'old-w'"
        ).fetchone()
    finally:
        conn.close()

    assert {"signature", "dispatch_info", "parent_id", "split_index", "split_count", "split_plan"} <= job_cols
    assert {"speed_index", "warm_models"} <= worker_cols
    assert {"worker_id", "signature", "ewma_seconds", "samples", "updated_at"} == stats_cols
    assert row == (None, "{}", None, None, 0, None)
    assert worker_row == (1.0, "[]")


# --- Step 2: requeue_stale records last_worker_id ------------------------


def test_requeue_stale_clears_peer_url(_db):
    """Phase 3.1 P2P: a worker's advertised seeder endpoint is only good
    while it's actually reachable. requeue_stale is the one place that
    flips a worker to offline (see its docstring), so it must clear
    peer_url there -- otherwise a dead endpoint could be handed out as a
    grant's seeder."""
    worker_id = _make_worker()
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.last_seen = _utcnow() - timedelta(seconds=200)
        worker.peer_url = "http://192.168.1.5:8850"
        session.commit()

    dispatch.requeue_stale(_utcnow())

    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        assert worker.status == "offline"
        assert worker.peer_url is None


def test_requeue_stale_still_requeues_a_deleted_workers_job(_db):
    """Review H1's counterweight: the metric/gauge bookkeeping skips deleted
    rows, but the JOB pass must not -- an admin delete kicks the socket without
    touching in-flight rows, and this is the only path that frees them."""
    worker_id = _make_worker()
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.last_seen = _utcnow() - timedelta(seconds=200)
        worker.deleted = True
        worker.disabled = True
        session.commit()
    job_id = _make_job(status="running", worker_id=worker_id)

    assert dispatch.requeue_stale(_utcnow()) == [job_id]

    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "queued"
        assert session.get(db.Worker, worker_id).status == "offline"


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


# --- Task 4: assign_jobs -- rank eligible workers per job -------------------


def test_assign_jobs_prefers_clean_worker_over_warned_worker(_db):
    # w_warn has just enough VRAM+RAM headroom to be eligible-with-warning
    # (vram_offload); w_clean fits the job in VRAM outright.
    warned_id = _make_worker("w_warn", hardware={"vram_gb": 8, "ram_gb": 64})
    clean_id = _make_worker("w_clean", hardware={"vram_gb": 24, "ram_gb": 64})
    job_id = _make_job(est_vram_gb=20)

    assignments = dispatch.assign_jobs([warned_id, clean_id])

    assert len(assignments) == 1
    worker_id, job = assignments[0]
    assert worker_id == clean_id
    assert job.id == job_id
    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "assigned"
        assert session.get(db.Job, job_id).worker_id == clean_id


def test_assign_jobs_ties_broken_by_largest_free_vram(_db):
    # A model-bearing (heavy) job: keeps the pre-Task-6 heavy-job ranking.
    small_id = _make_worker("w_small", dynamic={"free_vram_gb": 4})
    big_id = _make_worker("w_big", dynamic={"free_vram_gb": 12})
    job_id = _make_job(est_vram_gb=1)

    assignments = dispatch.assign_jobs([small_id, big_id])

    assert len(assignments) == 1
    worker_id, job = assignments[0]
    assert worker_id == big_id
    assert job.id == job_id


# --- Task 6: light-job dispatch preference --------------------------------


def _make_worker_backend(worker_id, backend, dynamic=None):
    with db.get_session() as session:
        session.add(
            db.Worker(
                id=worker_id,
                name=worker_id,
                pubkey="pk",
                backend=backend,
                hardware=json.dumps({}),
                dynamic=json.dumps(dynamic or {}),
            )
        )
        session.commit()
    return worker_id


def test_light_job_prefers_mps_worker_over_a_32gb_cuda_worker(_db):
    """A zero-model job (no required models, no est_vram_gb) should go to a
    weak/Mac worker rather than stealing the biggest GPU."""
    mac_id = _make_worker_backend("w_mac", "mps", dynamic={"free_vram_gb": 0})
    big_cuda_id = _make_worker_backend("w_cuda_big", "cuda", dynamic={"free_vram_gb": 32})
    job_id = _make_job()  # no models, no est_vram_gb -> light

    assignments = dispatch.assign_jobs([mac_id, big_cuda_id])

    assert len(assignments) == 1
    worker_id, job = assignments[0]
    assert worker_id == mac_id
    assert job.id == job_id


def test_light_job_prefers_smallest_free_vram_cuda_worker(_db):
    """Among two GPU workers (neither weak-backend), a light job should still
    go to the smallest free VRAM one, leaving the big card free."""
    small_cuda_id = _make_worker_backend("w_cuda_small", "cuda", dynamic={"free_vram_gb": 8})
    big_cuda_id = _make_worker_backend("w_cuda_big", "cuda", dynamic={"free_vram_gb": 24})
    job_id = _make_job()

    assignments = dispatch.assign_jobs([small_cuda_id, big_cuda_id])

    assert len(assignments) == 1
    worker_id, job = assignments[0]
    assert worker_id == small_cuda_id
    assert job.id == job_id


def test_heavy_job_ranking_is_unchanged_by_light_job_preference(_db):
    """A job with a real VRAM requirement must still prefer the biggest free
    VRAM worker, exactly as before -- the light-job preference must not leak
    into heavy-job ranking."""
    mac_id = _make_worker_backend("w_mac", "mps", dynamic={"free_vram_gb": 0})
    big_cuda_id = _make_worker_backend("w_cuda_big", "cuda", dynamic={"free_vram_gb": 32})
    job_id = _make_job(est_vram_gb=10)

    assignments = dispatch.assign_jobs([mac_id, big_cuda_id])

    assert len(assignments) == 1
    worker_id, job = assignments[0]
    assert worker_id == big_cuda_id
    assert job.id == job_id


def test_assign_jobs_assigns_both_jobs_oldest_first_in_one_tick(_db):
    worker_a = _make_worker("w_a")
    worker_b = _make_worker("w_b")
    now = _utcnow()
    with db.get_session() as session:
        session.add(
            db.Job(id="j_old", workflow_json="{}", status="queued", created_at=now - timedelta(seconds=10))
        )
        session.add(db.Job(id="j_new", workflow_json="{}", status="queued", created_at=now))
        session.commit()

    assignments = dispatch.assign_jobs([worker_a, worker_b])

    assert len(assignments) == 2
    assigned_job_ids = {job.id for _worker_id, job in assignments}
    assert assigned_job_ids == {"j_old", "j_new"}
    assigned_worker_ids = {worker_id for worker_id, _job in assignments}
    assert assigned_worker_ids == {worker_a, worker_b}
    with db.get_session() as session:
        assert session.get(db.Job, "j_old").status == "assigned"
        assert session.get(db.Job, "j_new").status == "assigned"


def test_assign_jobs_skips_gracefully_when_job_already_claimed(_db):
    worker_id = _make_worker()
    job_id = _make_job()

    # Simulate a concurrent claim landing between candidate evaluation and
    # this call's own atomic UPDATE: the job is no longer queued by the time
    # assign_jobs gets to it.
    with db.get_session() as session:
        session.execute(
            update(db.Job).where(db.Job.id == job_id).values(status="assigned", worker_id="someone-else")
        )
        session.commit()

    assignments = dispatch.assign_jobs([worker_id])

    assert assignments == []
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        assert job.worker_id == "someone-else"


def test_assign_jobs_ignores_unknown_worker_ids(_db):
    assert dispatch.assign_jobs(["no-such-worker"]) == []


def test_assign_jobs_empty_idle_list_returns_empty(_db):
    _make_job()
    assert dispatch.assign_jobs([]) == []


def test_assign_jobs_each_worker_gets_at_most_one_job_per_tick(_db):
    worker_id = _make_worker()
    job1 = _make_job("j1")
    job2 = _make_job("j2")

    assignments = dispatch.assign_jobs([worker_id])

    assert len(assignments) == 1
    assert assignments[0][1].id in (job1, job2)
    with db.get_session() as session:
        statuses = {j.id: j.status for j in session.query(db.Job).all()}
    # Exactly one of the two jobs got claimed; the other stays queued.
    assert sorted(statuses.values()) == ["assigned", "queued"]


# --- Task 4: fetch-aware two-tier ranking ---------------------------------


def _make_fetch_ready_worker(worker_id, dynamic=None, protocol=3, auto_fetch=True):
    with db.get_session() as session:
        session.add(
            db.Worker(
                id=worker_id,
                name=worker_id,
                pubkey="pk",
                protocol=protocol,
                auto_fetch=auto_fetch,
                hardware=json.dumps({"max_fetch_gb": 100}),
                dynamic=json.dumps(dynamic or {}),
                node_classes=json.dumps(["UNETLoader"]),
            )
        )
        session.commit()
    return worker_id


def _make_model_job(job_id="j1", models=("flux1-dev.safetensors",), status="queued"):
    with db.get_session() as session:
        session.add(
            db.Job(
                id=job_id,
                workflow_json="{}",
                status=status,
                required_models=json.dumps(list(models)),
                required_nodes=json.dumps(["UNETLoader"]),
            )
        )
        session.commit()
    return job_id


def test_assign_jobs_falls_back_to_eligible_after_fetch_when_nobody_has_it(_db):
    """A worker with the model missing but able to fetch it must still win
    the job when NO worker is directly eligible."""
    worker_id = _make_fetch_ready_worker("w1", dynamic={"free_disk_gb": 100.0})
    job_id = _make_model_job()
    fetchable = {"flux1-dev.safetensors": round(22.17 * 1024**3)}

    assignments = dispatch.assign_jobs([worker_id], fetchable)

    assert len(assignments) == 1
    assigned_worker_id, job = assignments[0]
    assert assigned_worker_id == worker_id
    assert job.id == job_id
    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "assigned"


def test_assign_jobs_never_prefers_fetch_candidate_over_a_directly_eligible_one(_db):
    """A worker that already has the model wins even if it would otherwise
    lose a fetch-ranking tiebreak (smaller free VRAM, say) -- tier 1 always
    beats tier 2."""
    has_it = _make_worker("w_has_it", model_inventory=[{"name": "flux1-dev.safetensors", "size": 22.17}])
    must_fetch = _make_fetch_ready_worker("w_must_fetch", dynamic={"free_disk_gb": 100.0})
    job_id = _make_model_job()
    fetchable = {"flux1-dev.safetensors": round(22.17 * 1024**3)}

    assignments = dispatch.assign_jobs([has_it, must_fetch], fetchable)

    assert len(assignments) == 1
    assigned_worker_id, job = assignments[0]
    assert assigned_worker_id == has_it
    assert job.id == job_id


def test_assign_jobs_fetch_tier_prefers_smallest_total_download(_db):
    """Among two fetch-eligible candidates, the one with the SMALLER total
    missing bytes wins -- not free VRAM, not name."""
    small_missing = _make_fetch_ready_worker(
        "w_small_missing",
        dynamic={"free_disk_gb": 100.0},
    )
    with db.get_session() as session:
        worker = session.get(db.Worker, small_missing)
        worker.model_inventory = json.dumps([{"name": "clip_l.safetensors", "size": 0.23}])
        session.commit()
    big_missing = _make_fetch_ready_worker("w_big_missing", dynamic={"free_disk_gb": 100.0})

    job_id = _make_model_job(models=("flux1-dev.safetensors", "clip_l.safetensors"))
    fetchable = {
        "flux1-dev.safetensors": round(22.17 * 1024**3),
        "clip_l.safetensors": round(0.23 * 1024**3),
    }

    assignments = dispatch.assign_jobs([small_missing, big_missing], fetchable)

    assert len(assignments) == 1
    assigned_worker_id, job = assignments[0]
    # small_missing is missing only flux1-dev.safetensors (has clip_l
    # already); big_missing is missing both -- small_missing's total
    # download is smaller, so it wins.
    assert assigned_worker_id == small_missing
    assert job.id == job_id


def test_assign_jobs_peer_only_model_skips_a_protocol_3_worker(_db):
    """Phase 3.1 P2P: a missing model whose ONLY manifest source is a peer
    (`peer_only_models`) is not fetchable by a protocol-3 worker -- it must
    never be assigned this job, even with nobody else in the pool."""
    worker_id = _make_fetch_ready_worker("w1", dynamic={"free_disk_gb": 100.0}, protocol=3)
    job_id = _make_model_job(models=("peer.safetensors",))
    fetchable = {"peer.safetensors": round(1.0 * 1024**3)}

    assignments = dispatch.assign_jobs(
        [worker_id], fetchable, peer_only_models=frozenset({"peer.safetensors"})
    )

    assert assignments == []
    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "queued"


def test_assign_jobs_peer_only_model_assigns_a_protocol_4_worker(_db):
    worker_id = _make_fetch_ready_worker("w1", dynamic={"free_disk_gb": 100.0}, protocol=4)
    job_id = _make_model_job(models=("peer.safetensors",))
    fetchable = {"peer.safetensors": round(1.0 * 1024**3)}

    assignments = dispatch.assign_jobs(
        [worker_id], fetchable, peer_only_models=frozenset({"peer.safetensors"})
    )

    assert len(assignments) == 1
    assigned_worker_id, job = assignments[0]
    assert assigned_worker_id == worker_id
    assert job.id == job_id


def test_assign_jobs_no_fetch_candidate_when_fetchable_models_not_supplied(_db):
    """The Task-3 no-op default: omitting fetchable_models must reproduce the
    exact pre-Task-4 behavior -- no missing-model worker is ever assigned."""
    worker_id = _make_fetch_ready_worker("w1", dynamic={"free_disk_gb": 100.0})
    _make_model_job()

    assignments = dispatch.assign_jobs([worker_id])

    assert assignments == []
    with db.get_session() as session:
        assert session.get(db.Job, "j1").status == "queued"


def test_assign_jobs_fetch_tier_still_prefers_clean_over_warned(_db):
    """has_warnings still outranks total_fetch_bytes in the fetch tier."""
    warned = _make_fetch_ready_worker(
        "w_warned", dynamic={"free_disk_gb": 100.0}
    )
    with db.get_session() as session:
        worker = session.get(db.Worker, warned)
        worker.hardware = json.dumps({"vram_gb": 8, "ram_gb": 64, "max_fetch_gb": 100})
        session.commit()
    clean = _make_fetch_ready_worker("w_clean", dynamic={"free_disk_gb": 100.0})
    with db.get_session() as session:
        worker = session.get(db.Worker, clean)
        worker.hardware = json.dumps({"vram_gb": 24, "ram_gb": 64, "max_fetch_gb": 100})
        session.commit()

    job_id = _make_job(est_vram_gb=20)
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        job.required_models = json.dumps(["flux1-dev.safetensors"])
        job.required_nodes = json.dumps([])
        session.commit()
    fetchable = {"flux1-dev.safetensors": round(22.17 * 1024**3)}

    assignments = dispatch.assign_jobs([warned, clean], fetchable)

    assert len(assignments) == 1
    assigned_worker_id, job = assignments[0]
    assert assigned_worker_id == clean


# --- Phase 3.3 Task 4: 排程器語意 -----------------------------------------


def _set_stats(worker_id, signature, ewma_seconds, samples=3):
    with db.get_session() as session:
        session.add(
            db.WorkerJobStats(
                worker_id=worker_id,
                signature=signature,
                ewma_seconds=ewma_seconds,
                samples=samples,
            )
        )
        session.commit()


def _make_signed_job(job_id="j1", signature="sig", models=(), est_vram_gb=None, created_at=None):
    with db.get_session() as session:
        session.add(
            db.Job(
                id=job_id,
                workflow_json="{}",
                status="queued",
                signature=signature,
                required_models=json.dumps(list(models)),
                est_vram_gb=est_vram_gb,
                **({"created_at": created_at} if created_at is not None else {}),
            )
        )
        session.commit()
    return job_id


def test_assign_jobs_prefers_a_warm_cache_over_a_bigger_but_cold_card(_db):
    """熱快取親和贏過 VRAM 較大但要重載（spec §6）。"""
    inventory = [{"name": "diffusion_models/flux1-dev.safetensors", "size": 22.0}]
    warm = _make_worker("w_warm", dynamic={"free_vram_gb": 16}, model_inventory=inventory)
    cold = _make_worker("w_cold", dynamic={"free_vram_gb": 48}, model_inventory=inventory)
    with db.get_session() as session:
        session.get(db.Worker, warm).warm_models = json.dumps(["flux1-dev.safetensors"])
        session.commit()

    job_id = _make_signed_job(models=("flux1-dev.safetensors",))

    assignments = dispatch.assign_jobs([warm, cold])

    assert [(w, j.id) for w, j in assignments] == [(warm, job_id)]


def test_assign_jobs_prefers_the_historically_faster_worker(_db):
    """歷史速度快者贏（spec §6）：兩台硬體看起來一樣，但一台跑這個簽章
    只要 30 秒、另一台要 90 秒。"""
    slow = _make_worker("w_slow", dynamic={"free_vram_gb": 24})
    fast = _make_worker("w_fast", dynamic={"free_vram_gb": 24})
    _set_stats(slow, "sig", 90.0)
    _set_stats(fast, "sig", 30.0)
    job_id = _make_signed_job()

    assignments = dispatch.assign_jobs([slow, fast])

    assert [(w, j.id) for w, j in assignments] == [(fast, job_id)]


def test_assign_jobs_spreads_two_heavy_jobs_across_two_cards(_db):
    """兩件重工作兩台卡各派一件而非同一台（spec §6）-- 舊的逐 job 貪婪演算法
    也做得到「一台一件」，這個測試真正釘住的是兩件都在同一個 tick 派出去，
    而且分別落在不同的卡上。"""
    big = _make_worker("w_big", dynamic={"free_vram_gb": 48})
    small = _make_worker("w_small", dynamic={"free_vram_gb": 24})
    now = _utcnow()
    _make_signed_job("j1", est_vram_gb=10, created_at=now - timedelta(seconds=10))
    _make_signed_job("j2", est_vram_gb=10, created_at=now)

    assignments = dispatch.assign_jobs([big, small])

    assert len(assignments) == 2
    assert {w for w, _j in assignments} == {big, small}
    assert {j.id for _w, j in assignments} == {"j1", "j2"}


def test_assign_jobs_writes_dispatch_info_and_warm_models(_db):
    # 這台 worker 必須真的有這個模型才會 eligible（沒有 fetchable_models 就
    # 沒有 tier 2）；inventory 條目刻意不帶 size，`assess.find_model` 回
    # `(True, None)`，所以 load_seconds 是 0 -- 這個測試釘的是 dispatch_info
    # 的欄位有沒有寫進去，成本項本身由 test_scheduler.py 負責。
    worker_id = _make_worker(
        "w1",
        dynamic={"free_vram_gb": 24},
        model_inventory=[{"name": "diffusion_models/flux1-dev.safetensors"}],
    )
    _set_stats(worker_id, "sig", 41.2)
    job_id = _make_signed_job(models=("flux1-dev.safetensors",))

    dispatch.assign_jobs([worker_id])

    with db.get_session() as session:
        info = json.loads(session.get(db.Job, job_id).dispatch_info)
        warm = json.loads(session.get(db.Worker, worker_id).warm_models)
    assert info["basis"] == "signature"
    assert info["predicted_seconds"] == pytest.approx(41.2)
    assert info["load_seconds"] == pytest.approx(0.0)
    assert info["fetch_seconds"] == pytest.approx(0.0)
    assert info["candidates"] == 1
    assert warm == ["flux1-dev.safetensors"]


def test_assign_jobs_dispatches_a_starved_job_even_behind_newer_ones(_db):
    """等待超過 STARVE_SECONDS 的 job，只要有合格 worker 一定本 tick 派出。"""
    worker_id = _make_worker("w1", dynamic={"free_vram_gb": 24})
    now = _utcnow()
    _make_signed_job("j_old", created_at=now - timedelta(seconds=scheduler.STARVE_SECONDS + 60))
    _make_signed_job("j_new", created_at=now)

    assignments = dispatch.assign_jobs([worker_id])

    assert [j.id for _w, j in assignments] == ["j_old"]


def test_assign_jobs_never_dispatches_a_parent_job(_db):
    """split_count > 0 的父 job 從派工清單排除（§2.5 第 2 步）。"""
    worker_id = _make_worker("w1", dynamic={"free_vram_gb": 24})
    job_id = _make_signed_job("j_parent")
    with db.get_session() as session:
        session.get(db.Job, job_id).split_count = 2
        session.commit()

    assert dispatch.assign_jobs([worker_id]) == []


def test_cancel_job_clears_worker_id_and_records_last_worker_id(_db):
    """So every later reference by the old owner hits the not-owned path and
    gets re-told (final review Major 1). Mirrors `requeue_stale`."""
    worker_id = _make_worker()
    job_id = _make_job(status="running", worker_id=worker_id)

    assert dispatch.cancel_job(job_id, reason="user requested") == worker_id

    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        assert job.worker_id is None
        assert job.last_worker_id == worker_id


def test_try_readopt_refuses_a_cancelled_job(_db):
    """Clearing worker_id must not make a cancelled job look re-adoptable:
    `try_readopt` requires status `queued`, and cancelled is terminal."""
    worker_id = _make_worker()
    job_id = _make_job(status="running", worker_id=worker_id)
    dispatch.cancel_job(job_id, reason="user requested")

    assert dispatch.try_readopt(job_id, worker_id) is False
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        assert job.status == "cancelled"
        assert job.worker_id is None


# --- Phase 3.3 §3.4/§3.6：子 job 動了就推導父 job ------------------------


def _make_split_family(parent_id="p", child_statuses=("queued", "running"), worker_ids=(None, None)):
    with db.get_session() as session:
        session.add(
            db.Job(
                id=parent_id,
                workflow_json="{}",
                status="queued",
                split_count=len(child_statuses),
                split_plan=json.dumps({"source_node_id": "1", "batch_size": 4}),
            )
        )
        for index, (status, worker_id) in enumerate(zip(child_statuses, worker_ids)):
            session.add(
                db.Job(
                    id=f"c{index}",
                    workflow_json="{}",
                    status=status,
                    worker_id=worker_id,
                    parent_id=parent_id,
                    split_index=index,
                )
            )
        session.commit()
    return parent_id


def test_cancelling_a_child_cancels_the_parent_and_siblings(_db):
    parent_id = _make_split_family()

    dispatch.cancel_job("c0", reason="cancelled by admin")

    with db.get_session() as session:
        assert session.get(db.Job, parent_id).status == "cancelled"
        assert session.get(db.Job, "c1").status == "cancelled"


def test_cancelling_a_child_hands_back_the_surviving_siblings_owners(_db):
    """裁決：串聯取消的 owner 要回到呼叫端，WS 層才推得出 `job_cancelled`。

    第三個元素是「取消當下這個子 job 正在 running 嗎」—— WS 層用它決定要不要
    像單一 job 取消那樣 mint 一張 cancelled 收據（只有真的燒過 GPU 的才有）。
    """
    _make_split_family(child_statuses=("queued", "running"), worker_ids=(None, "w7"))
    with db.get_session() as session:
        session.get(db.Job, "c1").started_at = _utcnow() - timedelta(seconds=30)
        session.commit()
    owners: list = []

    dispatch.cancel_job("c0", reason="cancelled by admin", cancelled_owners=owners)

    assert owners == [("c1", "w7", True)]


def test_a_cascade_cancelled_sibling_that_never_started_is_not_flagged_running(_db):
    """只是 assigned（沒有 `started_at`）的兄弟不算 running -> 不該有收據。"""
    _make_split_family(child_statuses=("queued", "assigned"), worker_ids=(None, "w7"))
    owners: list = []

    dispatch.cancel_job("c0", reason="cancelled by admin", cancelled_owners=owners)

    assert owners == [("c1", "w7", False)]


def test_marking_a_child_running_moves_the_parent_to_running(_db):
    parent_id = _make_split_family(child_statuses=("assigned", "queued"), worker_ids=("w1", None))

    assert dispatch.mark_running("c0", "w1") is True

    with db.get_session() as session:
        assert session.get(db.Job, parent_id).status == "running"


def test_a_failed_child_fails_the_parent_and_cancels_the_siblings(_db):
    parent_id = _make_split_family(child_statuses=("running", "running"), worker_ids=("w1", "w2"))
    with db.get_session() as session:
        session.get(db.Job, "c1").started_at = _utcnow() - timedelta(seconds=30)
        session.commit()
    owners: list = []

    assert dispatch.mark_failed("c0", "w1", "CUDA OOM", cancelled_owners=owners) is True

    with db.get_session() as session:
        parent = session.get(db.Job, parent_id)
        sibling = session.get(db.Job, "c1")
    assert parent.status == "failed"
    assert parent.error == "子任務 1/2：CUDA OOM"
    assert sibling.status == "cancelled"
    assert sibling.worker_id is None
    assert sibling.last_worker_id == "w2"
    assert owners == [("c1", "w2", True)]


def test_the_parent_is_done_only_once_every_child_is_done(_db):
    parent_id = _make_split_family(child_statuses=("running", "running"), worker_ids=("w1", "w2"))

    assert dispatch.mark_done("c0", "w1", ["a.png"]) is True
    with db.get_session() as session:
        assert session.get(db.Job, parent_id).status == "running"

    assert dispatch.mark_done("c1", "w2", ["b.png"]) is True
    with db.get_session() as session:
        assert session.get(db.Job, parent_id).status == "done"


def test_requeue_stale_pulls_the_parent_back_from_running(_db):
    _make_worker("w1")
    parent_id = _make_split_family(child_statuses=("running", "queued"), worker_ids=("w1", None))
    with db.get_session() as session:
        session.get(db.Job, parent_id).status = "running"
        worker = session.get(db.Worker, "w1")
        worker.last_seen = _utcnow() - timedelta(seconds=600)
        session.commit()

    assert dispatch.requeue_stale(_utcnow()) == ["c0"]

    with db.get_session() as session:
        assert session.get(db.Job, parent_id).status == "queued"


def test_a_retried_parent_is_dispatched_as_a_plain_job(_db):
    """§3.6：`split_count` 重設為 0 之後，子 job 的狀態再也影響不到它。"""
    parent_id = _make_split_family(child_statuses=("done", "done"))
    with db.get_session() as session:
        parent = session.get(db.Job, parent_id)
        parent.split_count = 0
        parent.split_plan = None
        parent.status = "queued"
        session.commit()

    assert dispatch.mark_done("c0", "w1", []) is False  # 早就 done，不歸誰
    with db.get_session() as session:
        assert session.get(db.Job, parent_id).status == "queued"


# --- Phase 3.3 §3.5：tick 的拆分步驟 -------------------------------------


def _make_splittable_job(job_id="j_split", batch_size=4, created_at=None):
    """一件可拆的 queued job：workflow 是真的（子 workflow 重寫要用），
    `split_plan` 是送件時就算好存下來的那個 JSON。"""
    workflow = {
        "1": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": 512, "height": 512, "batch_size": batch_size},
        },
        "2": {"class_type": "KSampler", "inputs": {"latent_image": ["1", 0], "steps": 20}},
        "3": {"class_type": "SaveImage", "inputs": {"images": ["2", 0]}},
    }
    with db.get_session() as session:
        session.add(
            db.Job(
                id=job_id,
                workflow_json=json.dumps(workflow),
                status="queued",
                signature="sig",
                required_models=json.dumps([]),
                required_nodes=json.dumps(sorted({n["class_type"] for n in workflow.values()})),
                split_plan=json.dumps({"source_node_id": "1", "batch_size": batch_size}),
                **({"created_at": created_at} if created_at is not None else {}),
            )
        )
        session.commit()
    return job_id


def test_assign_jobs_splits_a_batch_across_the_idle_fleet(_db):
    """§3.5：3 台閒置 worker + batch_size 4 -> 拆成 3 個子 job，父 job 退出
    派工清單，被派出去的全是子 job。"""
    workers = [_make_worker(f"w{i}", dynamic={"free_vram_gb": 24}) for i in range(3)]
    parent_id = _make_splittable_job()

    assignments = dispatch.assign_jobs(workers)

    children = split.children_of(parent_id)
    assert len(children) == 3
    assert [c.split_index for c in children] == [0, 1, 2]
    assert {job.id for _worker_id, job in assignments} == {c.id for c in children}
    with db.get_session() as session:
        parent = session.get(db.Job, parent_id)
    assert parent.split_count == 3
    # 父 job 自己從沒被指派出去。
    assert parent.worker_id is None


def test_assign_jobs_moves_the_parent_to_assigned_in_the_same_tick(_db):
    """§3.4：claim 一個子 job 成功的那一刻，父 job 也要跟著變成 `assigned`。

    少了這個推導，父 job 會一路停在 `queued` 直到第一個子 job 的 busy 心跳把
    它推成 `running` —— console／面板在「worker 已經在拿圖了」的整段區間裡
    顯示的都是錯的狀態。父 job 自己永遠沒有 worker。
    """
    workers = [_make_worker(f"w{i}", dynamic={"free_vram_gb": 24}) for i in range(3)]
    parent_id = _make_splittable_job()

    assignments = dispatch.assign_jobs(workers)

    assert len(assignments) == 3
    assert [c.status for c in split.children_of(parent_id)] == ["assigned"] * 3
    with db.get_session() as session:
        parent = session.get(db.Job, parent_id)
        assert parent.status == "assigned"
        assert parent.worker_id is None


def test_assign_jobs_does_not_split_for_a_single_idle_worker(_db):
    """k < 2 -> 不拆，整批照舊在一台 worker 上跑。"""
    worker_id = _make_worker("w1", dynamic={"free_vram_gb": 24})
    parent_id = _make_splittable_job()

    assignments = dispatch.assign_jobs([worker_id])

    assert split.children_of(parent_id) == []
    assert [job.id for _worker_id, job in assignments] == [parent_id]


def test_assign_jobs_caps_the_split_at_the_batch_size(_db):
    """batch_size 2 + 4 台閒置 worker -> 只拆成 2 個（partition 夾住 k）。"""
    workers = [_make_worker(f"w{i}", dynamic={"free_vram_gb": 24}) for i in range(4)]
    parent_id = _make_splittable_job(batch_size=2)

    dispatch.assign_jobs(workers)

    assert len(split.children_of(parent_id)) == 2


def test_assign_jobs_leaves_later_jobs_workers_for_themselves(_db):
    """`consumed` 的估計：前面那件不可拆的 job 會用掉一台，所以後面那件可拆的
    只剩 2 台可用，拆 2 個而不是 3 個。"""
    workers = [_make_worker(f"w{i}", dynamic={"free_vram_gb": 24}) for i in range(3)]
    base = _utcnow() - timedelta(seconds=60)
    _make_signed_job("j_plain", created_at=base)
    parent_id = _make_splittable_job(created_at=base + timedelta(seconds=1))

    dispatch.assign_jobs(workers)

    assert len(split.children_of(parent_id)) == 2


def test_assign_jobs_does_not_split_a_job_no_worker_is_eligible_for(_db):
    """沒有合格的 worker -> `eligible` 0 -> 不拆（拆了也沒人跑得動）。"""
    workers = [_make_worker(f"w{i}", dynamic={"free_vram_gb": 24}) for i in range(3)]
    parent_id = _make_splittable_job()
    # 沒有任何 worker 有這個模型，也沒傳 fetchable_models -> 一律 ineligible。
    with db.get_session() as session:
        session.get(db.Job, parent_id).required_models = json.dumps(["nobody-has-this.safetensors"])
        session.commit()

    assignments = dispatch.assign_jobs(workers)

    assert split.children_of(parent_id) == []
    assert assignments == []
