"""Agent identity: bundle-based registration with the platform, pinning its Ed25519 key."""

from __future__ import annotations

import httpx
from nacl.exceptions import BadSignatureError
from nacl.signing import SigningKey, VerifyKey

from .config import AgentConfig, PlatformEntry


class CertificateInvalid(Exception):
    """Raised when the platform's registration certificate fails verification."""


def register(bundle: dict, name: str, cfg_path: str, client: httpx.Client) -> PlatformEntry:
    """Register this agent with the platform described by `bundle`.

    Generates a fresh Ed25519 signing key, POSTs it (with the bundle's
    register token) to the platform's /api/agent/register, verifies the
    returned certificate against the bundle's pinned platform_pubkey, and
    only then persists a new PlatformEntry to the config at `cfg_path`.
    """
    signing_key = SigningKey.generate()
    pubkey_hex = bytes(signing_key.verify_key).hex()

    platform_url = bundle["platform_url"]
    resp = client.post(
        f"{platform_url}/api/agent/register",
        json={"token": bundle["register_token"], "name": name, "pubkey": pubkey_hex},
    )
    resp.raise_for_status()
    body = resp.json()

    worker_id = body["worker_id"]
    certificate = body["certificate"]

    verify_key = VerifyKey(bytes.fromhex(bundle["platform_pubkey"]))
    message = f"{worker_id}|{pubkey_hex}".encode()
    try:
        verify_key.verify(message, bytes.fromhex(certificate))
    except BadSignatureError as exc:
        raise CertificateInvalid("Platform registration certificate failed verification.") from exc

    entry = PlatformEntry(
        platform_url=platform_url,
        platform_pubkey=bundle["platform_pubkey"],
        worker_id=worker_id,
        certificate=certificate,
        signing_key_hex=bytes(signing_key).hex(),
    )

    cfg = AgentConfig.load(cfg_path)
    cfg.platforms.append(entry)
    cfg.save(cfg_path)

    return entry
