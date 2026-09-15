"""Web session auth: signed cookie sessions, login backoff, CSRF, password change.

Phase 3.0 multi-user: sessions carry `{uid, role, epoch, csrf}` rather than
the old single-admin `{authenticated, csrf}`. `SessionUser` / `require_user` /
`require_admin` / `resolve_session_user` / `issue_session_cookie` are the
interfaces later tasks (users API, per-user job scoping, panel scoping) build
on -- see docs/superpowers/specs/2026-09-12-comfyfed-spec.md's Phase 3.0
addendum.
"""

from __future__ import annotations

import math
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Response
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel

from . import db, limits, panelws, security

_SESSION_SECRET_KEY = "session_secret"
_LANG_KEY = "lang"
_PLATFORM_URL_KEY = "platform_url"
_OBJECT_INFO_MODE_KEY = "object_info_mode"
_OBJECT_INFO_MODES = ("union", "intersection")
_DEFAULT_OBJECT_INFO_MODE = "union"

SESSION_COOKIE_NAME = "cf_session"
_COOKIE_MAX_AGE = 7 * 24 * 3600  # 7 days
_SESSION_SALT = "comfyfed.session"

_BACKOFF_WINDOW = timedelta(minutes=10)
_BACKOFF_START_N = 4  # required wait kicks in once n >= this many consecutive failures

# Verified against every login attempt for a username that doesn't exist (or
# is disabled), so that "no such user" takes the same amount of time as "wrong
# password" -- otherwise response latency would let an attacker enumerate
# valid usernames. Computed once at import time, not per-request.
_DUMMY_PASSWORD_FOR_TIMING = "comfyfed-dummy-password-for-timing"
_DUMMY_HASH = security.hash_password(_DUMMY_PASSWORD_FOR_TIMING)


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


def _consecutive_failures(session, username: str) -> tuple[int, Optional[datetime]]:
    """Count consecutive failed LoginAttempt rows for `username` within the
    backoff window.

    "Consecutive" = failures since the last successful attempt for this same
    username. Backoff is per-username (Phase 3.0): failed logins against one
    account never lock out a different one. Returns (count, timestamp of the
    most recent failure) or (0, None).
    """
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - _BACKOFF_WINDOW
    rows = (
        session.query(db.LoginAttempt)
        .filter(db.LoginAttempt.at >= cutoff)
        .filter(db.LoginAttempt.username == username)
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
    username: str
    password: str


class ChangePasswordBody(BaseModel):
    old: str
    new: str


def _error(status_code: int, code: str, message: str = "") -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message or code})


def read_session_payload(session_cookie: Optional[str]) -> Optional[dict]:
    """Decode and verify a session cookie value. `None` if absent or invalid.

    Public, alongside `SESSION_COOKIE_NAME`, because the callers that cannot
    express their auth as a `Depends(require_admin)` -- the conditionally-
    public `/metrics` route, the `/comfy` static gate, and comfyapi's panel
    WebSocket, which must answer a failure with a close code rather than an
    HTTPException -- have to run this decode by hand, then feed the result
    through `resolve_session_user` for the uid/epoch/disabled checks. They
    previously reached into `auth._read_session_payload` and hard-coded the
    cookie name, which made the session format three modules' business
    instead of this one's.

    Note this only verifies the cookie's signature; it does NOT check that
    the `uid` inside still refers to an existing, enabled user at the right
    `session_epoch`. Use `resolve_session_user` (or `require_user` /
    `require_admin` for a FastAPI route) for that.
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


@dataclass
class SessionUser:
    """The authenticated principal behind a validated session cookie."""

    uid: str
    username: str
    role: str


def _session_user_from_payload(db_session, payload: Optional[dict]) -> Optional[SessionUser]:
    """Validate a decoded cookie payload against the current `users` row.

    Rejects (returns `None`) a payload with no `uid` (this includes every
    pre-Phase-3.0 cookie, which only ever carried `{authenticated, csrf}` --
    those are deliberately NOT mapped onto the old single admin account;
    everyone re-authenticates once after this upgrade), a `uid` with no
    matching row, a disabled user, or an `epoch` that no longer matches the
    user's current `session_epoch` (password changed / reset / disabled since
    this cookie was issued).
    """
    if not payload:
        return None
    uid = payload.get("uid")
    if not uid:
        return None
    user = db_session.get(db.User, uid)
    if user is None or user.disabled:
        return None
    if payload.get("epoch") != user.session_epoch:
        return None
    return SessionUser(uid=user.id, username=user.username, role=user.role)


def resolve_session_user(db_session, request) -> Optional[SessionUser]:
    """Full cookie-to-`SessionUser` resolution for hand-checked call sites.

    `request` is anything exposing a `.cookies` mapping -- a Starlette
    `Request` (the `/metrics` route, the `/comfy` static gate) or a
    `WebSocket` (comfyapi's panel socket) both qualify, so this one helper
    serves all three without them each re-implementing the uid/epoch/disabled
    checks that `require_user` applies for ordinary routes.
    """
    cookie = request.cookies.get(SESSION_COOKIE_NAME)
    payload = read_session_payload(cookie)
    if payload is None:
        return None
    return _session_user_from_payload(db_session, payload)


async def require_user(
    cf_session: Optional[str] = Cookie(default=None),
) -> SessionUser:
    """FastAPI dependency: any logged-in, enabled user with a current-epoch
    session cookie. 401 if the cookie is absent/invalid/missing uid, or if
    the referenced user is missing, disabled, or stale-epoch."""
    payload = read_session_payload(cf_session)
    if payload is None:
        raise _error(401, "auth.required", "Login required.")
    with db.get_session() as db_session:
        user = _session_user_from_payload(db_session, payload)
    if user is None:
        raise _error(401, "auth.required", "Login required.")
    return user


async def require_admin(user: SessionUser = Depends(require_user)) -> SessionUser:
    """`require_user` plus `role == 'admin'`. 401 unauthenticated (via
    `require_user`), 403 for a logged-in non-admin."""
    if user.role != "admin":
        raise _error(403, "auth.forbidden", "Admin role required.")
    return user


def _payload_and_csrf(cf_session: Optional[str], x_csrf: Optional[str]) -> dict:
    payload = read_session_payload(cf_session)
    if payload is None:
        raise _error(401, "auth.required", "Login required.")
    if not x_csrf or x_csrf != payload.get("csrf"):
        raise _error(403, "auth.csrf", "CSRF token missing or invalid.")
    return payload


async def require_csrf(
    user: SessionUser = Depends(require_admin),
    cf_session: Optional[str] = Cookie(default=None),
    x_csrf: Optional[str] = Header(default=None, alias="X-CSRF"),
) -> SessionUser:
    """Admin-session dependency that additionally enforces the X-CSRF header.

    Reusable across routers: depend on this for any admin-authenticated,
    state-changing route (POST/PUT/DELETE), and on `require_admin` alone for
    read-only admin routes. (`change-password` below is CSRF-protected too,
    but any logged-in user -- not just admin -- may change their own
    password, so it checks CSRF itself against `require_user` rather than
    going through this admin-only dependency.)
    """
    _payload_and_csrf(cf_session, x_csrf)
    return user


async def require_csrf_user(
    user: SessionUser = Depends(require_user),
    cf_session: Optional[str] = Cookie(default=None),
    x_csrf: Optional[str] = Header(default=None, alias="X-CSRF"),
) -> SessionUser:
    """Like `require_csrf` but for any logged-in user, not just admin.

    Phase 3.0 job ownership (jobs.py): `POST /api/jobs` and `POST
    /api/jobs/{id}/cancel` are owner-or-admin gated rather than admin-only,
    but still need the same CSRF enforcement any state-changing,
    cookie-authenticated route gets. `require_csrf` can't be reused as-is
    because it hangs off `require_admin`.
    """
    _payload_and_csrf(cf_session, x_csrf)
    return user


def issue_session_cookie(response: Response, user: db.User) -> str:
    """Set the session cookie for `user` and return the fresh CSRF token.

    Payload is `{uid, role, epoch, csrf}`: `epoch` pins this cookie to the
    user's `session_epoch` at issue time, so a later change-password/disable/
    reset (which bumps it) invalidates this cookie without needing to touch
    any other session -- no more global session-secret rotation logging
    everyone out for one person's password change.
    """
    csrf = secrets.token_urlsafe(32)
    with db.get_session() as db_session:
        secret = _get_or_create_session_secret(db_session)
    serializer = _serializer(secret)
    token = serializer.dumps(
        {"uid": user.id, "role": user.role, "epoch": user.session_epoch, "csrf": csrf}
    )
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        max_age=_COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
    )
    return csrf


router = APIRouter(prefix="/api/auth")


@router.post("/login")
def login(body: LoginBody, response: Response):
    username = body.username.strip().lower()

    with db.get_session() as db_session:
        n, latest_failure_at = _consecutive_failures(db_session, username)
        wait_needed = _required_wait_seconds(n)
        if wait_needed > 0 and latest_failure_at is not None:
            now = datetime.now(timezone.utc).replace(tzinfo=None)
            elapsed = (now - latest_failure_at).total_seconds()
            if elapsed < wait_needed:
                raise _error(429, "auth.too_many_attempts", "Too many attempts, please wait.")

        user = db_session.query(db.User).filter(db.User.username == username).one_or_none()
        if user is None or user.disabled:
            # Still run a verify against a dummy hash so an unknown or
            # disabled username takes the same time as a wrong password --
            # the error message below is identical either way.
            security.verify_password(body.password, _DUMMY_HASH)
            ok = False
        else:
            ok = security.verify_password(body.password, user.password_hash)

        db_session.add(db.LoginAttempt(ok=ok, username=username))
        db_session.commit()

        if not ok:
            raise _error(401, "auth.required", "Invalid password.")

        csrf = issue_session_cookie(response, user)

    return {"csrf": csrf}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(SESSION_COOKIE_NAME)
    return {"ok": True}


@router.get("/me")
def me(cf_session: Optional[str] = Cookie(default=None)):
    payload = read_session_payload(cf_session)
    with db.get_session() as db_session:
        lang = _get_setting(db_session, _LANG_KEY) or "en"
        platform_url = _get_setting(db_session, _PLATFORM_URL_KEY) or ""
        user = _session_user_from_payload(db_session, payload)

    if user is None:
        return {"authenticated": False, "lang": lang, "platform_url": platform_url}

    return {
        "authenticated": True,
        "username": user.username,
        "role": user.role,
        "lang": lang,
        "platform_url": platform_url,
    }


@router.post("/change-password")
def change_password(
    body: ChangePasswordBody,
    response: Response,
    cf_session: Optional[str] = Cookie(default=None),
    x_csrf: Optional[str] = Header(default=None, alias="X-CSRF"),
):
    """Any logged-in user may change their own password (CSRF-protected).

    Not gated by `require_admin`/`require_csrf` -- those are admin-only --
    since a future non-admin `user` role must be able to self-service this
    too. Bumps `session_epoch` so every OTHER session for this account stops
    validating, then immediately re-issues a fresh cookie at the new epoch so
    the caller's own session stays logged in.
    """
    payload = _payload_and_csrf(cf_session, x_csrf)

    if len(body.new) < 8:
        raise _error(400, "auth.password_too_short", "New password must be at least 8 characters.")

    with db.get_session() as db_session:
        user = _session_user_from_payload(db_session, payload)
        if user is None:
            raise _error(401, "auth.required", "Login required.")

        db_user = db_session.get(db.User, user.uid)
        if db_user is None or not security.verify_password(body.old, db_user.password_hash):
            raise _error(401, "auth.required", "Old password is incorrect.")

        db_user.password_hash = security.hash_password(body.new)
        db_user.session_epoch += 1
        db_session.commit()
        uid = db_user.id
        csrf = issue_session_cookie(response, db_user)

    # Final review finding #6: close any open panel WebSocket for this uid
    # now that its epoch has moved -- the caller's OWN session stays alive
    # via the fresh cookie issued above, but any other tab's panel socket
    # (already-open, pre-bump) must not keep streaming. Called OUTSIDE the
    # session block (like users.py's call sites): close_for_uid can block up
    # to 5s per socket, and holding the SQLite connection through that wait
    # would stall unrelated requests.
    panelws.close_for_uid(uid)

    return {"ok": True, "csrf": csrf}


class SettingsBody(BaseModel):
    platform_url: Optional[str] = None
    lang: Optional[str] = None
    object_info_mode: Optional[str] = None
    # Accepted as `float` for both so a JSON `50.0` (what a number input may
    # serialise) is not a 422 before the route's own range check can answer
    # the bilingual 400 -- `upload_max_file_mb` is then narrowed to an int.
    upload_max_file_mb: Optional[float] = None
    upload_user_quota_gb: Optional[float] = None


settings_router = APIRouter()


def _current_settings(db_session) -> dict:
    # Both upload limits go through `limits.read_limits`'s DEFENSIVE parse
    # rather than being read raw: a hand-edited or out-of-range row must
    # report (and be enforced as) the default, never as itself.
    upload_limits = limits.read_limits(db_session)
    return {
        "platform_url": _get_setting(db_session, _PLATFORM_URL_KEY) or "",
        "lang": _get_setting(db_session, _LANG_KEY) or "en",
        "object_info_mode": _get_setting(db_session, _OBJECT_INFO_MODE_KEY) or _DEFAULT_OBJECT_INFO_MODE,
        "upload_max_file_mb": upload_limits.max_file_mb,
        "upload_user_quota_gb": upload_limits.quota_gb,
    }


@settings_router.get("/api/settings")
def read_settings(_user: SessionUser = Depends(require_admin)):
    """Current server-level settings, for a console that opens straight to the
    Settings page rather than seeding itself from a prior POST's response."""
    with db.get_session() as db_session:
        return _current_settings(db_session)


@settings_router.post("/api/settings")
def update_settings(
    body: SettingsBody,
    _user: SessionUser = Depends(require_csrf),
):
    """Update server-level settings. Only the keys present in the body change.

    `platform_url` is validated as an absolute http(s) URL because it is baked
    verbatim into every worker registration bundle -- a relative or malformed
    value would silently produce agents that can never connect back.

    `object_info_mode` governs Task 7's `/comfy/api/object_info` merge:
    `union` (default) serves every node class any online worker defines,
    `intersection` serves only classes every online worker defines. See
    `comfyapi._merged_object_info` for why the combo-value merge stays
    union-shaped either way.
    """
    updates: dict[str, str] = {}

    if body.platform_url is not None:
        url = body.platform_url.strip()
        # Same strict shape the installer endpoints enforce at read time
        # (installer_routes._PLATFORM_URL_RE): a URL that passes here but
        # fails there would 500 every /install.* and /api/platform request,
        # discoverable only when a worker tries to install. Reject it now,
        # while the admin is looking at the settings form.
        from . import installer_routes

        if url and not installer_routes.PLATFORM_URL_RE.fullmatch(url):
            raise _error(
                400,
                "settings.bad_platform_url",
                "Platform URL must be a plain http(s) origin (optional path; no query, quotes or spaces).",
            )
        updates[_PLATFORM_URL_KEY] = url

    if body.lang is not None:
        if body.lang not in ("zh-TW", "en"):
            raise _error(400, "settings.bad_lang", "Language must be one of: zh-TW, en.")
        updates[_LANG_KEY] = body.lang

    if body.object_info_mode is not None:
        if body.object_info_mode not in _OBJECT_INFO_MODES:
            raise _error(
                400,
                "settings.bad_object_info_mode",
                "object_info_mode 必須是 union 或 intersection 其中之一。",
            )
        updates[_OBJECT_INFO_MODE_KEY] = body.object_info_mode

    # The two upload limits are validated STRICTLY here (an admin typing an
    # out-of-range number deserves to be told) even though every read of them
    # parses defensively -- the lenient parse exists for rows that were not
    # written through this endpoint.
    if body.upload_max_file_mb is not None:
        # `int(...)` on JSON NaN/Infinity (which pydantic's float admits)
        # raises ValueError/OverflowError -- that must be THIS bilingual
        # 400, never an untyped 500 (review finding; the GB branch's
        # isfinite guard already covered its own case).
        try:
            if not math.isfinite(body.upload_max_file_mb):
                raise ValueError
            mb = int(body.upload_max_file_mb)
        except (ValueError, OverflowError):
            mb = limits.MIN_UPLOAD_MAX_FILE_MB - 1  # forces the 400 below
        if (
            mb != body.upload_max_file_mb
            or mb < limits.MIN_UPLOAD_MAX_FILE_MB
            or mb > limits.MAX_UPLOAD_MAX_FILE_MB
        ):
            raise _error(
                400,
                "settings.bad_upload_max_file_mb",
                f"單檔上限必須是 {limits.MIN_UPLOAD_MAX_FILE_MB}–{limits.MAX_UPLOAD_MAX_FILE_MB} 之間的整數 MB。"
                f" / Max file size must be a whole number of MB between "
                f"{limits.MIN_UPLOAD_MAX_FILE_MB} and {limits.MAX_UPLOAD_MAX_FILE_MB}.",
            )
        updates[limits.UPLOAD_MAX_FILE_MB_KEY] = str(mb)

    if body.upload_user_quota_gb is not None:
        gb = float(body.upload_user_quota_gb)
        if gb != gb or gb < limits.MIN_UPLOAD_USER_QUOTA_GB or gb > limits.MAX_UPLOAD_USER_QUOTA_GB:
            raise _error(
                400,
                "settings.bad_upload_user_quota_gb",
                f"每人儲存配額必須介於 {limits.MIN_UPLOAD_USER_QUOTA_GB} 與 {limits.MAX_UPLOAD_USER_QUOTA_GB} GB 之間。"
                f" / Per-user storage quota must be between "
                f"{limits.MIN_UPLOAD_USER_QUOTA_GB} and {limits.MAX_UPLOAD_USER_QUOTA_GB} GB.",
            )
        # Stored as a plain decimal string; both stacks' parsers accept
        # whatever the other writes ("5" and "5.0" alike).
        updates[limits.UPLOAD_USER_QUOTA_GB_KEY] = repr(gb)

    with db.get_session() as db_session:
        for key, value in updates.items():
            _set_setting(db_session, key, value)
        db_session.commit()

        return _current_settings(db_session)
