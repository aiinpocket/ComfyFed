"""SQLite database layer: SQLAlchemy 2.x ORM models + Alembic-managed schema."""

from __future__ import annotations

import os
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator, Optional

from alembic import command
from alembic.config import Config
from sqlalchemy import Boolean, DateTime, Float, Integer, String, create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker


def _utcnow() -> datetime:
    """Timezone-naive UTC now, for SQLite-friendly storage."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _uuid_str() -> str:
    return str(uuid.uuid4())


class Base(DeclarativeBase):
    pass


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[str] = mapped_column(String)


class Worker(Base):
    __tablename__ = "workers"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid_str)
    name: Mapped[str] = mapped_column(String)
    pubkey: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, default="offline", server_default="offline")
    last_seen: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    disabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    hardware: Mapped[str] = mapped_column(String, default="{}", server_default="{}")
    dynamic: Mapped[str] = mapped_column(String, default="{}", server_default="{}")
    backend: Mapped[str] = mapped_column(String, default="", server_default="")
    torch_version: Mapped[str] = mapped_column(String, default="", server_default="")
    node_classes: Mapped[str] = mapped_column(String, default="[]", server_default="[]")
    model_inventory: Mapped[str] = mapped_column(String, default="[]", server_default="[]")
    object_info_hash: Mapped[str] = mapped_column(String, default="", server_default="")


class RegisterToken(Base):
    __tablename__ = "register_tokens"

    token: Mapped[str] = mapped_column(String, primary_key=True)
    worker_name: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    used: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid_str)
    workflow_json: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, default="queued", server_default="queued")
    worker_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    # The worker that most recently held this job before it went back to
    # `queued` (a stale-worker requeue -- see dispatch.requeue_stale). Lets
    # dispatch.try_readopt tell "you blipped offline and are back" (this
    # worker) apart from "someone else owns it now" (a different worker, or
    # nobody yet) when a late job_done/job_failed/heartbeat arrives.
    last_worker_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    progress: Mapped[float] = mapped_column(Float, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    error: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    result_files: Mapped[str] = mapped_column(String, default="[]", server_default="[]")
    requirements: Mapped[str] = mapped_column(String, default="{}", server_default="{}")
    required_nodes: Mapped[str] = mapped_column(String, default="[]", server_default="[]")
    required_models: Mapped[str] = mapped_column(String, default="[]", server_default="[]")
    est_vram_gb: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    input_assets: Mapped[str] = mapped_column(String, default="[]", server_default="[]")
    result_hashes: Mapped[str] = mapped_column(String, default="{}", server_default="{}")
    # Who submitted this job: "panel" (the ComfyUI-compatible surface at
    # `/comfy/api/*`) or "console" (ComfyFed's own `/api/jobs`). Both funnel
    # through `jobs.create_job`, which is what lets `/comfy/api/interrupt`,
    # `/comfy/api/queue`, and the panel's history view act only on jobs the
    # panel itself submitted, leaving console-submitted jobs alone -- the
    # console stays the one surface that sees and controls everything.
    origin: Mapped[str] = mapped_column(String, default="console", server_default="console")
    # Soft-delete flag for the panel's own history view only (`GET
    # /comfy/api/history` excludes these); the row is never actually
    # deleted, because receipts reference jobs by id. Console's `/api/jobs`
    # ignores this entirely -- it is the audit surface and must always show
    # everything.
    panel_hidden: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")


class Receipt(Base):
    __tablename__ = "receipts"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid_str)
    job_id: Mapped[str] = mapped_column(String)
    worker_id: Mapped[str] = mapped_column(String)
    gpu_seconds: Mapped[float] = mapped_column(Float)
    platform_sig: Mapped[str] = mapped_column(String)
    worker_sig: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    # What kind of job outcome this receipt records ("completed" | "failed" |
    # "cancelled") -- see agentws._create_and_push_receipt /
    # _create_and_push_failure_receipt / _mint_cancelled_receipt. Every
    # existing row predates this column and was a normal completion, hence
    # the "completed" backfill in migration #7.
    kind: Mapped[str] = mapped_column(String, default="completed", server_default="completed")
    # Whether this receipt counts toward billed GPU time. Failed and
    # cancelled runs still record their gpu_seconds (for capacity/health
    # reporting) but must never be billed for work the platform didn't
    # actually get a usable result for.
    billable: Mapped[bool] = mapped_column(Boolean, default=True, server_default="1")
    # How `gpu_seconds` was derived: "exec" (the agent's own measured GPU
    # execution time) or "wall" (a wall-clock fallback -- assigned/running
    # span, or started_at-to-cancel span). Mirrors the exec/wall distinction
    # `_create_and_push_receipt` already logs for completed jobs.
    basis: Mapped[str] = mapped_column(String, default="exec", server_default="exec")


class LoginAttempt(Base):
    __tablename__ = "login_attempts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    ok: Mapped[bool] = mapped_column(Boolean)


_engine: Optional[Engine] = None
_SessionFactory: Optional[sessionmaker] = None


def _package_dir() -> str:
    return os.path.dirname(os.path.abspath(__file__))


def _alembic_dir() -> str:
    # server/comfyfed_server/db.py -> server/alembic
    return os.path.join(os.path.dirname(_package_dir()), "alembic")


def _set_sqlite_pragma(dbapi_connection, connection_record) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    # WAL lets readers run alongside a writer, but writers still serialize.
    # Without a busy timeout a concurrent write (the dispatch loop committing
    # while a request handler commits) fails instantly with "database is
    # locked"; 5s of retry absorbs that contention.
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()


def init_db(path: str) -> None:
    """Create parent dirs, build the engine, and run Alembic migrations to head."""
    global _engine, _SessionFactory

    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)

    url = f"sqlite+pysqlite:///{path}"
    _engine = create_engine(url)
    event.listen(_engine, "connect", _set_sqlite_pragma)

    alembic_cfg = Config()
    alembic_cfg.set_main_option("script_location", _alembic_dir())
    alembic_cfg.set_main_option("sqlalchemy.url", url)
    command.upgrade(alembic_cfg, "head")

    _SessionFactory = sessionmaker(bind=_engine, expire_on_commit=False)


@contextmanager
def get_session() -> Iterator[Session]:
    if _SessionFactory is None:
        raise RuntimeError("Database not initialized: call init_db(path) first.")
    session = _SessionFactory()
    try:
        yield session
    finally:
        session.close()
