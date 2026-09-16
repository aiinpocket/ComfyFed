"""Multi-platform agent job runner: WS connections, busy broadcast, job execution."""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import json
import logging
import ntpath
import os
import signal
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

import httpx
import websockets
from websockets.exceptions import ConnectionClosed
from nacl.signing import SigningKey

from . import comfy, control, detect, fetcher, hardware, natmap, peerserve, signing, whitelist
from .config import AgentConfig, PlatformEntry

logger = logging.getLogger(__name__)

_HEARTBEAT_INTERVAL_SECONDS = 30
_OBJECT_INFO_INTERVAL_SECONDS = 600
_RECV_POLL_TIMEOUT_SECONDS = 1.0
# How often the platform-independent control loop republishes
# `agent_state.json` and looks for a `stop.request`. Deliberately much
# shorter than the heartbeat interval: `comfyfed stop` / `comfyfed status`
# must answer promptly, and neither touches the network.
_CONTROL_TICK_SECONDS = 5.0
_BACKOFF_START_SECONDS = 5
_BACKOFF_MAX_SECONDS = 60

# ComfyUI-not-running wait (live incident 2026-09-16): the agent autostarts
# at logon, ComfyUI (Desktop) is launched by a human and may be minutes --
# or hours -- behind it. Re-probe this often, but only repeat the WARNING
# every `_COMFY_WAIT_RELOG_SECONDS`, so a machine left without ComfyUI for a
# weekend writes ~6 lines an hour instead of a traceback every 5 s.
_COMFY_WAIT_POLL_SECONDS = 30
_COMFY_WAIT_RELOG_SECONDS = 600
# Published in `agent_state.json` as `reason` while that wait is in effect.
_COMFY_UNREACHABLE_REASON = "comfyui_unreachable"
# Phase 3.4 §8：一個 process 內因位址變化而自動重連，最多 1 次／小時。
# 滾動視窗（不是「整個 process 只有一次」）—— 一條每天換兩三次 IP 的
# 家用線路仍然能跟上，一條每分鐘抖動的線路也不會把平台打爆。
_PEER_RECONNECT_WINDOW_SECONDS = 3600.0
# spec §3.1 第 4 點／§4.3 共用的那段文字（雙語）：映射失敗、以及平台回報
# 「連不到」，對操作者來說要做的事一模一樣，所以共用同一段說明。
_PEER_NO_MAPPING_WARNING = (
    "無法自動開埠（NAT-PMP/UPnP 都沒有回應）；只有同區網的成員能從這台拉模型。"
    "要跨網路分享請在路由器手動轉埠並設定 peer_advertise_host。 / "
    "Automatic port mapping failed (neither NAT-PMP nor UPnP answered); only "
    "members on the same LAN can pull models from this machine. To share "
    "across networks, forward the port on your router and set "
    "peer_advertise_host."
)
# httpcore is httpx's transport and is always installed with it, but it is
# an implementation detail -- imported defensively so a future httpx that
# drops it cannot break the agent at import time.
try:  # pragma: no cover - trivial import guard
    import httpcore as _httpcore
    _CONNECT_ERROR_TYPES: tuple[type[BaseException], ...] = (
        httpx.ConnectError, _httpcore.ConnectError,
    )
except Exception:  # pragma: no cover
    _CONNECT_ERROR_TYPES = (httpx.ConnectError,)

# Backoff for re-reporting a finished job across a connection blip (see
# `_report_completion`). Unbounded in total: the work is already done and
# paid for in GPU time, so the only sane thing to do with it is keep trying
# to hand it over until the agent stops.
_REPORT_RETRY_START_SECONDS = 1.0
_REPORT_RETRY_MAX_SECONDS = 30.0

# Hard cap on the whole "signal received -> jobs wound down -> loop stopped"
# sequence (see `AgentLoop._graceful_shutdown_and_stop`). A ghost ComfyUI
# prompt is a known, designed-for recovery path (the server's stale-job
# requeue); a process that never exits on Ctrl-C is not, so on timeout we
# stop waiting and let the interpreter tear the loop down instead of hanging
# forever on a wedged cleanup.
_SIGNAL_SHUTDOWN_TIMEOUT_SECONDS = 10.0

# Phase 2.1 Task 5: a `job` push carries `fetch_models` only when the
# platform's dispatch decided this worker is `eligible_after_fetch`, which
# itself requires the worker's `hello.auto_fetch` to have been true (see
# `assess._eligible_after_fetch`). So a `fetch_models` push reaching a worker
# with `auto_fetch_models` now false is always a race (the operator flipped
# the config and restarted between hello and this push) or a server bug --
# never a normal flow. Reported as a polite job_failed rather than crashing:
# nothing was downloaded, nothing to clean up.
_AUTO_FETCH_DISABLED_MESSAGE = (
    "此 worker 未開啟自動下載 / this worker does not have auto-fetch enabled"
)


# WS close code the platform sends when it rejects a worker's auth: the
# worker is unknown/soft-deleted server-side OR its signature is invalid.
# Unlike a deploy/network drop (1006/1011), 4401 is meant to be PERMANENT, so
# it is classified and handled categorically differently.
#
# ...with one caveat that shapes the whole give-up path: platforms OLDER than
# this split also sent 4401 for a plain handshake TIMEOUT, which is entirely
# transient (a loaded box, a laptop waking from sleep). So ONE 4401 is not
# proof of a dead registration -- see `_AUTH_REJECTIONS_BEFORE_GIVING_UP`.
_AUTH_REJECTED_CLOSE_CODE = 4401

# The platform closed because an admin DISABLED this worker. Reversible (the
# admin can re-enable it), so this must never give up and never prune -- the
# agent just keeps retrying at the capped backoff until the worker is back.
_WORKER_DISABLED_CLOSE_CODE = 4403

# The platform's handshake timer fired (or the auth frame was malformed) --
# purely transient, retried like any other drop. Newer platforms send this
# instead of 4401 for that case; see server/comfyfed_server/agentws.py.
_AUTH_TIMEOUT_CLOSE_CODE = 4408

# How many CONSECUTIVE 4401 rejections one entry must collect, within this
# process, before the agent treats it as definitively dead (gives up and
# prunes). Two, not one: an older platform still answers a handshake timeout
# with 4401, and a single one of those must never delete a live registration.
# A successful handshake resets the counter (see `_run_platform`), so only a
# genuinely unauthenticatable entry can ever reach the threshold.
_AUTH_REJECTIONS_BEFORE_GIVING_UP = 2

# Where a 4401-pruned registration is parked (see
# `AgentLoop._prune_dead_registration`), always beside `agent.json` itself.
# A removed entry is NEVER just deleted: it carries this machine's Ed25519
# signing key for that platform, so it is appended here first and only then
# dropped from the live config -- an operator who disagrees with the prune
# (or a platform that comes back) can copy the record's fields straight back
# into `agent.json`'s `platforms` list.
_DEAD_REGISTRATIONS_FILENAME = "agent.dead.json"

# The only `reason` this agent writes into `agent.dead.json` today: the
# definitive per-entry 4401 give-up in `_run_platform`. Transient failures
# (1006/1011, DNS, refused TCP) never prune anything.
_DEAD_REASON_AUTH_REJECTED = "auth_rejected_4401"


class AllRegistrationsRejected(Exception):
    """Every configured platform rejected this agent's auth (4401) and none
    ever stayed connected.

    Raised out of `AgentLoop.run()` so `_cmd_run` can turn it into a loud,
    actionable, non-zero exit -- the live incident's stacked dead entries
    would otherwise have the process sit there looking alive while every
    handshake bounced on 4401.
    """


def _is_auth_rejected(exc: BaseException) -> bool:
    """True iff `exc` is a websockets `ConnectionClosed*` whose received OR
    sent close code is 4401 (auth rejected).

    4401 means the worker was removed or its credentials are invalid -- a
    PERMANENT condition, never a transient blip (those close with 1006/1011).
    Decided SOLELY on the `.rcvd`/`.sent` `Close` frame codes the exception
    carries (websockets >= 17 always populates one of them on a
    `ConnectionClosed`). A `str(exc)` substring check was deliberately
    removed: a transient 1006/1011 whose server-supplied reason string merely
    CONTAINS "4401" (a nonce, a request id) would be misread as a permanent
    rejection and make a healthy agent give up forever. Anything that is not
    a `ConnectionClosed*` (a plain OSError, a timeout) is False.
    """
    return _has_close_code(exc, _AUTH_REJECTED_CLOSE_CODE)


def _is_disabled(exc: BaseException) -> bool:
    """True iff `exc` is a websockets `ConnectionClosed*` carrying 4403, i.e.
    "an admin disabled this worker".

    REVERSIBLE, and that is the whole point of telling it apart from 4401:
    the admin can re-enable the worker at any time, so the agent must keep
    retrying (slowly) and must NEVER prune the registration -- a pruned entry
    would not come back when the worker does.
    """
    return _has_close_code(exc, _WORKER_DISABLED_CLOSE_CODE)


def _has_close_code(exc: BaseException, code: int) -> bool:
    """Shared frame-code test for `_is_auth_rejected`/`_is_disabled`: decided
    SOLELY on the `.rcvd`/`.sent` `Close` frames, never on `str(exc)`."""
    if not isinstance(exc, ConnectionClosed):
        return False
    for frame in (getattr(exc, "rcvd", None), getattr(exc, "sent", None)):
        if frame is not None and getattr(frame, "code", None) == code:
            return True
    return False


def _peer_upload_min_mbps(config: AgentConfig) -> Optional[float]:
    """做種時這台機器最慢會用的上傳上限（Mbps），`None` = 兩檔都不限速。

    The lowest cap this worker's peer server will ever throttle an upload to:
    the smaller of the active cap (`peer_upload_limit_mbps`) and the idle cap
    (`peer_upload_limit_idle_mbps`), skipping either one that is `0` --
    `0` means UNLIMITED here (see AgentConfig), so it is not a candidate for
    "slowest". Both unlimited -> `None`, i.e. "no floor to report".

    The platform sizes a P2P grant's TTL from this (peer.py's
    `grant_ttl_seconds`), so a user who deliberately caps their uplink below
    the 20 Mbps default gets a grant that actually covers the whole transfer
    instead of expiring mid-file. Reported regardless of whether peer serving
    is currently enabled: it is harmless (a non-seeder is never picked as a
    seeder) and keeps hello's shape stable across a `peer_serve` toggle.
    """
    caps = [
        cap
        for cap in (config.peer_upload_limit_mbps, config.peer_upload_limit_idle_mbps)
        if cap and cap > 0
    ]
    return min(caps) if caps else None


class PlatformUnavailable(Exception):
    """The platform could not be reached -- as opposed to answering and
    saying no.

    The distinction decides a job's fate. A platform that ANSWERS and
    rejects (a 4xx, a hash mismatch) is a real failure: report it and move
    on. A platform we simply could not talk to says nothing about the run,
    which finished perfectly well, so the completion is held and retried
    across the reconnect instead of being thrown away as a failure.
    """


class PlatformConnection:
    """One agent<->platform WebSocket connection, with small testable methods."""

    def __init__(self, entry: PlatformEntry, config: AgentConfig):
        self.entry = entry
        self.config = config
        self.ws = None
        self.state = "idle"
        # Last object_info hash this connection has confirmed sent to the
        # platform (or "" before the first successful upload). Carried on
        # every heartbeat so the platform can detect drift independently.
        self.object_info_hash: str = ""
        # Digest of the last model inventory this connection actually sent
        # (or "" before the first send). Lets refresh_model_inventory tell a
        # genuine change from a no-op rescan without resending the whole
        # (possibly large) model list just to compare it.
        self.model_inventory_hash: str = ""
        # M7 final-review fix: name -> sha256 for every model whose
        # `chunk_sha256s` has actually been sent to the platform on THIS
        # connection. `_dedup_chunk_lists` consults this to omit
        # `chunk_sha256s` from an inventory report for a file whose chunk
        # list the platform already has at the same sha256 -- only the first
        # report after connect, or a file (re)hashed since, carries it.
        self.chunks_sent: dict[str, str] = {}
        # Consecutive 4401 handshake rejections seen on THIS entry in THIS
        # process; reset to 0 by any successful handshake. Only when it
        # reaches `_AUTH_REJECTIONS_BEFORE_GIVING_UP` does `_run_platform`
        # treat the registration as definitively dead -- see that constant.
        self.auth_rejections: int = 0
        # Set once the 4403 "this worker is disabled" notice has been logged,
        # so a worker left disabled for a week doesn't log it every backoff.
        self.disabled_logged: bool = False

    def _ws_url(self) -> str:
        parsed = urlsplit(self.entry.platform_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        return urlunsplit((scheme, parsed.netloc, "/api/agent/ws", "", ""))

    async def connect(self) -> None:
        self.ws = await websockets.connect(self._ws_url())

    async def close(self) -> None:
        if self.ws is not None:
            try:
                await self.ws.close()
            except Exception:
                pass
            self.ws = None

    async def handshake(self) -> dict:
        """完成挑戰-回應，**回傳整個 `ready` frame**（Phase 3.4：裡面帶
        `remote_ip`，呼叫端要用它決定通告位址）。舊平台不帶這個欄位，
        呼叫端讀到 None 就沿用映射回報的外部 IP（spec §8）。"""
        challenge = json.loads(await self.ws.recv())
        nonce = challenge["nonce"]
        sig = self._sign(nonce.encode())
        await self._send({"type": "auth", "worker_id": self.entry.worker_id, "sig": sig})
        ready = json.loads(await self.ws.recv())
        if ready.get("type") != "ready":
            raise ConnectionError(f"Unexpected handshake reply: {ready!r}")
        return ready

    def _sign(self, message: bytes) -> str:
        signing_key = SigningKey(bytes.fromhex(self.entry.signing_key_hex))
        return signing_key.sign(message).signature.hex()

    async def _send(self, message: dict) -> None:
        await self.ws.send(json.dumps(message))

    async def recv(self) -> dict:
        return json.loads(await self.ws.recv())

    async def send_hello(
        self,
        hardware_info: dict,
        backend: str,
        torch_version: str,
        node_classes,
        peer_url: Optional[str] = None,
        peer_lan_url: Optional[str] = None,
        peer_nat: str = "none",
    ) -> None:
        message = {
            "type": "hello",
            "hardware": hardware_info,
            "backend": backend,
            "torch_version": torch_version,
            "node_classes": sorted(node_classes),
            # Protocol 4 (Phase 3.1 P2P addendum): adds the optional
            # `peer_url` field below, advertised only when this worker's
            # peer HTTP server is enabled (see peerserve.is_enabled). Still
            # guarantees everything protocol 3 did: `auto_fetch` and lazy
            # sha256/chunk hashes on inventory entries (hardware.scan_models),
            # `exec_seconds` on job_done/job_failed, and job_cancelled
            # pushes. A server that doesn't know protocol 4 yet just ignores
            # the unknown fields (see agentws.py).
            "protocol": 4,
            "auto_fetch": self.config.auto_fetch_models,
            # Optional (Phase 3.2 F1 fix): this worker's configured auto-fetch
            # budget (see AgentConfig.max_fetch_gb / fetcher._check_budget_and_
            # disk). No protocol bump -- an old server that doesn't know this
            # field just ignores it (today's behavior, unchanged); a server
            # that does know it folds this into the fleet fetchability gate
            # (assess._worker_fetch_capacity_ok) instead of assuming this
            # worker can absorb an unbounded download.
            "max_fetch_gb": self.config.max_fetch_gb,
            # Optional: the SLOWEST upload cap this worker will ever serve
            # peer bytes at, so the platform can size a P2P grant's TTL to
            # this seeder instead of assuming the 20 Mbps default (see
            # server/comfyfed_server/peer.py's grant_ttl_seconds). No
            # protocol bump -- an older platform just ignores the key.
            "peer_upload_min_mbps": _peer_upload_min_mbps(self.config),
        }
        if peer_url:
            message["peer_url"] = peer_url
        # Phase 3.4 §3.2：`peer_lan_url` 只在有值時帶（舊平台忽略未知欄位；
        # 新平台看不到就當 null）。`peer_nat` 永遠帶，讓 console 能顯示這個
        # `peer_url` 是怎麼來的（自動開埠／手動轉埠／只有區網）。
        if peer_lan_url:
            message["peer_lan_url"] = peer_lan_url
        message["peer_nat"] = peer_nat
        await self._send(message)

    async def send_inventory(self, models: list[dict]) -> None:
        await self._send({"type": "inventory", "models": models})

    async def send_heartbeat(
        self,
        state: str,
        progress: float = 0.0,
        job_id: Optional[str] = None,
        dynamic: Optional[dict] = None,
        object_info_hash: Optional[str] = None,
        stage: Optional[str] = None,
        fetch_pct: Optional[float] = None,
        fetch_model: Optional[str] = None,
    ) -> None:
        self.state = state
        message = {
            "type": "heartbeat",
            "state": state,
            "progress": progress,
            "job_id": job_id,
            "dynamic": dynamic or {},
            "object_info_hash": object_info_hash,
        }
        # Phase 2.1 Task 5: present only while this worker is downloading a
        # missing model before running the job it was pushed (see
        # fetcher.fetch_and_verify_models) -- omitted entirely otherwise, so
        # an ordinary heartbeat's wire shape is unchanged (matching
        # agentws.py's `"stage": "fetching_models"|absent` contract, as
        # opposed to job_id/dynamic/object_info_hash which are always
        # present, just possibly null/empty).
        if stage is not None:
            message["stage"] = stage
        if fetch_pct is not None:
            message["fetch_pct"] = fetch_pct
        if fetch_model is not None:
            message["fetch_model"] = fetch_model
        await self._send(message)

    async def send_object_info(self, gzip_payload: bytes, oi_hash: str) -> None:
        """Signed POST of a gzipped, canonical `/object_info` snapshot."""
        path = "/api/agent/object_info"
        headers = signing.signed_headers(self.entry, "POST", path, gzip_payload)
        headers["X-OI-Hash"] = oi_hash
        headers["Content-Encoding"] = "gzip"
        async with httpx.AsyncClient(base_url=self.entry.platform_url) as client:
            resp = await client.post(path, content=gzip_payload, headers=headers)
            resp.raise_for_status()

    async def send_job_done(
        self, job_id: str, result_files: list[str], exec_seconds: Optional[float] = None
    ) -> None:
        await self._send(
            {
                "type": "job_done",
                "job_id": job_id,
                "result_files": result_files,
                "exec_seconds": exec_seconds,
            }
        )

    async def send_job_failed(
        self, job_id: str, error: str, exec_seconds: Optional[float] = None
    ) -> None:
        await self._send(
            {"type": "job_failed", "job_id": job_id, "error": error, "exec_seconds": exec_seconds}
        )

    async def send_receipt_ack(self, receipt_id: str, worker_sig: str) -> None:
        await self._send({"type": "receipt_ack", "receipt_id": receipt_id, "worker_sig": worker_sig})

    def sign_receipt_payload(self, payload: str) -> str:
        return self._sign(payload.encode())


def _model_inventory_digest(models: list[dict]) -> str:
    """Stable digest of a model inventory, for change detection.

    Sorted by name (scan_models' own order is os.walk's, which is not
    guaranteed stable across calls) and dumped with sorted keys so two scans
    that found the exact same files/sizes/hashes always hash identically --
    the whole point being to skip resending an `inventory` message when
    nothing actually changed.
    """
    canonical = json.dumps(sorted(models, key=lambda m: m["name"]), sort_keys=True)
    return hashlib.sha256(canonical.encode()).hexdigest()


def _dedup_chunk_lists(models: list[dict], chunks_sent: dict[str, str]) -> tuple[list[dict], dict[str, str]]:
    """M7 final-review fix: strip `chunk_sha256s` from an outgoing inventory
    entry whose (name, sha256) was already sent-with-chunks on this same
    connection, per `chunks_sent` -- spec: 庫存回報攜帶分塊表僅在整檔雜湊首次回報或
    變更時傳. Returns `(outgoing_models, updates)`; `updates` is every
    (name -> sha256) pair that DOES go out with its chunk list this call --
    the caller applies it to `conn.chunks_sent` only once `send_inventory`
    actually succeeds (mirroring how `model_inventory_hash` is only updated
    after a successful send), so a failed send never wrongly marks a chunk
    list as delivered.

    Every other field is untouched -- the server already tolerates (and
    first-wins-stores) an inventory entry with no `chunk_sha256s`
    (`model_manifest.record_hash`'s `chunk_json is None` branch), so omitting
    it here is purely a payload-size optimization, never a behavior change
    for the server side.
    """
    out: list[dict] = []
    updates: dict[str, str] = {}
    for entry in models:
        chunk_list = entry.get("chunk_sha256s")
        name = entry.get("name")
        sha256 = entry.get("sha256")
        if not chunk_list or not isinstance(name, str) or not isinstance(sha256, str):
            out.append(entry)
            continue
        if chunks_sent.get(name) == sha256:
            out.append({k: v for k, v in entry.items() if k != "chunk_sha256s"})
        else:
            out.append(entry)
            updates[name] = sha256
    return out, updates


def _is_safe_relative_path(path: str) -> bool:
    """True if `path` is a non-empty relative path segment safe to join onto
    a configured base directory: no absolute form (in ANY sense) and no `..`
    traversal component.

    `filename`/`subfolder` ultimately derive from workflow content (a
    SaveImage node's `filename_prefix`, echoed back by ComfyUI's history) --
    i.e. this is workflow-influenced input feeding a DELETE, not merely our
    own local ComfyUI's say-so. A naive `os.path.isabs` check is not enough
    on Windows: `os.path.isabs("C:foo")` is False (it's drive-*relative*, not
    absolute) yet `os.path.join(base, "C:foo")` silently discards `base`
    entirely and resolves against drive C's current directory; `"/etc/passwd"`
    is also not `os.path.isabs` on Windows (no drive letter) but still joins
    to the root of whichever drive `base` lives on. So every one of these is
    rejected explicitly, not just POSIX-style `..` traversal -- and this is
    only the first of two independent checks; `_safe_remove_under` also
    verifies the final resolved path is still under `base_dir` before
    deleting anything.
    """
    if not path:
        return False
    if os.path.isabs(path):
        return False
    if ntpath.splitdrive(path)[0]:
        return False
    if path.startswith("/") or path.startswith("\\"):
        return False
    normalized = path.replace("\\", "/")
    if ".." in normalized.split("/"):
        return False
    return True


def _subfolder_chain(base_dir: str, subfolder: str) -> list[str]:
    """`base_dir/subfolder` and each parent up to (excluding) `base_dir`.

    Deepest first, so `cleanup_job_files` can rmdir the leaf and then peel
    the now-empty parents -- e.g. `comfyfed/<job>` removes `<job>` and then
    `comfyfed`, but stops at the first directory that still has content.
    """
    parts = [p for p in subfolder.replace("\\", "/").split("/") if p]
    return [os.path.join(base_dir, *parts[: i + 1]) for i in range(len(parts) - 1, -1, -1)]


def _safe_remove_under(base_dir: str, filename: str, subfolder: str = "") -> None:
    """Best-effort delete of `base_dir/<subfolder>/<filename>`, refusing unsafe paths.

    Two independent layers, mirroring `storage.sanitize_path_component`'s
    sanitize-then-verify approach for artifact paths: (1) `filename` and any
    non-empty `subfolder` must each pass `_is_safe_relative_path`; (2) even
    so, the joined path is resolved with `os.path.realpath` and confirmed to
    still fall strictly under `os.path.realpath(base_dir)` (via
    `os.path.commonpath`) before anything is removed -- belt and suspenders
    against a component that slips past (1) in some case not yet enumerated,
    or a symlink planted inside `base_dir`.

    Never raises: a path that fails either check, or a file that no longer
    exists, is logged and skipped, and any OS-level failure (permission
    denied, file in use) is caught and logged too. Cleanup must never be able
    to turn a successfully-reported job into a crashed one.
    """
    if not _is_safe_relative_path(filename):
        logger.warning("runner: refusing to clean up unsafe filename %r under %s", filename, base_dir)
        return
    if subfolder and not _is_safe_relative_path(subfolder):
        logger.warning("runner: refusing to clean up unsafe subfolder %r under %s", subfolder, base_dir)
        return

    candidate = os.path.join(base_dir, subfolder, filename) if subfolder else os.path.join(base_dir, filename)

    base_real = os.path.realpath(base_dir)
    candidate_real = os.path.realpath(candidate)
    try:
        inside_base = os.path.commonpath([base_real, candidate_real]) == base_real
    except ValueError:
        # commonpath raises when the paths don't share a root (e.g. different
        # drives on Windows) -- definitely not "under" the base dir either.
        inside_base = False
    if not inside_base:
        logger.warning("runner: refusing to clean up path outside %s: %s", base_dir, candidate_real)
        return

    try:
        if os.path.isfile(candidate_real):
            os.remove(candidate_real)
    except OSError:
        logger.exception("runner: failed to remove %s during job cleanup", candidate_real)


class CleanupMode(str, Enum):
    """How a finished job's ComfyUI-directory cleanup should behave.

    Three outcomes, two behaviours -- the split is deliberate:

    - `SUCCESS`: the run finished AND every artifact upload was
      hash-verified by the platform. Nothing on this worker is worth
      keeping, so both the staged inputs and the produced outputs go.
    - `CANCELLED`: the platform cancelled the job mid-run. Nobody will ever
      look at what was produced (there is no job, no receipt, no artifact
      to inspect against), so this cleans up exactly like SUCCESS --
      staged inputs plus whatever outputs already landed. A cancelled run
      that left its inputs behind would be a disk leak triggerable from the
      console, which is the whole reason cancel is not folded into FAILURE.
    - `FAILURE`: the run errored. Its (possibly partial) outputs are left in
      place for the operator to inspect, and the inputs with them so the
      failure can be reproduced by hand.
    """

    SUCCESS = "success"
    FAILURE = "failure"
    CANCELLED = "cancelled"


def cleanup_job_files(
    *,
    mode: CleanupMode,
    comfy_output_dir: Optional[str],
    comfy_input_dir: Optional[str],
    output_files: list[dict],
    input_filenames: list[str],
) -> None:
    """Best-effort disk cleanup for one finished job.

    Called from `handle_job`'s `finally`, so it runs whether the job
    succeeded or failed. This agent keeps a job's downloaded inputs and the
    outputs pulled back from ComfyUI's `/view` in memory only -- nothing of
    that kind is ever written to a local temp file, so there is no
    agent-private temp file to remove here.

    What DOES accumulate on disk without bound is ComfyUI's OWN `input` and
    `output` directories: every job's assets get copied into
    `comfy_input_dir` (by `comfy.upload_input`) and every render lands in
    `comfy_output_dir`. Deleting this job's entries there is the cleanup that
    actually keeps the worker's disk from filling up, and it only runs when:

    - both directories are configured (an operator who hasn't set them gets
      no deletions and a log line explaining why, never a guess at where
      ComfyUI's folders live), and
    - `mode` is not `FAILURE` -- see `CleanupMode` for why a cancelled job
      cleans up like a successful one while a failed job keeps everything.

    `output_files` is a list of `{"filename", "subfolder"}` dicts (from
    `comfy.run_workflow`'s results) and `input_filenames` the job's own
    `input_assets` list, both from `handle_job`.
    """
    if mode is CleanupMode.FAILURE:
        logger.debug("runner: job failed, skipping ComfyUI-directory cleanup")
        return

    if comfy_output_dir:
        for item in output_files:
            _safe_remove_under(comfy_output_dir, item.get("filename") or "", item.get("subfolder") or "")
        # `namespace_outputs` routes every save into a per-job subfolder, so
        # once its files are gone the directory chain is this job's litter
        # too. Deepest-first, rmdir only (refuses non-empty), same safety
        # gates as the file removals.
        subfolders = sorted(
            {item.get("subfolder") or "" for item in output_files if item.get("subfolder")},
            key=lambda s: s.count("/") + s.count("\\"),
            reverse=True,
        )
        base_real = os.path.realpath(comfy_output_dir)
        for subfolder in subfolders:
            if not _is_safe_relative_path(subfolder):
                continue
            for path in _subfolder_chain(comfy_output_dir, subfolder):
                path_real = os.path.realpath(path)
                try:
                    if os.path.commonpath([base_real, path_real]) != base_real or path_real == base_real:
                        break
                except ValueError:
                    break
                try:
                    os.rmdir(path_real)
                except OSError:
                    break  # not empty (another job's files) or in use -- stop here
    else:
        logger.debug("runner: comfy_output_dir not configured, skipping worker output cleanup")

    if comfy_input_dir:
        for filename in input_filenames:
            _safe_remove_under(comfy_input_dir, filename)
    else:
        logger.debug("runner: comfy_input_dir not configured, skipping worker input cleanup")


@dataclass
class _JobHandle:
    """Everything the receive loop needs to reach into a job already in flight.

    `handle_job` runs in its own task now, so the loop that reads the socket
    can no longer reach it through the call stack. This is the handshake
    between them: the loop trips `cancel_event` (checked by
    `comfy.run_workflow`'s polling loop) and uses `prompt_id` -- reported
    back by `run_workflow` the moment ComfyUI accepts the submission -- to
    stop ComfyUI itself.
    """

    job_id: str
    # The connection that dispatched this job. Everything about the job is
    # scoped to it: only that platform may cancel it, and only that
    # platform's heartbeats may name it (any other platform would read the
    # id as one it never issued -- i.e. not owned -- and push a
    # `job_cancelled` that would kill a perfectly healthy run).
    conn: Optional["PlatformConnection"] = None
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    prompt_id: Optional[str] = None
    task: Optional[asyncio.Task] = None
    # True from the moment this job wins `job_lock` until it finishes. The
    # single-job invariant means at most one handle has it set, and it is
    # what "busy with THIS job" means: a second platform's job that has been
    # dispatched but is still parked on the lock is emphatically not running.
    running: bool = False
    # True while the run is over and only the hand-off (artifact uploads +
    # job_done) is left. Such a job must not be cancel-evented by shutdown:
    # there is nothing left to abort, only a result to deliver or preserve.
    reporting: bool = False
    # The prompt id ComfyUI has already been told to stop, so the wind-down
    # re-check never fires a second `/interrupt` for a prompt the receive
    # loop already handled -- on a shared worker that second call could land
    # on somebody else's render.
    interrupted_prompt_id: Optional[str] = None
    # While the auto-fetch pre-phase is downloading models, the latest
    # {"stage": "fetching_models", "fetch_pct": .., "fetch_model": ..} --
    # None otherwise. EVERY heartbeat that names this job while it is set
    # must carry these fields (the initial busy beat and the periodic 30s
    # beat included): the server treats a stage-less busy heartbeat as "the
    # run has started" (it sets started_at / clears the panel's 下載模型中
    # chip), so a bare beat slipping out mid-download would start the
    # billing clock during a phase that is deliberately never billed.
    fetch_status: Optional[dict] = None

    def set_prompt_id(self, prompt_id: str) -> None:
        # Called from `run_workflow`'s worker thread; a plain attribute
        # assignment, which is all the cross-thread safety this needs.
        self.prompt_id = prompt_id


def _comfy_connect_error(exc: BaseException, comfy_url: str) -> bool:
    """True iff `exc` (or something in its `__cause__` chain) is a refused
    connection to `comfy_url`.

    Live incident 2026-09-16: with ComfyUI down, `_run_platform`'s
    post-handshake `collect_hardware`/`allowed_classes` calls raise
    `httpx.ConnectError`, which the generic drop handler logged with a full
    40-line traceback every 5-60 s forever. The traceback says nothing the
    one-line message does not, so this narrow, URL-checked recognition
    downgrades exactly that case -- and nothing else -- to a WARNING.

    `httpcore.ConnectError` is matched too because that is what httpx wraps
    (`raise httpx.ConnectError(...) from httpcore_exc`); the request URL is
    only ever attached to the httpx layer, so the whole chain is scanned for
    both facts independently.
    """
    base = comfy_url.rstrip("/")
    saw_connect_error = False
    saw_comfy_request = False
    seen: set[int] = set()
    cur: Optional[BaseException] = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        if isinstance(cur, _CONNECT_ERROR_TYPES):
            saw_connect_error = True
        url = getattr(getattr(cur, "request", None), "url", None)
        if url is not None and str(url).startswith(base):
            saw_comfy_request = True
        cur = cur.__cause__
    return saw_connect_error and saw_comfy_request


class AgentLoop:
    """Owns one `PlatformConnection` per configured platform and one global job lock."""

    def __init__(self, config: AgentConfig, cfg_path: str, connection_factory=PlatformConnection):
        self.config = config
        self.cfg_path = cfg_path
        # Where the cross-process control files live (pause flag, stop
        # request, published state) -- always beside agent.json, so a CLI
        # invoked with the same `--config` finds exactly this directory.
        self._config_dir = os.path.dirname(os.path.abspath(cfg_path))
        self.connections: dict[str, PlatformConnection] = {
            entry.worker_id: connection_factory(entry, config) for entry in config.platforms
        }
        self.job_lock = asyncio.Lock()
        # Jobs currently in flight, keyed by job_id. The single-job invariant
        # (`job_lock`) means at most one of these is actually executing; a
        # second `job` message that arrives anyway is still tracked here so
        # its cancel event is reachable while it waits for the lock.
        self._jobs: dict[str, _JobHandle] = {}
        # Every spawned handle_job task, so shutdown can reap them instead of
        # letting the event loop close over pending work.
        self._job_tasks: set[asyncio.Task] = set()
        # Same, for the fire-and-forget "tell ComfyUI to stop" tasks.
        self._stop_tasks: set[asyncio.Task] = set()
        # Most recently spawned job (diagnostics, and what tests await).
        self._current_job_task: Optional[asyncio.Task] = None
        self._current_job_id: Optional[str] = None
        # Set the instant the first SIGINT/SIGTERM/SIGBREAK is handled, so a
        # second signal (impatient operator, or a stuck cleanup) is
        # recognised as "already shutting down" and forces an immediate exit
        # instead of layering a second wind-down on top of the first.
        self._shutdown_in_progress = False
        # 4401 dead-registration tracking (see `_run_platform`/`run`).
        # `_connected_ever` flips True the first time ANY connection completes
        # its handshake; `_auth_gave_up` flips True when any `_run_platform`
        # returns because its entry was 4401-rejected. If every platform task
        # returns (gather completes) with a give-up and nothing ever
        # connected, `run()` raises `AllRegistrationsRejected`.
        self._connected_ever = False
        self._auth_gave_up = False
        # M4 final-review fix: serialises `_prune_dead_registration`'s
        # load->back up->save of agent.json. Two platforms can give up in the
        # same tick; without this, a future async step anywhere in that
        # sequence would silently reintroduce a lost update (one removal
        # overwriting the other's).
        self._prune_lock = asyncio.Lock()
        # Phase 3.1 P2P addendum (種子端): started in `run()` when
        # `peerserve.is_enabled(config)`, stopped in `shutdown()`. One
        # listener for the whole process, shared across every platform
        # connection (see peerserve.PeerHTTPServer's docstring).
        self._peer_server: Optional["peerserve.PeerHTTPServer"] = None
        self._peer_advertised_url: Optional[str] = None
        # Phase 3.4：自動開埠的結果與通告狀態。`_peer_mapping` 是 natmap 回
        # 報的那一筆映射（續租與關機解除都要它）；`_peer_lan_url` 永遠有值
        # （只要 peer 服務有開），`_peer_nat` 是 `peer_url` 的來源標籤。
        self._peer_mapping: Optional["natmap.Mapping"] = None
        self._peer_lan_url: Optional[str] = None
        self._peer_nat: str = "none"
        # 平台推回來的可連性結論（peer_status），只存記憶體供 status 顯示。
        self._peer_reachable: Optional[bool] = None
        self._peer_checked_url: Optional[str] = None
        # 最後一次由 `ready.remote_ip` 得知的公網 IP，與自動重連的節流紀錄
        # （`time.monotonic()` 時間戳，滾動一小時內最多一筆）。
        self._peer_remote_ip: Optional[str] = None
        self._peer_reconnects_at: list[float] = []
        # 續租任務（每 `natmap.RENEW_SECONDS` 一次），由 `run()` 起、
        # `shutdown()` 取消並 await 完之後才解除映射。
        self._peer_renew_task: Optional[asyncio.Task] = None
        # 分級 P2P 上傳限速：最後一次真的套用下去的上限（Mbps），只用來讓
        # tier 切換的 log 一次只印一行，而不是每 5 秒 tick 都印。
        # Last upload cap actually applied (Mbps); only used so the tier-switch
        # log fires ONCE per change instead of on every 5 s tick.
        self._peer_upload_limit_applied: Optional[float] = None
        # The single platform-independent control task (see `_control_loop`),
        # started by `run()` and stopped on either shutdown path.
        self._control_task: Optional[asyncio.Task] = None
        # Worker ids whose `_run_platform` is currently parked waiting for a
        # ComfyUI that is not running (see `_wait_for_comfy`). A SET rather
        # than a flag because every platform connection waits independently;
        # the published state says "waiting" while ANY of them does.
        self._comfy_waiting: set[str] = set()

    async def broadcast_heartbeat(
        self,
        state: str,
        progress: float = 0.0,
        job_id: Optional[str] = None,
        dynamic: Optional[dict] = None,
        stage: Optional[str] = None,
        fetch_pct: Optional[float] = None,
        fetch_model: Optional[str] = None,
    ) -> None:
        # EVERY would-be-"idle" beat goes through the availability gate, not
        # just the periodic tick: the job-completion beat (which is also the
        # failure and cancel wind-down beat -- one `finally` feeds them all)
        # fires the instant a job ends, and an ungated "idle" there would
        # make a paused worker dispatch-eligible again for a whole heartbeat
        # interval. `"busy"` is passed through untouched (see
        # `_effective_state`), so a running job is never affected.
        state = self._effective_state(state)
        for worker_id, conn in self.connections.items():
            # A connection that failed or lost its handshake has `ws is None`
            # (that is what `close()` leaves behind, and a never-connected
            # dead 4401 entry never sets it). A job-lifecycle beat must not
            # attempt a send on it -- live incident: `AttributeError: 'NoneType'
            # object has no attribute 'send'` spammed once per beat per dead
            # platform entry. (The periodic beat in `_connection_loop` is
            # unaffected: it only runs for a connection that just handshaked.)
            if getattr(conn, "ws", None) is None:
                continue
            try:
                await conn.send_heartbeat(
                    state,
                    progress=progress,
                    job_id=job_id,
                    dynamic=dynamic,
                    object_info_hash=getattr(conn, "object_info_hash", None) or None,
                    stage=stage,
                    fetch_pct=fetch_pct,
                    fetch_model=fetch_model,
                )
            except Exception:
                logger.exception("runner: failed to broadcast heartbeat to %s", worker_id)

    def _effective_state(self, state: str, availability: Optional[str] = None) -> str:
        """Rewrite an availability-bearing heartbeat state for this tick.

        `"busy"` (and any other non-availability state) is returned
        untouched: a running job keeps its busy beats and its job_id, because
        pausing never aborts work in flight -- it only stops NEW intake.
        Otherwise the tick reports `"idle"` or `"paused"` according to
        `control.availability`. `"paused"` is accepted as an input too: it is
        what the previous tick left on `conn.state`, and treating it as
        "would be idle" is what lets a resume flip back to `"idle"`.

        `availability`, when given, is a value the caller already computed
        for this tick -- reused instead of recomputed so one tick makes
        exactly one `idle.seconds_since_input` call and cannot publish a
        state that disagrees with the cap it applies.
        """
        if state not in ("idle", "paused"):
            return state
        if availability is None:
            availability = control.availability(self.config, self._config_dir)
        return "idle" if availability == "available" else "paused"

    def _aggregate_state(
        self, availability: Optional[str] = None
    ) -> tuple[str, Optional[str], Optional[str]]:
        """What this PROCESS is doing, for `agent_state.json` -- one verdict
        for the whole agent, not one per platform connection.

        The published state is read by `comfyfed status` in another terminal,
        which asks "is it safe to stop this machine's agent?". That question
        has no per-platform answer: a worker registered with two platforms
        running a job for platform A is busy, full stop. Deriving it from
        `handle.running` (the same source `_job_id_for` uses) rather than
        from any connection's `conn.state` is what keeps two connection loops
        from alternately publishing `busy` and `idle` into one file.
        """
        for handle in self._jobs.values():
            if handle.running:
                return "busy", handle.job_id, None
        # Waiting for ComfyUI is a real, operator-visible reason to be
        # unavailable, and it outranks the idle/pause verdict: nothing can be
        # dispatched here until ComfyUI answers, no matter how idle the
        # machine is. Reported as `paused` (an existing, understood state) so
        # readers that predate `reason` keep working unchanged.
        if self._comfy_waiting:
            return "paused", None, _COMFY_UNREACHABLE_REASON
        return self._effective_state("idle", availability), None, None

    def _publish_control_state(self, availability: Optional[str] = None) -> None:
        state, job_id, reason = self._aggregate_state(availability)
        control.write_state(
            self._config_dir, state, job_id, reason=reason, peer=self._peer_state_payload()
        )

    def _peer_state_payload(self) -> dict:
        """`comfyfed status` 要印的 P2P 那一行所需的全部資訊（spec §3.3）。
        `status` 是另一個 process，看不到 runner 的記憶體 —— 所以這些欄位
        跟著 `agent_state.json` 一起發布。"""
        return {
            "enabled": self._peer_server is not None,
            "nat": self._peer_nat,
            "url": self._peer_advertised_url,
            "lan_url": self._peer_lan_url,
            "reachable": self._peer_reachable,
        }

    def _apply_peer_upload_limit(self, availability: str) -> None:
        """依目前的閒置狀態，把分級上傳限速套到做種用的 peer server 上。

        做種跟派工不一樣：使用者在用電腦時「不」停止上傳（只吃 CPU 跟網路），
        而是降速讓出頻寬。`availability == "available"`（閒置）套
        `peer_upload_limit_idle_mbps`（預設 0 = 不限速），其餘情況（使用者
        活動中、手動暫停）套 `peer_upload_limit_mbps`（預設 20 Mbps）。

        Seeding is throttled, never stopped, while a human uses the machine.
        Called once per control tick and once right after the peer server
        starts, so the first seconds are not unlimited-by-omission.

        `availability` is the value the CALLER already computed for this tick
        (`control.availability`), passed in rather than recomputed: a second
        `idle.seconds_since_input` call per tick can disagree with the first,
        publishing the state as idle while capping as active (or vice versa).
        """
        server = self._peer_server
        if server is None:
            return
        idle_tier = availability == "available"
        limit = (
            self.config.peer_upload_limit_idle_mbps
            if idle_tier
            else self.config.peer_upload_limit_mbps
        )
        # 只有「這一輪算出來的上限跟上次套用的不一樣」才真的去動桶子：重申同一
        # 個速率不是免費的（每次都要碰全域鎖、重算容量），而且沒有任何好處。
        # Only touch the bucket when the effective tier/rate actually CHANGES
        # -- re-asserting the same rate every 5 s buys nothing.
        if limit == self._peer_upload_limit_applied:
            return
        try:
            server.set_upload_limit_mbps(limit)
        except Exception:
            logger.exception("runner: failed to apply the P2P upload limit")
            return
        self._peer_upload_limit_applied = limit
        shown = "不限速 / unlimited" if not limit else f"{limit:g} Mbps"
        reason_zh = "閒置中" if idle_tier else (
            "手動暫停" if availability == "paused-manual" else "使用者活動中"
        )
        reason_en = "idle" if idle_tier else (
            "manually paused" if availability == "paused-manual" else "user active"
        )
        logger.info(
            "P2P 上傳限速 -> %s（%s）/ P2P upload cap -> %s (%s)",
            shown, reason_zh, shown, reason_en,
        )

    async def _control_loop(self) -> None:
        """Publish the agent's state and honour `comfyfed stop`, independently
        of every platform connection.

        This deliberately does NOT live on the heartbeat: the heartbeat only
        ticks while a socket is established, so with the platform down (or
        the laptop off the VPN) `comfyfed stop` would write its request and
        wait forever while `comfyfed status` claimed the very-much-running
        agent was not running -- exactly the situation in which an operator
        most wants both commands to work. Nothing here touches the network.
        """
        while True:
            try:
                # 一個 tick 只算一次 availability（= 只問一次
                # `idle.seconds_since_input`），發布狀態跟套用上傳上限共用同
                # 一個結論，不會一個說閒置、一個說活動中。
                # One availability verdict per tick, shared by both the
                # published state and the upload cap.
                availability = control.availability(self.config, self._config_dir)
                self._publish_control_state(availability)
                self._poll_stop_request()
                # 做種不隨暫停停止，只降速：同一個 tick 算出來的 availability
                # 直接決定這一輪的上傳上限。
                # Seeding keeps running while paused -- it is only throttled.
                self._apply_peer_upload_limit(availability)
            except Exception:
                # Local control is a convenience layer; a surprise here must
                # never take down a working agent. The next tick retries.
                logger.exception("runner: control loop tick failed")
            await asyncio.sleep(_CONTROL_TICK_SECONDS)

    async def _stop_control_loop(self) -> None:
        """Cancel the control task and drop the published state.

        Both shutdown paths end here, so `comfyfed status` says "not running"
        the instant the process is on its way out instead of waiting out the
        120 s staleness window.
        """
        task = self._control_task
        self._control_task = None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.exception("runner: control loop raised while stopping")
        control.clear_state(self._config_dir)

    def _poll_stop_request(self) -> None:
        """Honour a `comfyfed stop` dropped by another process.

        The stop file is consumed (cleared) before the wind-down starts, so a
        crash mid-shutdown cannot leave a request that instantly kills the
        next run. Everything after that mirrors `_on_os_signal`: set
        `_shutdown_in_progress` and schedule exactly the same
        `_graceful_shutdown_and_stop` task on the running loop. A request
        arriving while a wind-down is already under way is a no-op -- unlike
        a second Ctrl-C there is no impatient operator at a console to
        escalate to `os._exit` for.
        """
        if not control.is_stop_requested(self._config_dir):
            return

        control.clear_stop(self._config_dir)
        if self._shutdown_in_progress:
            logger.info(
                "已在停止流程中，忽略重複的停止要求 / already shutting down, "
                "ignoring a repeated stop request"
            )
            return

        self._shutdown_in_progress = True
        logger.info(
            "收到停止要求，正在取消進行中的工作並清理（等同 Ctrl-C） / stop requested, "
            "cancelling the running job and cleaning up (same as Ctrl-C)"
        )
        loop = asyncio.get_running_loop()
        loop.create_task(
            self._graceful_shutdown_and_stop(loop), name="comfyfed-stop-request-shutdown"
        )

    async def refresh_object_info(self, conn: PlatformConnection, force: bool = False) -> None:
        """Fetch ComfyUI's full `/object_info` and upload it if it changed.

        Called after hello and every `_OBJECT_INFO_INTERVAL_SECONDS` from the
        connection loop, and with `force=True` when the platform replies
        `want_object_info` on a heartbeat (its stored hash drifted from ours,
        or its copy went missing). Any failure -- ComfyUI unreachable, upload
        rejected -- is logged and swallowed, leaving `conn.object_info_hash`
        unchanged so the next attempt naturally retries.
        """
        try:
            object_info = await asyncio.to_thread(comfy.get_object_info, self.config.comfy_url)
        except Exception:
            logger.exception("runner: failed to fetch object_info from ComfyUI")
            return

        payload = comfy.canonical_object_info_bytes(object_info)
        oi_hash = comfy.object_info_hash(payload)
        if not force and oi_hash == conn.object_info_hash:
            return

        try:
            await conn.send_object_info(gzip.compress(payload), oi_hash)
        except Exception:
            logger.exception("runner: failed to upload object_info to %s", conn.entry.platform_url)
            return

        conn.object_info_hash = oi_hash

    async def refresh_model_inventory(self, conn: PlatformConnection) -> None:
        """Rescan the local model inventory and push it only if it changed.

        Piggybacks the same `_OBJECT_INFO_INTERVAL_SECONDS` timer as
        `refresh_object_info` (see `_connection_loop`) rather than a second
        interval of its own: this is also what makes the lazy-hash
        convergence in `hardware.scan_models` real. A single hello-time scan
        would schedule at most one background hash and then never look
        again, so a models folder with several un-hashed files would sit
        forever with only the first one ever gaining a `sha256`. Re-scanning
        periodically lets each pass pick up the next still-unhashed file.

        A digest comparison (`_model_inventory_digest`) keeps a rescan that
        found nothing new from pushing a chatty no-op `inventory` message
        every 10 minutes -- only an actual change (a new/removed/resized
        file, or a hash finishing in the background) triggers a send.
        """
        if not self.config.models_dir:
            return

        models = await asyncio.to_thread(
            hardware.scan_models, self.config.models_dir, self.config.hash_models
        )
        digest = _model_inventory_digest(models)
        if digest == conn.model_inventory_hash:
            return

        outgoing, chunk_updates = _dedup_chunk_lists(models, conn.chunks_sent)
        try:
            await conn.send_inventory(outgoing)
        except Exception:
            logger.exception(
                "runner: failed to push updated model inventory to %s", conn.entry.platform_url
            )
            return

        conn.model_inventory_hash = digest
        conn.chunks_sent.update(chunk_updates)

    async def handle_job(self, conn: PlatformConnection, job_msg: dict) -> None:
        """Run one job dispatched over `conn`, broadcasting busy state to every platform.

        Normally driven as a background task spawned by `_handle_message`
        (so the receive loop keeps consuming this socket while the GPU
        works), but it stays directly awaitable: if no handle was registered
        for this job_id, it registers its own.
        """
        job_id = job_msg["job_id"]
        input_filenames = list(job_msg.get("input_assets") or [])
        output_files: list[dict] = []
        success = False
        cancelled = False
        # Set only once `run_workflow` actually returns (success path); a
        # failure raised from inside it (e.g. a ComfyUI execution error) is
        # not reflected here -- see the `except Exception` branch below,
        # which reads `exc.exec_seconds` for that case instead.
        exec_seconds: Optional[float] = None
        handle = self._jobs.get(job_id)
        if handle is None:
            handle = _JobHandle(job_id=job_id, conn=conn)
            self._jobs[job_id] = handle

        def raise_if_cancelled() -> None:
            if handle.cancel_event.is_set():
                raise comfy.JobCancelled()

        async with self.job_lock:
            handle.running = True
            try:
                # The platform may have cancelled while this job waited for
                # the lock, or between dispatch and here.
                raise_if_cancelled()

                fetch_models = list(job_msg.get("fetch_models") or [])
                if fetch_models and self.config.auto_fetch_models:
                    # The very first busy heartbeat must already carry the
                    # fetch stage: a stage-less busy beat is the server's
                    # signal that the RUN started (started_at / billing
                    # clock), and the download phase is never billed.
                    handle.fetch_status = {
                        "stage": "fetching_models",
                        "fetch_pct": 0.0,
                        "fetch_model": None,
                    }
                    await self.broadcast_heartbeat(
                        "busy",
                        progress=0.0,
                        job_id=job_id,
                        stage="fetching_models",
                        fetch_pct=0.0,
                    )
                else:
                    await self.broadcast_heartbeat("busy", progress=0.0, job_id=job_id)

                if fetch_models:
                    if not self.config.auto_fetch_models:
                        # Never a normal flow -- see _AUTO_FETCH_DISABLED_MESSAGE.
                        # Raising here (rather than reporting directly) lets the
                        # existing `except Exception` branch below do the
                        # reporting, exactly like every other fetch failure.
                        raise fetcher.FetchError(_AUTO_FETCH_DISABLED_MESSAGE)

                    async def report_fetch_progress(pct: float, model_name: Optional[str]) -> None:
                        # Runs directly on this coroutine (unlike run_workflow's
                        # on_progress, fetching is native async, no worker
                        # thread involved) -- so this is just a normal await,
                        # no run_coroutine_threadsafe needed.
                        handle.fetch_status = {
                            "stage": "fetching_models",
                            "fetch_pct": pct,
                            "fetch_model": model_name,
                        }
                        await self.broadcast_heartbeat(
                            "busy",
                            progress=0.0,
                            job_id=job_id,
                            stage="fetching_models",
                            fetch_pct=pct,
                            fetch_model=model_name,
                        )

                    await fetcher.fetch_and_verify_models(
                        entries=fetch_models,
                        platform_pubkey_hex=conn.entry.platform_pubkey,
                        models_dir=self.config.models_dir,
                        max_fetch_gb=self.config.max_fetch_gb,
                        cancel_event=handle.cancel_event,
                        report_progress=report_fetch_progress,
                        # Phase 3.1 P2P addendum: the ISSUING platform (the
                        # one that dispatched this job over `conn`) is who
                        # mints a peer grant -- fetcher tries that source
                        # first, per entry, before falling to the URL chain.
                        platform_entry=conn.entry,
                    )

                    # Fetch phase over: from here on heartbeats go back to
                    # the plain busy shape, and the first such stage-less
                    # beat is what tells the server the run is starting.
                    handle.fetch_status = None

                    # The manifest models just landed on disk -- push the
                    # updated inventory now rather than waiting for the
                    # periodic 10-minute rescan (see refresh_model_inventory),
                    # so the server learns immediately that this worker no
                    # longer has a gap for this job (or the next one).
                    await self.refresh_model_inventory(conn)
                    await self.broadcast_heartbeat("busy", progress=0.0, job_id=job_id)

                workflow = comfy.namespace_outputs(json.loads(job_msg["workflow_json"]), job_id)
                # allowed_classes does a blocking HTTP call to ComfyUI's
                # /object_info; running it inline would stall this connection's
                # heartbeats (and every other platform's, they share the loop).
                allowed = await asyncio.to_thread(
                    whitelist.allowed_classes,
                    self.config.node_policy,
                    self.config.comfy_url,
                    self.config.whitelist_extra,
                )
                whitelist.check(workflow, allowed)

                for filename in input_filenames:
                    content = await self._download_input(conn.entry, job_id, filename)
                    await asyncio.to_thread(comfy.upload_input, self.config.comfy_url, filename, content)

                loop = asyncio.get_running_loop()

                def on_progress(p: float) -> None:
                    fut = asyncio.run_coroutine_threadsafe(
                        self.broadcast_heartbeat("busy", progress=p, job_id=job_id), loop
                    )
                    try:
                        fut.result(timeout=10)
                    except Exception:
                        logger.exception("runner: failed to report job progress")

                raise_if_cancelled()

                files, exec_seconds = await asyncio.to_thread(
                    comfy.run_workflow,
                    self.config.comfy_url,
                    workflow,
                    on_progress,
                    cancel_event=handle.cancel_event,
                    on_prompt_id=handle.set_prompt_id,
                )
                output_files = [
                    {"filename": filename, "subfolder": subfolder} for filename, _content, subfolder in files
                ]

                await self._report_completion(conn, handle, files, exec_seconds)
                success = True
            except asyncio.CancelledError:
                # Almost always shutdown reaching a job whose result was
                # never handed over. Say so loudly and leave every file
                # alone (the `finally` picks FAILURE, which cleans nothing):
                # a restart can redo the run, or the server's requeue plus
                # blip re-adoption can still collect it. Deleting the inputs
                # here would only guarantee the redo starts from scratch.
                logger.warning(
                    "runner: job %s wound down before its completion reached the platform; "
                    "leaving its files on disk for a retry or requeue",
                    job_id,
                )
                raise
            except comfy.JobCancelled:
                # Deliberately silent toward the platform: it cancelled this
                # job, so neither job_done nor job_failed is sent -- either
                # would be a message about a job this worker no longer owns.
                cancelled = True
                logger.info("runner: job %s cancelled by the platform, aborting the run", job_id)
            except Exception as exc:
                if handle.cancel_event.is_set():
                    # The failure IS the cancellation, seen from the wrong
                    # end: a cancel landing mid-upload makes the server
                    # reject the bytes, which surfaces here as an upload
                    # error. Reporting job_failed for it would break the
                    # "a cancelled run sends nothing" contract, and worse,
                    # would select CleanupMode.FAILURE and leak the very
                    # files cancel cleanup exists to remove. Every route out
                    # of a cancelled run converges on the cancelled one.
                    cancelled = True
                    logger.info(
                        "runner: job %s failed while already cancelled (%s), winding down as cancelled",
                        job_id, exc,
                    )
                else:
                    logger.exception("runner: job %s failed", job_id)
                    failure_exec_seconds = (
                        exec_seconds if exec_seconds is not None else getattr(exc, "exec_seconds", None)
                    )
                    await self._report_failure(conn, job_id, str(exc), failure_exec_seconds)
            finally:
                handle.running = False
                # A fetch that failed/was cancelled must not leave the stage
                # pinned on later heartbeats for this (already ended) job.
                handle.fetch_status = None
                if cancelled:
                    # Last look at the prompt id: a cancel that raced the
                    # `/prompt` POST had nothing to stop when it arrived.
                    await self._stop_comfy_prompt(handle)
                if cancelled:
                    mode = CleanupMode.CANCELLED
                elif success:
                    mode = CleanupMode.SUCCESS
                else:
                    mode = CleanupMode.FAILURE
                try:
                    cleanup_job_files(
                        mode=mode,
                        comfy_output_dir=self.config.comfy_output_dir,
                        comfy_input_dir=self.config.comfy_input_dir,
                        output_files=output_files,
                        input_filenames=input_filenames,
                    )
                except Exception:
                    logger.exception("runner: job %s cleanup raised unexpectedly", job_id)
                if self._jobs.get(job_id) is handle:
                    del self._jobs[job_id]
                    if self._current_job_id == job_id:
                        self._current_job_id = None
                        self._current_job_task = None
                await self.broadcast_heartbeat("idle", progress=0.0, job_id=None)

    async def _report_failure(
        self, conn: PlatformConnection, job_id: str, error: str, exec_seconds: Optional[float] = None
    ) -> None:
        """Report `job_failed`, including `exec_seconds` when the prompt
        actually started (same measurement as the success path -- see
        `comfy.run_workflow` and `comfy.ComfyError.exec_seconds`), omitted
        (`None`) otherwise. The platform mints a non-billable receipt from
        this either way; a transport failure here is left to the normal
        connection-drop/retry loop rather than held and retried like a
        completion -- a failed job has no artifacts to lose.
        """
        await conn.send_job_failed(job_id, error, exec_seconds)

    async def _report_completion(
        self, conn: PlatformConnection, handle: _JobHandle, files: list, exec_seconds
    ) -> None:
        """Hand a finished job's artifacts and `job_done` to the platform,
        surviving a connection blip.

        This is the phase the whole re-adoption design hinges on, and the
        one most likely to straddle an outage: the server's stale requeue
        fires at 90s precisely because runs outlive short disconnects, so
        "the run ended while the socket was down" is the NORMAL blip, not an
        exotic one. Dropping the completion there would send the job back to
        the queue and have a second worker redo GPU-minutes that are already
        spent -- the double-spend this phase exists to remove.

        So a transport failure (`PlatformUnavailable` from an upload, or any
        error from `send_job_done` -- during a blip `conn.ws` is None and
        `_send` raises) is not a failure of the job: it backs off, waits for
        `_run_platform` to put a live socket back on the same connection
        object, and starts the hand-off again from the first artifact. The
        server accepts the retry through `try_readopt`, and re-uploading an
        artifact it already has is idempotent (same job, same filename,
        hash-verified).

        A platform that ANSWERS and rejects is a different thing entirely
        and propagates untouched to the failure path. So does a cancel
        (`JobCancelled`) and a task cancellation.
        """
        job_id = handle.job_id
        handle.reporting = True
        backoff = _REPORT_RETRY_START_SECONDS
        while True:
            try:
                # The cancel event is re-read before every file: the upload
                # loop is the longest NETWORK phase of a job (minutes, for
                # video), and a cancelled job's uploads are rejected anyway
                # (the artifact gate wants assigned/running).
                for filename, content, _subfolder in files:
                    if handle.cancel_event.is_set():
                        raise comfy.JobCancelled()
                    await self._upload_artifact(conn.entry, job_id, filename, content)

                if handle.cancel_event.is_set():
                    raise comfy.JobCancelled()
                try:
                    await conn.send_job_done(
                        job_id, [filename for filename, _content, _subfolder in files], exec_seconds
                    )
                except Exception as exc:  # the socket, not the job
                    raise PlatformUnavailable(str(exc)) from exc
                return
            except PlatformUnavailable as exc:
                logger.warning(
                    "runner: job %s finished but the platform is unreachable (%s); "
                    "holding the completion, retrying in %.0fs",
                    job_id, exc, backoff,
                )
                await self._wait_before_retry(conn, backoff)
                backoff = min(backoff * 2, _REPORT_RETRY_MAX_SECONDS)

    async def _wait_before_retry(self, conn: PlatformConnection, backoff: float) -> None:
        """Pace the next hand-off attempt: sleep `backoff`, cut short only if
        a socket that was down comes back.

        The two transport failures behind a held completion want different
        things. A dead WebSocket has a definite recovery signal --
        `_run_platform` reconnects on the SAME `PlatformConnection` object,
        replacing `.ws` in place -- so waiting on that attribute resumes the
        moment it is worth resuming. An artifact upload that failed over
        HTTP has no such signal (it runs on its own client against
        `entry.platform_url`, entirely independent of this socket), and the
        socket being alive says nothing about it: returning immediately on
        that basis would retry a failing endpoint as fast as it can answer,
        with no cooldown at all. So the backoff is always actually slept
        unless the specific thing it was waiting for has happened.
        """
        socket_was_down = getattr(conn, "ws", None) is None
        deadline = time.monotonic() + backoff
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            await asyncio.sleep(min(0.25, remaining))
            if socket_was_down and getattr(conn, "ws", None) is not None:
                return

    async def _download_input(self, entry: PlatformEntry, job_id: str, filename: str) -> bytes:
        path = f"/api/agent/jobs/{job_id}/inputs/{filename}"
        headers = signing.signed_headers(entry, "GET", path, b"")
        async with httpx.AsyncClient(base_url=entry.platform_url) as client:
            resp = await client.get(path, headers=headers)
            resp.raise_for_status()
            return resp.content

    async def _upload_artifact(self, entry: PlatformEntry, job_id: str, filename: str, content: bytes) -> None:
        """Upload one job artifact and verify the platform received it uncorrupted.

        Phase 2's presigned upload protocol is tried first: a small signed
        JSON `POST .../artifacts/presign` asks the platform how it wants the
        bytes delivered. A platform that doesn't know this route yet (404/405
        -- any ComfyFed server older than this protocol, or a transport
        error reaching it at all) falls back to the original multipart
        upload unchanged, so this method works unmodified against both an
        old and a new platform. A platform that DOES answer with a mode
        picks one of two cloud-only paths:

          - `"direct"`: PUT the raw bytes to the one-time-token URL the
            presign response names, unsigned (the token itself is the
            auth) -- verified below by `_upload_via_presign_direct`.
          - `"s3"`: PUT the raw bytes straight to the given aws4-presigned
            R2 URL, then a signed `POST .../artifacts/confirm` tells the
            platform the upload landed -- `_upload_via_presign_s3`.

        Whichever path is taken, the platform recomputes/records its own
        hash over the bytes it received (or, in "s3" mode, HEADs the object
        and trusts this agent's own claim -- see the platform's `confirm`
        docstring for why that's an acceptable, narrower trust boundary).
        Only a response whose hash matches local ours counts as success.

        Which exception it raises matters: `RuntimeError` when the platform
        ANSWERED and the upload still did not verify (a real rejection --
        the job failed), `PlatformUnavailable` when no attempt got an
        answer at all (a transport problem -- the job is fine, the socket
        isn't). `_report_completion` holds and retries only the latter.
        """
        local_sha256 = hashlib.sha256(content).hexdigest()

        presign = await self._try_presign(entry, job_id, filename, local_sha256, len(content))
        if presign is not None:
            mode = presign.get("mode")
            if mode == "direct":
                await self._upload_via_presign_direct(entry, presign, content, filename)
                return
            if mode == "s3":
                await self._upload_via_presign_s3(entry, job_id, presign, content, filename, local_sha256)
                return
            logger.warning("runner: presign for %r returned an unknown mode %r; using legacy upload", filename, mode)

        await self._upload_artifact_legacy(entry, job_id, filename, content, local_sha256)

    async def _try_presign(
        self, entry: PlatformEntry, job_id: str, filename: str, sha256_hex: str, size: int
    ) -> Optional[dict]:
        """Ask the platform how it wants this artifact's bytes delivered.

        Returns the parsed `{"mode": ..., ...}` response on success, or
        `None` whenever the legacy multipart path should be used instead:
        the platform doesn't have this route (404/405 -- an older
        ComfyFed), it answered with anything else that isn't a clean 200,
        or the request couldn't even be sent (a `_FakeAsyncClient`-style
        test double with no `post`, a real transport error, ...). Every one
        of those collapses to the same safe fallback rather than raising --
        a broken/old presign endpoint must never turn into a lost job.
        """
        path = f"/api/agent/jobs/{job_id}/artifacts/presign"
        body = json.dumps({"filename": filename, "sha256": sha256_hex, "size": size}).encode()
        try:
            async with httpx.AsyncClient(base_url=entry.platform_url) as client:
                headers = signing.signed_headers(entry, "POST", path, body)
                headers["Content-Type"] = "application/json"
                resp = await client.post(path, content=body, headers=headers)
        except Exception:
            logger.debug("runner: presign request for %r failed to send; using legacy upload", filename, exc_info=True)
            return None

        if resp.status_code in (404, 405):
            return None
        if resp.status_code != 200:
            logger.warning(
                "runner: presign for %r returned status=%s; using legacy upload", filename, resp.status_code
            )
            return None
        try:
            data = resp.json()
        except Exception:
            logger.warning("runner: presign for %r returned non-JSON; using legacy upload", filename)
            return None
        return data if isinstance(data, dict) else None

    async def _upload_via_presign_direct(
        self, entry: PlatformEntry, presign: dict, content: bytes, filename: str
    ) -> None:
        """PUT raw bytes to the one-time-token URL from a `"direct"` presign
        response. The token in the URL is the sole auth -- no signed
        headers. Retried once (same shape as the legacy path's retry), since
        a token is single-use: a genuine transport failure on attempt one
        (never reached the platform) is safe to retry, but the token itself
        does NOT get re-issued here -- a caller that failed after the
        platform actually received and rejected the bytes must re-presign
        from scratch (a fresh token), which is why a non-2xx answer raises
        immediately rather than retrying against the same, now possibly
        consumed, token.
        """
        url = presign.get("url")
        if not isinstance(url, str) or not url:
            raise RuntimeError("artifact upload failed: presign response missing url")

        for attempt in range(2):
            try:
                async with httpx.AsyncClient(base_url=entry.platform_url) as client:
                    resp = await client.put(url, content=content)
            except Exception:
                logger.exception(
                    "runner: presigned direct upload for %r raised (attempt=%d)", filename, attempt + 1
                )
                continue

            if resp.status_code == 200:
                return
            # The platform answered -- the token is one-time, so retrying the
            # SAME url would just 409. Only a transport-level failure
            # (caught above) is worth a second attempt.
            logger.warning(
                "runner: presigned direct upload for %r not confirmed (status=%s)", filename, resp.status_code
            )
            raise RuntimeError("artifact upload failed")

        raise PlatformUnavailable(f"artifact upload for {filename!r} could not reach the platform")

    async def _upload_via_presign_s3(
        self,
        entry: PlatformEntry,
        job_id: str,
        presign: dict,
        content: bytes,
        filename: str,
        local_sha256: str,
    ) -> None:
        """PUT raw bytes straight to the presigned S3 (R2) URL, then tell the
        platform via a signed confirm call. The PUT itself carries no
        platform auth at all (the URL's own signature is the auth, verified
        by R2 -- not by ComfyFed), so a failure there is always a transport
        problem worth retrying; the confirm call is what actually finishes
        the hand-off and is retried like every other signed platform call.
        """
        url = presign.get("url")
        if not isinstance(url, str) or not url:
            raise RuntimeError("artifact upload failed: presign response missing url")

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.put(url, content=content)
        except Exception as exc:
            raise PlatformUnavailable(f"artifact upload for {filename!r} could not reach storage") from exc
        if resp.status_code not in (200, 201, 204):
            raise RuntimeError(f"artifact upload failed: storage PUT returned {resp.status_code}")

        confirm_path = f"/api/agent/jobs/{job_id}/artifacts/confirm"
        confirm_body = json.dumps({"filename": filename, "sha256": local_sha256}).encode()
        try:
            async with httpx.AsyncClient(base_url=entry.platform_url) as client:
                headers = signing.signed_headers(entry, "POST", confirm_path, confirm_body)
                headers["Content-Type"] = "application/json"
                resp = await client.post(confirm_path, content=confirm_body, headers=headers)
        except Exception as exc:
            raise PlatformUnavailable(f"artifact confirm for {filename!r} could not reach the platform") from exc

        if resp.status_code == 200:
            return
        raise RuntimeError(f"artifact confirm failed: platform returned {resp.status_code}")

    async def _upload_artifact_legacy(
        self, entry: PlatformEntry, job_id: str, filename: str, content: bytes, local_sha256: str
    ) -> None:
        """The original (pre-Phase-2) multipart upload, kept byte-for-byte
        for platforms that don't understand the presign protocol -- see
        `_upload_artifact`'s docstring for the fallback contract.
        """
        path = f"/api/agent/jobs/{job_id}/artifacts"
        answered = False

        for attempt in range(2):
            try:
                async with httpx.AsyncClient(base_url=entry.platform_url) as client:
                    request = client.build_request("POST", path, files={"file": (filename, content)})
                    body = request.read()
                    headers = signing.signed_headers(entry, "POST", path, body)
                    headers["X-Artifact-SHA256"] = local_sha256
                    request.headers.update(headers)
                    resp = await client.send(request)

                answered = True
                if resp.status_code == 200 and resp.json().get("sha256") == local_sha256:
                    return

                logger.warning(
                    "runner: artifact upload for %r not confirmed (status=%s, attempt=%d)",
                    filename, resp.status_code, attempt + 1,
                )
            except Exception:
                logger.exception("runner: artifact upload for %r raised (attempt=%d)", filename, attempt + 1)

        if not answered:
            raise PlatformUnavailable(f"artifact upload for {filename!r} could not reach the platform")
        raise RuntimeError("artifact upload failed")

    def _spawn_job(self, conn: PlatformConnection, message: dict) -> asyncio.Task:
        """Start `handle_job` as a background task and register its handle.

        The task, not an inline `await`, is the whole point: a render takes
        minutes, and while it runs this connection must keep reading its
        socket -- for `job_cancelled` above all, but also receipts and
        `want_object_info`. The single-job invariant is unaffected: the
        `job_lock` inside `handle_job` still serialises actual execution, a
        second job simply waits there instead of stalling the socket.
        """
        job_id = message["job_id"]
        # Registered BEFORE the task starts, so a `job_cancelled` arriving in
        # the same batch of messages can already find (and trip) the handle.
        handle = _JobHandle(job_id=job_id, conn=conn)
        self._jobs[job_id] = handle

        task = asyncio.create_task(self.handle_job(conn, message), name=f"comfyfed-job-{job_id}")
        handle.task = task
        self._job_tasks.add(task)
        self._current_job_task = task
        self._current_job_id = job_id
        task.add_done_callback(self._on_job_task_done)
        return task

    def _on_job_task_done(self, task: asyncio.Task) -> None:
        """Reap a finished job task, surfacing anything it swallowed.

        `handle_job` handles its own errors, so an exception reaching here is
        a bug in the wind-down path itself -- exactly the kind that vanishes
        silently when nobody ever retrieves a task's result.
        """
        self._job_tasks.discard(task)
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            logger.error("runner: job task %s raised", task.get_name(), exc_info=exc)

    def _job_id_for(self, conn: PlatformConnection) -> Optional[str]:
        """The id of the job `conn`'s own platform dispatched, if one is
        running -- and never another platform's.

        This is what the periodic heartbeat carries, and it is the entire
        basis of the spec's "a zombied worker learns within one heartbeat":
        a heartbeat with no job_id tells the server nothing to check
        ownership against, so a worker re-assigned away mid-run would only
        find out when its `job_done` is finally rejected -- after the render
        it was told to abandon. Naming a job on the WRONG platform's
        heartbeat is worse than naming none: that platform never issued the
        id, would read it as not-owned, and would push a `job_cancelled`
        that aborts a healthy run.

        Two deliberate choices, both about what happens when a second
        platform dispatches while the first platform's job is running:

        - The answer is derived from `handle.running`, not from
          `_current_job_id`. That pointer means "most recently spawned",
          and a second platform's job is spawned the moment it arrives even
          though `job_lock` parks it until the first finishes -- so keying
          on it would blank out the RUNNING job's id on its own platform's
          heartbeats for the rest of its run, which is precisely the gap
          this whole mechanism exists to close.
        - The waiting platform's heartbeat carries no job_id (its `state`
          still goes busy, as the job broadcast already made it). Naming a
          job that has not started would have the server flip it to
          `running` and stamp `started_at`, starting its wall clock -- and
          the billing bound derived from it -- while it is still queued
          behind another platform's work.
        """
        for handle in self._jobs.values():
            if handle.running and handle.conn is conn:
                return handle.job_id
        return None

    def _fetch_status_for(self, conn: PlatformConnection) -> Optional[dict]:
        """The running job's live fetch-phase status for `conn`'s platform,
        or None. The periodic heartbeat must carry it for the same reason
        the initial busy beat does (see `_JobHandle.fetch_status`): a bare
        busy heartbeat slipping out mid-download would make the server
        start the billing clock during the never-billed fetch phase."""
        for handle in self._jobs.values():
            if handle.running and handle.conn is conn:
                return handle.fetch_status
        return None

    async def _handle_job_cancelled(self, conn: PlatformConnection, message: dict) -> None:
        """Platform says this job is no longer ours: stop ComfyUI and wind down.

        Two independent halves, both needed. The cancel event unblocks *us*
        (`comfy.run_workflow` raises `JobCancelled` on its next poll, so
        `handle_job` skips the completion messages and cleans up), while
        `interrupt_or_dequeue` stops *ComfyUI* -- otherwise the GPU keeps
        grinding out a result nobody asked for any more.
        """
        job_id = message.get("job_id")
        handle = self._jobs.get(job_id) if job_id else None
        if handle is None or (handle.conn is not None and handle.conn is not conn):
            # Routine, not alarming: the server pushes job_cancelled whenever
            # this agent references a job it no longer owns, which includes
            # jobs this process already finished or never ran. A job id that
            # belongs to a DIFFERENT platform's run is ignored for the same
            # reason it is never advertised there -- only the platform that
            # dispatched a job may cancel it.
            logger.debug("runner: job_cancelled for job %r we are not running, ignoring", job_id)
            return

        logger.info("runner: platform cancelled job %s", job_id)
        handle.cancel_event.set()
        # Stopping ComfyUI is fired as its own task, never awaited here:
        # this runs inside the receive loop, and `interrupt_or_dequeue`
        # makes two HTTP calls that a hung ComfyUI can stall for their full
        # timeout -- during which this connection would read no message and
        # send no heartbeat, and could trip the server's 90s stale requeue
        # from inside the handler whose purpose is preventing exactly that.
        self._spawn_stop_comfy_prompt(handle)

    def _spawn_stop_comfy_prompt(self, handle: _JobHandle) -> asyncio.Task:
        """Run `_stop_comfy_prompt` off the caller's own coroutine, tracked
        so `shutdown` can reap it and a failure inside it is never silent."""
        task = asyncio.create_task(
            self._stop_comfy_prompt(handle), name=f"comfyfed-stop-{handle.job_id}"
        )
        self._stop_tasks.add(task)

        def _done(t: asyncio.Task) -> None:
            self._stop_tasks.discard(t)
            if not t.cancelled() and t.exception() is not None:
                logger.error("runner: %s raised", t.get_name(), exc_info=t.exception())

        task.add_done_callback(_done)
        return task

    async def _stop_comfy_prompt(self, handle: _JobHandle) -> None:
        """Tell ComfyUI to stop this job's prompt, at most once per prompt.

        Called from two places on purpose. The receive loop calls it the
        instant a cancel arrives -- but the cancel can arrive while the
        `/prompt` POST is still in flight, when there is no prompt id to
        stop yet. `handle_job`'s wind-down therefore calls it again once the
        run has actually unwound, by which point `on_prompt_id` has reported
        whatever ComfyUI accepted. Without that second look the agent would
        go idle while ComfyUI kept rendering a prompt nobody will collect.

        `interrupted_prompt_id` makes the pair idempotent. It is checked and
        set with no `await` between the two, so the two callers cannot both
        get through on the same prompt.
        """
        prompt_id = handle.prompt_id
        if prompt_id is None:
            # Nothing has been submitted (yet): the cancel event alone ends
            # the job, and the wind-down will look again.
            logger.debug("runner: job %s has no ComfyUI prompt to stop (yet)", handle.job_id)
            return
        if handle.interrupted_prompt_id == prompt_id:
            return
        handle.interrupted_prompt_id = prompt_id

        try:
            outcome = await asyncio.to_thread(
                comfy.interrupt_or_dequeue, self.config.comfy_url, prompt_id
            )
            logger.info("runner: job %s prompt %s -> %s", handle.job_id, prompt_id, outcome)
        except Exception:
            # The cancel event still stops us waiting on it, so a failure
            # here degrades to "ComfyUI finishes a run nobody collects".
            logger.exception(
                "runner: failed to stop ComfyUI prompt %s for job %s", prompt_id, handle.job_id
            )

    async def shutdown(self, timeout: float = 30.0) -> None:
        """Wind down every in-flight job task and wait for it.

        Called from `run`'s `finally` so the event loop never closes over
        pending work ("Task was destroyed but it is pending!"). Cooperative
        first -- tripping the cancel events lets `comfy.run_workflow` return
        out of its polling loop and `handle_job`'s `finally` run cleanup --
        because a hard `task.cancel()` only cancels the *await*, leaving the
        `asyncio.to_thread` worker thread grinding on until the process
        joins it. Anything still alive after `timeout` is then cancelled
        outright.
        """
        handles = list(self._jobs.values())
        for handle in handles:
            if handle.reporting:
                # The run is over; only the hand-off is left. Tripping its
                # cancel event would make a delivered-or-preserved result
                # look like a platform cancellation and delete its files.
                logger.warning(
                    "runner: job %s finished but its completion never reached the platform",
                    handle.job_id,
                )
                continue
            handle.cancel_event.set()
        # Stopping ourselves is not enough: an agent that exits while ComfyUI
        # renders on would come back, advertise idle, and get dispatched work
        # that then queues behind the ghost prompt of the job it abandoned.
        for handle in handles:
            if not handle.reporting:
                await self._stop_comfy_prompt(handle)

        tasks = list(self._job_tasks) + list(self._stop_tasks)
        if tasks:
            _done, pending = await asyncio.wait(tasks, timeout=timeout)
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
        self._job_tasks.clear()
        self._stop_tasks.clear()
        self._jobs.clear()

        # 續租任務一定要先收乾淨再解除映射：一個正在飛的續租會在路由器上
        # 重新開好一筆轉埠，而它指向的服務下一秒就關了。
        if self._peer_renew_task is not None:
            self._peer_renew_task.cancel()
            try:
                await self._peer_renew_task
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.debug("runner: peer renewal task ended with an error", exc_info=True)
            self._peer_renew_task = None

        if self._peer_mapping is not None:
            # spec §3.1 第 6 點：agent 結束時把映射收掉（NAT-PMP lifetime 0 /
            # UPnP DeletePortMapping），別在路由器上留一筆指向已關閉服務的
            # 轉埠。盡力而為 —— natmap.unmap_port 自己吞例外，而且是阻塞的，
            # 所以照樣走 to_thread。
            try:
                await asyncio.to_thread(natmap.unmap_port, self._peer_mapping)
            except Exception:
                logger.debug("runner: releasing the port mapping failed (ignored)", exc_info=True)
            self._peer_mapping = None

        if self._peer_server is not None:
            try:
                self._peer_server.stop()
            except Exception:
                logger.exception("runner: failed to stop peer HTTP server cleanly")
            self._peer_server = None
            self._peer_advertised_url = None
            self._peer_upload_limit_applied = None

    def _start_peer_server(self) -> None:
        """Start the peer HTTP server when `peer_serve`/`peer_listen_port`
        are configured, so `_run_platform` has an advertisable `peer_url`
        for every connection's `hello`. Best-effort: a bind failure (port in
        use, no permission) disables peer serving for this run rather than
        crashing agent startup -- the agent still works fine as a puller-only
        or non-P2P worker.
        """
        if not peerserve.is_enabled(self.config):
            return
        if not self.config.models_dir:
            logger.warning(
                "runner: peer_serve is enabled but models_dir is not configured; "
                "skipping the peer HTTP server for this run"
            )
            return
        try:
            self._peer_server = peerserve.PeerHTTPServer(
                models_dir=self.config.models_dir,
                port=self.config.peer_listen_port,
                platforms=list(self.config.platforms),
                bind_host=self.config.peer_bind_host,
            )
            self._peer_server.start()
            self._peer_advertised_url = peerserve.advertised_url(self.config)
            logger.info(
                "runner: peer HTTP server listening on port %s, advertising %s",
                self.config.peer_listen_port, self._peer_advertised_url,
            )
        except Exception:
            logger.exception("runner: failed to start the peer HTTP server; P2P serving disabled for this run")
            self._peer_server = None
            self._peer_advertised_url = None
            return

        # 套上限的動作放在 try/except 之外：listener 已經 bind 成功了，這裡若
        # 拋例外被上面的 except 接走，會把 `_peer_server` 清成 None，留下一個
        # 沒人關得掉的 listener（port 佔住、shutdown 不會 stop()）。
        # Applying the tier lives OUTSIDE the try: the listener is already
        # bound and serving by now, so a raise here must not be caught by the
        # start handler that nulls `_peer_server` -- that would orphan a live
        # listener (port stays bound, `shutdown()` never stops it) while the
        # log claims P2P is disabled.
        #
        # 開機第一秒就要有上限，不能等到第一次 control tick 才套。
        # Apply a tier immediately so the first seconds are not
        # unlimited-by-omission before the first control tick.
        if self._peer_server is not None:
            self._apply_peer_upload_limit(control.availability(self.config, self._config_dir))

    async def _setup_port_mapping(self) -> None:
        """在 peer server 起來之後、連平台之前，決定 `peer_url` 要通告什麼
        （spec §3.1／§3.2）。順序：

        1. peer 服務沒開 → 什麼都不做（`peer_nat = "none"`）。
        2. 設了 `peer_advertise_host` → 直接用它，**不做映射**（使用者已經
           講明對外位址了），`peer_nat = "manual"`。
        3. `peer_nat_traversal == "off"` → 不做映射，用區網位址，`"lan"`。
        4. 否則跑 natmap（8 秒上限，整段在 `asyncio.to_thread` 裡跑，永不擋
           事件迴圈）。成功且外部 IP 可用 → `http://<外部IP>:<外部埠>`；成功
           但外部 IP 不可用（雙層 NAT）→ 先用區網位址，等 `ready.remote_ip`
           到了再由 `_apply_remote_ip` 換掉。失敗 → 區網位址 + 一行 WARNING。
        """
        if not peerserve.is_enabled(self.config):
            self._peer_nat = "none"
            return

        self._peer_lan_url = peerserve.lan_url(self.config)

        if self.config.peer_advertise_host:
            self._peer_advertised_url = peerserve.advertised_url(self.config)
            self._peer_nat = "manual"
            return

        if self.config.peer_nat_traversal == "off":
            self._peer_advertised_url = self._peer_lan_url
            self._peer_nat = "lan"
            return

        # BLOCKING（UDP/HTTP 到路由器）。natmap 自己吞掉所有例外並回 None，
        # 但 to_thread 的邊界還是包一層，免得任何意外把啟動流程拖垮。
        try:
            mapping = await asyncio.to_thread(
                natmap.map_port, port=self.config.peer_listen_port
            )
        except Exception:
            logger.exception(
                "runner: automatic port mapping raised; falling back to the LAN address"
            )
            mapping = None

        if mapping is None:
            self._peer_mapping = None
            self._peer_advertised_url = self._peer_lan_url
            self._peer_nat = "lan"
            logger.warning(_PEER_NO_MAPPING_WARNING)
            return

        self._peer_mapping = mapping
        self._peer_nat = mapping.method
        host = mapping.external_ip or self._peer_remote_ip
        if host:
            self._peer_advertised_url = peerserve.peer_url_for(host, mapping.external_port)
        else:
            # 雙層 NAT 或路由器沒回報外部 IP：先用區網位址連上去，拿到
            # `ready.remote_ip` 再換（spec §3.1 第 5 點）。
            self._peer_advertised_url = self._peer_lan_url
        logger.info(
            "runner: port mapping via %s -> external %s:%s, advertising %s",
            mapping.method,
            mapping.external_ip or "(unknown, awaiting ready.remote_ip)",
            mapping.external_port,
            self._peer_advertised_url,
        )

    def _apply_remote_ip(self, remote_ip: Optional[str]) -> bool:
        """吃下 `ready.remote_ip`（spec §3.1 第 5 點／§8）。回傳「是否應該
        為了送出更新後的 hello 而重連一次」。

        只在「有映射、而且映射本身沒給出可用的外部 IP」時才有意義：手動
        指定（`manual`）尊重使用者、純區網（`lan`）沒有對外位址可言 ——
        兩者都直接回 False。重連在滾動一小時內最多 1 次。
        """
        if not remote_ip or natmap.is_private_address(remote_ip):
            return False
        if self._peer_mapping is None or self._peer_nat in ("manual", "lan", "none"):
            return False
        if self._peer_mapping.external_ip:
            # 路由器自己就報得出可用的外部 IP，以它為準。
            return False

        previous_ip = self._peer_remote_ip
        self._peer_remote_ip = remote_ip
        new_url = peerserve.peer_url_for(remote_ip, self._peer_mapping.external_port)
        if new_url == self._peer_advertised_url:
            return False
        self._peer_advertised_url = new_url

        now = time.monotonic()
        self._peer_reconnects_at = [
            t for t in self._peer_reconnects_at if now - t < _PEER_RECONNECT_WINDOW_SECONDS
        ]
        if self._peer_reconnects_at:
            # 已經在這一小時內重連過；位址記下來，下次自然重連時就會帶出去。
            logger.info(
                "runner: public address changed (%s -> %s) but an automatic "
                "reconnect already happened this hour; the new address goes "
                "out on the next reconnect",
                previous_ip, remote_ip,
            )
            return False
        self._peer_reconnects_at.append(now)
        return True

    async def _peer_renew_loop(self) -> None:
        """每 `natmap.RENEW_SECONDS` 重新請求同一筆映射（spec §3.1 第 6 點）。
        外部 IP 變了就走跟 `_apply_remote_ip` 同一條路（更新通告位址，下次
        重連自然帶出去）—— 絕不無聲地換掉 URL 卻讓平台手上的 hello 過期。
        失敗只記 log：既有的 lease 還有 `natmap.LEASE_SECONDS` 秒，下一輪再試。
        """
        while True:
            await asyncio.sleep(natmap.RENEW_SECONDS)
            if self._peer_mapping is None:
                continue
            try:
                mapping = await asyncio.to_thread(
                    natmap.map_port, port=self.config.peer_listen_port
                )
            except Exception:
                logger.exception("runner: peer port-mapping renewal raised")
                continue
            if mapping is None:
                logger.warning(
                    "runner: peer port-mapping renewal failed; keeping the current lease"
                )
                continue
            self._peer_mapping = mapping
            self._peer_nat = mapping.method
            host = mapping.external_ip or self._peer_remote_ip
            if not host:
                continue
            new_url = peerserve.peer_url_for(host, mapping.external_port)
            if new_url == self._peer_advertised_url:
                continue
            logger.info("runner: renewed mapping changed the peer URL to %s", new_url)
            self._peer_advertised_url = new_url
            # 位址真的變了 ⇒ 平台手上的 hello 已經過期。走跟 ready.remote_ip
            # 完全一樣的重連路徑（同一個 1 次／小時的節流），而不是偷偷換掉
            # 本地的字串讓平台繼續拿舊位址做健康檢查。
            await self._request_peer_reconnect()

    async def _request_peer_reconnect(self) -> None:
        """把每一條平台連線踢掉一次，讓 `_run_platform` 的重試迴圈帶著新的
        `peer_url` 重新 handshake + hello。受同一個「滾動一小時最多一次」的
        節流約束（spec §8）。"""
        now = time.monotonic()
        self._peer_reconnects_at = [
            t for t in self._peer_reconnects_at if now - t < _PEER_RECONNECT_WINDOW_SECONDS
        ]
        if self._peer_reconnects_at:
            logger.info(
                "runner: the peer URL changed but an automatic reconnect already "
                "happened this hour; the new address goes out on the next reconnect"
            )
            return
        self._peer_reconnects_at.append(now)
        for conn in self.connections.values():
            # `conn.close()` 自己吞掉關閉時的例外；`_run_platform` 的
            # ConnectionClosed 處理會照既有的 backoff 重連並重送 hello。
            await conn.close()

    def _install_signal_handlers(self, loop: asyncio.AbstractEventLoop) -> None:
        """Install SIGINT/SIGTERM (and SIGBREAK on Windows) handlers.

        Windows' asyncio does not support `loop.add_signal_handler` (POSIX
        only), and a `signal.signal` handler always runs on the main thread
        outside the event loop's own control flow -- so it must not touch
        asyncio state directly. It only schedules `_on_os_signal` back onto
        the loop via `call_soon_threadsafe`, which is the one thread-safe way
        to hand control back to a coroutine world from a signal handler.

        Ctrl-C in a real console (and CTRL_BREAK on Windows) previously had
        no handler at all here, so the interpreter's default action killed
        the process instantly (exit 0xC000013A) with no chance to run
        `shutdown()` -- the dispatched ComfyUI prompt kept rendering as a
        ghost with nobody left to report or cancel it. See T3m9.
        """

        def _handler(signum, _frame) -> None:
            loop.call_soon_threadsafe(self._on_os_signal, signum, loop)

        sig_names = ["SIGINT", "SIGTERM"]
        if hasattr(signal, "SIGBREAK"):  # Windows only (Ctrl-Break / console close)
            sig_names.append("SIGBREAK")

        for name in sig_names:
            sig = getattr(signal, name)
            try:
                signal.signal(sig, _handler)
            except (ValueError, OSError):
                # ValueError: not the main thread (e.g. under some test
                # runners). OSError: platform refuses this signal. Either
                # way, logging and moving on beats crashing agent startup
                # over best-effort shutdown handling.
                logger.debug("runner: could not install a handler for %s", name)

    def _on_os_signal(self, signum: int, loop: asyncio.AbstractEventLoop) -> None:
        """Runs on the event loop (via `call_soon_threadsafe`) the instant a
        console signal is delivered.

        Idempotent: the first signal starts the graceful wind-down; any
        signal after that (an operator hitting Ctrl-C twice, or one arriving
        while cleanup is already stuck) skips straight to `os._exit` --
        there is nothing more cooperative left to try.
        """
        if self._shutdown_in_progress:
            logger.warning(
                "再次收到中止訊號，強制立即結束 / received a second interrupt signal (%s), "
                "forcing immediate exit",
                signum,
            )
            os._exit(1)
            return

        self._shutdown_in_progress = True
        logger.info(
            "收到中止訊號，正在停止 ComfyUI 工作並清理… / received signal %s, "
            "stopping the ComfyUI job and cleaning up",
            signum,
        )
        loop.create_task(
            self._graceful_shutdown_and_stop(loop), name="comfyfed-signal-shutdown"
        )

    async def _graceful_shutdown_and_stop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Run the full graceful wind-down (`shutdown`) under a hard cap, then
        stop the event loop so the process actually exits.

        `shutdown()` already does the real work reused from server-driven
        cancellation: trip every running job's `cancel_event`, call
        `_stop_comfy_prompt` (which does `comfy.interrupt_or_dequeue` against
        ComfyUI), and run `cleanup_job_files` with `CleanupMode.CANCELLED` --
        never a completion or failure report, because the server's stale-job
        timeout is the designed recovery for a job this process is
        abandoning. This wrapper only adds the timeout and the actual
        process exit.
        """
        try:
            await asyncio.wait_for(self.shutdown(), timeout=_SIGNAL_SHUTDOWN_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            logger.warning(
                "清理逾時，強制結束程序 / graceful shutdown timed out after %.0fs, forcing exit",
                _SIGNAL_SHUTDOWN_TIMEOUT_SECONDS,
            )
            os._exit(1)
            return
        except Exception:
            logger.exception("runner: graceful shutdown raised unexpectedly, forcing exit")
            os._exit(1)
            return

        # `loop.stop()` below never resumes `run()`, so its `finally` -- and
        # the state cleanup in it -- would otherwise never run on either the
        # signal or the `comfyfed stop` path, leaving `status` insisting the
        # agent is alive for the next 120 s.
        await self._stop_control_loop()
        loop.stop()

    @property
    def shutdown_in_progress(self) -> bool:
        """True from the first console signal onward.

        Public so the CLI entry point (`main._cmd_run`) can tell a clean,
        signal-initiated `loop.stop()` apart from any other `RuntimeError`
        `asyncio.run` might raise -- see `_graceful_shutdown_and_stop`.
        """
        return self._shutdown_in_progress

    async def _handle_message(self, conn: PlatformConnection, message: dict) -> None:
        msg_type = message.get("type")
        if msg_type == "job":
            self._spawn_job(conn, message)
        elif msg_type == "job_cancelled":
            await self._handle_job_cancelled(conn, message)
        elif msg_type == "receipt":
            worker_sig = conn.sign_receipt_payload(message["payload"])
            await conn.send_receipt_ack(message["receipt_id"], worker_sig)
        elif msg_type == "want_object_info":
            await self.refresh_object_info(conn, force=True)
        elif msg_type == "peer_status":
            self._handle_peer_status(message)
        else:
            logger.warning("runner: unknown message type %r from platform", msg_type)

    def _handle_peer_status(self, message: dict) -> None:
        """平台推來的可連性結論（spec §4.3）。只存記憶體供 `comfyfed status`
        顯示；`reachable=false` 且不是使用者手動指定位址時，記一行 WARNING
        （與映射失敗同一段文字 —— 對操作者來說要做的事一模一樣）。

        只在**結論改變**時才吼：平台會週期性複查，否則一台真的沒開埠的機器
        會被同一段文字洗版。"""
        reachable = message.get("reachable")
        if not isinstance(reachable, bool):
            return
        changed = reachable != self._peer_reachable
        self._peer_reachable = reachable
        checked_url = message.get("checked_url")
        if isinstance(checked_url, str):
            self._peer_checked_url = checked_url
        if not reachable and self._peer_nat != "manual" and changed:
            logger.warning(_PEER_NO_MAPPING_WARNING)

    async def _connection_loop(self, conn: PlatformConnection) -> None:
        last_heartbeat = time.monotonic()
        last_object_info = time.monotonic()
        while True:
            try:
                message = await asyncio.wait_for(conn.recv(), timeout=_RECV_POLL_TIMEOUT_SECONDS)
            except asyncio.TimeoutError:
                message = None

            if message is not None:
                await self._handle_message(conn, message)

            now = time.monotonic()
            if now - last_heartbeat >= _HEARTBEAT_INTERVAL_SECONDS:
                dynamic = hardware.collect_dynamic(self.config.models_dir)
                fetch_status = self._fetch_status_for(conn) or {}
                job_id = self._job_id_for(conn)
                effective_state = self._effective_state(conn.state)
                await conn.send_heartbeat(
                    effective_state,
                    # Carrying the job id is what lets the server notice a
                    # worker still grinding on a job it no longer owns; see
                    # `_job_id_for` for why it is scoped to this connection.
                    job_id=job_id,
                    dynamic=dynamic,
                    object_info_hash=conn.object_info_hash or None,
                    # While the auto-fetch pre-phase is active, the periodic
                    # beat carries the stage too -- a stage-less busy beat
                    # is the server's run-started signal (started_at).
                    stage=fetch_status.get("stage"),
                    fetch_pct=fetch_status.get("fetch_pct"),
                    fetch_model=fetch_status.get("fetch_model"),
                )
                last_heartbeat = now

            if now - last_object_info >= _OBJECT_INFO_INTERVAL_SECONDS:
                await self.refresh_object_info(conn)
                await self.refresh_model_inventory(conn)
                last_object_info = now

    async def _wait_for_comfy(self, conn: PlatformConnection) -> None:
        """Block this connection until ComfyUI answers -- quietly.

        Live incident 2026-09-16 (POKAI-HOME): after a reboot the agent
        autostarted from its scheduled task while ComfyUI Desktop, which a
        human launches, did not. `_run_platform` connected and handshaked
        anyway, then hit ComfyUI for `/object_info` -> `httpx.ConnectError`
        -> a 40-line traceback every 5-60 s (agent.log reached 18k lines),
        and the worker never appeared online.

        Connecting to the platform before ComfyUI is up buys nothing: the
        worker cannot render. So the probe happens FIRST, on every reconnect
        iteration (ComfyUI can also die later), and the connect is simply
        deferred -- one WARNING when the wait starts, a repeat only every
        `_COMFY_WAIT_RELOG_SECONDS`, one INFO when it clears.

        Nothing here blocks the event loop: the probe is a blocking HTTP call
        and goes to a thread exactly like `collect_hardware` below, and the
        wait is per-connection, so another platform's coroutine is untouched.
        """

        def _probe() -> bool:
            with httpx.Client() as client:
                return detect.probe_comfy(self.config.comfy_url, client)

        if await asyncio.to_thread(_probe):
            return

        def _warn() -> None:
            logger.warning(
                "ComfyUI（%s）尚未啟動，agent 會每 %s 秒重試，啟動後自動上線。 / "
                "ComfyUI at %s is not running; retrying every %s s and going "
                "online once it is up.",
                self.config.comfy_url, _COMFY_WAIT_POLL_SECONDS,
                self.config.comfy_url, _COMFY_WAIT_POLL_SECONDS,
            )

        # Publishing the wait is what makes `comfyfed status` (and the state
        # file behind it) say WHY the worker is unavailable instead of an
        # unexplained `paused`. Removed in `finally` so a crash in the loop
        # cannot leave the agent permanently "waiting".
        self._comfy_waiting.add(conn.entry.worker_id)
        try:
            _warn()
            last_log = time.monotonic()
            while True:
                await asyncio.sleep(_COMFY_WAIT_POLL_SECONDS)
                if await asyncio.to_thread(_probe):
                    break
                now = time.monotonic()
                if now - last_log >= _COMFY_WAIT_RELOG_SECONDS:
                    _warn()
                    last_log = now
        finally:
            self._comfy_waiting.discard(conn.entry.worker_id)
        logger.info(
            "ComfyUI 已可連線，開始連接平台。 / "
            "ComfyUI reachable; connecting to the platform.",
        )

    async def _run_platform(self, conn: PlatformConnection) -> None:
        backoff = _BACKOFF_START_SECONDS
        while True:
            try:
                # BEFORE the socket: a worker with no ComfyUI behind it has
                # nothing to offer the platform, and connecting anyway is
                # what produced the endless post-handshake traceback loop.
                # Per ITERATION, not once: ComfyUI can also go away later.
                await self._wait_for_comfy(conn)
                await conn.connect()
                ready = await conn.handshake()
                # Past the handshake: this entry's credentials are accepted,
                # so it is not a dead 4401 registration. Clears the "all
                # rejected" verdict for the whole process AND this entry's
                # consecutive-rejection counter -- a 4401 that a successful
                # handshake follows was, by definition, not permanent.
                self._connected_ever = True
                conn.auth_rejections = 0
                conn.disabled_logged = False

                # spec §3.1 第 5 點：平台回報的公網 IP 若讓通告位址變了，就
                # 重連一次把新的 hello 送出去（滾動一小時最多 1 次）。記在
                # 上面那三行之後 —— 這次 handshake 本身是成功的。
                if self._apply_remote_ip(ready.get("remote_ip")):
                    logger.info(
                        "runner: public address resolved to %s; reconnecting once to "
                        "advertise %s",
                        self._peer_remote_ip, self._peer_advertised_url,
                    )
                    # 每一條連線都得重送 hello，不只這一條：其他平台手上那份
                    # 還寫著舊位址，它們的可連性檢查會打到一個沒人在聽的地方。
                    for other in self.connections.values():
                        if other is not conn:
                            await other.close()
                    await conn.close()
                    continue

                # BLOCKING (an HTTP call to ComfyUI), so it goes to a thread
                # exactly like `whitelist.allowed_classes` below. On the event
                # loop it stalls EVERY other platform's coroutine, and a
                # platform whose challenge is left unanswered for 10 s closes
                # the handshake -- which is how a healthy registration used to
                # collect a spurious rejection while another platform was
                # merely slow to answer.
                hw = await asyncio.to_thread(hardware.collect_hardware, self.config.comfy_url)
                backend, torch_version = hardware.detect_backend()
                # Blocking (HTTP to ComfyUI) -- see handle_job.
                allowed = await asyncio.to_thread(
                    whitelist.allowed_classes,
                    self.config.node_policy,
                    self.config.comfy_url,
                    self.config.whitelist_extra,
                )
                await conn.send_hello(
                    hw,
                    backend,
                    torch_version,
                    allowed,
                    peer_url=self._peer_advertised_url,
                    peer_lan_url=self._peer_lan_url,
                    peer_nat=self._peer_nat,
                )

                # One immediate beat carrying the real availability. Both
                # platforms record a freshly handshaked agent as `idle` and
                # will dispatch to it at once, while the first periodic beat
                # -- the only thing that can say `paused` -- is a full
                # heartbeat interval away. Without this, every connect and
                # every reconnect (Wi-Fi blip, platform deploy) reopens a
                # 30 s window in which a render can start on the machine a
                # human is actively using. It goes through `_effective_state`
                # like every other availability-bearing beat, so a busy
                # reconnect is still reported busy.
                await conn.send_heartbeat(
                    self._effective_state(conn.state),
                    job_id=self._job_id_for(conn),
                    dynamic=hardware.collect_dynamic(self.config.models_dir),
                    object_info_hash=conn.object_info_hash or None,
                )

                # Also BLOCKING, and far worse: with `hash_models` on and a
                # real model directory this is minutes of sha256 on the event
                # loop. Same `to_thread` treatment, same reason.
                models = (
                    await asyncio.to_thread(
                        hardware.scan_models,
                        self.config.models_dir,
                        hash_models=self.config.hash_models,
                    )
                    if self.config.models_dir
                    else []
                )
                # M7 final-review fix: a fresh connection (including a
                # reconnect) always sends every currently-hashed file's
                # chunk_sha256s at least once -- `chunks_sent` resets here so
                # "first report after connect" is exactly the hello-time
                # inventory send, matching the spec's wording literally.
                conn.chunks_sent = {}
                outgoing, chunk_updates = _dedup_chunk_lists(models, conn.chunks_sent)
                await conn.send_inventory(outgoing)
                conn.model_inventory_hash = _model_inventory_digest(models)
                conn.chunks_sent.update(chunk_updates)

                await self.refresh_object_info(conn)

                backoff = _BACKOFF_START_SECONDS
                await self._connection_loop(conn)
            except Exception as exc:
                if _is_disabled(exc):
                    # 4403: an admin disabled this worker. REVERSIBLE, so this
                    # is NOT a give-up and emphatically NOT a prune -- the
                    # registration has to still be here when the admin
                    # re-enables the worker. Logged once per disabled spell so
                    # the operator sees why nothing is happening, then handled
                    # by the ordinary backoff loop (capped at
                    # `_BACKOFF_MAX_SECONDS`, i.e. a slow, quiet retry).
                    conn.auth_rejections = 0
                    if not getattr(conn, "disabled_logged", False):
                        conn.disabled_logged = True
                        logger.error(
                            "此 worker（%s）已被平台 %s 的管理員停用，將持續以慢速重試；"
                            "管理員重新啟用後會自動恢復。 / "
                            "Worker %s has been disabled by the platform admin at %s; "
                            "will keep retrying slowly and reconnect automatically once "
                            "it is re-enabled.",
                            conn.entry.worker_id, conn.entry.platform_url,
                            conn.entry.worker_id, conn.entry.platform_url,
                        )
                elif _is_auth_rejected(exc):
                    # `getattr`: every real `PlatformConnection` initialises
                    # this, but the attribute is read defensively so a
                    # duck-typed connection can never turn a rejection into
                    # an AttributeError raised *inside* this except block.
                    conn.auth_rejections = getattr(conn, "auth_rejections", 0) + 1
                    if conn.auth_rejections < _AUTH_REJECTIONS_BEFORE_GIVING_UP:
                        # ONE 4401 is not proof: a platform older than the
                        # 4401/4403/4408 split answers a handshake TIMEOUT
                        # with 4401 too, and a timeout is transient. Retry
                        # like any other drop and see whether it repeats.
                        logger.warning(
                            "平台 %s 以 4401 拒絕 worker %s；先重試一次以排除逾時等暫時狀況。 / "
                            "Platform %s rejected worker %s with 4401; retrying once more "
                            "before treating it as permanent (an older platform also sends "
                            "4401 on a transient handshake timeout).",
                            conn.entry.platform_url, conn.entry.worker_id,
                            conn.entry.platform_url, conn.entry.worker_id,
                        )
                    else:
                        # Repeated, consecutive 4401s: the worker really was
                        # removed server-side or its credentials are invalid,
                        # and every retry bounces the same way (the live
                        # incident: stacked dead entries spamming `received
                        # 4401` forever). Fail loud and actionable, then STOP
                        # retrying this entry by returning -- unlike every
                        # other disconnect.
                        self._auth_gave_up = True
                        logger.error(
                            "該 worker（%s）連續 %s 次被平台 %s 以 4401 拒絕（可能已被移除或憑證失效），"
                            "不再重試此註冊。請重新執行安裝指令以重新註冊。 / "
                            "Worker %s was rejected %s times in a row by platform %s "
                            "(removed or credentials invalid); giving up on this "
                            "registration after repeated rejections. Re-run the installer "
                            "to re-register.",
                            conn.entry.worker_id, conn.auth_rejections, conn.entry.platform_url,
                            conn.entry.worker_id, conn.auth_rejections, conn.entry.platform_url,
                        )
                        # ...and take the dead entry OUT of agent.json, so the
                        # next start doesn't re-attempt (and re-log) it
                        # forever. Only ever reached from THIS definitive
                        # per-entry give-up -- never from a transient drop
                        # (1006/1011/4408), never from 4403, and never from
                        # `run()`'s `AllRegistrationsRejected` aggregation.
                        await self._prune_dead_registration(conn.entry)
                        # `finally` below still runs `conn.close()` on the way out.
                        return
                else:
                    # Everything else -- 1006/1011, 4408 (handshake timeout),
                    # DNS, refused TCP -- is an ordinary transient retry, and
                    # resets the consecutive-rejection counter: "consecutive"
                    # means consecutive 4401s, with nothing else in between.
                    conn.auth_rejections = 0
                    if _comfy_connect_error(exc, self.config.comfy_url):
                        # ComfyUI died under a live connection (or never came
                        # up between the probe and this call). Expected,
                        # self-healing, and the traceback is pure noise -- the
                        # next iteration's `_wait_for_comfy` parks quietly.
                        logger.warning(
                            "連線 ComfyUI 失敗（%s），%ss 後重試 / "
                            "ComfyUI request failed (%s); retrying in %ss",
                            self.config.comfy_url, backoff,
                            self.config.comfy_url, backoff,
                        )
                    else:
                        logger.exception(
                            "runner: connection to %s dropped, retrying in %ss",
                            conn.entry.platform_url, backoff,
                        )
            finally:
                await conn.close()
                # A job task is NOT killed when its connection drops: a blip
                # is exactly the case the platform's re-adoption path exists
                # for (see dispatch.try_readopt), and killing the render
                # would throw away GPU-minutes the reconnect could still
                # deliver. Finished tasks have already reaped themselves via
                # `_on_job_task_done`; a survivor is logged, not orphaned --
                # `shutdown` still accounts for it at process exit.
                for handle in self._jobs.values():
                    if handle.conn is conn and handle.task is not None and not handle.task.done():
                        logger.warning(
                            "runner: job %s still running across the %s reconnect",
                            handle.job_id, conn.entry.platform_url,
                        )

            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, _BACKOFF_MAX_SECONDS)

    def _dead_registrations_path(self) -> str:
        """`agent.dead.json`, always beside the config this loop was given."""
        return os.path.join(self._config_dir, _DEAD_REGISTRATIONS_FILENAME)

    def _append_dead_registration(self, entry: PlatformEntry) -> None:
        """Append `entry` (plus when and why) to `agent.dead.json`.

        Written BEFORE the entry leaves `agent.json`, so a crash in between
        can only ever leave the registration recorded twice -- never lost.
        The file holds an Ed25519 signing key in the clear, exactly like the
        config, so it gets the same atomic write + best-effort 0600 treatment
        (`config.save`); chmod is a no-op on Windows and that is fine.
        """
        path = self._dead_registrations_path()
        records: list = []
        if os.path.exists(path):
            unreadable = False
            try:
                # utf-8-sig for the same reason config.load uses it: a
                # hand-edited file on Windows often carries a BOM.
                with open(path, "r", encoding="utf-8-sig") as f:
                    loaded = json.load(f)
                if isinstance(loaded, list):
                    records = loaded
                else:
                    unreadable = True
            except (OSError, ValueError):
                unreadable = True
            if unreadable:
                # M3 final-review fix: a corrupt/unreadable backup file is
                # RENAMED ASIDE, never overwritten. Whatever is in there is
                # the only copy of earlier registrations' Ed25519 signing
                # keys -- destroying it is exactly the loss this whole
                # feature exists to prevent -- while refusing the prune would
                # bring the 4401 spam back. Renaming is neither.
                corrupt_path = f"{path}.corrupt-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
                os.replace(path, corrupt_path)
                logger.warning(
                    "runner: %s 無法解析，已改名保留為 %s，改用全新的備份清單。 / "
                    "could not parse %s; preserved it as %s and started a fresh backup list.",
                    path, corrupt_path, path, corrupt_path,
                )

        records.append(
            {
                **asdict(entry),
                "removed_at": datetime.now(timezone.utc).isoformat(),
                "reason": _DEAD_REASON_AUTH_REJECTED,
            }
        )

        parent = os.path.dirname(os.path.abspath(path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        tmp_path = f"{path}.tmp-{os.getpid()}"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(records, f, indent=2, ensure_ascii=False)
        # L1 final-review fix: chmod the TEMP file, BEFORE it is published.
        # Doing it after `os.replace` leaves a window in which a file holding
        # an Ed25519 signing key is readable at whatever the umask allows
        # (commonly 0644) by any other local user. Best-effort: chmod is a
        # no-op for permissions on Windows and can fail on exotic
        # filesystems, neither of which is worth failing the backup over.
        try:
            os.chmod(tmp_path, 0o600)
        except OSError:
            pass
        os.replace(tmp_path, path)

    async def _prune_dead_registration(self, entry: PlatformEntry) -> None:
        """Remove a definitively auth-rejected `entry` from the persisted config.

        Called ONLY from `_run_platform`'s per-entry give-up (two consecutive
        4401s). The whole load -> back up -> save -> update-memory sequence runs
        under `self._prune_lock` and contains no `await` of its own, so two
        platforms giving up at the same time cannot interleave a read-modify-
        write of `agent.json` and lose one another's removal -- and a later
        refactor that makes any step async still can't, because the lock
        (not the accident of being synchronous) is what enforces it.

        It re-reads the config from disk rather than serialising
        `self.config`, so an unrelated hand edit made while the agent was
        running is not silently reverted -- but only for keys
        `AgentConfig.load`/`save` know about: the round-trip DROPS any
        unknown/hand-added key and COERCES a malformed value back to its
        default (see config.py, e.g. a hand-typed `"max_fetch_gb": "abc"`
        becomes 30). It does NOT touch `self.connections` -- the other
        platforms' `_run_platform` tasks are still iterating over their own
        connections.

        NOT guarded against another PROCESS (review L2, parked): a
        `comfyfed-agent register` (or the installer) run WHILE the agent is
        up does its own load->modify->save in `identity.register`, and
        nothing coordinates the two. The window is sub-millisecond on both
        sides and re-registering is an installer-time action, so this is
        accepted rather than solved with a file lock.
        """
        async with self._prune_lock:
            self._prune_dead_registration_locked(entry)

    def _prune_dead_registration_locked(self, entry: PlatformEntry) -> None:
        """The body of `_prune_dead_registration`, run under `_prune_lock`.
        Synchronous by design: nothing in here may await, or the lock would
        stop serialising the read-modify-write it exists to serialise."""
        try:
            cfg = AgentConfig.load(self.cfg_path)
        except Exception:
            # M1 final-review fix: `Exception`, not `(OSError, ValueError)`.
            # This re-read exists to tolerate a hand edit made while the agent
            # runs, and a hand edit is exactly what produces the other cases:
            # an extra key inside a `platforms` entry raises TypeError from
            # `PlatformEntry(**p)`, a top-level JSON array raises
            # AttributeError. This runs INSIDE `_run_platform`'s `except`
            # block, so anything escaping here propagates through
            # `asyncio.gather` and kills every healthy platform with it.
            logger.exception(
                "runner: 無法讀取 %s，略過這次清除（該註冊留在原處）。 / "
                "could not read %s to prune the dead registration; skipping the "
                "prune and leaving the entry in place.",
                self.cfg_path, self.cfg_path,
            )
            return

        remaining = [
            p
            for p in cfg.platforms
            if not (p.worker_id == entry.worker_id and p.platform_url == entry.platform_url)
        ]
        if len(remaining) == len(cfg.platforms):
            # Already gone -- a previous run pruned it, or the operator
            # removed it by hand while this process was up. Nothing to back
            # up, nothing to save, nothing to announce.
            return

        try:
            self._append_dead_registration(entry)
        except Exception:
            # M1: `Exception` here too -- `json.dump` can raise TypeError and
            # `os.makedirs` ValueError on a hand-broken path, and neither may
            # escape into `_run_platform`'s except block (see above).
            # The backup is the whole point: without it the signing key would
            # be unrecoverable, so a failed backup CANCELS the prune. The
            # entry stays in agent.json and is simply re-attempted next start
            # (today's behavior), which is the safe direction to fail.
            logger.exception(
                "runner: could not back up the dead registration to %s; leaving %s in %s",
                self._dead_registrations_path(), entry.worker_id, self.cfg_path,
            )
            return

        cfg.platforms = remaining
        try:
            cfg.save(self.cfg_path)  # tmp + os.replace, i.e. atomic
        except OSError:
            logger.exception("runner: could not save %s after pruning", self.cfg_path)
            return

        # Keep the in-memory config in step with what is now on disk. NOT
        # `self.connections`: this connection's own task is about to return,
        # and every other platform's task keeps its connection untouched.
        self.config.platforms = [
            p
            for p in self.config.platforms
            if not (p.worker_id == entry.worker_id and p.platform_url == entry.platform_url)
        ]

        logger.info(
            "已將失效的註冊（worker %s）移出 agent.json，備份於 agent.dead.json；"
            "下次啟動不再嘗試。 / Moved the dead registration (worker %s) out of "
            "agent.json (backup in agent.dead.json); it will not be retried on "
            "the next start.",
            entry.worker_id, entry.worker_id,
        )

    async def run(self) -> None:
        if not self.connections:
            return
        loop = asyncio.get_running_loop()
        self._install_signal_handlers(loop)
        # A stop.request left behind by a crash (or by the previous run being
        # killed before it could consume the file) must not kill this fresh
        # run on its very first heartbeat.
        control.clear_stop(self._config_dir)
        self._start_peer_server()
        # 開埠要在連平台之前完成（hello 一次就要帶對位址），整體上限 8 秒。
        # 只有 listener 真的起來了才值得去動路由器。
        if self._peer_server is not None:
            await self._setup_port_mapping()
            if self._peer_mapping is not None:
                self._peer_renew_task = asyncio.create_task(
                    self._peer_renew_loop(), name="comfyfed-peer-renew"
                )
        # One control task for the whole process, started before any socket
        # is attempted so `stop`/`status` work during the very first connect
        # and through every reconnect backoff.
        self._control_task = asyncio.create_task(self._control_loop(), name="comfyfed-control-loop")
        try:
            await asyncio.gather(*(self._run_platform(conn) for conn in self.connections.values()))
            # Reaching here means every `_run_platform` RETURNED, and the only
            # path out of that retry loop is a 4401 give-up. If nothing ever
            # handshaked, every configured registration is dead -- surface it
            # loudly (a healthy entry never returns, so a mixed fleet keeps
            # running and never reaches this line).
            if self._auth_gave_up and not self._connected_ever:
                raise AllRegistrationsRejected(
                    "every configured platform rejected this agent's registration (4401)"
                )
        finally:
            # A signal already ran (and awaited) the full graceful shutdown
            # via `_graceful_shutdown_and_stop` before stopping the loop --
            # running it a second time here would re-enter `shutdown()` on
            # an already-empty job table, which is harmless but pointless,
            # and would race `os._exit` on a stuck cleanup. Only run it here
            # for the ordinary "gather raised" path (e.g. every platform
            # connection failing outright) that no signal ever touched.
            if not self._shutdown_in_progress:
                await self.shutdown()
            # The published state describes a LIVE agent; leaving it behind
            # would have `comfyfed status` report this process as running
            # until the 120s staleness window expires. (`_graceful_shutdown_
            # and_stop` already did this on the signal/stop path, which never
            # resumes this coroutine; calling it twice is harmless.)
            await self._stop_control_loop()
