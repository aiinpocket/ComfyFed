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
from typing import Literal, Optional

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Response
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel

from . import api_tokens, db, limits, panelws, security, split

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


def _utcnow() -> datetime:
    """Timezone-naive UTC now, matching how every timestamp in `db` is stored."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


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
    """The authenticated principal behind a validated session cookie -- or,
    since 2026-09-19 (spec §4.3), behind an `Authorization: Bearer cft_...`
    API token, which is equivalent everywhere a session is accepted except
    the token-management / change-password / logout routes.

    `auth` says which of the two it was, so `/api/auth/me` can report it and
    so the CSRF-enforcing dependencies know to skip the header check (a
    bearer token is never sent cross-site by a browser). `token_expires_at`
    is the ISO timestamp of the token behind a `auth == "token"` principal,
    `None` for a cookie session -- the MCP client shows it to the user so an
    expiry is not a surprise 401.
    """

    uid: str
    username: str
    role: str
    auth: Literal["session", "token"] = "session"
    token_expires_at: Optional[str] = None


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


def _bearer_user(authorization: Optional[str]) -> SessionUser:
    """`Authorization` header -> `SessionUser`, or 401 (spec §4.3).

    Every failure reason -- malformed header, unknown/revoked/expired token,
    stale epoch, disabled user -- answers the SAME 401 as a missing cookie
    does. Telling a caller WHICH of those it was would hand an attacker an
    oracle over other people's tokens, and the honest caller cannot act on
    the distinction anyway: get a new token.
    """
    with db.get_session() as db_session:
        resolved = api_tokens.resolve_bearer_token(
            db_session, authorization, _utcnow()
        )
        if resolved is None:
            raise _error(401, "auth.required", "Login required.")
        row, user = resolved
        return SessionUser(
            uid=user.id,
            username=user.username,
            role=user.role,
            auth="token",
            token_expires_at=row.expires_at.isoformat(),
        )


async def require_user(
    cf_session: Optional[str] = Cookie(default=None),
    authorization: Optional[str] = Header(default=None),
) -> SessionUser:
    """FastAPI dependency: any logged-in, enabled user -- via a current-epoch
    session cookie, or via an API token (spec §4.3). 401 if the cookie is
    absent/invalid/missing uid, if the referenced user is missing, disabled,
    or stale-epoch, or if the bearer token fails any of its own checks.

    An `Authorization` header present at all means bearer-ONLY: no fallback
    to the cookie, even a valid one. Mixing the two would make "which
    identity is this request?" depend on which credential happened to be
    better -- a browser tab with a stale token would silently act as its
    cookie user instead of failing.
    """
    if authorization is not None:
        return _bearer_user(authorization)
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
    password, so it hangs off the cookie-only `require_csrf_session` rather
    than going through this admin-only dependency.)

    A bearer-authenticated caller skips the CSRF check entirely (spec §4.3):
    CSRF exists because a browser attaches cookies to cross-site requests by
    itself, and it never attaches an `Authorization` header by itself.
    """
    if user.auth == "token":
        return user
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

    Bearer callers skip CSRF -- same reasoning as `require_csrf`.
    """
    if user.auth == "token":
        return user
    _payload_and_csrf(cf_session, x_csrf)
    return user


async def require_csrf_session(
    cf_session: Optional[str] = Cookie(default=None),
    x_csrf: Optional[str] = Header(default=None, alias="X-CSRF"),
) -> SessionUser:
    """Cookie-ONLY, CSRF-enforcing dependency: an API token can never satisfy
    it (spec §4.3's exception list).

    The routes behind this are the ones a token must not be able to reach
    even though it otherwise speaks for its user: minting/listing/revoking
    tokens (a stolen token must not be able to mint itself a successor that
    outlives revocation), changing the password, and logging out. It
    deliberately does NOT take an `Authorization` header at all -- a bearer
    request simply has no cookie to check, so it gets the same 401 as an
    anonymous one.
    """
    payload = _payload_and_csrf(cf_session, x_csrf)
    with db.get_session() as db_session:
        user = _session_user_from_payload(db_session, payload)
    if user is None:
        raise _error(401, "auth.required", "Login required.")
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
def logout(response: Response, _user: SessionUser = Depends(require_csrf_session)):
    """Cookie-only (spec §4.3): there is no cookie for a bearer caller to drop,
    so an API token gets the same 401 here as an anonymous request."""
    response.delete_cookie(SESSION_COOKIE_NAME)
    return {"ok": True}


# Final-review M3：`/api/auth/me` 的回應是每個使用者各自不同的（username /
# role / csrf），絕不能落入任何共用快取。跟 templates.py 的
# `_INDEX_CACHE_HEADERS` 同一個理由跟同一個寫法：寫在回應上，而不是
# 靠「反正預設不快取」的慣例。
_ME_CACHE_CONTROL = "private, no-store"


@router.get("/me")
def me(
    response: Response,
    cf_session: Optional[str] = Cookie(default=None),
    authorization: Optional[str] = Header(default=None),
):
    """Who am I, and (spec §4.3) by which credential.

    Anonymous callers still get the public `{authenticated: false, lang,
    platform_url}` shape -- the console reads this before login. A bearer
    caller is the exception: a present-but-invalid `Authorization` header is
    a 401, not an anonymous 200, because this is the route the MCP client
    calls to check its token is still good (spec §6.3 `platform_status`),
    and "your token died" must not look like "the platform is fine".
    """
    response.headers["Cache-Control"] = _ME_CACHE_CONTROL

    token_user = _bearer_user(authorization) if authorization is not None else None
    payload = None if token_user is not None else read_session_payload(cf_session)

    with db.get_session() as db_session:
        lang = _get_setting(db_session, _LANG_KEY) or "en"
        platform_url = _get_setting(db_session, _PLATFORM_URL_KEY) or ""
        user = token_user or _session_user_from_payload(db_session, payload)

    if user is None:
        return {"authenticated": False, "lang": lang, "platform_url": platform_url}

    return {
        "authenticated": True,
        "username": user.username,
        "role": user.role,
        "lang": lang,
        "platform_url": platform_url,
        "csrf": payload.get("csrf") if payload else None,
        "auth": user.auth,
        "token_expires_at": user.token_expires_at,
    }


@router.post("/change-password")
def change_password(
    body: ChangePasswordBody,
    response: Response,
    user: SessionUser = Depends(require_csrf_session),
):
    """Any logged-in user may change their own password (CSRF-protected).

    Not gated by `require_admin`/`require_csrf` -- those are admin-only --
    since a future non-admin `user` role must be able to self-service this
    too. Bumps `session_epoch` so every OTHER session for this account stops
    validating, then immediately re-issues a fresh cookie at the new epoch so
    the caller's own session stays logged in.

    Cookie-only (`require_csrf_session`, spec §4.3): an API token must not be
    able to rotate the password of the account it belongs to -- especially
    since doing so would bump `session_epoch` and kill every OTHER token.
    """
    if len(body.new) < 8:
        raise _error(400, "auth.password_too_short", "New password must be at least 8 characters.")

    with db.get_session() as db_session:
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


class CreateTokenBody(BaseModel):
    name: Optional[str] = None


# 2026-09-19 spec §4.2：三條 token 管理端點。全部走 `require_csrf_session`
# —— cookie＋CSRF，bearer 一律 401（token 不能再生 token）。
@router.post("/tokens", status_code=201)
def create_api_token(
    user: SessionUser = Depends(require_csrf_session),
    body: Optional[CreateTokenBody] = None,
):
    """Mint an API token for the caller. The plaintext appears in THIS
    response and nowhere else, ever -- the server keeps only its sha256.

    The body (and `name` within it) is optional -- spec §4.2 -- so a caller
    that just wants a token need not invent a label for it.
    """
    with db.get_session() as db_session:
        db_user = db_session.get(db.User, user.uid)
        if db_user is None:
            raise _error(401, "auth.required", "Login required.")
        try:
            row, plaintext = api_tokens.create_token(
                db_session,
                db_user,
                ((body.name if body else None) or "").strip(),
                _utcnow(),
            )
        except api_tokens.BadName:
            raise _error(
                400,
                "auth.bad_token_name",
                f"Token name must be at most {api_tokens.API_TOKEN_NAME_MAX} characters."
                f" / 名稱最多 {api_tokens.API_TOKEN_NAME_MAX} 字。",
            )
        except api_tokens.TooManyTokens:
            raise _error(
                409,
                "auth.too_many_tokens",
                f"At most {api_tokens.API_TOKEN_MAX_ACTIVE_PER_USER} active tokens;"
                f" revoke one first. / 最多 {api_tokens.API_TOKEN_MAX_ACTIVE_PER_USER}"
                f" 枚有效 token，請先撤銷一枚。",
            )

        return {
            "id": row.id,
            "name": row.name,
            "token": plaintext,
            "prefix": row.prefix,
            "created_at": row.created_at.isoformat(),
            "expires_at": row.expires_at.isoformat(),
        }


@router.get("/tokens")
def list_api_tokens(user: SessionUser = Depends(require_csrf_session)):
    """The caller's own tokens, newest first. Never includes any plaintext."""
    with db.get_session() as db_session:
        return api_tokens.list_tokens(db_session, user.uid, _utcnow())


@router.delete("/tokens/{token_id}")
def revoke_api_token(token_id: str, user: SessionUser = Depends(require_csrf_session)):
    """Revoke one of the caller's tokens. Idempotent; someone else's token
    (or one that never existed) is a 404 -- the two are deliberately
    indistinguishable, so this cannot be used to probe for token ids."""
    with db.get_session() as db_session:
        if not api_tokens.revoke_token(db_session, user.uid, token_id, _utcnow()):
            raise _error(404, "auth.token_not_found", "No such token.")
    return {"revoked": True}


class SettingsBody(BaseModel):
    platform_url: Optional[str] = None
    lang: Optional[str] = None
    object_info_mode: Optional[str] = None
    # Phase 3.3 §3.7: whether new submissions may be split into per-batch
    # child jobs. Typed as a bool, so a non-boolean is pydantic's 422 (same
    # as any other wrongly-typed field here); the cloud twin answers its own
    # 400 `settings.bad_split_batches`.
    split_batches: Optional[bool] = None
    # Phase 3.4 final review I2: whether `X-Forwarded-For` may be believed when
    # deciding a worker's `remote_ip`. Default OFF -- see
    # `agentws.trust_proxy_enabled`.
    trust_proxy: Optional[bool] = None
    # Accepted as `float` for both so a JSON `50.0` (what a number input may
    # serialise) is not a 422 before the route's own range check can answer
    # the bilingual 400 -- `upload_max_file_mb` is then narrowed to an int.
    upload_max_file_mb: Optional[float] = None
    upload_user_quota_gb: Optional[float] = None


settings_router = APIRouter()


def _current_settings(db_session) -> dict:
    # Imported locally (same reason as `installer_routes` below): `agentws`
    # pulls in `workers`, which imports this module -- a top-level import here
    # would close the cycle.
    from . import agentws

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
        # Default ON: anything but an explicit "0" (including a missing row)
        # means splitting is allowed -- same reading `split.split_batches_enabled`
        # applies on the dispatch side.
        "split_batches": _get_setting(db_session, split.SPLIT_BATCHES_SETTING_KEY) != "0",
        # Default OFF (the mirror image of `split_batches`): only an explicit
        # "1" turns X-Forwarded-For trust on -- same reading
        # `agentws.trust_proxy_enabled` applies on the WebSocket side.
        "trust_proxy": _get_setting(db_session, agentws.TRUST_PROXY_SETTING_KEY) == "1",
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
    from . import agentws  # local import -- see `_current_settings`

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

    if body.split_batches is not None:
        # Phase 3.3 §3.7: turning this off does not touch children already
        # created (they are independent queued jobs and run to completion) --
        # it only stops NEW submissions from getting a split plan.
        updates[split.SPLIT_BATCHES_SETTING_KEY] = "1" if body.split_batches else "0"

    if body.trust_proxy is not None:
        # Phase 3.4 §2: only meaningful when the platform really sits behind a
        # reverse proxy. Leaving it on without one lets any agent pick its own
        # `remote_ip` (and therefore its own "same NAT" peer group).
        updates[agentws.TRUST_PROXY_SETTING_KEY] = "1" if body.trust_proxy else "0"

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
