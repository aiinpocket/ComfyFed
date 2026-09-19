"""Agent-side model auto-fetch: verify, download, and land manifest-pushed models.

Phase 2.1 Task 5. A `job` push may carry `fetch_models` (Task 4's server-side
addition -- see `comfyfed_server.model_manifest.entries` for the exact shape:
`name`/`directory`/`url`/`backup_url`/`sha256`/`size_bytes`/`sig`) whenever
this worker was dispatched a job it can only run AFTER downloading one or
more missing models. `fetch_and_verify_models` is the pre-phase
`runner.handle_job` runs before touching ComfyUI at all:

1. Verify every entry's platform signature (`sig`, hex Ed25519 over
   `f"{name}|{directory}|{sha256}|{size_bytes}"` -- MUST byte-for-byte match
   `model_manifest.entries`'s payload construction) against the dispatching
   platform's pinned `platform_pubkey`. Any single entry failing aborts the
   whole batch before anything is downloaded.
2. Enforce the configured `max_fetch_gb` budget and free disk space (via
   `shutil.disk_usage`) over the SUM of every entry's `size_bytes`, before
   any download starts.
3. Stream each entry's bytes (httpx, 1MB chunks, running sha256) to a
   `<target>.part` file under `models_dir/<directory>/<name>`, retrying once
   against the primary `url`, then once each against `backup_url`, verifying
   both size and hash before an atomic `os.replace` onto the final name.

Every failure (signature, budget, disk, sanitize, network, hash mismatch) and
every cancellation raises with every `.part` file this call created already
removed -- callers never need their own fetch-specific cleanup. A signature
failure or download failure raises `FetchError`, whose `str()` is already
the zh-TW-first bilingual message meant to be reported verbatim as the job's
`job_failed` error. A cancel_event trip (either a platform `job_cancelled` or
this process's own graceful shutdown -- both simply set the same
`asyncio.Event`, see `runner._JobHandle`) raises `comfy.JobCancelled`
directly, so it flows through `runner.handle_job`'s existing cancellation
branch exactly like a cancel mid-render: silently, no `job_failed` sent.

Phase 3.5（面板下載鈕）adds a SECOND entry shape, `unverified: true` (spec §6):
a url the platform approved but has never hashed, because no worker on the
fleet has the file yet -- so `sha256` is `null` and the signature covers the
url instead (`f"{name}|{directory}|{url}|{size_bytes}|unverified"`). Such an
entry is downloaded from that one signed https url only (no peer source, no
`backup_url`) and checked against `size_bytes` alone; the sha256 of whatever
landed is REPORTED rather than verified, and the platform learns the hash
from it (`fetch_and_verify_models`'s return value -> `job_done`'s
`fetched_models`, spec §9). Everything else -- budget, disk, path
sanitization, `.part` cleanup, cancellation -- is identical to a verified
entry's, and a verified entry's behavior is unchanged in every respect.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import ntpath
import os
import re
import shutil
import time
from typing import Awaitable, Callable, Optional
from urllib.parse import quote

import httpx
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

from . import hardware, signing
from .comfy import JobCancelled
from .config import PlatformEntry

logger = logging.getLogger(__name__)

_CONNECT_TIMEOUT_SECONDS = 30.0
_READ_TIMEOUT_SECONDS = 120.0
_CHUNK_SIZE = 1024 * 1024  # 1 MiB, matching hardware._HASH_READ_CHUNK
_PART_SUFFIX = ".part"

# Phase 3.1 P2P addendum (拉方/puller side). Peer chunk boundary MUST match
# hardware.CHUNK_SIZE (64 MiB, Global Constraints) -- reused directly rather
# than duplicated, since it also governs how `chunk_sha256s` offsets are
# computed on the seeder/reporting side.
_PEER_CHUNK_SIZE = hardware.CHUNK_SIZE
_PEER_GRANT_PATH = "/api/agent/peer-grant"
# Must byte-for-byte match comfyfed_agent.peerserve._ROUTE_PREFIX / the
# seeder's route -- duplicated (not imported) the same way peerserve itself
# duplicates comfyfed_server.peer's field ordering, per that module's own
# precedent for these cross-process wire-shape constants.
_PEER_ROUTE_PREFIX = "/peer/models/"
_PEER_GRANT_HEADER = "X-ComfyFed-Grant"
# Phase 3.4 §5：每個候選位址的 connect timeout 從 30 秒縮到 5 秒。現在一次
# grant 可能有多個位址要依序試（區網 → 對外），30 秒 × N 會讓一台連不到的
# 種子把整個 fetch 拖死；而平台在派 grant 之前已經驗過對外位址連得到
# （peerhealth），所以 5 秒對「真的活著」的種子綽綽有餘。
# read timeout 不變（120 秒）：那是傳輸中途的停頓，跟連不連得上無關。
_PEER_CONNECT_TIMEOUT_SECONDS = 5.0
_PEER_READ_TIMEOUT_SECONDS = 120.0
# Cap on consecutive re-grants that make NO forward progress (offset
# unchanged after re-verifying `.part`) before giving up on the peer source
# entirely -- without this, a seeder that keeps 403-ing a range while the
# platform keeps issuing fresh grants would re-grant forever, and the
# fetch-stage heartbeat would keep the job "alive" the whole time instead of
# ever failing or falling back (final review, Task 5).
_MAX_NO_PROGRESS_REGRANTS = 3


class _PeerGrantExpired(Exception):
    """The grant expired (403 from the seeder, or the locally-tracked
    `expires_at` already elapsed) -- caller re-requests a grant and resumes."""


class _PeerChunkMismatch(Exception):
    """One pulled chunk failed its `chunk_sha256s` check -- the peer source
    is abandoned entirely for this entry (whole `.part` cleared) in favor of
    the URL chain."""


class _PeerFailure(Exception):
    """Any other unrecoverable peer-source problem (malformed grant
    response, network error, unexpected HTTP status, short read) -- falls
    back to the URL chain the same as `_PeerChunkMismatch`."""

# Progress is reported at most this often OR on at least this big a jump in
# overall percent -- whichever comes first -- so a fast local download (many
# small chunks per second) never floods the platform with heartbeats, per
# the brief's "at most ~every 2 seconds or 5% steps".
_PROGRESS_MIN_INTERVAL_SECONDS = 2.0
_PROGRESS_MIN_PCT_STEP = 5.0

_SHA256_HEX_RE = re.compile(r"^[0-9a-fA-F]{64}$")


class FetchError(Exception):
    """A model auto-fetch pre-phase failure.

    `str(exc)` is already the zh-TW-first bilingual message this job's
    `job_failed` should carry verbatim -- callers must not reword or
    re-wrap it (see `runner.handle_job`'s generic `except Exception` branch,
    which does exactly that for every `FetchError`).
    """


def _is_safe_relative_path(path: str) -> bool:
    """True if `path` is a safe relative path (no absolute form in ANY
    sense, no `..` traversal component).

    Deliberately duplicated from `runner._is_safe_relative_path` rather than
    imported: `fetcher` is imported FROM `runner`, so importing back would
    be circular. See that function's docstring for the full rationale
    (including why a plain `os.path.isabs` check is not enough on Windows).
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


def _sanitize_name(name: object) -> str:
    """A manifest entry's `name` must be a single, safe path segment (a bare
    filename) -- never a traversal or an absolute/drive-relative path, and
    never containing a `:` (on Windows/NTFS, `name:stream` addresses an
    alternate data stream of `name` rather than creating a file called
    `name:stream` -- silently writing into/reading out of a hidden stream
    instead of the visible file a later scan or delete would expect)."""
    if (
        not isinstance(name, str)
        or not name
        or os.path.basename(name) != name
        or name in (".", "..")
        or ntpath.splitdrive(name)[0]
        or ":" in name
    ):
        raise FetchError(
            f"模型清單名稱不安全，拒絕下載：{name!r} / "
            f"unsafe model name in fetch manifest, refusing to download: {name!r}"
        )
    return name


def _validate_entry_shape(entry: dict) -> None:
    """Fail closed on a manifest entry whose `sha256`/`size_bytes` are not
    shaped so that `_download_one` can actually verify them.

    `_download_one`'s hash/size checks are conditional (`if expected_sha256`,
    `isinstance(expected_size, int)`) so a download can be VERIFIED against
    whatever is present -- but that means an entry with a falsy/malformed
    `sha256` (missing, empty, not 64 hex chars) or a non-positive/non-int
    `size_bytes` would have its download checks silently skipped instead of
    failed, landing an unverified file. Checked for every entry BEFORE any
    signature verification or download, so a malformed entry is rejected
    the same way a bad signature is: nothing downloaded, one clear error.

    Phase 3.5（面板下載鈕）: an `unverified: true` entry (spec §6 -- a URL the
    platform approved but has never hashed, because nobody on the fleet has
    the file yet) legitimately has NO sha256, so the hash requirement flips
    to `sha256 is None` EXACTLY -- an entry claiming both shapes at once is
    malformed, not a free pass around the hash check. `size_bytes` stays a
    positive int either way (with no hash it is the ONLY integrity signal
    the download has left), and the `url` must be a non-empty https string:
    the platform's approval of that url IS the whole trust basis here, and
    plaintext would let anyone on the path swap the bytes undetected.
    """
    name = entry.get("name")
    sha256 = entry.get("sha256")
    size_bytes = entry.get("size_bytes")
    url = entry.get("url")
    if entry.get("unverified") is True:
        sha256_ok = sha256 is None
        url_ok = isinstance(url, str) and url.startswith("https://")
    else:
        sha256_ok = isinstance(sha256, str) and bool(_SHA256_HEX_RE.match(sha256))
        url_ok = True
    size_ok = (
        isinstance(size_bytes, int) and not isinstance(size_bytes, bool) and size_bytes > 0
    )
    if not sha256_ok or not size_ok or not url_ok:
        raise FetchError(f"模型清單條目無效：{name} / invalid manifest entry: {name}")


def _sanitize_directory(directory: object) -> str:
    """A manifest entry's `directory` may be empty (models root) or a safe
    relative subpath -- never a traversal or an absolute/drive-relative path."""
    if directory in (None, ""):
        return ""
    if not isinstance(directory, str) or not _is_safe_relative_path(directory):
        raise FetchError(
            f"模型清單資料夾不安全，拒絕下載：{directory!r} / "
            f"unsafe model directory in fetch manifest, refusing to download: {directory!r}"
        )
    return directory


def _resolve_target_path(models_dir: str, entry: dict) -> str:
    """`models_dir/<sanitized directory>/<sanitized name>`, with a second,
    independent check (realpath + commonpath, mirroring
    `runner._safe_remove_under`'s belt-and-suspenders approach) that the
    resolved path is still actually under `models_dir` before anything is
    created there.
    """
    name = _sanitize_name(entry.get("name"))
    directory = _sanitize_directory(entry.get("directory"))

    target_dir = (
        os.path.join(models_dir, *directory.replace("\\", "/").split("/"))
        if directory
        else models_dir
    )
    target_path = os.path.join(target_dir, name)

    base_real = os.path.realpath(models_dir)
    target_real = os.path.realpath(target_path)
    try:
        inside = os.path.commonpath([base_real, target_real]) == base_real
    except ValueError:
        inside = False
    if not inside:
        raise FetchError(
            f"模型路徑不安全，拒絕下載：{name!r} / "
            f"unsafe resolved model path, refusing to download: {name!r}"
        )

    os.makedirs(target_dir, exist_ok=True)
    return target_path


def _verify_entry_signature(entry: dict, platform_pubkey_hex: str) -> None:
    """Verify one manifest entry's `sig` against the platform's pinned
    Ed25519 public key. The signed payload MUST match
    `model_manifest.entries`'s construction byte-for-byte:
    `f"{name}|{directory}|{sha256}|{size_bytes}"`.

    Phase 3.5（面板下載鈕）: an `unverified: true` entry has no sha256 to sign
    over, so its payload covers the URL instead (spec §6):
    `f"{name}|{directory}|{url}|{size_bytes}|unverified"` -- matching
    `model_fetch.unverified_payload` byte-for-byte. That is what makes the url
    un-substitutable in flight, which matters far more here than for a
    verified entry: with no hash to check the bytes against, "the platform
    approved THIS url" is the only thing standing between the worker and
    an attacker-chosen download.
    """
    name = entry.get("name")
    if entry.get("unverified") is True:
        payload = (
            f"{name}|{entry.get('directory')}|{entry.get('url')}|"
            f"{entry.get('size_bytes')}|unverified"
        )
    else:
        payload = f"{name}|{entry.get('directory')}|{entry.get('sha256')}|{entry.get('size_bytes')}"
    sig = entry.get("sig")
    try:
        if not isinstance(sig, str):
            raise ValueError("sig is not a string")
        verify_key = VerifyKey(bytes.fromhex(platform_pubkey_hex))
        verify_key.verify(payload.encode(), bytes.fromhex(sig))
    except (BadSignatureError, ValueError, TypeError):
        raise FetchError(
            f"模型清單簽章驗證失敗：{name} / manifest signature verification failed: {name}"
        ) from None


def _check_budget_and_disk(entries: list[dict], max_fetch_gb: float, models_dir: str) -> None:
    """Enforce `Σ size_bytes <= max_fetch_gb` and `Σ size_bytes <= free disk`,
    both BEFORE any download starts (a mid-batch failure here must never
    leave a half-downloaded set of models on disk)."""
    total_bytes = sum(int(e.get("size_bytes") or 0) for e in entries)
    max_bytes = int(max_fetch_gb * (1024 ** 3))
    if total_bytes > max_bytes:
        raise FetchError(
            f"待下載模型總大小 {total_bytes / (1024 ** 3):.2f} GB 超過設定上限 "
            f"{max_fetch_gb:.2f} GB，拒絕下載 / "
            f"total fetch size {total_bytes / (1024 ** 3):.2f} GB exceeds the configured "
            f"max_fetch_gb={max_fetch_gb:.2f} GB, refusing to download"
        )

    os.makedirs(models_dir, exist_ok=True)
    try:
        free_bytes = shutil.disk_usage(models_dir).free
    except OSError as exc:
        raise FetchError(
            f"無法讀取磁碟空間資訊：{models_dir} / "
            f"could not read free disk space for {models_dir}: {exc}"
        ) from exc

    if total_bytes > free_bytes:
        raise FetchError(
            f"磁碟空間不足：需要 {total_bytes / (1024 ** 3):.2f} GB，僅剩 "
            f"{free_bytes / (1024 ** 3):.2f} GB / "
            f"insufficient free disk space: need {total_bytes / (1024 ** 3):.2f} GB, only "
            f"{free_bytes / (1024 ** 3):.2f} GB free"
        )


def _safe_unlink(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def _finalize_download(
    *,
    part_path: str,
    target_path: str,
    expected_sha256,
    expected_size,
    source_label: str,
    written_size: Optional[int] = None,
    precomputed_sha256: Optional[str] = None,
) -> Optional[str]:
    """Final whole-file size + SHA-256 verify, then atomic `os.replace` onto
    `target_path` -- shared by BOTH the URL path (`_download_one`, which
    already has a streaming digest/byte-count in hand -- passed as
    `written_size`/`precomputed_sha256` to avoid a second read) and the peer
    path (which re-reads `part_path` from disk here, since its chunks are
    verified individually, not against a running whole-file digest).

    `expected_sha256=None` (Phase 3.5's unverified-source entries, spec §6)
    skips the hash comparison -- there is no hash to compare against -- but
    NOT the size comparison: `_validate_entry_shape` guarantees those entries
    still carry a positive int `size_bytes`, so the size branch below always
    runs for them and stays their one integrity check.

    Returns `None` on success (file is now at `target_path`), or an error
    message with `part_path` already removed on failure. Never raises for an
    OSError while stat'ing/reading -- folded into the returned message like
    every other download failure.
    """
    try:
        size = written_size if written_size is not None else os.path.getsize(part_path)
    except OSError as exc:
        _safe_unlink(part_path)
        return f"{source_label} -> could not stat downloaded file: {exc}"

    if isinstance(expected_size, int) and size != expected_size:
        _safe_unlink(part_path)
        return f"{source_label} -> size mismatch (got {size} bytes, expected {expected_size})"

    if expected_sha256:
        digest_hex = precomputed_sha256
        if digest_hex is None:
            digest = hashlib.sha256()
            try:
                with open(part_path, "rb") as f:
                    for chunk in iter(lambda: f.read(_CHUNK_SIZE), b""):
                        digest.update(chunk)
            except OSError as exc:
                _safe_unlink(part_path)
                return f"{source_label} -> could not read downloaded file: {exc}"
            digest_hex = digest.hexdigest()
        if digest_hex != expected_sha256:
            _safe_unlink(part_path)
            return f"{source_label} -> sha256 mismatch"

    os.replace(part_path, target_path)
    return None


def _is_verified_mismatch(error: str) -> bool:
    """True iff `_finalize_download`'s error came from a whole-file size or
    sha256 check that actually ran against fully-downloaded bytes -- i.e. the
    transfer completed and the content is definitively wrong, not merely
    unreadable/unstatable (those remain retry-worthy, like a network error).
    A verified mismatch is deterministic: retrying the SAME url will produce
    the same bytes and fail again, so it must not consume a second attempt
    against that url (see `_download_one`).
    """
    return "size mismatch (" in error or error.endswith("sha256 mismatch")


async def _download_one(
    *,
    entry: dict,
    target_path: str,
    client: httpx.AsyncClient,
    cancel_event,
    on_bytes: Callable[[int], Awaitable[None]],
) -> str:
    """Download one manifest entry to `target_path`, trying `url` then
    `backup_url`, verifying size + sha256 before an atomic rename. Returns
    the hex SHA-256 of the bytes that actually landed -- for a verified
    entry that is necessarily the entry's own `sha256` (it was just checked
    against it), for an unverified one it is what the platform is told the
    file turned out to be (spec §9's `fetched_models`).

    Each distinct source gets up to two attempts (one retry) for
    transient/network failures. A VERIFIED content mismatch (whole-file size
    or sha256 check against fully-downloaded bytes) is deterministic -- the
    same url will just re-download the same wrong bytes -- so it is NOT
    retried against that same url; the next distinct source is tried
    immediately instead. Every attempt's partial bytes are removed before the
    next one starts; the final failure names every URL tried.
    """
    name = entry.get("name")
    primary = entry.get("url") or None
    # Phase 3.5（面板下載鈕）: an unverified entry has exactly ONE approved
    # source -- the signed url. `backup_url` is a mirror the platform
    # vouched for BY HASH, and with no hash there is nothing tying that
    # mirror's bytes to the approved download, so it is not a fallback here.
    # (The server already sends `backup_url: null` for these; this makes the
    # agent side fail closed rather than trust that it always will.)
    backup = None if entry.get("unverified") is True else (entry.get("backup_url") or None)
    sources = [u for u in (primary, backup) if u]
    if not sources:
        raise FetchError(f"模型 {name} 沒有可用的下載網址 / model {name} has no download url")

    expected_sha256 = entry.get("sha256")
    expected_size = entry.get("size_bytes")
    part_path = target_path + _PART_SUFFIX
    urls_tried: list[str] = []
    last_error = "unknown error"

    timeout = httpx.Timeout(
        connect=_CONNECT_TIMEOUT_SECONDS,
        read=_READ_TIMEOUT_SECONDS,
        write=_READ_TIMEOUT_SECONDS,
        pool=_CONNECT_TIMEOUT_SECONDS,
    )

    for url in sources:
        for _attempt in range(2):
            urls_tried.append(url)
            if cancel_event.is_set():
                _safe_unlink(part_path)
                raise JobCancelled()

            digest = hashlib.sha256()
            written = 0
            try:
                async with client.stream("GET", url, timeout=timeout) as resp:
                    resp.raise_for_status()
                    if resp.is_redirect or 300 <= resp.status_code < 400:
                        # Belt-and-suspenders: the client is constructed with
                        # follow_redirects=True, so this should never trigger in
                        # production, but a 3xx must never be treated as success
                        # via the size-mismatch branch below (an un-followed
                        # redirect's body is empty/small, not a hash mismatch).
                        raise RuntimeError(f"unexpected redirect status {resp.status_code}")
                    with open(part_path, "wb") as f:
                        async for chunk in resp.aiter_bytes(_CHUNK_SIZE):
                            if cancel_event.is_set():
                                raise JobCancelled()
                            f.write(chunk)
                            digest.update(chunk)
                            written += len(chunk)
                            await on_bytes(len(chunk))
            except JobCancelled:
                _safe_unlink(part_path)
                raise
            except Exception as exc:
                last_error = f"{url} -> {exc}"
                logger.warning("fetcher: download attempt for %r from %s failed: %s", name, url, exc)
                _safe_unlink(part_path)
                continue

            digest_hex = digest.hexdigest()
            error = _finalize_download(
                part_path=part_path,
                target_path=target_path,
                expected_sha256=expected_sha256,
                expected_size=expected_size,
                source_label=url,
                written_size=written,
                precomputed_sha256=digest_hex,
            )
            if error is not None:
                last_error = error
                logger.warning("fetcher: %s", error)
                if _is_verified_mismatch(error):
                    # Deterministic failure -- do not burn the retry on the
                    # same url, move straight to the next distinct source.
                    break
                continue

            return digest_hex

    raise FetchError(
        f"模型 {name} 下載失敗（已嘗試：{', '.join(urls_tried)}）：{last_error} / "
        f"failed to download model {name} (tried: {', '.join(urls_tried)}): {last_error}"
    )


# --- Phase 3.1 P2P addendum (拉方/puller side) --------------------------------


def _inventory_name(entry: dict) -> str:
    """The `dir/file`-shaped inventory name `hardware.scan_models` (and
    therefore `db.ModelHash`/peer-grant/peerserve) uses for this entry --
    NOT the bare `name` field a fetch-manifest entry carries (see
    `model_manifest.entries`'s separate `name`/`directory` fields). Built
    from the SAME already-sanitized values `_resolve_target_path` validated
    for this entry earlier in `fetch_and_verify_models`."""
    name = entry.get("name")
    directory = (entry.get("directory") or "").replace("\\", "/").strip("/")
    return f"{directory}/{name}" if directory else name


def _seeder_urls(grant_response: dict) -> list[str]:
    """這張 grant 該依序嘗試的種子位址（spec §5）。新平台給 `seeder_urls`
    （第一個就等於 `peer_url`）；舊平台只有 `peer_url`，退回單元素清單。
    型別不對的 `seeder_urls` 一律當作沒有 —— 一個惡意／壞掉的平台回應不該
    讓 agent 去連一串不知道是什麼的東西。"""
    urls = grant_response.get("seeder_urls")
    if isinstance(urls, list):
        cleaned = [u for u in urls if isinstance(u, str) and u]
        if cleaned:
            return cleaned
    peer_url = grant_response.get("peer_url")
    return [peer_url] if isinstance(peer_url, str) and peer_url else []


async def _request_peer_grant(
    *,
    platform_entry: PlatformEntry,
    name: str,
    size_bytes: int,
    client_factory: Callable[..., httpx.AsyncClient],
    is_url_sourced: bool = False,
) -> Optional[dict]:
    """`POST /api/agent/peer-grant` to the issuing platform. Returns the
    response body (`{"grant": {...+sig}, "peer_url": ..., "chunk_sha256s":
    ...}`) on a 200, or `None` on ANY other outcome -- a typed 404
    (`peer.no_seeder`/`peer.no_model`)/400 (`peer.already_has_model`) refusal,
    an unexpected status, or a network failure all just fall back to the URL
    chain the same way, logged once at info level (never a warning/error:
    "no peer available" is an expected, routine outcome, not a fault) --
    EXCEPT (L5 final-review fix) a `peer.no_model` 404 for a URL-sourced
    entry (`is_url_sourced=True`), which is also the symptom of the guide/
    inventory directory mismatch `_inventory_name` can hit (model_guide's
    `directory` and `db.ModelHash.name`'s leniently-matched directory
    disagreeing -- see `model_manifest._find_hash_row`): that one gets a
    WARNING naming the possibility, since it otherwise silently degrades to
    "no peer available" indistinguishably from the routine case, every
    dispatch, with no signal pointing at the actual cause."""
    body = json.dumps({"name": name, "size_bytes": size_bytes}).encode()
    try:
        headers = signing.signed_headers(platform_entry, "POST", _PEER_GRANT_PATH, body)
        headers["Content-Type"] = "application/json"
        async with client_factory(base_url=platform_entry.platform_url) as client:
            resp = await client.post(_PEER_GRANT_PATH, content=body, headers=headers)
        if resp.status_code != 200:
            code = None
            if is_url_sourced and resp.status_code == 404:
                try:
                    code = resp.json().get("error", {}).get("code")
                except Exception:
                    code = None
            if code == "peer.no_model":
                logger.warning(
                    "fetcher: peer grant unavailable for %r (peer.no_model) -- this can mean the "
                    "platform's learned model_hashes name disagrees with this entry's model_guide "
                    "directory (a guide/inventory directory mismatch), not just \"no consensus hash "
                    "yet\"; falling back to URL chain",
                    name,
                )
            else:
                logger.info(
                    "fetcher: peer grant unavailable for %r (status=%s), falling back to URL chain",
                    name, resp.status_code,
                )
            return None
        return resp.json()
    except Exception as exc:
        logger.info(
            "fetcher: peer grant request failed for %r (%s), falling back to URL chain", name, exc
        )
        return None


def _verify_local_chunks(part_path: str, chunk_sha256s: Optional[list], size_bytes: int) -> int:
    """Resume support: re-hash an existing `.part` chunk-by-chunk against
    `chunk_sha256s` (in `_PEER_CHUNK_SIZE` pieces), keep the longest verified
    PREFIX, and truncate the file to exactly that many bytes (dropping any
    trailing partial/invalid chunk). Returns the resulting byte offset to
    resume pulling from.

    No `chunk_sha256s` on the grant (M8 final-review fix): there is no way
    to verify anything already on disk chunk-by-chunk, but discarding the
    whole `.part` anyway means a large peer-only transfer on a link slower
    than TTL/size never converges -- every re-grant (once its TTL elapses) throws away
    everything pulled so far, forever. Instead, trust the existing bytes
    BLINDLY and resume appending from the current file size: the mandatory
    whole-file SHA-256 in `_finalize_download` is still the actual trust
    root regardless of chunk verification, exactly as it already is for the
    URL path (which never verifies mid-download either). Only a `.part`
    somehow LARGER than the expected `size_bytes` is discarded outright --
    that can't be a valid prefix of the target file no matter what's in it.
    """
    if not os.path.exists(part_path):
        return 0
    if not chunk_sha256s:
        try:
            existing_size = os.path.getsize(part_path)
        except OSError:
            _safe_unlink(part_path)
            return 0
        if existing_size > size_bytes:
            _safe_unlink(part_path)
            return 0
        return existing_size

    verified_bytes = 0
    try:
        with open(part_path, "rb") as f:
            for i, expected in enumerate(chunk_sha256s):
                chunk_start = i * _PEER_CHUNK_SIZE
                if chunk_start >= size_bytes:
                    break
                chunk_end = min(chunk_start + _PEER_CHUNK_SIZE, size_bytes)
                chunk_len = chunk_end - chunk_start
                data = f.read(chunk_len)
                if len(data) != chunk_len or hashlib.sha256(data).hexdigest() != expected:
                    break
                verified_bytes = chunk_end
    except OSError:
        _safe_unlink(part_path)
        return 0

    try:
        with open(part_path, "r+b") as f:
            f.truncate(verified_bytes)
    except OSError:
        _safe_unlink(part_path)
        return 0
    return verified_bytes


async def _pull_chunks_from_offset(
    *,
    entry: dict,
    inventory_name: str,
    target_path: str,
    grant_response: dict,
    peer_url: str,
    start_offset: int,
    cancel_event,
    on_bytes: Callable[[int], Awaitable[None]],
    client_factory: Callable[..., httpx.AsyncClient],
    ignore_chunk_verification: bool = False,
) -> None:
    """Pull `target_path`'s `.part` from `start_offset` through end-of-file
    via sequential `_PEER_CHUNK_SIZE` Range GETs against the seeder,
    appending each verified chunk. Raises `comfy.JobCancelled`,
    `_PeerGrantExpired`, `_PeerChunkMismatch`, or `_PeerFailure` -- never
    returns partway through, always either finishes (returns normally, every
    byte through `size_bytes` on disk) or raises.

    `ignore_chunk_verification=True` (the spec's 整檔重驗兜底, M2 final-review
    fix) skips the per-chunk hash check entirely regardless of whether the
    grant carries a `chunk_sha256s` list -- used for the one blind retry
    `_fetch_via_peer` makes after a chunk mismatch, since a poisoned/wrong
    chunk table must not be able to permanently block a peer-only model: the
    mandatory whole-file SHA-256 in `_finalize_download` is still the actual
    trust root either way."""
    size_bytes = entry.get("size_bytes")
    part_path = target_path + _PART_SUFFIX
    chunk_sha256s = None if ignore_chunk_verification else grant_response.get("chunk_sha256s")
    # Phase 3.4：位址由呼叫端逐一指定（`seeder_urls` 依序嘗試），不再從
    # grant 回應裡自己撈 —— 同一張 grant 可以對多個位址使用。
    grant = grant_response.get("grant")
    if not peer_url or not isinstance(grant, dict) or "sig" not in grant:
        raise _PeerFailure("malformed peer grant response")

    url = peer_url.rstrip("/") + _PEER_ROUTE_PREFIX + quote(inventory_name, safe="")
    header_value = base64.b64encode(json.dumps(grant).encode()).decode()

    timeout = httpx.Timeout(
        connect=_PEER_CONNECT_TIMEOUT_SECONDS,
        read=_PEER_READ_TIMEOUT_SECONDS,
        write=_PEER_READ_TIMEOUT_SECONDS,
        pool=_PEER_CONNECT_TIMEOUT_SECONDS,
    )

    offset = start_offset
    async with client_factory(timeout=timeout) as client:
        while offset < size_bytes:
            if cancel_event.is_set():
                raise JobCancelled()
            if grant.get("expires_at", 0) <= time.time():
                raise _PeerGrantExpired()

            chunk_end = min(offset + _PEER_CHUNK_SIZE, size_bytes) - 1
            try:
                resp = await client.get(
                    url,
                    headers={_PEER_GRANT_HEADER: header_value, "Range": f"bytes={offset}-{chunk_end}"},
                )
            except Exception as exc:
                raise _PeerFailure(f"request error: {exc}") from exc

            if resp.status_code == 403:
                raise _PeerGrantExpired()
            if resp.status_code not in (200, 206):
                raise _PeerFailure(f"unexpected status {resp.status_code}")

            data = resp.content
            expected_len = chunk_end - offset + 1
            if len(data) != expected_len:
                raise _PeerFailure(
                    f"short chunk read (got {len(data)} bytes, expected {expected_len})"
                )

            if chunk_sha256s:
                chunk_index = offset // _PEER_CHUNK_SIZE
                if chunk_index < len(chunk_sha256s) and hashlib.sha256(data).hexdigest() != chunk_sha256s[chunk_index]:
                    raise _PeerChunkMismatch()

            with open(part_path, "ab") as f:
                f.write(data)
            offset = chunk_end + 1
            await on_bytes(expected_len)


async def _fetch_via_peer(
    *,
    entry: dict,
    target_path: str,
    platform_entry: PlatformEntry,
    cancel_event,
    on_bytes: Callable[[int], Awaitable[None]],
    peer_client_factory: Callable[..., httpx.AsyncClient],
    platform_client_factory: Callable[..., httpx.AsyncClient],
) -> bool:
    """Try the peer source for one manifest entry, end to end: grant, chunked
    pull (with resume + re-grant-on-expiry), final whole-file verify +
    atomic replace (via `_finalize_download`, the SAME helper `_download_one`
    uses).

    Returns `True` iff `target_path` now holds the fully verified file.
    `False` means "give up on peer for this entry, try the URL chain instead"
    -- every case reaching `False` has already logged once and cleaned up
    any `.part` bytes it can no longer vouch for. Raises `comfy.JobCancelled`
    on cancellation (unchanged existing behavior, handled by the caller).
    """
    if cancel_event.is_set():
        raise JobCancelled()

    name = entry.get("name")
    size_bytes = entry.get("size_bytes")
    inventory_name = _inventory_name(entry)
    part_path = target_path + _PART_SUFFIX
    is_url_sourced = entry.get("url") is not None

    grant_response = await _request_peer_grant(
        platform_entry=platform_entry,
        name=inventory_name,
        size_bytes=size_bytes,
        client_factory=platform_client_factory,
        is_url_sourced=is_url_sourced,
    )
    if grant_response is None:
        return False

    chunk_sha256s = grant_response.get("chunk_sha256s")
    offset = _verify_local_chunks(part_path, chunk_sha256s, size_bytes)
    if offset:
        await on_bytes(offset)

    # A seeder that keeps 403-ing (or a platform that keeps granting against
    # a seeder that never actually delivers a byte) must not re-grant
    # forever: the fetch-stage heartbeat keeps the job "alive" from the
    # platform's point of view, so an unbounded loop here would wedge the
    # job indefinitely rather than fail. Tracked as consecutive re-grant
    # attempts that land with NO forward progress (the resumed offset after
    # re-verifying `.part` is no larger than it was before this attempt);
    # reset the instant a re-grant DOES make progress. This is independent
    # of "a fresh grant could not be obtained at all" (_request_peer_grant
    # returning None), which already bails immediately with no cap needed.
    no_progress_regrants = 0
    # Set once a chunk mismatch has already triggered the one blind retry
    # below (M2 final-review fix, spec 整檔重驗兜底) -- a second mismatch while
    # ALREADY ignoring the chunk list is a genuine unrecoverable peer failure
    # (bad data from the network, not a bad chunk table), so it falls back to
    # the URL chain exactly as before.
    blind_retry_used = False
    # spec §5：依序嘗試每個位址，每個 connect 5 秒，全部失敗才落回官方
    # 載點鏈。`seeder_urls` 由平台排序（同 NAT ⇒ 區網優先）。
    candidate_urls = _seeder_urls(grant_response)
    if not candidate_urls:
        logger.info("fetcher: peer grant for %r carried no usable address, falling back to URL chain", name)
        return False
    url_index = 0

    while True:
        offset_before_attempt = offset
        ignore_chunks = blind_retry_used
        try:
            await _pull_chunks_from_offset(
                entry=entry,
                inventory_name=inventory_name,
                target_path=target_path,
                grant_response=grant_response,
                peer_url=candidate_urls[url_index],
                start_offset=offset,
                cancel_event=cancel_event,
                on_bytes=on_bytes,
                client_factory=peer_client_factory,
                ignore_chunk_verification=ignore_chunks,
            )
            break
        except _PeerGrantExpired:
            logger.info("fetcher: peer grant expired mid-transfer for %r, re-granting", name)
            new_grant_response = await _request_peer_grant(
                platform_entry=platform_entry,
                name=inventory_name,
                size_bytes=size_bytes,
                client_factory=platform_client_factory,
                is_url_sourced=is_url_sourced,
            )
            if new_grant_response is None:
                logger.info(
                    "fetcher: could not obtain a fresh peer grant for %r, falling back to URL chain",
                    name,
                )
                _safe_unlink(part_path)
                return False
            grant_response = new_grant_response
            chunk_sha256s = grant_response.get("chunk_sha256s")
            # 新 grant 可能指向不同的種子／不同的位址順序，整組換掉並從頭試。
            candidate_urls = _seeder_urls(grant_response) or candidate_urls
            url_index = 0
            # Recompute from disk: any bytes already pulled under the
            # expired grant were already reported via on_bytes as they
            # landed, so this must NOT be re-reported here.
            offset = _verify_local_chunks(part_path, chunk_sha256s, size_bytes)

            if offset > offset_before_attempt:
                no_progress_regrants = 0
            else:
                no_progress_regrants += 1
                if no_progress_regrants >= _MAX_NO_PROGRESS_REGRANTS:
                    logger.info(
                        "fetcher: peer source made no progress across %d re-grant(s) for %r, "
                        "falling back to URL chain",
                        no_progress_regrants, name,
                    )
                    _safe_unlink(part_path)
                    return False
            continue
        except _PeerChunkMismatch:
            if not blind_retry_used:
                # Spec's 整檔重驗兜底: a chunk list can be poisoned by a
                # malicious/buggy reporter (final-review M2) without the
                # whole-file hash itself being wrong, so a mismatch alone
                # must not permanently block a peer-only model. Discard the
                # chunk-verified prefix (it was checked against a chunk list
                # we no longer trust at all) and pull the ENTIRE file again
                # from this same seeder with chunk verification off -- the
                # mandatory whole-file SHA-256 below is still the actual
                # trust root, exactly as it always is.
                logger.info(
                    "fetcher: peer chunk hash mismatch for %r, retrying once blind "
                    "(ignoring chunk list, whole-file sha256 will adjudicate)", name
                )
                _safe_unlink(part_path)
                offset = 0
                blind_retry_used = True
                continue
            logger.info(
                "fetcher: peer chunk hash mismatch for %r persisted through the blind "
                "retry, falling back to URL chain", name
            )
            _safe_unlink(part_path)
            return False
        except _PeerFailure as exc:
            failed_url = candidate_urls[url_index]
            url_index += 1
            if url_index < len(candidate_urls):
                # 還有下一個位址（典型情況：對外位址 hairpin 不過，改走區網）。
                # `.part` 留著：同一張 grant、同一個檔案，換位址續傳即可。
                logger.info(
                    "fetcher: peer pull from %s failed for %r (%s), trying the next seeder address %s",
                    failed_url, name, exc, candidate_urls[url_index],
                )
                offset = _verify_local_chunks(part_path, chunk_sha256s, size_bytes)
                continue
            logger.info(
                "fetcher: peer pull failed for %r (%s) on every advertised address, "
                "falling back to URL chain", name, exc,
            )
            _safe_unlink(part_path)
            return False

    error = _finalize_download(
        part_path=part_path,
        target_path=target_path,
        expected_sha256=entry.get("sha256"),
        expected_size=size_bytes,
        source_label=f"peer:{candidate_urls[url_index]}",
    )
    if error is not None:
        logger.info("fetcher: peer whole-file verify failed for %r (%s), falling back to URL chain", name, error)
        return False
    return True


def _fetch_result(entry: dict, sha256) -> dict:
    """One `fetched_models` item for a landed entry (spec §9's shape).

    `name` is the entry's `name` VERBATIM -- not `_inventory_name`'s
    `dir/file` form -- because the server matches it against the job's
    `required_models`; anything else is dropped there with a warning or, for
    a model_fetch job, learned under the wrong key.
    """
    return {
        "name": entry.get("name"),
        "directory": entry.get("directory") or "",
        "size_bytes": int(entry.get("size_bytes") or 0),
        "sha256": sha256,
    }


async def fetch_and_verify_models(
    *,
    entries: list[dict],
    platform_pubkey_hex: str,
    models_dir: Optional[str],
    max_fetch_gb: float,
    cancel_event,
    report_progress: Callable[[float, Optional[str]], Awaitable[None]],
    client_factory: Callable[..., httpx.AsyncClient] = httpx.AsyncClient,
    platform_entry: Optional[PlatformEntry] = None,
    peer_client_factory: Callable[..., httpx.AsyncClient] = httpx.AsyncClient,
    platform_client_factory: Callable[..., httpx.AsyncClient] = httpx.AsyncClient,
) -> list[dict]:
    """Verify, budget-check, and download every `fetch_models` entry.

    Returns one `{name, directory, size_bytes, sha256}` dict per entry, in
    input order (`[]` for no entries) -- what `runner.handle_job` hands the
    platform as a `job_done`'s `fetched_models` so the server can LEARN the
    hash of a model it had never seen hashed before (spec §9). `name` is the
    entry's own `name` verbatim, because that is the key the server matches
    against the job's `required_models`; anything else is silently dropped
    there or lands as a duplicate hash row. Callers that only care about the
    files landing on disk (every pre-3.5 one) just ignore the return value.

    `report_progress(pct, model_name)` is awaited with the OVERALL percent
    (0-100, weighted by `size_bytes` across every entry, not per-file) and
    the name of the entry currently in flight, throttled to at most every
    `_PROGRESS_MIN_INTERVAL_SECONDS` or `_PROGRESS_MIN_PCT_STEP`.

    Phase 3.1 P2P addendum: when `platform_entry` (the PlatformEntry of the
    platform that dispatched this job -- `conn.entry` in `runner.handle_job`)
    is given, EVERY entry tries the peer source FIRST via that platform's
    `/api/agent/peer-grant`, before its URL chain -- see `_fetch_via_peer`.
    `platform_entry=None` (the default, and every pre-3.1 caller) skips the
    peer attempt entirely and behaves exactly as before. An entry shaped
    `{"url": None, "peer": True}` (peer-only, Task 6) skips the URL chain
    entirely: a failed/unavailable peer source for one of those is a fetch
    failure via the same `FetchError` path as any other download failure,
    not a silent fall-through to a URL chain that doesn't exist for it.

    Raises `FetchError` (a signature, budget, disk, path, or download
    failure -- `str()` is the ready-to-report zh-TW-first message) or
    `comfy.JobCancelled` (cancel_event tripped, either a platform cancel or
    this process's own shutdown). Either way every `.part` file this call
    created is removed before the exception propagates; a `FetchError`
    guarantees NOTHING was downloaded when it is a verification/budget
    failure (those are checked for every entry before any download starts).
    """
    if not entries:
        return []
    if not models_dir:
        raise FetchError(
            "此 worker 未設定 models_dir，無法自動下載模型 / "
            "models_dir is not configured on this worker; cannot auto-fetch models"
        )

    for entry in entries:
        _validate_entry_shape(entry)
        _verify_entry_signature(entry, platform_pubkey_hex)

    _check_budget_and_disk(entries, max_fetch_gb, models_dir)

    targets = [(entry, _resolve_target_path(models_dir, entry)) for entry in entries]

    if cancel_event.is_set():
        raise JobCancelled()

    total_bytes = sum(int(e.get("size_bytes") or 0) for e in entries) or 1
    state = {"downloaded": 0, "last_time": time.monotonic(), "last_pct": 0.0}

    async def on_bytes(model_name: str, n: int) -> None:
        state["downloaded"] += n
        pct = min(100.0, state["downloaded"] / total_bytes * 100.0)
        now = time.monotonic()
        if (
            now - state["last_time"] >= _PROGRESS_MIN_INTERVAL_SECONDS
            or pct - state["last_pct"] >= _PROGRESS_MIN_PCT_STEP
            or pct >= 100.0
        ):
            state["last_time"] = now
            state["last_pct"] = pct
            await report_progress(pct, model_name)

    created_parts = [target_path + _PART_SUFFIX for _entry, target_path in targets]
    results: list[dict] = []

    try:
        async with client_factory(
            timeout=httpx.Timeout(_READ_TIMEOUT_SECONDS), follow_redirects=True
        ) as client:
            for entry, target_path in targets:
                model_name = entry.get("name")
                is_peer_only = entry.get("url") is None and entry.get("peer") is True
                # Phase 3.5（面板下載鈕）: a peer can only be asked for bytes the
                # platform already holds a hash for (the grant is minted
                # against `model_hashes`), and an unverified entry exists
                # precisely because no such hash exists yet -- so the peer
                # source is skipped outright rather than attempted and failed.
                is_unverified = entry.get("unverified") is True

                async def _on_bytes(n: int, _name=model_name) -> None:
                    await on_bytes(_name, n)

                peer_ok = False
                if platform_entry is not None and not is_unverified:
                    peer_ok = await _fetch_via_peer(
                        entry=entry,
                        target_path=target_path,
                        platform_entry=platform_entry,
                        cancel_event=cancel_event,
                        on_bytes=_on_bytes,
                        peer_client_factory=peer_client_factory,
                        platform_client_factory=platform_client_factory,
                    )
                if peer_ok:
                    # The peer path verifies against the entry's own sha256
                    # (`_finalize_download`), so that IS the landed digest.
                    results.append(_fetch_result(entry, entry.get("sha256")))
                    continue

                if is_peer_only:
                    raise FetchError(
                        f"模型 {model_name} 沒有可用的下載網址（點對點來源失敗）/ "
                        f"model {model_name} has no download url (peer source failed)"
                    )

                digest = await _download_one(
                    entry=entry,
                    target_path=target_path,
                    client=client,
                    cancel_event=cancel_event,
                    on_bytes=_on_bytes,
                )
                results.append(_fetch_result(entry, digest))
    except (JobCancelled, FetchError):
        for part_path in created_parts:
            _safe_unlink(part_path)
        raise
    except Exception as exc:
        for part_path in created_parts:
            _safe_unlink(part_path)
        raise FetchError(
            f"模型下載發生未預期錯誤 / unexpected error while fetching models: {exc}"
        ) from exc

    await report_progress(100.0, None)
    return results
