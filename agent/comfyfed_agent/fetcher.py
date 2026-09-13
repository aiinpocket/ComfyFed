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
"""

from __future__ import annotations

import hashlib
import logging
import ntpath
import os
import re
import shutil
import time
from typing import Awaitable, Callable, Optional

import httpx
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

from .comfy import JobCancelled

logger = logging.getLogger(__name__)

_CONNECT_TIMEOUT_SECONDS = 30.0
_READ_TIMEOUT_SECONDS = 120.0
_CHUNK_SIZE = 1024 * 1024  # 1 MiB, matching hardware._HASH_READ_CHUNK
_PART_SUFFIX = ".part"

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
    """
    name = entry.get("name")
    sha256 = entry.get("sha256")
    size_bytes = entry.get("size_bytes")
    sha256_ok = isinstance(sha256, str) and bool(_SHA256_HEX_RE.match(sha256))
    size_ok = (
        isinstance(size_bytes, int) and not isinstance(size_bytes, bool) and size_bytes > 0
    )
    if not sha256_ok or not size_ok:
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
    """
    name = entry.get("name")
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


async def _download_one(
    *,
    entry: dict,
    target_path: str,
    client: httpx.AsyncClient,
    cancel_event,
    on_bytes: Callable[[int], Awaitable[None]],
) -> None:
    """Download one manifest entry to `target_path`, trying `url` then
    `backup_url`, each once plus one retry, verifying size + sha256 before
    an atomic rename. Every attempt's partial bytes are removed before the
    next one starts; the final failure names every URL tried.
    """
    name = entry.get("name")
    primary = entry.get("url") or None
    backup = entry.get("backup_url") or None
    attempts = [u for u in (primary, primary, backup, backup) if u]
    if not attempts:
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

    for url in attempts:
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

        if isinstance(expected_size, int) and written != expected_size:
            last_error = f"{url} -> size mismatch (got {written} bytes, expected {expected_size})"
            logger.warning("fetcher: %s", last_error)
            _safe_unlink(part_path)
            continue
        if expected_sha256 and digest.hexdigest() != expected_sha256:
            last_error = f"{url} -> sha256 mismatch"
            logger.warning("fetcher: sha256 mismatch downloading %r from %s", name, url)
            _safe_unlink(part_path)
            continue

        os.replace(part_path, target_path)
        return

    raise FetchError(
        f"模型 {name} 下載失敗（已嘗試：{', '.join(urls_tried)}）：{last_error} / "
        f"failed to download model {name} (tried: {', '.join(urls_tried)}): {last_error}"
    )


async def fetch_and_verify_models(
    *,
    entries: list[dict],
    platform_pubkey_hex: str,
    models_dir: Optional[str],
    max_fetch_gb: float,
    cancel_event,
    report_progress: Callable[[float, Optional[str]], Awaitable[None]],
    client_factory: Callable[..., httpx.AsyncClient] = httpx.AsyncClient,
) -> None:
    """Verify, budget-check, and download every `fetch_models` entry.

    `report_progress(pct, model_name)` is awaited with the OVERALL percent
    (0-100, weighted by `size_bytes` across every entry, not per-file) and
    the name of the entry currently in flight, throttled to at most every
    `_PROGRESS_MIN_INTERVAL_SECONDS` or `_PROGRESS_MIN_PCT_STEP`.

    Raises `FetchError` (a signature, budget, disk, path, or download
    failure -- `str()` is the ready-to-report zh-TW-first message) or
    `comfy.JobCancelled` (cancel_event tripped, either a platform cancel or
    this process's own shutdown). Either way every `.part` file this call
    created is removed before the exception propagates; a `FetchError`
    guarantees NOTHING was downloaded when it is a verification/budget
    failure (those are checked for every entry before any download starts).
    """
    if not entries:
        return
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

    try:
        async with client_factory(
            timeout=httpx.Timeout(_READ_TIMEOUT_SECONDS), follow_redirects=True
        ) as client:
            for entry, target_path in targets:
                model_name = entry.get("name")

                async def _on_bytes(n: int, _name=model_name) -> None:
                    await on_bytes(_name, n)

                await _download_one(
                    entry=entry,
                    target_path=target_path,
                    client=client,
                    cancel_event=cancel_event,
                    on_bytes=_on_bytes,
                )
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
