"""Hardware/backend reporting and local model inventory scanning.

Every function here is individually mockable: no test should need a real GPU,
`nvidia-smi`, or network access. `comfy_url` is accepted for symmetry with
other agent modules but not currently used to probe ComfyUI's own hardware
report.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import platform
import shutil
import subprocess
import threading

import psutil

from . import __version__

logger = logging.getLogger(__name__)

_HASH_SIDECAR_NAME = ".comfyfed_hashes.json"
_HASH_READ_CHUNK = 1024 * 1024  # 1 MiB, per the brief's "1MB read loop"
# P2P chunk boundary (Phase 3.1 addendum, 分塊雜湊). Fixed at 64 MiB so every
# agent and the server (`model_hashes.chunk_sha256s`) agree on chunk offsets
# without exchanging a chunk size out of band.
CHUNK_SIZE = 64 * 1024 * 1024

# In-flight hashing threads, keyed by absolute file path, so a scan pass
# never schedules a second thread for a file that is already being hashed --
# a large model can take minutes, and the 10-minute rescan loop must not
# pile up duplicate hashers for it in the meantime. Module-level (not
# per-call) because scan_models itself is synchronous and returns long
# before the hash finishes.
_HASH_LOCK = threading.Lock()
_IN_FLIGHT: dict[str, threading.Thread] = {}


def _run_nvidia_smi(args: list[str]) -> str:
    result = subprocess.run(
        ["nvidia-smi", *args],
        capture_output=True,
        text=True,
        timeout=5,
        check=True,
    )
    return result.stdout.strip()


def collect_hardware(comfy_url: str) -> dict:
    """Gather this machine's hardware summary for the WS `hello` message."""
    gpu_name = None
    vram_gb = None
    try:
        line = _run_nvidia_smi(
            ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]
        ).splitlines()[0]
        name, mem_mib = [part.strip() for part in line.split(",")]
        gpu_name = name
        vram_gb = round(float(mem_mib) / 1024.0, 1)
    except Exception:
        pass

    return {
        "gpu_name": gpu_name,
        "vram_gb": vram_gb,
        "cpu": platform.processor() or platform.machine(),
        "cpu_cores": psutil.cpu_count(logical=True),
        "ram_gb": round(psutil.virtual_memory().total / (1024 ** 3), 1),
        "agent_version": __version__,
        # "Windows" | "Darwin" | "Linux" -- lets the platform tell a Mac/CPU
        # worker apart from a headless Linux box even when `backend` alone
        # (cuda/rocm/mps/cpu) is ambiguous (a Linux box can be "cpu" too).
        "platform": platform.system(),
    }


def detect_backend() -> tuple[str, str]:
    """Detect the compute backend and, if importable, the installed torch version."""
    backend = "cpu"
    try:
        _run_nvidia_smi(["--query-gpu=name", "--format=csv,noheader"])
        backend = "cuda"
    except Exception:
        try:
            subprocess.run(
                ["rocm-smi"], capture_output=True, text=True, timeout=5, check=True
            )
            backend = "rocm"
        except Exception:
            if platform.system() == "Darwin":
                backend = "mps"

    torch_version = ""
    try:
        import torch  # type: ignore

        torch_version = getattr(torch, "__version__", "")
    except Exception:
        pass

    return backend, torch_version


def collect_dynamic(model_dir_or_none: str | None) -> dict:
    """Gather point-in-time free-resource figures for a heartbeat message."""
    free_vram_gb = None
    try:
        line = _run_nvidia_smi(
            ["--query-gpu=memory.free", "--format=csv,noheader,nounits"]
        ).splitlines()[0]
        free_vram_gb = round(float(line.strip()) / 1024.0, 1)
    except Exception:
        pass

    free_ram_gb = None
    try:
        free_ram_gb = round(psutil.virtual_memory().available / (1024 ** 3), 1)
    except Exception:
        pass

    free_disk_gb = None
    try:
        disk_path = model_dir_or_none if model_dir_or_none else os.getcwd()
        free_disk_gb = round(shutil.disk_usage(disk_path).free / (1024 ** 3), 1)
    except Exception:
        pass

    return {
        "free_vram_gb": free_vram_gb,
        "free_ram_gb": free_ram_gb,
        "free_disk_gb": free_disk_gb,
    }


def _hash_file_sha256(path: str) -> tuple[str, list[str]]:
    """Single-pass whole-file SHA-256 + per-`CHUNK_SIZE` chunk SHA-256 list.

    `path` is read exactly once, in `_HASH_READ_CHUNK` (1 MiB) pieces so a
    multi-GB model never needs to be loaded into memory whole; each piece
    feeds both the running whole-file digest and the current 64 MiB chunk
    digest. When the chunk digest reaches `CHUNK_SIZE` bytes it is finalized
    and a fresh one started -- this is what makes the per-chunk hashes
    (Phase 3.1 addendum, 分塊雜湊) "free": no second read pass over the file.

    Returns `(whole_file_sha256_hex, [chunk_sha256_hex, ...])`. The last
    chunk is short unless the file size is an exact multiple of
    `CHUNK_SIZE`. A file smaller than one chunk (including an empty file)
    yields exactly one chunk hash, equal to the whole-file hash.
    """
    whole = hashlib.sha256()
    chunk_hashes: list[str] = []
    chunk = hashlib.sha256()
    chunk_bytes = 0
    with open(path, "rb") as f:
        for piece in iter(lambda: f.read(_HASH_READ_CHUNK), b""):
            whole.update(piece)
            offset = 0
            while offset < len(piece):
                room = CHUNK_SIZE - chunk_bytes
                take = piece[offset : offset + room]
                chunk.update(take)
                chunk_bytes += len(take)
                offset += len(take)
                if chunk_bytes == CHUNK_SIZE:
                    chunk_hashes.append(chunk.hexdigest())
                    chunk = hashlib.sha256()
                    chunk_bytes = 0
    if chunk_bytes > 0 or not chunk_hashes:
        # Trailing partial chunk, or a file with no bytes at all (an empty
        # file never enters the loop above, so without this it would end up
        # with zero chunk hashes instead of the required one).
        chunk_hashes.append(chunk.hexdigest())
    return whole.hexdigest(), chunk_hashes


def _load_hash_cache(cache_path: str) -> dict:
    """Read the sidecar hash cache, tolerating any corruption.

    A scan must never crash because `.comfyfed_hashes.json` got truncated by
    a killed process, hand-edited, or written by an incompatible future
    version -- any read/parse/shape problem just starts fresh (empty cache),
    which only costs a re-hash, never a crashed scan.
    """
    try:
        with open(cache_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return data


def _save_hash_cache_atomic(cache_path: str, cache: dict) -> None:
    """Write the sidecar hash cache via temp-file + os.replace.

    This runs from a background hashing thread that can be killed by process
    exit at any point; without the temp+replace dance a crash mid-write would
    leave a truncated JSON file for the next scan's `_load_hash_cache` to
    trip over (handled, but avoidable).
    """
    tmp_path = f"{cache_path}.tmp-{os.getpid()}-{threading.get_ident()}"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(cache, f)
        os.replace(tmp_path, cache_path)
    except OSError:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise


def _hash_worker(full_path: str, rel_path: str, cache_path: str, size_bytes: int, mtime: float) -> None:
    """Background job: hash one file and merge the result into the sidecar cache.

    Always removes itself from `_IN_FLIGHT` when done (success or failure) so
    a later scan pass can retry a file whose hash attempt failed (e.g. the
    file was deleted mid-hash).
    """
    try:
        digest, chunk_hashes = _hash_file_sha256(full_path)
    except OSError:
        logger.warning("hardware: failed to hash %s", full_path, exc_info=True)
        return
    finally:
        with _HASH_LOCK:
            _IN_FLIGHT.pop(full_path, None)

    with _HASH_LOCK:
        # Re-read + merge rather than overwrite: another file's hash may have
        # been written to this same cache file by a previous pass while this
        # one was in flight.
        cache = _load_hash_cache(cache_path)
        cache[rel_path] = {
            "size": size_bytes,
            "mtime": mtime,
            "sha256": digest,
            "chunk_sha256s": chunk_hashes,
        }
        try:
            _save_hash_cache_atomic(cache_path, cache)
        except OSError:
            logger.warning("hardware: failed to write hash cache %s", cache_path, exc_info=True)


def scan_models(models_dir: str, hash_models: bool = True) -> list[dict]:
    """Walk `models_dir` and return the local model inventory.

    Returns `[{"name": "relative/posix/path", "size": <GB>, "size_bytes": <int>,
    "sha256": <hex>, "chunk_sha256s": [<hex>, ...]}, ...]`. `sha256` and
    `chunk_sha256s` are present only once known, and always together -- see
    below. `chunk_sha256s` (Phase 3.1 addendum) is the per-`CHUNK_SIZE`
    (64 MiB) chunk hash list computed in the SAME read pass as `sha256` (see
    `_hash_file_sha256`); an inventory report just forwards these entries
    verbatim (`runner.refresh_model_inventory`/`_handle_hello`), so there is
    no separate report-assembly step to keep in sync -- adding the field
    here is the whole change. `size_bytes` is the file's EXACT `os.stat().
    st_size` -- additive
    alongside `size` (GB, rounded, kept for display/back-compat with older
    server builds and the VRAM/disk estimates) so the server's signed
    fetch-manifest trust payload (Phase 2.1 Task 2) can pin the real byte
    length instead of reconstructing an approximation from rounded GB.

    `name` is relative to the models ROOT and therefore keeps its category
    directory: `diffusion_models/flux1-dev.safetensors`, not
    `flux1-dev.safetensors`. A workflow's loader value, by contrast, is
    relative to that node's CATEGORY folder, so the server must not compare
    the two as plain strings -- it matches them with
    `comfyfed_server.assess.matches_model_name`, which strips the leading
    category component. Keep this shape: reporting bare filenames instead
    would make models in different categories collide.

    `size` is the file size in **gigabytes**, rounded to 3 decimal places
    (~1 MB resolution) -- NOT bytes.

    The unit matters: this list goes out as the WS `inventory` message, and
    the server's VRAM estimate and free-disk headroom checks all work in GB
    (as do `collect_hardware`'s vram_gb/ram_gb and `collect_dynamic`'s
    free_*_gb). Reporting bytes here would inflate every estimate by ~10^9.

    Hashing is lazy and cached (Phase 2.1 model auto-distribution
    groundwork). A sidecar `<models_dir>/.comfyfed_hashes.json` maps relpath
    -> `{size, mtime, sha256, chunk_sha256s}`. On each call:

    - a file whose (size, mtime) match the cache AND whose cache entry
      already carries a non-empty `chunk_sha256s` gets its cached sha256 +
      chunk_sha256s immediately, with no re-read;
    - a file that is new, changed, never hashed, OR whose cache entry
      predates chunk hashing (matching size/mtime but no `chunk_sha256s` --
      an old sidecar) is a *candidate*, all judged by the same rule so an
      upgrade can't starve a genuinely new file; at most ONE candidate is
      handed to a background thread per call, chosen smallest-first over
      that combined set so cheap models converge on a hash immediately
      instead of queueing behind one multi-GB file. The 10-minute agent
      rescan loop means every model eventually gets caught up over several
      passes.
    - a file whose hash is already being computed by a still-running thread
      from a previous call is left alone rather than scheduled again.
    - any sidecar entry for a file no longer found on disk (deleted or
      moved) is pruned on the spot, so the cache stays bounded by what's
      actually present instead of accumulating forever.

    `hash_models=False` disables all of the above: entries simply omit
    `sha256`, the sidecar cache is neither read nor written, and nothing is
    scheduled in the background.
    """
    results: list[dict] = []
    if not models_dir or not os.path.isdir(models_dir):
        return results

    cache_path = os.path.join(models_dir, _HASH_SIDECAR_NAME)
    cache = _load_hash_cache(cache_path) if hash_models else {}
    # (size_bytes, full_path, rel_path, mtime) for every file needing a hash.
    candidates: list[tuple[int, str, str, float]] = []

    for root, _dirs, files in os.walk(models_dir):
        for filename in files:
            full_path = os.path.join(root, filename)
            if full_path == cache_path or filename.startswith(_HASH_SIDECAR_NAME):
                continue  # our own sidecar (and its .tmp-* siblings), not a model
            if filename.endswith(".part"):
                # An in-progress auto-fetch download (fetcher._PART_SUFFIX):
                # still being written, so inventorying/hashing it would report
                # a junk model AND persist a junk model_hashes row server-side
                # (final-review m2). It becomes visible on the rescan after
                # its atomic rename.
                continue
            try:
                stat_result = os.stat(full_path)
            except OSError:
                continue
            size_bytes = stat_result.st_size
            mtime = stat_result.st_mtime
            rel_path = os.path.relpath(full_path, models_dir).replace(os.sep, "/")
            entry = {
                "name": rel_path,
                "size": round(size_bytes / (1024 ** 3), 3),
                "size_bytes": size_bytes,
            }

            if hash_models:
                cached = cache.get(rel_path)
                cached_chunks = cached.get("chunk_sha256s") if cached else None
                if (
                    cached
                    and cached.get("size") == size_bytes
                    and cached.get("mtime") == mtime
                    and isinstance(cached_chunks, list)
                    and cached_chunks
                ):
                    entry["sha256"] = cached["sha256"]
                    entry["chunk_sha256s"] = cached_chunks
                else:
                    # No cache hit, a stale (size, mtime), OR a cache entry
                    # from before chunk hashing existed (no chunk_sha256s):
                    # all three are treated the same -- un-hashed -- so an
                    # old sidecar upgrades to carrying chunks over the
                    # normal one-file-per-pass smallest-first schedule below,
                    # without a separate "upgrade pass" that could starve
                    # genuinely new files.
                    candidates.append((size_bytes, full_path, rel_path, mtime))

            results.append(entry)

    if hash_models and cache:
        # Prune sidecar entries for files that no longer exist (deleted or
        # moved models) so the cache doesn't grow without bound. Re-load
        # under the lock in case a background `_hash_worker` wrote a fresh
        # entry between our read above and now -- pruning must never race
        # away a hash that just finished.
        seen = {entry["name"] for entry in results}
        stale_keys = [rel_path for rel_path in cache if rel_path not in seen]
        if stale_keys:
            with _HASH_LOCK:
                fresh_cache = _load_hash_cache(cache_path)
                changed = False
                for rel_path in stale_keys:
                    if fresh_cache.pop(rel_path, None) is not None:
                        changed = True
                if changed:
                    try:
                        _save_hash_cache_atomic(cache_path, fresh_cache)
                    except OSError:
                        logger.warning(
                            "hardware: failed to prune hash cache %s", cache_path, exc_info=True
                        )

    if hash_models and candidates:
        candidates.sort(key=lambda c: c[0])  # smallest first
        with _HASH_LOCK:
            # A hash already running (from a previous pass) means this pass
            # schedules nothing at all -- not even a different candidate.
            # Only one hashing thread is ever in flight at a time, so a big
            # model's multi-minute hash can't be starved by a steady stream
            # of smaller candidates jumping the queue on every rescan.
            if not _IN_FLIGHT:
                size_bytes, full_path, rel_path, mtime = candidates[0]
                thread = threading.Thread(
                    target=_hash_worker,
                    args=(full_path, rel_path, cache_path, size_bytes, mtime),
                    name=f"comfyfed-hash-{rel_path}",
                    daemon=True,
                )
                _IN_FLIGHT[full_path] = thread
                thread.start()

    return results
