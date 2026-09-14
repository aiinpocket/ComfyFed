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
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

import httpx
import websockets
from nacl.signing import SigningKey

from . import comfy, fetcher, hardware, peerserve, signing, whitelist
from .config import AgentConfig, PlatformEntry

logger = logging.getLogger(__name__)

_HEARTBEAT_INTERVAL_SECONDS = 30
_OBJECT_INFO_INTERVAL_SECONDS = 600
_RECV_POLL_TIMEOUT_SECONDS = 1.0
_BACKOFF_START_SECONDS = 5
_BACKOFF_MAX_SECONDS = 60

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

    async def handshake(self) -> None:
        challenge = json.loads(await self.ws.recv())
        nonce = challenge["nonce"]
        sig = self._sign(nonce.encode())
        await self._send({"type": "auth", "worker_id": self.entry.worker_id, "sig": sig})
        ready = json.loads(await self.ws.recv())
        if ready.get("type") != "ready":
            raise ConnectionError(f"Unexpected handshake reply: {ready!r}")

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
        }
        if peer_url:
            message["peer_url"] = peer_url
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


class AgentLoop:
    """Owns one `PlatformConnection` per configured platform and one global job lock."""

    def __init__(self, config: AgentConfig, cfg_path: str, connection_factory=PlatformConnection):
        self.config = config
        self.cfg_path = cfg_path
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
        # Phase 3.1 P2P addendum (種子端): started in `run()` when
        # `peerserve.is_enabled(config)`, stopped in `shutdown()`. One
        # listener for the whole process, shared across every platform
        # connection (see peerserve.PeerHTTPServer's docstring).
        self._peer_server: Optional["peerserve.PeerHTTPServer"] = None
        self._peer_advertised_url: Optional[str] = None

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
        for worker_id, conn in self.connections.items():
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

        if self._peer_server is not None:
            try:
                self._peer_server.stop()
            except Exception:
                logger.exception("runner: failed to stop peer HTTP server cleanly")
            self._peer_server = None
            self._peer_advertised_url = None

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
        else:
            logger.warning("runner: unknown message type %r from platform", msg_type)

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
                await conn.send_heartbeat(
                    conn.state,
                    # Carrying the job id is what lets the server notice a
                    # worker still grinding on a job it no longer owns; see
                    # `_job_id_for` for why it is scoped to this connection.
                    job_id=self._job_id_for(conn),
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

    async def _run_platform(self, conn: PlatformConnection) -> None:
        backoff = _BACKOFF_START_SECONDS
        while True:
            try:
                await conn.connect()
                await conn.handshake()

                hw = hardware.collect_hardware(self.config.comfy_url)
                backend, torch_version = hardware.detect_backend()
                # Blocking (HTTP to ComfyUI) -- see handle_job.
                allowed = await asyncio.to_thread(
                    whitelist.allowed_classes,
                    self.config.node_policy,
                    self.config.comfy_url,
                    self.config.whitelist_extra,
                )
                await conn.send_hello(hw, backend, torch_version, allowed, peer_url=self._peer_advertised_url)

                models = (
                    hardware.scan_models(self.config.models_dir, hash_models=self.config.hash_models)
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
            except Exception:
                logger.exception("runner: connection to %s dropped, retrying in %ss", conn.entry.platform_url, backoff)
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

    async def run(self) -> None:
        if not self.connections:
            return
        loop = asyncio.get_running_loop()
        self._install_signal_handlers(loop)
        self._start_peer_server()
        try:
            await asyncio.gather(*(self._run_platform(conn) for conn in self.connections.values()))
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
