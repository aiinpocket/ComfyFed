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


def _uuid_hex() -> str:
    return uuid.uuid4().hex


class Base(DeclarativeBase):
    pass


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[str] = mapped_column(String)


class User(Base):
    """A login account (Phase 3.0 multi-user). Created by `bootstrap` (the
    initial admin) or, later, the admin-only `/api/users` management surface.

    `session_epoch` is bumped whenever every existing session for this user
    must stop validating (password change, disable, reset-password) --
    `auth.require_user` rejects a cookie whose `epoch` claim no longer
    matches. This replaces the old global session-secret rotation, which
    logged out every user on any password change.
    """

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid_hex)
    username: Mapped[str] = mapped_column(String, unique=True)
    password_hash: Mapped[str] = mapped_column(String)
    role: Mapped[str] = mapped_column(String)
    disabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    session_epoch: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class Worker(Base):
    __tablename__ = "workers"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid_str)
    name: Mapped[str] = mapped_column(String)
    pubkey: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, default="offline", server_default="offline")
    last_seen: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    disabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    # SOFT delete. Receipts and jobs reference workers for the billing ledger,
    # so an admin "delete" must never remove the row: it flips this flag (and
    # `disabled`, so every existing disabled-gated path keeps holding even if
    # a future caller forgets `deleted`). A deleted worker disappears from the
    # console listing, dispatch eligibility and metrics, and can no longer
    # complete the agent WS handshake -- but `GET /api/reports/*` still
    # resolves its historical receipts by id, unchanged.
    deleted: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    hardware: Mapped[str] = mapped_column(String, default="{}", server_default="{}")
    dynamic: Mapped[str] = mapped_column(String, default="{}", server_default="{}")
    backend: Mapped[str] = mapped_column(String, default="", server_default="")
    torch_version: Mapped[str] = mapped_column(String, default="", server_default="")
    node_classes: Mapped[str] = mapped_column(String, default="[]", server_default="[]")
    model_inventory: Mapped[str] = mapped_column(String, default="[]", server_default="[]")
    object_info_hash: Mapped[str] = mapped_column(String, default="", server_default="")
    # Agent protocol version reported in `hello` (see agentws._handle_hello).
    # 1 = pre-Phase-1.9 agent: no guaranteed exec_seconds, doesn't understand
    # `job_cancelled` pushes -- still served, but gets a one-time deprecation
    # frame and is never sent job_cancelled. 2 = baseline exec_seconds/
    # job_cancelled support. 3 = hello's auto_fetch opt-in exists (Phase 2.1;
    # see assess._MIN_AUTO_FETCH_PROTOCOL). 4 = Phase 3.1 P2P: hello may carry
    # `peer_url`, and chunk-hash fields exist on inventory reports -- older
    # agents are still fully served, just never handed peer_url or
    # peer-only fetch_models entries.
    protocol: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    # Opt-in: whether this worker should auto-fetch missing models from the
    # signed manifest (Phase 2.1 Task 3). Every existing worker predates the
    # feature and defaults to off.
    auto_fetch: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    # Phase 3.1 P2P: this worker's advertised peer-serving HTTP endpoint
    # (e.g. "http://192.168.1.5:8850"), set from `hello.peer_url` when the
    # agent has `peer_serve` enabled and validates as an http(s) URL with a
    # host (see agentws._parse_peer_url). Hello-only, not heartbeat -- unlike
    # `dynamic` (an opaque per-heartbeat blob forwarded verbatim), this is a
    # dedicated column and the endpoint is effectively static agent config,
    # not a fast-changing runtime value, so re-parsing it every heartbeat
    # would add work for no benefit. None when the agent doesn't advertise
    # (protocol < 4, peer_serve off, or an invalid value), and cleared
    # whenever the worker is marked offline (see dispatch.requeue_stale) so
    # a stale endpoint is never handed out as a seeder.
    peer_url: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    # Phase 3.4 §4.1：區網位址（`hello.peer_lan_url`），永遠與 `peer_url` 一起
    # 回報，供「拉方與種子同一個 remote_ip ⇒ 同一個 NAT」時優先使用。跟
    # `peer_url` 一樣是 hello-only、每次 hello 全量取代。
    peer_lan_url: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    # Phase 3.4 §3.2：`peer_url` 是怎麼來的 —— natpmp/upnp/manual/lan/none。
    # 舊 agent 不帶 ⇒ "lan"（server_default 也是 lan，既有列不必回填）。
    peer_nat: Mapped[str] = mapped_column(String, default="lan", server_default="lan")
    # Phase 3.4 §4.2：平台自己打 `<peer_url>/peer/health` 的結果。
    # None = 尚未檢查、1 = 204 通過、0 = 靜態拒絕或檢查失敗。
    # 與 `peer_url` 一起在 dispatch.requeue_stale 清掉。
    peer_reachable: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    peer_checked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # Phase 3.4 §2：這台 worker 連過來的公網 IP（預設 request.client.host；
    # 只有平台設定 trust_proxy 開啟時才取 X-Forwarded-For 第一跳），每次
    # hello 更新。兩台 worker 的
    # `remote_ip` 相同 ⇒ 極可能在同一個 NAT 後面 ⇒ 可以互相走區網位址。
    remote_ip: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    # Phase 3.3 §2.2: 相對全隊的速度係數，1.0 = 平均、2.0 = 兩倍快。
    # 由 stats.record_completion 在每次有效 job_done 後更新，夾在
    # [SPEED_MIN, SPEED_MAX]。
    speed_index: Mapped[float] = mapped_column(Float, default=1.0, server_default="1.0")
    # Phase 3.3 §2.2: 這台 worker 最近一次被指派的 job 的 required_models
    # （JSON array）。在 claim 成功時寫入，不等 job 完成 -- 模型載入發生在
    # 開始執行時，熱快取親和要在那個時間點就成立。
    warm_models: Mapped[str] = mapped_column(String, default="[]", server_default="[]")


class ModelHash(Base):
    """Learned (name, size_bytes) -> sha256 consensus from agent inventory
    reports (Phase 2.1 Task 2). `name` is the inventory-relative path (see
    `assess.matches_model_name`), not the bare model_guide name. See
    `comfyfed_server.model_manifest`.
    """

    __tablename__ = "model_hashes"

    name: Mapped[str] = mapped_column(String, primary_key=True)
    size_bytes: Mapped[int] = mapped_column(Integer, primary_key=True)
    sha256: Mapped[str] = mapped_column(String)
    first_worker_id: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    # Set when a later report for this (name, size_bytes) disagreed with the
    # first-seen sha256 above (see model_manifest.record_hash). Persistent
    # replacement for the old in-memory, per-process poisoned-name set --
    # `model_manifest.entries()` excludes any row with this set, and it
    # survives a restart/second-replica since it lives on the row itself.
    conflict: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    # Phase 3.1 P2P: per-64-MiB-chunk SHA-256 list (JSON array of hex
    # strings), learned from an agent's inventory report the same way
    # `sha256` above is (see model_manifest). An early-abort optimization
    # only -- the whole-file `sha256` stays the sole consensus/trust root;
    # a chunk mismatch just aborts that one P2P source, it never substitutes
    # for the final whole-file verification. Null until some report on this
    # (name, size_bytes) carries chunk hashes (older agents never do).
    chunk_sha256s: Mapped[Optional[str]] = mapped_column(String, nullable=True)


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
    # Who submitted the job (Phase 3.0 multi-user). Nullable, no FK -- matches
    # this module's existing loose-reference style (see e.g. `worker_id`) --
    # because pre-migration jobs are backfilled to whichever user the
    # migration created from the old single admin hash, and a user is never
    # actually deleted (only disabled), so the column stays populated for any
    # job created from here on.
    user_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    # Phase 3.3 §2.1: `assess.signature` 算出的工作指紋，送件時寫入。
    # NULL = 舊資料列（migration 不回填；回填由 stats.backfill_if_needed 在
    # 重放收據時順手補上，見 §2.6）。
    signature: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    # Phase 3.3 §2.2: claim 當下的選擇依據，供 console 顯示。
    # {"predicted_seconds": float, "basis": str, "load_seconds": float,
    #  "fetch_seconds": float, "candidates": int}
    dispatch_info: Mapped[str] = mapped_column(String, default="{}", server_default="{}")
    # Phase 3.3 §3.4: 批次拆分。`parent_id` 指向被拆的父 job（子 job 才有）；
    # `split_count` 是父 job 的子數（0 = 不是父 job，一律當普通 job 處理，
    # 包含重試後被重設為 0 的父 job）；`split_plan` 是送件時算出的
    # `{"source_node_id": str, "batch_size": int}`，NULL = 不可拆。
    parent_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    split_index: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    split_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    split_plan: Mapped[Optional[str]] = mapped_column(String, nullable=True)


class Receipt(Base):
    __tablename__ = "receipts"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid_str)
    # Nullable as of Phase 3.1: `kind == "p2p_upload"` receipts (a seeder's
    # bandwidth booking for serving a P2P grant) aren't tied to any job, so
    # job_id is NULL for those and those alone -- every other kind still
    # always sets it. See agentws/peer.py receipt minting.
    job_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
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
    # Phase 3.1 P2P: bytes actually served for a `p2p_upload` receipt (the
    # seeder's bandwidth booking). Null for every other kind -- gpu_seconds
    # stays the payout/usage-report metric; this is purely the contributions
    # report's separate "P2P upload volume" total.
    bytes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)


class WorkerJobStats(Base):
    """Phase 3.3 §2.2: 每個 (worker, signature) 的執行時間指數移動平均。

    只在 `job_done` 且 `exec_seconds` 有效時更新（failed/cancelled 不更新）
    -- 見 `stats.record_completion`。
    """

    __tablename__ = "worker_job_stats"

    worker_id: Mapped[str] = mapped_column(String, primary_key=True)
    signature: Mapped[str] = mapped_column(String, primary_key=True)
    ewma_seconds: Mapped[float] = mapped_column(Float)
    samples: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class LoginAttempt(Base):
    __tablename__ = "login_attempts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    ok: Mapped[bool] = mapped_column(Boolean)
    # The attempted username (Phase 3.0 multi-user), lowercased same as
    # `User.username`. Nullable because pre-migration rows predate it and are
    # never backfilled (there is no way to recover who was being guessed
    # against). Backoff is now per-username: see `auth._consecutive_failures`.
    username: Mapped[Optional[str]] = mapped_column(String, nullable=True)


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
