"""Multi-platform agent job runner: WS connections, busy broadcast, job execution."""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import json
import logging
import ntpath
import os
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

import httpx
import websockets
from nacl.signing import SigningKey

from . import comfy, hardware, signing, whitelist
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

    async def send_hello(self, hardware_info: dict, backend: str, torch_version: str, node_classes) -> None:
        await self._send(
            {
                "type": "hello",
                "hardware": hardware_info,
                "backend": backend,
                "torch_version": torch_version,
                "node_classes": sorted(node_classes),
            }
        )

    async def send_inventory(self, models: list[dict]) -> None:
        await self._send({"type": "inventory", "models": models})

    async def send_heartbeat(
        self,
        state: str,
        progress: float = 0.0,
        job_id: Optional[str] = None,
        dynamic: Optional[dict] = None,
        object_info_hash: Optional[str] = None,
    ) -> None:
        self.state = state
        await self._send(
            {
                "type": "heartbeat",
                "state": state,
                "progress": progress,
                "job_id": job_id,
                "dynamic": dynamic or {},
                "object_info_hash": object_info_hash,
            }
        )

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

    async def send_job_failed(self, job_id: str, error: str) -> None:
        await self._send({"type": "job_failed", "job_id": job_id, "error": error})

    async def send_receipt_ack(self, receipt_id: str, worker_sig: str) -> None:
        await self._send({"type": "receipt_ack", "receipt_id": receipt_id, "worker_sig": worker_sig})

    def sign_receipt_payload(self, payload: str) -> str:
        return self._sign(payload.encode())


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
    # True while the run is over and only the hand-off (artifact uploads +
    # job_done) is left. Such a job must not be cancel-evented by shutdown:
    # there is nothing left to abort, only a result to deliver or preserve.
    reporting: bool = False
    # The prompt id ComfyUI has already been told to stop, so the wind-down
    # re-check never fires a second `/interrupt` for a prompt the receive
    # loop already handled -- on a shared worker that second call could land
    # on somebody else's render.
    interrupted_prompt_id: Optional[str] = None

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

    async def broadcast_heartbeat(
        self,
        state: str,
        progress: float = 0.0,
        job_id: Optional[str] = None,
        dynamic: Optional[dict] = None,
    ) -> None:
        for worker_id, conn in self.connections.items():
            try:
                await conn.send_heartbeat(
                    state,
                    progress=progress,
                    job_id=job_id,
                    dynamic=dynamic,
                    object_info_hash=getattr(conn, "object_info_hash", None) or None,
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
        handle = self._jobs.get(job_id)
        if handle is None:
            handle = _JobHandle(job_id=job_id, conn=conn)
            self._jobs[job_id] = handle

        def raise_if_cancelled() -> None:
            if handle.cancel_event.is_set():
                raise comfy.JobCancelled()

        async with self.job_lock:
            try:
                # The platform may have cancelled while this job waited for
                # the lock, or between dispatch and here.
                raise_if_cancelled()
                await self.broadcast_heartbeat("busy", progress=0.0, job_id=job_id)

                workflow = json.loads(job_msg["workflow_json"])
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
                    await conn.send_job_failed(job_id, str(exc))
            finally:
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
                await self._wait_for_live_connection(conn, backoff)
                backoff = min(backoff * 2, _REPORT_RETRY_MAX_SECONDS)

    async def _wait_for_live_connection(self, conn: PlatformConnection, timeout: float) -> None:
        """Sleep until `conn` has a socket again, or `timeout` elapses.

        `_run_platform` reconnects on the SAME `PlatformConnection` object,
        replacing `.ws` in place, so that attribute is the signal a held
        completion waits on. The timeout keeps this a backoff rather than a
        promise: a retry against a socket that is merely about to die simply
        fails again and backs off further.
        """
        deadline = time.monotonic() + timeout
        while getattr(conn, "ws", None) is None and time.monotonic() < deadline:
            await asyncio.sleep(min(0.25, timeout))

    async def _download_input(self, entry: PlatformEntry, job_id: str, filename: str) -> bytes:
        path = f"/api/agent/jobs/{job_id}/inputs/{filename}"
        headers = signing.signed_headers(entry, "GET", path, b"")
        async with httpx.AsyncClient(base_url=entry.platform_url) as client:
            resp = await client.get(path, headers=headers)
            resp.raise_for_status()
            return resp.content

    async def _upload_artifact(self, entry: PlatformEntry, job_id: str, filename: str, content: bytes) -> None:
        """Upload one job artifact and verify the platform received it uncorrupted.

        Sends the locally computed sha256 as `X-Artifact-SHA256`; the
        platform recomputes its own hash over the bytes it received and
        echoes it back in `{"sha256": ...}`. Only a response whose hash
        matches ours counts as success -- a mismatch (corruption or a swap in
        transit) or any non-2xx (including the platform's own 400
        `artifact.hash_mismatch`) is retried once with a fresh upload. If
        that also fails, raises so `handle_job` reports the job failed
        instead of silently losing or corrupting the result.

        Which exception it raises matters: `RuntimeError` when the platform
        ANSWERED and the upload still did not verify (a real rejection --
        the job failed), `PlatformUnavailable` when no attempt got an
        answer at all (a transport problem -- the job is fine, the socket
        isn't). `_report_completion` holds and retries only the latter.
        """
        path = f"/api/agent/jobs/{job_id}/artifacts"
        local_sha256 = hashlib.sha256(content).hexdigest()
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
        """
        job_id = self._current_job_id
        if job_id is None:
            return None
        handle = self._jobs.get(job_id)
        if handle is None or handle.conn is not conn:
            return None
        return job_id

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
                await conn.send_heartbeat(
                    conn.state,
                    # Carrying the job id is what lets the server notice a
                    # worker still grinding on a job it no longer owns; see
                    # `_job_id_for` for why it is scoped to this connection.
                    job_id=self._job_id_for(conn),
                    dynamic=dynamic,
                    object_info_hash=conn.object_info_hash or None,
                )
                last_heartbeat = now

            if now - last_object_info >= _OBJECT_INFO_INTERVAL_SECONDS:
                await self.refresh_object_info(conn)
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
                await conn.send_hello(hw, backend, torch_version, allowed)

                models = hardware.scan_models(self.config.models_dir) if self.config.models_dir else []
                await conn.send_inventory(models)

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
        try:
            await asyncio.gather(*(self._run_platform(conn) for conn in self.connections.values()))
        finally:
            await self.shutdown()
