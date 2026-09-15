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


def _wheel_filename_for(wheel_url: str, version: str) -> str:
    """The PEP 427 filename pip must see for the downloaded wheel.

    pip validates the FILENAME, not just the bytes: anything that is not
    `<dist>-<version>[-<build>]-<py>-<abi>-<plat>.whl` is refused with
    "is not a valid wheel filename". Prefer the URL's own basename (the
    platform publishes the wheel under its real name); when the URL carries
    no usable name (a query-string download, a bare id) fall back to the
    conventional pure-Python name for this distribution and version.
    """
    import re
    from urllib.parse import unquote, urlsplit

    pep427 = re.compile(r"^[A-Za-z0-9_.]+-[0-9][A-Za-z0-9_.!+]*(-[0-9][A-Za-z0-9_.]*)?-[^-]+-[^-]+-[^-]+\.whl$")
    basename = unquote(os.path.basename(urlsplit(wheel_url).path))
    if pep427.match(basename):
        return basename
    return f"comfyfed-{version}-py3-none-any.whl"


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

    # Precedence matters -- and the old order was a fleet-wide landmine. The
    # platform's publish endpoint raises `min_supported` to `latest` on EVERY
    # release, so with "blocked" checked first, every agent that merely
    # RESTARTED after a publish (reboot, logon autostart, `comfyfed stop`)
    # exited 3 with "please update" -- never reaching the self-update branch
    # that had a signed wheel ready. "Below min_supported + a wheel to fetch"
    # is therefore a MANDATORY update, not a dead end; "blocked" is reserved
    # for the case where nothing can be fetched (auto_update off is handled
    # by the caller, which then also refuses to start).
    below_min = parse_version(current) < parse_version(min_supported)
    below_latest = parse_version(current) < parse_version(latest)
    if (below_min or below_latest) and wheel_url:
        action = "update"
    elif below_min:
        action = "blocked"
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


# Exit status that means "the update is installed -- start me again". Every
# supervisor this agent runs under already restarts a NON-ZERO exit:
# systemd `Restart=on-failure`, launchd `KeepAlive/SuccessfulExit=false`, and
# the Windows launcher.ps1 loop, which restarts on exactly this code. A plain
# 0 (graceful `comfyfed stop`) is never restarted.
RESTART_EXIT_CODE = 75


def _default_restart() -> None:
    """Hand control to the supervisor instead of re-exec'ing ourselves.

    The old `os.execv(sys.executable, [sys.executable] + sys.argv)` was the
    fifth and last masked layer of the self-update chain: under pip's
    Windows console-script launcher `sys.argv[0]` is the stub path WITHOUT
    `.exe` and `sys.executable` is the base interpreter, so the re-exec'd
    command was `python.exe ...\\Scripts\\comfyfed-agent` -- a file that does
    not exist. The child died on the spot while the parent had already
    exited: every successful update took the agent offline (live-caught).
    Exiting with RESTART_EXIT_CODE lets the platform's own supervisor bring
    the freshly installed version up -- the same mechanism on all three OSes,
    with no dependence on argv or interpreter paths.
    """
    logger.info(
        "更新已安裝，正在結束以便由監督程序重新啟動 / update installed; exiting so the supervisor restarts the agent (exit %d)",
        RESTART_EXIT_CODE,
    )
    sys.stdout.flush()
    sys.stderr.flush()
    raise SystemExit(RESTART_EXIT_CODE)


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

    # The platform may advertise the wheel as a path relative to itself
    # ("/api/agent/releases/<file>"); a bare path is not a fetchable URL and
    # was silently failing every self-update against such a platform
    # (live-caught). Join it onto the pinned platform_url; an absolute URL
    # passes through untouched.
    wheel_url = decision.wheel_url
    if not wheel_url.lower().startswith(("http://", "https://")):
        wheel_url = entry.platform_url.rstrip("/") + ("" if wheel_url.startswith("/") else "/") + wheel_url
    try:
        resp = client.get(wheel_url)
        resp.raise_for_status()
        wheel_bytes = resp.content
    except Exception:
        logger.warning("Failed to download wheel from %s.", wheel_url)
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

    # pip refuses any wheel whose FILENAME is not PEP 427-shaped
    # ("<dist>-<version>-<py>-<abi>-<plat>.whl") -- `mkstemp(suffix=".whl")`
    # produced names like tmpeka2_2_0.whl and pip answered "is not a valid
    # wheel filename", so no in-place self-update had ever installed
    # (live-caught, the third masked layer after the precedence and
    # relative-URL bugs). Write the bytes into a private temp DIRECTORY under
    # the wheel's real name: the URL's basename when it is a valid wheel
    # name, else a conventional pure-Python name built from the version.
    tmp_dir = tempfile.mkdtemp(prefix="comfyfed-update-")
    tmp_path = os.path.join(tmp_dir, _wheel_filename_for(wheel_url, decision.latest))
    try:
        with open(tmp_path, "wb") as f:
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
        try:
            os.rmdir(tmp_dir)
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
