"""Admin-only user-management API (Phase 3.0 multi-user).

`GET/POST /api/users`, `PATCH /api/users/{id}`, `POST
/api/users/{id}/reset-password`. No DELETE -- accounts are only ever
disabled, never removed (jobs.user_id and receipts reference them
indefinitely). See docs/superpowers/specs/2026-09-12-comfyfed-spec.md's
Phase 3.0 addendum, subsection 使用者管理 API.
"""

from __future__ import annotations

import re
import secrets
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func

from . import auth, db, security

_USERNAME_RE = re.compile(r"^[a-z0-9_.-]{3,32}$")
_ROLES = ("admin", "user")


def _error(status_code: int, code: str, message: str = "") -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message or code})


def _normalize_username(username: str) -> str:
    normalized = (username or "").strip().lower()
    if not _USERNAME_RE.match(normalized):
        raise _error(400, "invalid_username", "Username must be 3-32 chars: a-z, 0-9, _.-")
    return normalized


def _validate_role(role: str) -> str:
    if role not in _ROLES:
        raise _error(400, "invalid_role", f"Role must be one of {_ROLES}")
    return role


def _active_admin_count(db_session, exclude_id: Optional[str] = None) -> int:
    query = db_session.query(db.User).filter(db.User.role == "admin", db.User.disabled.is_(False))
    if exclude_id is not None:
        query = query.filter(db.User.id != exclude_id)
    return query.count()


def _get_user_or_404(db_session, user_id: str) -> db.User:
    user = db_session.get(db.User, user_id)
    if user is None:
        raise _error(404, "not_found", "User not found.")
    return user


def _user_list_row(user: db.User, job_count: int) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "disabled": user.disabled,
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "jobs": job_count,
    }


class CreateUserBody(BaseModel):
    username: str
    role: str
    password: Optional[str] = None


class PatchUserBody(BaseModel):
    role: Optional[str] = None
    disabled: Optional[bool] = None


def create_router() -> APIRouter:
    r = APIRouter()

    @r.get("/api/users")
    def list_users(_user: auth.SessionUser = Depends(auth.require_admin)):
        with db.get_session() as session:
            users = session.query(db.User).order_by(db.User.created_at.asc()).all()
            counts = dict(
                session.query(db.Job.user_id, func.count(db.Job.id))
                .group_by(db.Job.user_id)
                .all()
            )
            return {"users": [_user_list_row(u, counts.get(u.id, 0)) for u in users]}

    @r.post("/api/users")
    def create_user(
        body: CreateUserBody,
        _user: auth.SessionUser = Depends(auth.require_csrf),
    ):
        username = _normalize_username(body.username)
        role = _validate_role(body.role)
        password = body.password or secrets.token_urlsafe(12)

        with db.get_session() as session:
            existing = session.query(db.User).filter(db.User.username == username).one_or_none()
            if existing is not None:
                raise _error(400, "username_taken", "That username is already in use.")

            new_user = db.User(
                username=username,
                password_hash=security.hash_password(password),
                role=role,
            )
            session.add(new_user)
            session.commit()
            return {
                "id": new_user.id,
                "username": new_user.username,
                "role": new_user.role,
                "password": password,
            }

    @r.post("/api/users/{user_id}/reset-password")
    def reset_password(
        user_id: str,
        _user: auth.SessionUser = Depends(auth.require_csrf),
    ):
        with db.get_session() as session:
            target = _get_user_or_404(session, user_id)
            password = secrets.token_urlsafe(12)
            target.password_hash = security.hash_password(password)
            target.session_epoch += 1
            session.commit()
            return {"password": password}

    @r.patch("/api/users/{user_id}")
    def patch_user(
        user_id: str,
        body: PatchUserBody,
        _user: auth.SessionUser = Depends(auth.require_csrf),
    ):
        role = _validate_role(body.role) if body.role is not None else None

        with db.get_session() as session:
            target = _get_user_or_404(session, user_id)

            demoting = role is not None and target.role == "admin" and role != "admin"
            disabling = body.disabled is True and not target.disabled

            if (demoting or disabling) and target.role == "admin" and not target.disabled:
                if _active_admin_count(session, exclude_id=target.id) == 0:
                    raise _error(400, "last_admin", "Cannot disable or demote the only active admin.")

            if role is not None:
                target.role = role
            if body.disabled is not None:
                target.disabled = body.disabled
            if disabling:
                target.session_epoch += 1

            session.commit()
            job_count = session.query(db.Job).filter(db.Job.user_id == target.id).count()
            return _user_list_row(target, job_count)

    return r
