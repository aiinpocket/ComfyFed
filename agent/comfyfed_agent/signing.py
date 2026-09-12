"""Agent-side request signing: Ed25519 signatures with replay-protection headers."""

from __future__ import annotations

import secrets
import time

from nacl.signing import SigningKey

from .config import PlatformEntry


def signed_headers(entry: PlatformEntry, method: str, path: str, body: bytes) -> dict:
    """Build the signed-request headers for one HTTP call to the platform.

    Signs `f"{method}\\n{path}\\n{ts}\\n{nonce}\\n".encode() + body` with the
    agent's Ed25519 signing key (from `entry.signing_key_hex`). `method` is
    uppercased; `path` should be the URL path only (no scheme/host/query).
    """
    ts = str(int(time.time()))
    nonce = secrets.token_hex(16)
    method = method.upper()

    message = f"{method}\n{path}\n{ts}\n{nonce}\n".encode() + body

    signing_key = SigningKey(bytes.fromhex(entry.signing_key_hex))
    signature = signing_key.sign(message).signature

    return {
        "X-Worker-Id": entry.worker_id,
        "X-Ts": ts,
        "X-Nonce": nonce,
        "X-Sig": signature.hex(),
    }
