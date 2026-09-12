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


def cleanup_job_files(
    *,
    success: bool,
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
    - `success` is true -- i.e. the run finished AND every artifact's upload
      was hash-verified by the platform. A failed job's (possibly partial)
      outputs are left in place for the operator to inspect.

    `output_files` is a list of `{"filename", "subfolder"}` dicts (from
    `comfy.run_workflow`'s results) and `input_filenames` the job's own
    `input_assets` list, both from `handle_job`.
    """
    if not success:
        logger.debug("runner: job did not succeed, skipping ComfyUI-directory cleanup")
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


class AgentLoop:
    """Owns one `PlatformConnection` per configured platform and one global job lock."""

    def __init__(self, config: AgentConfig, cfg_path: str, connection_factory=PlatformConnection):
        self.config = config
        self.cfg_path = cfg_path
        self.connections: dict[str, PlatformConnection] = {
            entry.worker_id: connection_factory(entry, config) for entry in config.platforms
        }
        self.job_lock = asyncio.Lock()

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
        """Run one job dispatched over `conn`, broadcasting busy state to every platform."""
        job_id = job_msg["job_id"]
        input_filenames = list(job_msg.get("input_assets") or [])
        output_files: list[dict] = []
        success = False
        async with self.job_lock:
            try:
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

                files, exec_seconds = await asyncio.to_thread(
                    comfy.run_workflow, self.config.comfy_url, workflow, on_progress
                )
                output_files = [
                    {"filename": filename, "subfolder": subfolder} for filename, _content, subfolder in files
                ]

                for filename, content, _subfolder in files:
                    await self._upload_artifact(conn.entry, job_id, filename, content)

                await conn.send_job_done(
                    job_id, [filename for filename, _content, _subfolder in files], exec_seconds
                )
                success = True
            except Exception as exc:
                logger.exception("runner: job %s failed", job_id)
                await conn.send_job_failed(job_id, str(exc))
            finally:
                try:
                    cleanup_job_files(
                        success=success,
                        comfy_output_dir=self.config.comfy_output_dir,
                        comfy_input_dir=self.config.comfy_input_dir,
                        output_files=output_files,
                        input_filenames=input_filenames,
                    )
                except Exception:
                    logger.exception("runner: job %s cleanup raised unexpectedly", job_id)
                await self.broadcast_heartbeat("idle", progress=0.0, job_id=None)

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
        """
        path = f"/api/agent/jobs/{job_id}/artifacts"
        local_sha256 = hashlib.sha256(content).hexdigest()

        for attempt in range(2):
            try:
                async with httpx.AsyncClient(base_url=entry.platform_url) as client:
                    request = client.build_request("POST", path, files={"file": (filename, content)})
                    body = request.read()
                    headers = signing.signed_headers(entry, "POST", path, body)
                    headers["X-Artifact-SHA256"] = local_sha256
                    request.headers.update(headers)
                    resp = await client.send(request)

                if resp.status_code == 200 and resp.json().get("sha256") == local_sha256:
                    return

                logger.warning(
                    "runner: artifact upload for %r not confirmed (status=%s, attempt=%d)",
                    filename, resp.status_code, attempt + 1,
                )
            except Exception:
                logger.exception("runner: artifact upload for %r raised (attempt=%d)", filename, attempt + 1)

        raise RuntimeError("artifact upload failed")

    async def _handle_message(self, conn: PlatformConnection, message: dict) -> None:
        msg_type = message.get("type")
        if msg_type == "job":
            await self.handle_job(conn, message)
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
                    conn.state, dynamic=dynamic, object_info_hash=conn.object_info_hash or None
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

            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, _BACKOFF_MAX_SECONDS)

    async def run(self) -> None:
        if not self.connections:
            return
        await asyncio.gather(*(self._run_platform(conn) for conn in self.connections.values()))
