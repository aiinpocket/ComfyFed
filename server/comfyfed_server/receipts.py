"""Contribution report: aggregates dual-signed job receipts per worker.

Receipt creation and the platform/worker dual-signature flow live in
`agentws.py` (they happen over the agent WebSocket as part of the job_done /
receipt_ack exchange). This module just reports on the resulting rows.
"""

from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from . import auth, db


def _error(status_code: int, code: str, message: str = "") -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message or code})


_POOL_RE = re.compile(r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$")


def _parse_pool(value: Optional[str]) -> float:
    """Parse the `pool` query parameter for the payout report.

    Declared as a plain string (not FastAPI's `float` query type) so a bad
    value becomes our own `{code, message}` 400 -- consistent with
    `_parse_date` -- rather than FastAPI's default 422 validation-error body.

    Final review finding #10: gated behind a plain-decimal regex BEFORE
    `float()` ever sees it, matching cloud's `parsePoolParam` byte-for-byte.
    `float()` alone accepts forms beyond plain decimal notation that the
    `isfinite`/non-negative checks below cannot catch on their own --
    notably `"1_0"` (Python's underscore digit-group separator, parses to
    the perfectly finite `10.0`) -- and cloud's `Number()` separately
    accepts `"0x10"` as hex 16, which the same regex also kills so both
    stacks reject it identically. `"nan"`/`"inf"` were already handled by
    the `isfinite` check (non-finite) before this fix; the regex rejects
    them earlier now, but the outcome is unchanged. Trimmed first so
    incidental whitespace around an otherwise-valid number still parses.
    """
    trimmed = (value or "").strip()
    if not _POOL_RE.fullmatch(trimmed):
        raise _error(400, "reports.bad_pool", f"Not a valid number: {value!r}")
    pool = float(trimmed)
    if not math.isfinite(pool):
        raise _error(400, "reports.bad_pool", f"Not a valid number: {value!r}")
    if pool < 0:
        raise _error(400, "reports.bad_pool", "pool must be non-negative")
    return pool


def _parse_date(value: Optional[str]) -> Optional[datetime]:
    """Parse an ISO-8601 `from`/`to` query parameter into a naive-UTC datetime.

    Receipt timestamps are stored naive-UTC, so an offset-aware input is
    converted to UTC and stripped -- comparing aware to naive would otherwise
    raise a TypeError inside the query. An unparseable value is the caller's
    mistake, so it becomes a 400 rather than a 500.
    """
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        raise _error(400, "reports.bad_date", f"Not a valid ISO-8601 date: {value!r}")
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def create_router() -> APIRouter:
    r = APIRouter()

    @r.get("/api/reports/contributions")
    def contributions(
        from_: Optional[str] = Query(default=None, alias="from"),
        to: Optional[str] = Query(default=None, alias="to"),
        _payload: dict = Depends(auth.require_admin),
    ):
        start = _parse_date(from_)
        end = _parse_date(to)

        with db.get_session() as session:
            query = session.query(db.Receipt)
            if start is not None:
                query = query.filter(db.Receipt.created_at >= start)
            if end is not None:
                query = query.filter(db.Receipt.created_at <= end)
            receipts = query.all()

            worker_ids = {rec.worker_id for rec in receipts}
            names: dict[str, str] = {}
            if worker_ids:
                workers = session.query(db.Worker).filter(db.Worker.id.in_(worker_ids)).all()
                names = {w.id: w.name for w in workers}

        aggregated: dict[str, dict] = {}
        for rec in receipts:
            entry = aggregated.setdefault(
                rec.worker_id,
                {
                    "worker_id": rec.worker_id,
                    "name": names.get(rec.worker_id, ""),
                    "jobs": 0,
                    "gpu_seconds": 0.0,
                    "unbilled_gpu_seconds": 0.0,
                    "receipts": [],
                },
            )
            # Headline `jobs`/`gpu_seconds` stay billable-only -- unchanged
            # semantics from before non-billable receipts existed (every
            # receipt was billable then, so this reproduces the old totals
            # exactly for data that predates this column). Failed/cancelled
            # receipts still show up in `unbilled_gpu_seconds` and the
            # per-receipt listing below, just never in the headline numbers.
            if rec.billable:
                entry["jobs"] += 1
                entry["gpu_seconds"] += rec.gpu_seconds
            else:
                entry["unbilled_gpu_seconds"] += rec.gpu_seconds
            entry["receipts"].append(
                {
                    "job_id": rec.job_id,
                    "kind": rec.kind,
                    "billable": rec.billable,
                    "basis": rec.basis,
                    "gpu_seconds": rec.gpu_seconds,
                    "acked": rec.worker_sig is not None,
                }
            )

        return list(aggregated.values())

    def _usage_rows(start: Optional[datetime], end: Optional[datetime], only_user_id: Optional[str] = None):
        """Shared aggregation for `/usage` and `/my-usage`: receipts joined
        through jobs.user_id to users, grouped per user. Same billable/
        unbilled split as `contributions`. A receipt whose job is missing or
        whose job has no `user_id` (pre-Phase-3.0 data) aggregates into a
        single `user_id: None` row rather than being dropped.
        """
        with db.get_session() as session:
            query = (
                session.query(db.Receipt, db.Job.user_id, db.User.username)
                .outerjoin(db.Job, db.Job.id == db.Receipt.job_id)
                .outerjoin(db.User, db.User.id == db.Job.user_id)
            )
            if start is not None:
                query = query.filter(db.Receipt.created_at >= start)
            if end is not None:
                query = query.filter(db.Receipt.created_at <= end)
            if only_user_id is not None:
                query = query.filter(db.Job.user_id == only_user_id)
            rows = query.all()

        aggregated: dict[Optional[str], dict] = {}
        for rec, user_id, username in rows:
            entry = aggregated.setdefault(
                user_id,
                {
                    "user_id": user_id,
                    "username": username,
                    "jobs": 0,
                    "gpu_seconds": 0.0,
                    "unbilled_gpu_seconds": 0.0,
                },
            )
            if rec.billable:
                entry["jobs"] += 1
                entry["gpu_seconds"] += rec.gpu_seconds
            else:
                entry["unbilled_gpu_seconds"] += rec.gpu_seconds

        return sorted(aggregated.values(), key=lambda row: row["gpu_seconds"], reverse=True)

    @r.get("/api/reports/usage")
    def usage(
        from_: Optional[str] = Query(default=None, alias="from"),
        to: Optional[str] = Query(default=None, alias="to"),
        _payload: auth.SessionUser = Depends(auth.require_admin),
    ):
        start = _parse_date(from_)
        end = _parse_date(to)
        return _usage_rows(start, end)

    @r.get("/api/reports/my-usage")
    def my_usage(
        from_: Optional[str] = Query(default=None, alias="from"),
        to: Optional[str] = Query(default=None, alias="to"),
        user: auth.SessionUser = Depends(auth.require_user),
    ):
        start = _parse_date(from_)
        end = _parse_date(to)
        rows = _usage_rows(start, end, only_user_id=user.uid)
        if rows:
            return rows[0]
        return {
            "user_id": user.uid,
            "username": user.username,
            "jobs": 0,
            "gpu_seconds": 0.0,
            "unbilled_gpu_seconds": 0.0,
        }

    @r.get("/api/reports/payout")
    def payout(
        pool: Optional[str] = Query(default=None),
        from_: Optional[str] = Query(default=None, alias="from"),
        to: Optional[str] = Query(default=None, alias="to"),
        _payload: auth.SessionUser = Depends(auth.require_admin),
    ):
        pool_value = _parse_pool(pool)
        start = _parse_date(from_)
        end = _parse_date(to)

        with db.get_session() as session:
            query = session.query(db.Receipt).filter(db.Receipt.billable.is_(True))
            if start is not None:
                query = query.filter(db.Receipt.created_at >= start)
            if end is not None:
                query = query.filter(db.Receipt.created_at <= end)
            receipts = query.all()

            worker_ids = {rec.worker_id for rec in receipts}
            names: dict[str, str] = {}
            if worker_ids:
                workers = session.query(db.Worker).filter(db.Worker.id.in_(worker_ids)).all()
                names = {w.id: w.name for w in workers}

        totals: dict[str, float] = {}
        for rec in receipts:
            totals[rec.worker_id] = totals.get(rec.worker_id, 0.0) + rec.gpu_seconds

        total_gpu_seconds = sum(totals.values())
        if total_gpu_seconds == 0:
            return {"total_gpu_seconds": 0, "pool": pool_value, "workers": []}

        workers = [
            {
                "worker_id": worker_id,
                "name": names.get(worker_id, ""),
                "gpu_seconds": gpu_seconds,
                "ratio": gpu_seconds / total_gpu_seconds,
                "amount": pool_value * (gpu_seconds / total_gpu_seconds),
            }
            for worker_id, gpu_seconds in totals.items()
        ]
        workers.sort(key=lambda w: w["gpu_seconds"], reverse=True)

        return {"total_gpu_seconds": total_gpu_seconds, "pool": pool_value, "workers": workers}

    return r
