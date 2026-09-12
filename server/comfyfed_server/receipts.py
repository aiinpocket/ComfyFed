"""Contribution report: aggregates dual-signed job receipts per worker.

Receipt creation and the platform/worker dual-signature flow live in
`agentws.py` (they happen over the agent WebSocket as part of the job_done /
receipt_ack exchange). This module just reports on the resulting rows.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from . import auth, db


def _error(status_code: int, code: str, message: str = "") -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message or code})


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
                {"worker_id": rec.worker_id, "name": names.get(rec.worker_id, ""), "jobs": 0, "gpu_seconds": 0.0},
            )
            entry["jobs"] += 1
            entry["gpu_seconds"] += rec.gpu_seconds

        return list(aggregated.values())

    return r
