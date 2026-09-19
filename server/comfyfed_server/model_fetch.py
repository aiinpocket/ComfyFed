"""Panel "Download" button -> `kind=model_fetch` job (spec 2026-09-19 §5-§6).

Pure helpers only; the HTTP route lives in `comfyapi.py` and the dispatch/
job_done wiring in `agentws.py`. Trust model: a worker downloads only
platform-signed entries. A model the platform has no learned/curated hash
for is dispatched as an *unverified-source* entry -- the url itself is in
the signed payload, the url's origin must be in `TRUSTED_ORIGINS`, and the
worker reports the real sha256 on completion so the platform learns it.
"""
from __future__ import annotations

from urllib.parse import urlsplit

import httpx

TRUSTED_ORIGINS: frozenset[str] = frozenset({"https://huggingface.co", "https://civitai.com"})
_HEAD_TIMEOUT_SECONDS = 10.0


def is_trusted_url(url: str) -> bool:
    """Whether `url`'s PARSED origin (scheme + host, lowercased) is in
    `TRUSTED_ORIGINS`.

    Deliberately not a string-prefix test: `https://huggingface.co.evil.com/x`
    starts with `https://huggingface.co` but is a wholly different origin, and
    the signed unverified entry's only trust root is "the platform approved
    THIS url" (§6), so the host must be matched exactly. A non-443 explicit
    port is rejected for the same reason -- it is a different endpoint than
    the origin the allowlist vouches for.
    """
    if not isinstance(url, str) or not url:
        return False
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    if parts.scheme.lower() != "https" or not parts.hostname:
        return False
    if port not in (None, 443):
        return False
    origin = f"{parts.scheme.lower()}://{parts.hostname.lower()}"
    return origin in TRUSTED_ORIGINS


class HeadError(Exception):
    """`code` is "gated" (401/403) or "size_unknown" (anything else)."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(detail or code)
        self.code = code


def head_size_bytes(url: str, *, client_factory=httpx.Client) -> int:
    """The exact byte length `url` advertises via `Content-Length`, probed
    with a redirect-following HEAD and a 10 s timeout.

    The signed entry pins `size_bytes` (§6) and an unverified entry has no
    sha256 for the agent to check instead -- so a source that will not state
    its length cannot be dispatched at all (`size_unknown`), and a source
    that demands a login (401/403) is `gated` and reported as such rather
    than being retried by a worker that has no credentials either.

    `client_factory` exists so tests can inject an `httpx.MockTransport`
    client; production passes the default `httpx.Client`.
    """
    try:
        with client_factory(
            timeout=httpx.Timeout(_HEAD_TIMEOUT_SECONDS), follow_redirects=True
        ) as client:
            resp = client.head(url)
    except httpx.HTTPError as exc:
        raise HeadError("size_unknown", str(exc)) from exc
    if resp.status_code in (401, 403):
        raise HeadError("gated", f"HTTP {resp.status_code}")
    if not (200 <= resp.status_code < 300):
        raise HeadError("size_unknown", f"HTTP {resp.status_code}")
    raw = resp.headers.get("content-length")
    try:
        size = int(raw) if raw is not None else 0
    except ValueError:
        size = 0
    if size <= 0:
        raise HeadError("size_unknown", "no Content-Length")
    return size


def unverified_payload(name: str, directory: str, url: str, size_bytes: int) -> str:
    """The Ed25519 payload for an unverified-source entry (spec §6).

    Byte-exact and mirrored by the agent's `fetcher._verify_entry_signature`
    and the cloud stack -- the trailing `|unverified` literal is what keeps
    it from ever colliding with the verified `name|directory|sha256|size`
    payload, so neither shape can be replayed as the other.
    """
    return f"{name}|{directory}|{url}|{size_bytes}|unverified"


def sign_unverified_entry(signing_key, *, name: str, directory: str, url: str, size_bytes: int) -> dict:
    """Sign an unverified-source manifest entry with the platform key.

    `sha256`/`backup_url` are explicitly None: there is no known content
    hash yet (that is the whole point -- the worker reports the real one on
    completion, §9) and no content-addressed fallback source exists without
    one, so no GCS mirror and no peer pull for this entry (§3).
    """
    sig = signing_key.sign(unverified_payload(name, directory, url, size_bytes).encode()).signature.hex()
    return {
        "name": name,
        "directory": directory,
        "url": url,
        "backup_url": None,
        "sha256": None,
        "size_bytes": size_bytes,
        "unverified": True,
        "sig": sig,
    }


def is_unverified_entry(entry: dict) -> bool:
    """Whether `entry` is an unverified-source entry -- the one flag both
    the agent's shape validator and the dispatch protocol gate key off."""
    return isinstance(entry, dict) and entry.get("unverified") is True
