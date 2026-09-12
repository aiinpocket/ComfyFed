"""Agent self-update: version check against the platform + signed wheel install."""

from __future__ import annotations

import hashlib
import logging
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from typing import Callable, Optional

import httpx
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

from .config import PlatformEntry

logger = logging.getLogger(__name__)


# Sort-lowest sentinel for a version string this parser cannot read.
_UNPARSEABLE_VERSION = (0,)


def parse_version(s: str) -> tuple[int, ...]:
    """Parse a simple dotted-int version string, e.g. "0.1.0" -> (0, 1, 0).

    No `packaging` dependency needed for the plain `major.minor.patch` scheme
    used by this project. A string this scheme cannot express (a pre-release
    like "0.2.0rc1", or anything non-numeric) logs a warning and returns the
    lowest-sorting sentinel `(0,)` rather than raising -- a stray value in a
    server setting must never crash the agent's startup version check.
    """
    try:
        return tuple(int(part) for part in s.split("."))
    except (AttributeError, ValueError):
        logger.warning("Unparseable version string %r; treating it as unknown.", s)
        return _UNPARSEABLE_VERSION


@dataclass
class UpdateDecision:
    action: str  # "ok" | "update" | "blocked"
    latest: str
    min_supported: str
    wheel_url: Optional[str] = None
    sha256: Optional[str] = None
    platform_sig: Optional[str] = None


def check(entry: PlatformEntry, current: str, client: httpx.Client) -> UpdateDecision:
    """Ask the platform for the latest/min-supported agent version and decide what to do.

    Network errors are swallowed (logged) and treated as "ok" so a temporarily
    unreachable version endpoint never blocks agent startup.
    """
    try:
        resp = client.get(f"{entry.platform_url}/api/agent/version")
        resp.raise_for_status()
        body = resp.json()
    except Exception:
        logger.warning("Could not reach %s/api/agent/version; skipping update check.", entry.platform_url)
        return UpdateDecision(action="ok", latest=current, min_supported=current)

    latest = body.get("latest", current)
    min_supported = body.get("min_supported", current)
    wheel_url = body.get("wheel_url")
    sha256 = body.get("sha256")
    platform_sig = body.get("platform_sig")

    if parse_version(current) < parse_version(min_supported):
        action = "blocked"
    elif parse_version(current) < parse_version(latest) and wheel_url:
        action = "update"
    else:
        action = "ok"

    return UpdateDecision(
        action=action,
        latest=latest,
        min_supported=min_supported,
        wheel_url=wheel_url,
        sha256=sha256,
        platform_sig=platform_sig,
    )


def _default_pip_install(path: str) -> None:
    subprocess.run([sys.executable, "-m", "pip", "install", "--no-deps", path], check=True)


def _default_restart() -> None:
    os.execv(sys.executable, [sys.executable] + sys.argv)


def apply_update(
    entry: PlatformEntry,
    decision: UpdateDecision,
    client: httpx.Client,
    pip_install: Callable[[str], None] = _default_pip_install,
    restart: Callable[[], None] = _default_restart,
) -> bool:
    """Download, verify, and install the wheel described by `decision`.

    Verification must fully succeed before anything is installed: the sha256
    of the downloaded bytes must match, and the platform's Ed25519 signature
    must verify over `f"{version}|{sha256hex}"`.

    The version is part of the signed payload deliberately. A signature over
    the digest alone is transferable between releases: an attacker who can
    answer /api/agent/version could pair an old release's still-valid
    (sha256, signature) pair with a *newer* advertised version number and
    force a silent downgrade to a known-vulnerable build. Binding the two
    together makes each signature usable for exactly one release.
    (`comfyfed-server publish-agent` produces this format.)

    Any failure returns False and leaves the current install untouched -- the
    caller should keep running the old version.
    """
    if decision.action != "update":
        logger.warning("apply_update called with action=%r; refusing to update.", decision.action)
        return False

    if not decision.wheel_url or not decision.sha256 or not decision.platform_sig:
        logger.warning("Update decision missing wheel_url/sha256/platform_sig; refusing to update.")
        return False

    try:
        resp = client.get(decision.wheel_url)
        resp.raise_for_status()
        wheel_bytes = resp.content
    except Exception:
        logger.warning("Failed to download wheel from %s.", decision.wheel_url)
        return False

    digest = hashlib.sha256(wheel_bytes).hexdigest()
    if digest != decision.sha256:
        logger.warning("Wheel sha256 mismatch; refusing to update.")
        return False

    signed_payload = f"{decision.latest}|{decision.sha256}"
    try:
        verify_key = VerifyKey(bytes.fromhex(entry.platform_pubkey))
        verify_key.verify(signed_payload.encode(), bytes.fromhex(decision.platform_sig))
    except (BadSignatureError, ValueError):
        logger.warning("Wheel platform signature invalid; refusing to update.")
        return False

    fd, tmp_path = tempfile.mkstemp(suffix=".whl")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(wheel_bytes)
        try:
            pip_install(tmp_path)
        except Exception:
            logger.warning("pip install of downloaded wheel failed; continuing with the current version.")
            return False
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass

    # pip install has already succeeded at this point, so a failure to
    # restart is logged but still reported as a successful update -- the
    # new version is installed and will take effect on the next start.
    try:
        restart()
    except Exception:
        logger.warning("Update installed but restart failed; it will take effect on next start.")
    return True
