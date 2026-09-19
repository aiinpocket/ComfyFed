from comfyfed_server import db


def test_init_creates_tables(tmp_path):
    db.init_db(str(tmp_path / "t.db"))
    with db.get_session() as s:
        s.add(db.Setting(key="platform_url", value="http://x"))
        s.commit()
        assert s.get(db.Setting, "platform_url").value == "http://x"


def test_worker_defaults(tmp_path):
    db.init_db(str(tmp_path / "t.db"))
    with db.get_session() as s:
        w = db.Worker(id="w1", name="n", pubkey="pk")
        s.add(w)
        s.commit()
        assert (w.status, w.disabled) == ("offline", False)


def test_job_has_kind_and_fetch_entry_defaults(tmp_path):
    """2026-09-19 model_fetch: an ordinary prompt job keeps its shape --
    `kind` defaults to "prompt" and `fetch_entry` stays NULL, so nothing
    that creates a Job today has to learn about the new columns."""
    db.init_db(str(tmp_path / "t.db"))
    with db.get_session() as s:
        job = db.Job(workflow_json="{}")
        s.add(job)
        s.commit()
        assert job.kind == "prompt" and job.fetch_entry is None


def test_alembic_migration_c4d5e6f7a8b9_backfills_kind_on_existing_jobs(tmp_path):
    """升級到 head 之後，既有 job 列要拿到 kind='prompt'、fetch_entry=NULL
    （`server_default` 的作用），不是 NULL kind。"""
    import sqlite3

    from alembic import command
    from alembic.config import Config

    db_path = str(tmp_path / "t.db")
    cfg = Config()
    cfg.set_main_option("script_location", db._alembic_dir())
    cfg.set_main_option("sqlalchemy.url", f"sqlite+pysqlite:///{db_path}")
    command.upgrade(cfg, "b3c4d5e6f7a8")

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO jobs (id, workflow_json, status, progress, created_at, "
            "result_files, requirements, required_nodes, required_models, "
            "input_assets, result_hashes, origin, panel_hidden) "
            "VALUES ('old-job', '{}', 'done', 0, '2026-01-01 00:00:00', "
            "'[]', '{}', '[]', '[]', '[]', '{}', 'console', 0)"
        )
        conn.commit()
    finally:
        conn.close()

    command.upgrade(cfg, "head")

    conn = sqlite3.connect(db_path)
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(jobs)").fetchall()}
        assert {"kind", "fetch_entry"} <= cols
        row = conn.execute("SELECT kind, fetch_entry FROM jobs WHERE id = 'old-job'").fetchone()
        assert row == ("prompt", None)
    finally:
        conn.close()


def test_job_has_attempts_and_retry_count_defaults(tmp_path):
    """2026-09-19 job-retry: 既有建 Job 的程式碼一行都不必改 --
    `attempts` 預設空 JSON 物件、`retry_count` 預設 0。"""
    db.init_db(str(tmp_path / "t.db"))
    with db.get_session() as s:
        job = db.Job(workflow_json="{}")
        s.add(job)
        s.commit()
        assert job.attempts == "{}" and job.retry_count == 0


def test_worker_task_failure_composite_primary_key(tmp_path):
    """(worker_id, task_key) 是複合主鍵：同一台對同一種任務只有一列。"""
    db.init_db(str(tmp_path / "t.db"))
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    with db.get_session() as s:
        s.add(
            db.WorkerTaskFailure(
                worker_id="w1", task_key="sig-a", failures=1, last_error="boom",
                last_job_id="j1", updated_at=now,
            )
        )
        s.add(
            db.WorkerTaskFailure(
                worker_id="w1", task_key="sig-b", failures=1, last_error="boom",
                last_job_id="j1", updated_at=now,
            )
        )
        s.commit()
        assert s.get(db.WorkerTaskFailure, ("w1", "sig-a")).failures == 1
        assert s.query(db.WorkerTaskFailure).count() == 2


def test_alembic_migration_d5e6f7a8b9c0_backfills_attempts_on_existing_jobs(tmp_path):
    """升級到 head 之後，既有 job 列要拿到 attempts='{}'、retry_count=0
    （`server_default` 的作用），而不是 NULL；`worker_task_failures` 建出來。"""
    import sqlite3

    from alembic import command
    from alembic.config import Config

    db_path = str(tmp_path / "t.db")
    cfg = Config()
    cfg.set_main_option("script_location", db._alembic_dir())
    cfg.set_main_option("sqlalchemy.url", f"sqlite+pysqlite:///{db_path}")
    command.upgrade(cfg, "c4d5e6f7a8b9")

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO jobs (id, workflow_json, status, progress, created_at, "
            "result_files, requirements, required_nodes, required_models, "
            "input_assets, result_hashes, origin, panel_hidden, kind) "
            "VALUES ('old-job', '{}', 'done', 0, '2026-01-01 00:00:00', "
            "'[]', '{}', '[]', '[]', '[]', '{}', 'console', 0, 'prompt')"
        )
        conn.commit()
    finally:
        conn.close()

    command.upgrade(cfg, "head")

    conn = sqlite3.connect(db_path)
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(jobs)").fetchall()}
        assert {"attempts", "retry_count"} <= cols
        row = conn.execute(
            "SELECT attempts, retry_count FROM jobs WHERE id = 'old-job'"
        ).fetchone()
        assert row == ("{}", 0)

        failure_cols = {
            r[1] for r in conn.execute("PRAGMA table_info(worker_task_failures)").fetchall()
        }
        assert failure_cols == {
            "worker_id", "task_key", "failures", "last_error", "last_job_id", "updated_at",
        }
    finally:
        conn.close()
