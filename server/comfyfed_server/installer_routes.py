"""Public one-line installer endpoints: `GET /install.{ps1,sh,cmd}` and `GET /api/platform`.

See the "一行安裝指令 addendum" section of
`docs/superpowers/specs/2026-09-12-comfyfed-spec.md` for the binding spec.

The three installer scripts live as package data under `installers/` (this
package's `__package__`, resolved via `importlib.resources` the same way
`templates.templates_dir()` resolves `templates_data/` -- both installed
wheels and a source checkout answer the same way). Each is served with two
literal placeholders substituted:

  {{PLATFORM_URL}}   -- from the `platform_url` setting, falling back to the
                         request's own base URL when unset (so a fresh
                         install with no configured platform_url still gets a
                         working one-line command).
  {{REGISTER_TOKEN}}  -- from the `?token=` query parameter, defaulting to
                         the empty string.

`install.cmd` additionally carries `{{TOKEN_QUERY}}`, the literal query
string fragment (`?token=<token>` or empty) to splice into the `irm` URL it
bootstraps -- the addendum's "handle empty token: omit query" behavior,
which only `install.cmd` needs since it builds a URL rather than
substituting variables used inline.
"""

from __future__ import annotations

import re
from importlib import resources
from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from . import security
from .bootstrap import get_platform_url

_INSTALLERS_DIRNAME = "installers"

_CONTENT_TYPES = {
    "install.ps1": "text/plain; charset=utf-8",
    "install.sh": "text/plain; charset=utf-8",
    "install.cmd": "text/plain; charset=utf-8",
}

_NO_STORE_HEADERS = {"Cache-Control": "no-store"}

# `?token=` values are always `secrets.token_urlsafe(N)` outputs (see
# workers.py); that alphabet is exactly URL-safe-base64-without-padding:
# letters, digits, `-`, `_`. Anything else is either not a real token or an
# attempt to break out of the single-quoted shell/PowerShell string literal
# these values get substituted into (e.g. `'`, `"`, backtick, `$(`, a
# newline). Reject before substitution rather than trying to escape --
# escaping quoting rules differ between PowerShell, POSIX sh, and cmd, and
# getting any one of them wrong reopens the injection.
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

# Same reasoning for the platform URL, which is also substituted verbatim
# into single-quoted string literals in all three scripts. Deliberately
# conservative: scheme, host (letters/digits/dots/brackets for IPv6/colon
# for a port/hyphen/underscore), and an optional path made of the usual
# unreserved URL characters. No query string, no fragment, no quotes,
# backticks, `$`, or whitespace.
_PLATFORM_URL_RE = re.compile(r"^https?://[A-Za-z0-9.\[\]:_-]+(/[A-Za-z0-9._~/-]*)?$")
# Public alias: auth.py applies the same shape at settings-write time.
PLATFORM_URL_RE = _PLATFORM_URL_RE


class InvalidTokenError(Exception):
    """The `?token=` query parameter failed `_TOKEN_RE` validation."""


class InvalidPlatformUrlError(Exception):
    """The configured `platform_url` setting failed `_PLATFORM_URL_RE` validation."""


class InvalidRequestOriginError(Exception):
    """The request's own base URL (Host-derived fallback) failed `_PLATFORM_URL_RE` validation."""


def installers_dir() -> str:
    """Filesystem path of the packaged `installers/` directory.

    Resolved through `importlib.resources` off this package (mirrors
    `templates.templates_dir()`): `installers/` has no `__init__.py`, so it
    is package data, not an importable sub-package.
    """
    return str(resources.files(__package__).joinpath(_INSTALLERS_DIRNAME))


def _read_template(filename: str) -> str:
    """Read a bundled installer script.

    Decoded as `utf-8-sig` so `install.ps1` -- stored on disk with a UTF-8
    BOM (PowerShell 5.1's `-File` path needs the BOM on non-UTF-8 system
    locales to not mangle the bilingual 中文 strings) -- is served as clean
    BOM-less UTF-8 rather than leaking the BOM (or, if decoded as plain
    `utf-8`, a literal `﻿`/mojibake) into the response body. `utf-8-sig`
    is a strict superset of `utf-8` decoding for files with no BOM, so this
    is a no-op for `install.sh` / `install.cmd`.

    `install.sh` is additionally normalized to LF unconditionally: a
    Windows checkout (or a zealous git autocrlf) that turns it into CRLF
    would otherwise be served verbatim and die inside `bash` on the stray
    carriage returns.
    """
    path = resources.files(__package__).joinpath(_INSTALLERS_DIRNAME).joinpath(filename)
    text = path.read_text(encoding="utf-8-sig")
    if filename.endswith(".sh"):
        text = text.replace("\r\n", "\n")
    return text


def _resolve_platform_url(request: Request) -> str:
    """Resolve and validate the platform URL to substitute into a script.

    Raises `InvalidPlatformUrlError` when the *configured* `platform_url`
    setting fails validation (a server misconfiguration -- 500), or
    `InvalidRequestOriginError` when there is no configured setting and the
    request's own Host-derived base URL fails validation (client-supplied
    -- refused without echoing the raw value back).
    """
    configured = get_platform_url()
    if configured:
        platform_url = configured.rstrip("/")
        if not _PLATFORM_URL_RE.match(platform_url):
            raise InvalidPlatformUrlError()
        return platform_url

    base = str(request.base_url).rstrip("/")
    if not _PLATFORM_URL_RE.match(base):
        raise InvalidRequestOriginError()
    return base


def _resolve_token(request: Request) -> str:
    """Resolve and validate the `?token=` query parameter.

    Raises `InvalidTokenError` before the value ever reaches a template
    substitution.
    """
    token = request.query_params.get("token", "") or ""
    if token and not _TOKEN_RE.match(token):
        raise InvalidTokenError()
    return token


def _error_response(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": code, "message": message},
        headers=_NO_STORE_HEADERS,
    )


def create_router(data_dir: str) -> APIRouter:
    r = APIRouter()

    def _render(filename: str, request: Request) -> str:
        # Validate BEFORE any substitution -- both of these values get
        # spliced into single-quoted shell/PowerShell string literals in
        # the served scripts, so an unvalidated value is a straight
        # injection into whatever runs `irm ... | iex` / `curl ... | bash`.
        platform_url = _resolve_platform_url(request)
        token = _resolve_token(request)

        text = _read_template(filename)
        text = text.replace("{{PLATFORM_URL}}", platform_url)
        text = text.replace("{{REGISTER_TOKEN}}", token)
        if "{{TOKEN_QUERY}}" in text:
            token_query = f"?token={quote(token)}" if token else ""
            text = text.replace("{{TOKEN_QUERY}}", token_query)
        return text

    def _serve(filename: str, request: Request) -> PlainTextResponse | JSONResponse:
        try:
            text = _render(filename, request)
        except InvalidTokenError:
            return _error_response(
                400, "invalid_token", "The token parameter is invalid."
            )
        except InvalidPlatformUrlError:
            return _error_response(
                500,
                "invalid_platform_url",
                "The server's configured platform_url is invalid.",
            )
        except InvalidRequestOriginError:
            return _error_response(
                400,
                "invalid_request_origin",
                "Unable to determine a valid platform URL for this request.",
            )
        return PlainTextResponse(
            text, media_type=_CONTENT_TYPES[filename], headers=_NO_STORE_HEADERS
        )

    @r.get("/install.ps1", response_class=PlainTextResponse)
    def install_ps1(request: Request):
        return _serve("install.ps1", request)

    @r.get("/install.sh", response_class=PlainTextResponse)
    def install_sh(request: Request):
        return _serve("install.sh", request)

    @r.get("/install.cmd", response_class=PlainTextResponse)
    def install_cmd(request: Request):
        return _serve("install.cmd", request)

    @r.get("/api/platform")
    def api_platform(request: Request):
        try:
            platform_url = _resolve_platform_url(request)
        except InvalidPlatformUrlError:
            return _error_response(
                500,
                "invalid_platform_url",
                "The server's configured platform_url is invalid.",
            )
        except InvalidRequestOriginError:
            return _error_response(
                400,
                "invalid_request_origin",
                "Unable to determine a valid platform URL for this request.",
            )
        _, verify_key = security.load_platform_keys(data_dir)
        return {
            "platform_url": platform_url,
            "platform_pubkey": bytes(verify_key).hex(),
        }

    return r
