"""Web session auth: signed cookie sessions, login backoff, CSRF, password change."""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Response
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel

from . import db, security

_SESSION_SECRET_KEY = "session_secret"
_ADMIN_PASSWORD_HASH_KEY = "admin_password_hash"
_LANG_KEY = "lang"
_PLATFORM_URL_KEY = "platform_url"

SESSION_COOKIE_NAME = "cf_session"
_COOKIE_MAX_AGE = 7 * 24 * 3600  # 7 days
_SESSION_SALT = "comfyfed.session"

_BACKOFF_WINDOW = timedelta(minutes=10)
_BACKOFF_START_N = 4  # required wait kicks in once n >= this many consecutive failures


def _get_setting(session, key: str) -> Optional[str]:
    row = session.get(db.Setting, key)
    return row.value if row is not None else None


def _set_setting(session, key: str, value: str) -> None:
    row = session.get(db.Setting, key)
    if row is None:
        session.add(db.Setting(key=key, value=value))
    else:
        row.value = value


def _get_or_create_session_secret(session) -> str:
    secret = _get_setting(session, _SESSION_SECRET_KEY)
    if secret is None:
        secret = secrets.token_hex(32)
        _set_setting(session, _SESSION_SECRET_KEY, secret)
        session.commit()
    return secret


def _serializer(secret: str) -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(secret_key=secret, salt=_SESSION_SALT)


def _consecutive_failures(session) -> tuple[int, Optional[datetime]]:
    """Count consecutive failed LoginAttempt rows within the backoff window.

    "Consecutive" = failures since the last successful attempt. Returns
    (count, timestamp of the most recent failure) or (0, None).
    """
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - _BACKOFF_WINDOW
    rows = (
        session.query(db.LoginAttempt)
        .filter(db.LoginAttempt.at >= cutoff)
        .order_by(db.LoginAttempt.at.desc())
        .all()
    )
    count = 0
    latest_failure_at: Optional[datetime] = None
    for row in rows:
        if row.ok:
            break
        count += 1
        if latest_failure_at is None:
            latest_failure_at = row.at
    return count, latest_failure_at


def _required_wait_seconds(n: int) -> float:
    if n < _BACKOFF_START_N:
        return 0.0
    return float(2 ** (n - 3))


class LoginBody(BaseModel):
    password: str


class ChangePasswordBody(BaseModel):
    old: str
    new: str


def _error(status_code: int, code: str, message: str = "") -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message or code})


def read_session_payload(session_cookie: Optional[str]) -> Optional[dict]:
    """Decode and verify a session cookie value. `None` if absent or invalid.

    Public, alongside `SESSION_COOKIE_NAME`, because the two callers that
    cannot express their auth as a `Depends(require_admin)` -- the
    conditionally-public `/metrics` route and the `/comfy` static gate, both
    in app.py, plus comfyapi's panel WebSocket, which must answer a failure
    with a close code rather than an HTTPException -- have to run exactly
    this check by hand. They previously reached into `auth._read_session_payload`
    and hard-coded the cookie name, which made the session format three
    modules' business instead of this one's.
    """
    if not session_cookie:
        return None
    with db.get_session() as db_session:
        secret = _get_or_create_session_secret(db_session)
    serializer = _serializer(secret)
    try:
        return serializer.loads(session_cookie, max_age=_COOKIE_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return None


async def require_admin(
    cf_session: Optional[str] = Cookie(default=None),
) -> dict:
    payload = read_session_payload(cf_session)
    if not payload or not payload.get("authenticated"):
        raise _error(401, "auth.required", "Login required.")
    return payload


def _require_csrf(payload: dict, x_csrf: Optional[str]) -> None:
    if not x_csrf or x_csrf != payload.get("csrf"):
        raise _error(403, "auth.csrf", "CSRF token missing or invalid.")


async def require_csrf(
    payload: dict = Depends(require_admin),
    x_csrf: Optional[str] = Header(default=None, alias="X-CSRF"),
) -> dict:
    """Admin-session dependency that additionally enforces the X-CSRF header.

    Reusable across routers: depend on this for any admin-authenticated,
    state-changing route (POST/PUT/DELETE), and on `require_admin` alone for
    read-only admin routes.
    """
    _require_csrf(payload, x_csrf)
    return payload


router = APIRouter(prefix="/api/auth")


@router.post("/login")
def login(body: LoginBody, response: Response):
    with db.get_session() as db_session:
        n, latest_failure_at = _consecutive_failures(db_session)
        wait_needed = _required_wait_seconds(n)
        if wait_needed > 0 and latest_failure_at is not None:
            now = datetime.now(timezone.utc).replace(tzinfo=None)
            elapsed = (now - latest_failure_at).total_seconds()
            if elapsed < wait_needed:
                raise _error(429, "auth.too_many_attempts", "Too many attempts, please wait.")

        admin_hash = _get_setting(db_session, _ADMIN_PASSWORD_HASH_KEY)
        ok = bool(admin_hash) and security.verify_password(body.password, admin_hash)

        db_session.add(db.LoginAttempt(ok=ok))
        db_session.commit()

        if not ok:
            raise _error(401, "auth.required", "Invalid password.")

        secret = _get_or_create_session_secret(db_session)

    csrf = secrets.token_urlsafe(32)
    serializer = _serializer(secret)
    token = serializer.dumps({"authenticated": True, "csrf": csrf})

    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        max_age=_COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
    )
    return {"csrf": csrf}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(SESSION_COOKIE_NAME)
    return {"ok": True}


@router.get("/me")
def me(cf_session: Optional[str] = Cookie(default=None)):
    payload = read_session_payload(cf_session)
    authenticated = bool(payload and payload.get("authenticated"))
    with db.get_session() as db_session:
        lang = _get_setting(db_session, _LANG_KEY) or "en"
        platform_url = _get_setting(db_session, _PLATFORM_URL_KEY) or ""
    return {"authenticated": authenticated, "lang": lang, "platform_url": platform_url}


@router.post("/change-password")
def change_password(
    body: ChangePasswordBody,
    payload: dict = Depends(require_csrf),
):
    if len(body.new) < 8:
        raise _error(400, "auth.password_too_short", "New password must be at least 8 characters.")

    with db.get_session() as db_session:
        admin_hash = _get_setting(db_session, _ADMIN_PASSWORD_HASH_KEY)
        if not admin_hash or not security.verify_password(body.old, admin_hash):
            raise _error(401, "auth.required", "Old password is incorrect.")

        new_hash = security.hash_password(body.new)
        _set_setting(db_session, _ADMIN_PASSWORD_HASH_KEY, new_hash)

        # Rotate the cookie-signing secret so every session issued under the
        # old password stops validating -- including this one. Changing a
        # password that someone else may know is worthless if their existing
        # session keeps working; the UI already tells the admin to sign in
        # again afterwards.
        _set_setting(db_session, _SESSION_SECRET_KEY, secrets.token_hex(32))
        db_session.commit()

    return {"ok": True}


class SettingsBody(BaseModel):
    platform_url: Optional[str] = None
    lang: Optional[str] = None


settings_router = APIRouter()


@settings_router.post("/api/settings")
def update_settings(
    body: SettingsBody,
    _payload: dict = Depends(require_csrf),
):
    """Update server-level settings. Only the keys present in the body change.

    `platform_url` is validated as an absolute http(s) URL because it is baked
    verbatim into every worker registration bundle -- a relative or malformed
    value would silently produce agents that can never connect back.
    """
    updates: dict[str, str] = {}

    if body.platform_url is not None:
        url = body.platform_url.strip()
        if url and not (url.startswith("http://") or url.startswith("https://")):
            raise _error(
                400, "settings.bad_platform_url", "Platform URL must start with http:// or https://."
            )
        updates[_PLATFORM_URL_KEY] = url

    if body.lang is not None:
        if body.lang not in ("zh-TW", "en"):
            raise _error(400, "settings.bad_lang", "Language must be one of: zh-TW, en.")
        updates[_LANG_KEY] = body.lang

    with db.get_session() as db_session:
        for key, value in updates.items():
            _set_setting(db_session, key, value)
        db_session.commit()

        return {
            "platform_url": _get_setting(db_session, _PLATFORM_URL_KEY) or "",
            "lang": _get_setting(db_session, _LANG_KEY) or "en",
        }
