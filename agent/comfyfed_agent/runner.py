"""Multi-platform agent job runner: WS connections, busy broadcast, job execution."""

from __future__ import annotations

import asyncio
import json
import logging
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
    ) -> None:
        self.state = state
        await self._send(
            {
                "type": "heartbeat",
                "state": state,
                "progress": progress,
                "job_id": job_id,
                "dynamic": dynamic or {},
            }
        )

    async def send_job_done(self, job_id: str, result_files: list[str]) -> None:
        await self._send({"type": "job_done", "job_id": job_id, "result_files": result_files})

    async def send_job_failed(self, job_id: str, error: str) -> None:
        await self._send({"type": "job_failed", "job_id": job_id, "error": error})

    async def send_receipt_ack(self, receipt_id: str, worker_sig: str) -> None:
        await self._send({"type": "receipt_ack", "receipt_id": receipt_id, "worker_sig": worker_sig})

    def sign_receipt_payload(self, payload: str) -> str:
        return self._sign(payload.encode())


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
                await conn.send_heartbeat(state, progress=progress, job_id=job_id, dynamic=dynamic)
            except Exception:
                logger.exception("runner: failed to broadcast heartbeat to %s", worker_id)

    async def handle_job(self, conn: PlatformConnection, job_msg: dict) -> None:
        """Run one job dispatched over `conn`, broadcasting busy state to every platform."""
        job_id = job_msg["job_id"]
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

                for filename in job_msg.get("input_assets") or []:
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

                files = await asyncio.to_thread(
                    comfy.run_workflow, self.config.comfy_url, workflow, on_progress
                )

                for filename, content in files:
                    await self._upload_artifact(conn.entry, job_id, filename, content)

                await conn.send_job_done(job_id, [filename for filename, _content in files])
            except Exception as exc:
                logger.exception("runner: job %s failed", job_id)
                await conn.send_job_failed(job_id, str(exc))
            finally:
                await self.broadcast_heartbeat("idle", progress=0.0, job_id=None)

    async def _download_input(self, entry: PlatformEntry, job_id: str, filename: str) -> bytes:
        path = f"/api/agent/jobs/{job_id}/inputs/{filename}"
        headers = signing.signed_headers(entry, "GET", path, b"")
        async with httpx.AsyncClient(base_url=entry.platform_url) as client:
            resp = await client.get(path, headers=headers)
            resp.raise_for_status()
            return resp.content

    async def _upload_artifact(self, entry: PlatformEntry, job_id: str, filename: str, content: bytes) -> None:
        path = f"/api/agent/jobs/{job_id}/artifacts"
        async with httpx.AsyncClient(base_url=entry.platform_url) as client:
            request = client.build_request("POST", path, files={"file": (filename, content)})
            body = request.read()
            headers = signing.signed_headers(entry, "POST", path, body)
            request.headers.update(headers)
            resp = await client.send(request)
            resp.raise_for_status()

    async def _handle_message(self, conn: PlatformConnection, message: dict) -> None:
        msg_type = message.get("type")
        if msg_type == "job":
            await self.handle_job(conn, message)
        elif msg_type == "receipt":
            worker_sig = conn.sign_receipt_payload(message["payload"])
            await conn.send_receipt_ack(message["receipt_id"], worker_sig)
        else:
            logger.warning("runner: unknown message type %r from platform", msg_type)

    async def _connection_loop(self, conn: PlatformConnection) -> None:
        last_heartbeat = time.monotonic()
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
                await conn.send_heartbeat(conn.state, dynamic=dynamic)
                last_heartbeat = now

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
