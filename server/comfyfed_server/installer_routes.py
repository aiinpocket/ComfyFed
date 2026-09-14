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

from importlib import resources
from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse

from . import security
from .bootstrap import get_platform_url

_INSTALLERS_DIRNAME = "installers"

_CONTENT_TYPES = {
    "install.ps1": "text/plain; charset=utf-8",
    "install.sh": "text/plain; charset=utf-8",
    "install.cmd": "text/plain; charset=utf-8",
}


def installers_dir() -> str:
    """Filesystem path of the packaged `installers/` directory.

    Resolved through `importlib.resources` off this package (mirrors
    `templates.templates_dir()`): `installers/` has no `__init__.py`, so it
    is package data, not an importable sub-package.
    """
    return str(resources.files(__package__).joinpath(_INSTALLERS_DIRNAME))


def _read_template(filename: str) -> str:
    """Read a bundled installer script.

    `install.sh` is normalized to LF unconditionally: a Windows checkout
    (or a zealous git autocrlf) that turns it into CRLF would otherwise be
    served verbatim and die inside `bash` on the stray carriage returns.
    """
    path = resources.files(__package__).joinpath(_INSTALLERS_DIRNAME).joinpath(filename)
    text = path.read_text(encoding="utf-8")
    if filename.endswith(".sh"):
        text = text.replace("\r\n", "\n")
    return text


def create_router(data_dir: str) -> APIRouter:
    r = APIRouter()

    def _render(filename: str, request: Request) -> str:
        platform_url = get_platform_url() or str(request.base_url).rstrip("/")
        platform_url = platform_url.rstrip("/")
        token = request.query_params.get("token", "") or ""

        text = _read_template(filename)
        text = text.replace("{{PLATFORM_URL}}", platform_url)
        text = text.replace("{{REGISTER_TOKEN}}", token)
        if "{{TOKEN_QUERY}}" in text:
            token_query = f"?token={quote(token)}" if token else ""
            text = text.replace("{{TOKEN_QUERY}}", token_query)
        return text

    @r.get("/install.ps1", response_class=PlainTextResponse)
    def install_ps1(request: Request):
        return PlainTextResponse(
            _render("install.ps1", request), media_type=_CONTENT_TYPES["install.ps1"]
        )

    @r.get("/install.sh", response_class=PlainTextResponse)
    def install_sh(request: Request):
        return PlainTextResponse(
            _render("install.sh", request), media_type=_CONTENT_TYPES["install.sh"]
        )

    @r.get("/install.cmd", response_class=PlainTextResponse)
    def install_cmd(request: Request):
        return PlainTextResponse(
            _render("install.cmd", request), media_type=_CONTENT_TYPES["install.cmd"]
        )

    @r.get("/api/platform")
    def api_platform(request: Request):
        platform_url = get_platform_url() or str(request.base_url).rstrip("/")
        _, verify_key = security.load_platform_keys(data_dir)
        return {
            "platform_url": platform_url.rstrip("/"),
            "platform_pubkey": bytes(verify_key).hex(),
        }

    return r
