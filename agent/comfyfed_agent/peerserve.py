"""Agent-side peer HTTP server (Phase 3.1 P2P addendum, 種子端/seeder side).

Serves model bytes directly to another agent (the puller) that holds a
short-lived, platform-signed Grant (see `comfyfed_server.peer` for how the
platform mints one). This module never talks to the platform to authorize a
transfer -- it verifies the Grant itself, against every platform this agent
is pinned to (`AgentConfig.platforms`), and only then serves bytes:

1. `GET /peer/models/<name>` -- `<name>` is a URL-encoded manifest name in
   the SAME shape `hardware.scan_models` reports (`dir/file`, POSIX
   separators, relative to `models_dir`). It is resolved ONLY through
   `_ModelIndex`, a periodically-refreshed snapshot of the agent's own model
   inventory: the requested name must be an exact key in that index, so an
   attacker-controlled path string is never joined onto `models_dir` --
   only names this agent already knows it has can ever be opened. Each
   decoded path segment is additionally sanitized with the same rules
   `fetcher._sanitize_name` uses (no `..`, no absolute/drive form, no `:` --
   the NTFS alternate-data-stream guard) as defense in depth, rejected
   before the index is even consulted.

2. Auth header `X-ComfyFed-Grant: base64(json)` -- the JSON is the grant
   dict the platform handed the puller, `sig` included alongside the grant's
   own fields (see `comfyfed_server.peer.peer_grant`'s response shape,
   `{"grant": {**grant, "sig": sig}, ...}` -- that inner dict is exactly what
   gets base64'd here). Verified against the pipe-joined payload
   `grant_id|name|size_bytes|sha256|seeder_id|puller_id|expires_at` (Global
   Constraints -- must byte-for-byte match `peer._grant_payload`), tried
   against EVERY pinned platform's public key (a multi-platform agent has no
   way to know which platform issued a given grant up front -- the grant
   carries no platform id by design). A request is authorized iff:

   - some pinned platform's key verifies `sig` over the grant payload,
   - that platform's copy has not expired (`expires_at > now`),
   - `grant["name"]` equals the requested (decoded) name, and
   - `grant["seeder_id"]` equals THAT platform's `worker_id` (multi-platform:
     the same physical worker can have a different id per platform, so the
     seeder-id check is meaningless against any platform whose key didn't
     verify the signature).

   Any other outcome is a 403 with no detail in the body -- never which of
   the above failed, so a probing client learns nothing.

3. Range: a single `bytes=start-end` or `bytes=start-` is honored with a 206
   + Content-Range/Content-Length; no `Range` header serves the whole file
   (200). A malformed header, a multi-range list (`bytes=0-10,20-30`), or a
   range outside the file's bounds is answered 416 (Range Not Satisfiable --
   the more specific, standard code for "the Range header itself is the
   problem", as opposed to 403 which this module reserves for auth/path
   failures).

One log line is emitted the FIRST time a given `grant_id` is seen (not per
request/per range) -- see `_GrantTracker.note_grant`. Bytes actually written
to the wire are tallied per `grant_id` (`_GrantTracker.add_bytes`), readable
at any time via `PeerHTTPServer.pop_served()` (also what the bandwidth
reporter background thread drains once a grant goes idle or expires -- see
`PeerHTTPServer._reporter_loop`).
"""

from __future__ import annotations

import base64
import json
import logging
import math
import ntpath
import os
import re
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Optional
from urllib.parse import unquote, urlsplit

import httpx
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

from . import hardware, signing
from .config import AgentConfig, PlatformEntry

logger = logging.getLogger(__name__)

_CHUNK_SIZE = 1024 * 1024  # 1 MiB per wfile.write, matching fetcher._CHUNK_SIZE

# Token-bucket rounding dust: `tokens` accumulates as a float, so after a
# perfectly-paced sleep it can land a billionth of a byte short of the amount
# it just paid for. Treating that as a real shortfall makes `consume` compute
# a wait so small it cannot move the clock, and spin. A millionth of a byte
# is never a meaningful debt.
_TOKEN_EPSILON = 1e-6
_INDEX_TTL_SECONDS = 5.0
_IDLE_REPORT_SECONDS = 60.0
_REPORT_POLL_SECONDS = 5.0
_ROUTE_PREFIX = "/peer/models/"

# Phase 3.4 §4.2：平台用來驗證這台種子連不連得到的探針。**不需要憑證**，
# 回 204、無內容、無識別資訊 —— 它只回答「這個位址上有一個 ComfyFed peer
# 服務在聽」，不回答這台有哪些模型、屬於誰。其他路徑一律照舊要憑證。
HEALTH_PATH = "/peer/health"

# M4 final-review fix: cap consecutive failed `peer-served` report attempts
# per grant -- an unbounded retry loop (the pre-fix behavior) means a grant
# rejected for any terminal reason (the platform pruned it, already booked,
# bad bytes, wrong seeder) polls forever for the rest of this process's
# life. After this many failed attempts, give up and log once rather than
# silently retrying, so a stuck grant is at least visible in the logs.
_MAX_REPORT_ATTEMPTS = 5

# Ordered exactly as comfyfed_server.peer._GRANT_FIELDS / the signed payload
# (Global Constraints: grant_id|name|size_bytes|sha256|seeder_id|puller_id|expires_at).
_GRANT_FIELDS = ("grant_id", "name", "size_bytes", "sha256", "seeder_id", "puller_id", "expires_at")

_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")

def is_enabled(config: AgentConfig) -> bool:
    """Peer serving is on iff both a `peer_serve` opt-in AND a port to bind
    are present -- a bare `peer_serve: true` with no configured port has
    nothing to listen on and is treated as off."""
    return bool(config.peer_serve and config.peer_listen_port)


def _detect_local_ip() -> str:
    """Best-effort primary LAN IP via the classic UDP-connect trick: no
    packet is actually sent (UDP `connect` just picks a route/local address
    for the kernel to use), so this works even with no real connectivity to
    8.8.8.8. Falls back to loopback if the OS refuses even that (e.g. no
    network stack at all, some sandboxes)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def advertised_url(config: AgentConfig) -> Optional[str]:
    """The `http://host:port` this agent should put in `hello.peer_url`, or
    `None` when peer serving is not enabled. `peer_advertise_host` overrides
    the auto-detected LAN IP (NAT/port-forward/fixed-hostname setups)."""
    if not is_enabled(config):
        return None
    host = config.peer_advertise_host or _detect_local_ip()
    return peer_url_for(host, config.peer_listen_port)


def peer_url_for(host: str, port: int) -> str:
    """`http://host:port`，`peer_url`／`peer_lan_url` 的唯一組法。"""
    return f"http://{host}:{port}"


def lan_url(config: AgentConfig) -> Optional[str]:
    """這台的區網位址（`hello.peer_lan_url`，spec §3.2）。**永遠**用自動
    偵測到的區網 IP，即使使用者設了 `peer_advertise_host` —— 那個值是對外
    位址（`peer_url`），而 `peer_lan_url` 存在的意義正是給「跟我在同一個
    NAT 後面、連對外位址反而會 hairpin 失敗」的成員用的。"""
    if not is_enabled(config):
        return None
    return peer_url_for(_detect_local_ip(), config.peer_listen_port)


def _sanitize_peer_name(name: str) -> bool:
    """Whether `name` (already URL-decoded) is a safe `dir/file`-shaped
    manifest name: at most one `/` (mirrors `hardware.scan_models`'s
    single-category-directory layout), no segment that is empty, `.`/`..`,
    drive-relative, containing a NTFS-ADS `:`, or a literal backslash
    (defense in depth -- mirrors `fetcher._sanitize_name`'s guards, applied
    per segment). This is checked BEFORE the name is looked up in the
    inventory index; the index membership check is the actual trust
    boundary, this just fails closed on garbage early and cheaply."""
    if not name:
        return False
    segments = name.split("/")
    if len(segments) > 2:
        return False
    for seg in segments:
        if (
            not seg
            or seg in (".", "..")
            or ntpath.splitdrive(seg)[0]
            or ":" in seg
            or "\\" in seg
        ):
            return False
    return True


def _grant_payload(grant: dict) -> str:
    return "|".join(str(grant[field]) for field in _GRANT_FIELDS)


def _grant_shape_ok(grant: object) -> bool:
    if not isinstance(grant, dict):
        return False
    for field in _GRANT_FIELDS:
        if field not in grant:
            return False
    for field in ("size_bytes", "expires_at"):
        value = grant[field]
        if not isinstance(value, int) or isinstance(value, bool):
            return False
    return True


def _parse_grant_header(value: str) -> Optional[tuple[dict, str]]:
    """Decode `X-ComfyFed-Grant` into `(grant_fields, sig)`, or `None` on any
    malformed input (bad base64, bad JSON, not an object, missing/non-string
    `sig`) -- never raises."""
    try:
        raw = base64.b64decode(value, validate=False)
        obj = json.loads(raw)
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    sig = obj.get("sig")
    if not isinstance(sig, str) or not sig:
        return None
    grant = {k: v for k, v in obj.items() if k != "sig"}
    return grant, sig


def verify_grant_signature(grant: dict, sig: str, platform_pubkey_hex: str) -> bool:
    """Whether `sig` (hex) is `platform_pubkey_hex`'s valid Ed25519
    signature over `grant`'s pipe-joined fields. Never raises -- any
    malformed hex/signature just reads as "not valid" (fail-closed, mirrors
    `comfyfed_server.peer.verify_grant`)."""
    try:
        verify_key = VerifyKey(bytes.fromhex(platform_pubkey_hex))
        verify_key.verify(_grant_payload(grant).encode(), bytes.fromhex(sig))
        return True
    except (BadSignatureError, ValueError, TypeError):
        return False


def authorize_grant(
    grant: dict, sig: str, requested_name: str, platforms: list[PlatformEntry]
) -> Optional[PlatformEntry]:
    """The `PlatformEntry` that authorizes this request, or `None` if none
    does.

    Checked once, shape/expiry/name-independent of which platform's key
    verifies (those hold regardless), then tried against every pinned
    platform's key: a grant is accepted only for the platform whose key
    verifies AND whose own `worker_id` equals `grant["seeder_id"]` -- a
    multi-platform agent has a different worker_id per platform, so the
    seeder-id check is only meaningful against the platform that actually
    signed it.
    """
    if not _grant_shape_ok(grant):
        return None
    if grant["expires_at"] <= time.time():
        return None
    if grant["name"] != requested_name:
        return None

    for entry in platforms:
        if not verify_grant_signature(grant, sig, entry.platform_pubkey):
            continue
        if grant["seeder_id"] == entry.worker_id:
            return entry
    return None


def _parse_range(range_header: str, size_bytes: int) -> Optional[tuple[int, int]]:
    """Parse a single `bytes=start-end` / `bytes=start-` Range header against
    a file of `size_bytes`. Returns `None` for anything this server does not
    support or that is out of bounds: a multi-range list, a malformed
    header, or a range that doesn't fit -- callers turn `None` into 416."""
    if "," in range_header:
        return None  # multi-range: not supported
    match = _RANGE_RE.match(range_header.strip())
    if not match:
        return None
    start_s, end_s = match.groups()
    if start_s == "":
        return None  # suffix ranges ("bytes=-500") are not part of this contract
    start = int(start_s)
    end = int(end_s) if end_s != "" else size_bytes - 1
    if size_bytes <= 0 or start < 0 or end < start or start >= size_bytes:
        return None
    end = min(end, size_bytes - 1)
    return start, end


class UploadThrottle:
    """行程層級、全體共用的 token bucket 上傳限速器。

    所有並行的傳輸共用同一個桶子：N 個下載端加起來受同一個上限約束，而不是
    每人各拿一份上限（N x cap）。桶子會依 monotonic 時鐘連續補充，並且封頂在
    「1 秒的速率」或「一個 chunk」兩者取大——長時間沒人下載之後，第一個連線
    也不會一口氣爆出一大串 burst 把使用者的上行塞滿。

    A process-global, shared token bucket. Every concurrent transfer draws
    from the SAME bucket, so N pullers are jointly bounded by the cap rather
    than getting N x cap. The bucket refills continuously from a monotonic
    clock and is capped at one second of rate (or one chunk, whichever is
    larger) so a long idle gap cannot grant a huge burst.

    `now` / `sleep` are injectable so tests can drive it with a fake clock
    instead of real wall time. This class deliberately knows nothing about
    idle detection or config -- the runner drives it (see
    `PeerHTTPServer.set_upload_limit_mbps`).
    """

    def __init__(
        self,
        rate_bytes_per_sec: float | None = None,
        *,
        now: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self._lock = threading.Lock()
        self._now = now
        self._sleep = sleep
        self._rate: float | None = None
        self._capacity = 0.0
        self._tokens = 0.0
        self._last = now()
        self.set_rate(rate_bytes_per_sec)

    def set_rate(self, bytes_per_sec: float | None) -> None:
        """Set the shared cap. `None` or `0` (or anything non-positive /
        non-finite) means UNLIMITED -- `consume` then never sleeps."""
        if bytes_per_sec is None:
            rate: float | None = None
        else:
            try:
                value = float(bytes_per_sec)
            except (TypeError, ValueError):
                value = 0.0
            rate = value if math.isfinite(value) and value > 0 else None
        with self._lock:
            # 先把「上一次補充到現在」這段時間的 token 補進來，再換速率——
            # runner 每個 tick 都可能重申同一個速率，如果直接把 `_last` 推到
            # 現在，這段已經累積的額度就被丟掉，實際速率會系統性低於設定值。
            # Credit the elapsed interval BEFORE swapping the rate: re-
            # asserting the SAME rate must be lossless, otherwise every
            # re-assert silently discards whatever accrued since the last
            # refill and the delivered rate sits below the configured cap.
            self._refill_locked()
            self._rate = rate
            if rate is None:
                self._capacity = 0.0
                self._tokens = 0.0
            else:
                self._capacity = max(rate, float(_CHUNK_SIZE))
                # A rate change starts from an empty-ish bucket rather than
                # carrying over tokens minted under the previous (possibly
                # unlimited) tier -- switching 0 -> 20 Mbps must take effect
                # immediately, not after a stale burst drains.
                self._tokens = min(self._tokens, self._capacity)
            # `_refill_locked` above already advanced `_last` to now; do NOT
            # re-stamp it here (that is exactly what used to drop tokens).

    @property
    def rate_bytes_per_sec(self) -> float | None:
        with self._lock:
            return self._rate

    def _refill_locked(self) -> None:
        now = self._now()
        elapsed = now - self._last
        self._last = now
        if elapsed > 0 and self._rate is not None:
            self._tokens = min(self._capacity, self._tokens + elapsed * self._rate)

    def consume(self, nbytes: int) -> None:
        """Block (in small sleeps) until `nbytes` worth of tokens are
        available, then spend them. Returns immediately when unlimited."""
        if nbytes <= 0:
            return
        remaining = nbytes
        while remaining > 0:
            with self._lock:
                rate = self._rate
                if rate is None:
                    return
                self._refill_locked()
                # A request larger than the whole bucket is paid for in
                # bucket-sized bites rather than waited for in one go -- it
                # could never be satisfied outright, and spending it as one
                # negative balance would let an oversized write through
                # unpaced.
                take = min(remaining, self._capacity)
                if self._tokens >= take - _TOKEN_EPSILON:
                    self._tokens = max(0.0, self._tokens - take)
                    remaining -= take
                    continue
                deficit = take - self._tokens
                wait = deficit / rate
            # Capped so a rate change (or a stop) is picked up promptly
            # instead of being stuck inside one long sleep.
            #
            # PARKED (reviewed, deliberately not fixed): there is no queue or
            # fairness among simultaneous sleepers -- N threads can all be
            # sleeping on their own (now stale) deficits while the bucket
            # refills to `_capacity` and overflows, so AGGREGATE throughput
            # can fall BELOW the cap and one unlucky thread can be beaten to
            # the tokens repeatedly. Both effects are in the safe direction
            # (never above the cap) and bounded by the 0.5 s wake-up, so a
            # fair queue is not worth the complexity here.
            self._sleep(min(wait, 0.5))


# 全行程共用的上傳限速桶：一個 agent 行程只有一個 listener，所有並行傳輸共用
# 這一個上限（N 個下載端合計受限，不是每人一份）。預設不限速，由 runner 每次
# control tick 依閒置狀態呼叫 `PeerHTTPServer.set_upload_limit_mbps` 調整。
# The ONE process-global upload bucket shared by every concurrent transfer.
# Unlimited until the runner sets a tier.
_UPLOAD_THROTTLE = UploadThrottle(None)


class _ModelIndex:
    """Periodically-refreshed `name -> (abs_path, size_bytes)` snapshot of
    `models_dir`, rebuilt via `hardware.scan_models(..., hash_models=False)`
    (a plain directory walk, no hashing) at most once every
    `_INDEX_TTL_SECONDS`.

    `resolve` is the ONLY way a request's name ever becomes a filesystem
    path: a name not present as an exact key in the index is never opened,
    no matter what it looks like -- there is no code path that joins a
    request's raw string onto `models_dir`.
    """

    def __init__(self, models_dir: str):
        self._models_dir = models_dir
        self._lock = threading.Lock()
        self._by_name: dict[str, tuple[str, int]] = {}
        self._last_refresh = 0.0

    def resolve(self, name: str) -> Optional[tuple[str, int]]:
        with self._lock:
            now = time.monotonic()
            if now - self._last_refresh >= _INDEX_TTL_SECONDS:
                self._refresh_locked()
            return self._by_name.get(name)

    def _refresh_locked(self) -> None:
        try:
            entries = hardware.scan_models(self._models_dir, hash_models=False)
        except Exception:
            logger.exception("peerserve: failed to scan model inventory under %s", self._models_dir)
            entries = []
        by_name: dict[str, tuple[str, int]] = {}
        for entry in entries:
            name = entry.get("name")
            size_bytes = entry.get("size_bytes")
            if not isinstance(name, str) or not isinstance(size_bytes, int):
                continue
            abs_path = os.path.join(self._models_dir, *name.split("/"))
            by_name[name] = (abs_path, size_bytes)
        self._by_name = by_name
        self._last_refresh = time.monotonic()


class _GrantTracker:
    """Per-`grant_id` bookkeeping shared between the request handler and the
    background bandwidth reporter: first-seen logging, a thread-safe served-
    bytes counter, and idle/expiry tracking for `PeerHTTPServer._reporter_loop`.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._bytes: dict[str, int] = {}
        self._seen: set = set()
        self._platform: dict[str, PlatformEntry] = {}
        self._last_activity: dict[str, float] = {}
        self._expires_at: dict[str, int] = {}
        self._reported: set = set()
        self._report_attempts: dict[str, int] = {}
        # grant_id -> how many responses are STREAMING bytes for it right now.
        self._active_streams: dict[str, int] = {}

    def note_grant(self, grant: dict, platform: PlatformEntry) -> None:
        grant_id = grant["grant_id"]
        first = False
        with self._lock:
            if grant_id not in self._seen:
                first = True
                self._seen.add(grant_id)
            self._platform[grant_id] = platform
            self._expires_at[grant_id] = grant["expires_at"]
            self._last_activity[grant_id] = time.time()
            self._bytes.setdefault(grant_id, 0)
        if first:
            logger.info(
                "peerserve: serving grant %s (name=%r, seeder=%s, puller=%s, platform=%s)",
                grant_id, grant.get("name"), grant.get("seeder_id"), grant.get("puller_id"),
                platform.platform_url,
            )

    def add_bytes(self, grant_id: str, n: int) -> None:
        with self._lock:
            self._bytes[grant_id] = self._bytes.get(grant_id, 0) + n
            self._last_activity[grant_id] = time.time()

    def begin_stream(self, grant_id: str) -> None:
        """Mark one response as actively streaming bytes for `grant_id`.

        傳輸途中授權單過期不該把這條連線的位元組丟掉：一張還在傳的授權單即使
        過了 `expires_at`，也要等串流結束才結算回報。（新的請求仍然會被
        `authorize_grant` 擋掉，這裡只保護「已經在傳」的那一條。）

        A grant that expires mid-stream must NOT be reported-and-closed while
        the response is still writing: `due_for_report` skips a grant with a
        live stream, so bytes served after expiry are still credited once the
        stream ends. A NEW request on an expired grant is still refused by
        `authorize_grant` -- this only protects an in-flight response.
        """
        with self._lock:
            self._active_streams[grant_id] = self._active_streams.get(grant_id, 0) + 1

    def end_stream(self, grant_id: str) -> None:
        """Counterpart to `begin_stream` -- always called from a `finally`."""
        with self._lock:
            left = self._active_streams.get(grant_id, 0) - 1
            if left > 0:
                self._active_streams[grant_id] = left
            else:
                self._active_streams.pop(grant_id, None)

    def active_streams(self, grant_id: str) -> int:
        with self._lock:
            return self._active_streams.get(grant_id, 0)

    def pop_served(self) -> dict:
        """Snapshot and zero every grant's served-bytes counter. Safe to
        call at any time (tests use it directly); grant metadata (platform,
        activity, expiry) is untouched so the reporter loop keeps working."""
        with self._lock:
            served = dict(self._bytes)
            self._bytes = {grant_id: 0 for grant_id in self._bytes}
        return served

    def bytes_for(self, grant_id: str) -> int:
        with self._lock:
            return self._bytes.get(grant_id, 0)

    def platform_for(self, grant_id: str) -> Optional[PlatformEntry]:
        with self._lock:
            return self._platform.get(grant_id)

    def due_for_report(self, idle_seconds: float = _IDLE_REPORT_SECONDS) -> list:
        """Grant ids that are idle for `idle_seconds` or already expired,
        have not yet been successfully reported, and have NO response still
        streaming (an in-flight transfer is settled when it finishes, so its
        post-expiry bytes are counted -- see `begin_stream`)."""
        now = time.time()
        with self._lock:
            due = []
            for grant_id in self._seen:
                if grant_id in self._reported:
                    continue
                if self._active_streams.get(grant_id, 0) > 0:
                    continue
                last = self._last_activity.get(grant_id, 0.0)
                expires = self._expires_at.get(grant_id, 0)
                if now - last >= idle_seconds or now >= expires:
                    due.append(grant_id)
            return due

    def mark_reported(self, grant_id: str) -> None:
        with self._lock:
            self._reported.add(grant_id)

    def record_failed_attempt(self, grant_id: str) -> int:
        """Increment and return the failed-report attempt count for
        `grant_id` (M4 final-review fix's retry cap)."""
        with self._lock:
            self._report_attempts[grant_id] = self._report_attempts.get(grant_id, 0) + 1
            return self._report_attempts[grant_id]


def _make_handler_class(server_state: "_ServerState") -> type:
    """Build a `BaseHTTPRequestHandler` subclass closed over `server_state`
    (index/platforms/tracker) -- `http.server` instantiates handlers itself
    per request with a fixed `(request, client_address, server)` signature,
    so state must be reachable some other way; a closure keeps the handler
    itself stateless and simple to reason about."""

    class _Handler(BaseHTTPRequestHandler):
        server_version = "ComfyFedPeer/1"
        # Fix round 1: `BaseHTTPRequestHandler` appends its own
        # `sys_version` ("Python/3.12.10") to every `Server` header. An
        # unauthenticated `/peer/health` probe -- or any 403 -- would hand a
        # scanner this machine's exact interpreter version, which is a free
        # CVE shortlist and tells it nothing it needs. Empty means the header
        # is just "ComfyFedPeer/1".
        sys_version = ""
        protocol_version = "HTTP/1.1"
        # M6 final-review fix: `BaseHTTPRequestHandler` sets no socket
        # timeout by default, so an unauthenticated client that opens a
        # keep-alive connection and sends nothing blocks `rfile.readline()`
        # indefinitely -- with `ThreadingHTTPServer` spawning one thread per
        # connection and no cap, enough idle connections exhaust threads/file
        # handles on the machine that's also running ComfyUI jobs. This
        # attribute is `socketserver.BaseRequestHandler`'s own timeout hook:
        # it reaps an idle connection (read/handle timeout) after 30s.
        timeout = 30

        def log_message(self, fmt: str, *args) -> None:  # noqa: A002
            logger.debug("peerserve: %s - " + fmt, self.client_address[0], *args)

        def do_GET(self) -> None:  # noqa: N802 (http.server's naming convention)
            try:
                self._serve()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            except Exception:
                logger.exception("peerserve: unhandled error serving %s", self.path)
                try:
                    self._deny(500)
                except Exception:
                    pass

        def _deny(self, status: int) -> None:
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def _no_content(self) -> None:
            """A bare 204. Fix round 1: RFC 9110 §15.3.5 -- a 204 has no
            body, so it must not carry `Content-Length` (or `Content-Type`)
            either. `_deny` sends `Content-Length: 0`, which is right for a
            403/404 but wrong here."""
            self.send_response(204)
            self.end_headers()

        def _serve(self) -> None:
            parsed = urlsplit(self.path)
            # Phase 3.4 §4.2：可連性探針，無憑證 204。放在憑證檢查之前是
            # 刻意的 —— 平台做這個檢查時手上沒有（也不該有）任何 grant。
            # 精確比對路徑，不是 startswith：`/peer/healthz` 之類的變形不算。
            if parsed.path == HEALTH_PATH:
                self._no_content()
                return
            if not parsed.path.startswith(_ROUTE_PREFIX):
                self._deny(404)
                return

            raw_name = parsed.path[len(_ROUTE_PREFIX):]
            try:
                name = unquote(raw_name)
            except Exception:
                self._deny(403)
                return
            if not _sanitize_peer_name(name):
                self._deny(403)
                return

            # M5 final-review fix: authorize the grant BEFORE ever consulting
            # the model index. `authorize_grant` only needs the requested
            # `name` string (not whether this agent actually has that file),
            # so this ordering costs nothing -- and it means an
            # unauthenticated request can no longer distinguish "no such
            # model" (previously 404, before auth) from "auth failed"
            # (403): both are now 403, and the index (a directory-scan-backed
            # lookup) is never even queried for a request that fails auth,
            # closing the pre-auth model-inventory oracle.
            grant_header = self.headers.get("X-ComfyFed-Grant")
            if not grant_header:
                self._deny(403)
                return
            parsed_grant = _parse_grant_header(grant_header)
            if parsed_grant is None:
                self._deny(403)
                return
            grant, sig = parsed_grant

            platform = authorize_grant(grant, sig, name, server_state.platforms)
            if platform is None:
                self._deny(403)
                return

            resolved = server_state.index.resolve(name)
            if resolved is None:
                self._deny(404)
                return
            abs_path, size_bytes = resolved

            server_state.tracker.note_grant(grant, platform)

            range_header = self.headers.get("Range")
            status = 200
            start, end = 0, size_bytes - 1
            if range_header:
                parsed_range = _parse_range(range_header, size_bytes)
                if parsed_range is None:
                    self._deny(416)
                    return
                start, end = parsed_range
                status = 206

            length = end - start + 1
            try:
                fh = open(abs_path, "rb")
            except OSError:
                self._deny(404)
                return

            grant_id = grant["grant_id"]
            with fh:
                try:
                    fh.seek(start)
                except OSError:
                    self._deny(500)
                    return
                self.send_response(status)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(length))
                self.send_header("Accept-Ranges", "bytes")
                if status == 206:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size_bytes}")
                self.end_headers()

                remaining = length
                # 這條串流開始後，即使授權單中途過期也要讓它傳完並照算位元組
                # （回報要等串流結束）；擋的是「過期後的新請求」。
                # A throttled 6.5 GB transfer easily outlives its grant: mark
                # the stream live so an expiry mid-flight neither closes the
                # accounting early nor drops the bytes still to come.
                server_state.tracker.begin_stream(grant_id)
                try:
                    while remaining > 0:
                        chunk = fh.read(min(_CHUNK_SIZE, remaining))
                        if not chunk:
                            break
                        # 先扣 token 再寫：限速在「寫上線路之前」生效，所以使用者
                        # 在用電腦時，做種不會先一口氣灌滿 socket buffer。
                        # Pay before writing, so the cap actually shapes what goes
                        # on the wire instead of trailing behind a full buffer.
                        _UPLOAD_THROTTLE.consume(len(chunk))
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
                        server_state.tracker.add_bytes(grant_id, len(chunk))
                finally:
                    server_state.tracker.end_stream(grant_id)

    return _Handler


class _ServerState:
    """Plain bag of the per-listener objects the handler closure needs."""

    def __init__(self, index: _ModelIndex, platforms: list[PlatformEntry], tracker: _GrantTracker):
        self.index = index
        self.platforms = platforms
        self.tracker = tracker


class PeerHTTPServer:
    """Owns one `ThreadingHTTPServer` serving `GET /peer/models/<name>`, plus
    a background thread that reports served bandwidth back to whichever
    platform issued each grant, once it goes idle or expires.

    One instance per running agent process (not per platform): a single
    listener serves grants issued by ANY of this agent's pinned platforms,
    each verified against that platform's own key (see `authorize_grant`).
    """

    def __init__(
        self,
        *,
        models_dir: str,
        port: int,
        platforms: list[PlatformEntry],
        bind_host: str = "0.0.0.0",
        client_factory: Callable[..., httpx.Client] = httpx.Client,
    ):
        self._index = _ModelIndex(models_dir)
        self._tracker = _GrantTracker()
        self._platforms = list(platforms)
        self._client_factory = client_factory
        state = _ServerState(self._index, self._platforms, self._tracker)
        handler_cls = _make_handler_class(state)
        self._httpd = ThreadingHTTPServer((bind_host, port), handler_cls)
        self._httpd.daemon_threads = True
        self._serve_thread = threading.Thread(
            target=self._httpd.serve_forever, name="comfyfed-peerserve", daemon=True
        )
        self._reporter_stop = threading.Event()
        self._reporter_thread = threading.Thread(
            target=self._reporter_loop, name="comfyfed-peer-reporter", daemon=True
        )
        self._started = False

    @property
    def port(self) -> int:
        """The actually-bound port (equal to the requested `port` unless it
        was 0, which tests use for an ephemeral port)."""
        return self._httpd.server_address[1]

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        self._serve_thread.start()
        self._reporter_thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        """Stop accepting connections and join both background threads.
        Idempotent -- safe to call even if `start()` was never called or
        `stop()` already ran."""
        self._reporter_stop.set()
        try:
            self._httpd.shutdown()
        except Exception:
            logger.exception("peerserve: error shutting down the HTTP listener")
        try:
            self._httpd.server_close()
        except Exception:
            logger.exception("peerserve: error closing the HTTP listener socket")
        if self._serve_thread.is_alive():
            self._serve_thread.join(timeout=timeout)
        if self._reporter_thread.is_alive():
            self._reporter_thread.join(timeout=timeout)
        # 限速桶是模組全域的：listener 收掉之後把它歸位成「不限速」，免得下一
        # 個 listener 在 runner 套用分級之前，先沿用上一輪留下的速率。
        # The bucket is a module global; reset it so a later listener does not
        # inherit whatever rate this one happened to leave behind.
        _UPLOAD_THROTTLE.set_rate(None)

    def set_upload_limit_mbps(self, mbps: float) -> None:
        """設定做種上傳上限（Mbps，百萬位元/秒）；`0`（或負數／非數字）= 不限速。

        Set the shared seeding cap in megabits per second; `0` (or anything
        non-positive/unparseable) means unlimited. This module stays free of
        any idle/control dependency -- the runner decides WHICH tier applies
        and calls this once per control tick (see `runner._control_loop`).
        """
        try:
            value = float(mbps)
        except (TypeError, ValueError):
            value = 0.0
        if not math.isfinite(value) or value <= 0:
            _UPLOAD_THROTTLE.set_rate(None)
            return
        _UPLOAD_THROTTLE.set_rate(value * 1_000_000 / 8)

    def pop_served(self) -> dict:
        """Snapshot + zero every grant's served-bytes counter (test hook and
        general introspection; the reporter loop uses `bytes_for` directly
        so it can report one grant at a time)."""
        return self._tracker.pop_served()

    def _reporter_loop(self) -> None:
        # A final pass right before the stop flag is honored catches a grant
        # that went idle/expired in the last few seconds of the agent's life
        # instead of losing that bandwidth credit entirely.
        while not self._reporter_stop.wait(_REPORT_POLL_SECONDS):
            self._report_due_grants()
        self._report_due_grants()

    def _report_due_grants(self) -> None:
        for grant_id in self._tracker.due_for_report():
            platform = self._tracker.platform_for(grant_id)
            bytes_served = self._tracker.bytes_for(grant_id)
            if platform is None or bytes_served <= 0:
                # Nothing (or nothing attributable) to report -- e.g. a grant
                # that was verified but no bytes were ever actually streamed
                # (a 416/error after auth, or the puller never followed up).
                self._tracker.mark_reported(grant_id)
                continue
            if self._post_peer_served(platform, grant_id, bytes_served):
                self._tracker.mark_reported(grant_id)
                continue
            # M4 final-review fix: on failure, leave it un-reported so the
            # next poll retries (whatever additional bytes may have accrued
            # since) UP TO `_MAX_REPORT_ATTEMPTS` -- beyond that, a stuck
            # grant (platform pruned it, already booked by a prior attempt
            # that timed out client-side, or any other terminal rejection)
            # must not retry for the rest of this process's life.
            attempts = self._tracker.record_failed_attempt(grant_id)
            if attempts >= _MAX_REPORT_ATTEMPTS:
                logger.warning(
                    "peerserve: giving up reporting bandwidth for grant %s after %d failed attempts",
                    grant_id, attempts,
                )
                self._tracker.mark_reported(grant_id)

    def _post_peer_served(self, entry: PlatformEntry, grant_id: str, bytes_served: int) -> bool:
        path = "/api/agent/peer-served"
        body = json.dumps({"grant_id": grant_id, "bytes_served": bytes_served}).encode()
        try:
            headers = signing.signed_headers(entry, "POST", path, body)
            headers["Content-Type"] = "application/json"
            with self._client_factory(base_url=entry.platform_url) as client:
                resp = client.post(path, content=body, headers=headers)
            if resp.status_code == 200:
                return True
            logger.warning(
                "peerserve: peer-served report for grant %s rejected (status=%s)",
                grant_id, resp.status_code,
            )
            return False
        except Exception:
            logger.exception("peerserve: failed to report peer-served for grant %s", grant_id)
            return False
