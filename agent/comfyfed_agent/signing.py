"""Agent-side request signing: Ed25519 signatures with replay-protection headers."""

from __future__ import annotations

import secrets
import time

from nacl.signing import SigningKey

from .config import PlatformEntry


def signed_headers(
    entry: PlatformEntry, method: str, path: str, body: bytes, query: str = ""
) -> dict:
    """Build the signed-request headers for one HTTP call to the platform.

    Canonical string signed with the agent's Ed25519 key (from
    `entry.signing_key_hex`) -- must stay identical to the server's
    canonical message (`cloud/src/lib/verify_agent.ts`):

        {METHOD}\\n{path}[?{query}]\\n{ts}\\n{nonce}\\n{body}

    `method` is uppercased; `path` is the URL path only (no scheme/host).
    `query` is the raw query string without its leading `?`, and is included
    in the signed target only when non-empty -- so a signature is bound to
    the parameters it was issued for and cannot be replayed against different
    ones. Pass it whenever the request carries a query string.
    """
    ts = str(int(time.time()))
    nonce = secrets.token_hex(16)
    method = method.upper()

    target = f"{path}?{query}" if query else path
    message = f"{method}\n{target}\n{ts}\n{nonce}\n".encode() + body

    signing_key = SigningKey(bytes.fromhex(entry.signing_key_hex))
    signature = signing_key.sign(message).signature

    return {
        "X-Worker-Id": entry.worker_id,
        "X-Ts": ts,
        "X-Nonce": nonce,
        "X-Sig": signature.hex(),
    }
