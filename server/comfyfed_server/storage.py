"""Artifact storage abstraction for job result files.

Phase 1 ships a single `LocalStore` implementation that writes artifacts to
disk under the server's data directory. `get_store` selects the backend via
the `artifact_store` setting so a future Phase 2 can add an S3-backed store
(presigned direct upload) without changing callers.
"""

from __future__ import annotations

import os
from abc import ABC, abstractmethod
from typing import BinaryIO, IO

from . import db

_ARTIFACTS_DIRNAME = "artifacts"
_ARTIFACT_STORE_SETTING_KEY = "artifact_store"


# Reserved DOS device names. On Windows these resolve to devices rather than
# files at ANY directory depth and with ANY extension -- opening `con.png` for
# write succeeds and writes to the console, `nul.json` silently discards, and
# `com1` can block on a serial port. A client-supplied artifact or upload name
# must never reach `open()` as one of these.
_WINDOWS_DEVICE_NAMES = frozenset(
    ["con", "prn", "aux", "nul"]
    + [f"com{n}" for n in range(1, 10)]
    + [f"lpt{n}" for n in range(1, 10)]
)


def sanitize_path_component(value: str, *, what: str = "path component") -> str:
    """Reduce `value` to a single, safe path segment, or raise ValueError.

    Rejects empty strings, `.`/`..`, and anything containing a path
    separator (including a disguised traversal like `../../etc/passwd`,
    whose basename would otherwise be accepted as `passwd`). Idempotent:
    sanitizing an already-sanitized value returns it unchanged.

    Also rejects two Windows-specific hazards, unconditionally rather than
    only on Windows, so the same name is valid or invalid on every host a
    ComfyFed server may run on (an artifact name that a Linux platform
    accepted must not become unservable when the deployment moves):

    * Reserved DOS device names (`CON`, `NUL`, `COM1`, ... -- case
      insensitive, with or without an extension). These are devices, not
      files: `open("nul.json", "wb")` on Windows writes to the null device
      and the artifact is silently lost.
    * Names ending in a dot or a space. Windows strips those on resolution,
      so `report.png.` and `report.png` are the same file -- a difference
      that lets a name slip past an equality check and then collide.

    Both path separators are rejected UNCONDITIONALLY, before any
    ``os.path.basename`` call: ``os.path.basename`` only treats a backslash
    as a separator on Windows, so ``..\\..\\x`` would survive this check on
    POSIX and become a literal one-segment filename there while Windows (and
    the cloud twin, ``lib/store.ts``'s ``basename``, which always splits on
    both separators) rejected it. Same name, same verdict, every host.

    Control characters (anything below 0x20, plus DEL) are rejected too: a
    NUL in particular makes `open()` raise `ValueError: embedded null byte`
    deep inside a route, which would surface as an unhandled 500 instead of
    a 400.

    Public because every place that turns a client-supplied name into a path
    segment -- artifact storage here, and job-input uploads in jobs.py --
    must use exactly this rule, so there is only one definition of "safe".
    """
    if not value:
        raise ValueError(f"Invalid {what}: {value!r}")
    if "/" in value or "\\" in value:
        raise ValueError(f"Invalid {what}: {value!r}")
    if any(ch < " " or ch == "\x7f" for ch in value):
        raise ValueError(f"Invalid {what}: {value!r}")
    base = os.path.basename(value)
    if base != value or base in ("", ".", ".."):
        raise ValueError(f"Invalid {what}: {value!r}")
    if base[-1] in (".", " "):
        raise ValueError(f"Invalid {what}: {value!r}")
    # "con.png" and plain "con" are both the console device; the stem before
    # the FIRST dot is what Windows matches on.
    if base.split(".", 1)[0].lower() in _WINDOWS_DEVICE_NAMES:
        raise ValueError(f"Invalid {what}: {value!r}")
    return base


def _sanitize_filename(filename: str) -> str:
    return sanitize_path_component(filename or "", what="artifact filename")


def _sanitize_job_id(job_id: str) -> str:
    return sanitize_path_component(job_id or "", what="job id")


class ArtifactStore(ABC):
    """Backend-agnostic storage for job result artifacts."""

    @abstractmethod
    def put(self, job_id: str, filename: str, stream: BinaryIO) -> str:
        """Store `stream`'s bytes under `job_id`/`filename`. Returns the stored filename."""

    @abstractmethod
    def open(self, job_id: str, filename: str) -> IO[bytes]:
        """Open a stored artifact for reading. Raises FileNotFoundError if absent."""

    @abstractmethod
    def url(self, job_id: str, filename: str) -> str:
        """Return the (Phase 1: API) URL clients should use to fetch this artifact."""

    def path(self, job_id: str, filename: str) -> str:
        """Return a local filesystem path the server can stream directly.

        Only meaningful for backends whose artifacts are local files: it lets
        the download route hand the file to `FileResponse` (sendfile, ranged
        requests, no whole-file read into memory) instead of buffering bytes.

        Backends without local files must not implement it -- a future S3
        store will redirect the client to a presigned URL instead, so its
        download route branches on this NotImplementedError rather than
        pretending a path exists. Raises FileNotFoundError if the artifact is
        absent, matching `open`.
        """
        raise NotImplementedError(
            f"{type(self).__name__} has no local path for artifacts; serve them by URL instead."
        )


class LocalStore(ArtifactStore):
    """Stores artifacts on the local filesystem at `<base_dir>/artifacts/<job_id>/<filename>`."""

    def __init__(self, base_dir: str):
        self._base_dir = base_dir

    def _path(self, job_id: str, filename: str) -> str:
        job = _sanitize_job_id(job_id)
        name = _sanitize_filename(filename)
        return os.path.join(self._base_dir, _ARTIFACTS_DIRNAME, job, name)

    def put(self, job_id: str, filename: str, stream: BinaryIO) -> str:
        name = _sanitize_filename(filename)
        path = self._path(job_id, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                f.write(chunk)
        return name

    def open(self, job_id: str, filename: str) -> IO[bytes]:
        path = self._path(job_id, filename)
        return open(path, "rb")

    def path(self, job_id: str, filename: str) -> str:
        path = self._path(job_id, filename)
        if not os.path.isfile(path):
            raise FileNotFoundError(path)
        return path

    def url(self, job_id: str, filename: str) -> str:
        job = _sanitize_job_id(job_id)
        name = _sanitize_filename(filename)
        return f"/api/jobs/{job}/artifacts/{name}"


def get_store(data_dir: str) -> ArtifactStore:
    """Build the configured `ArtifactStore` for this server instance.

    Reads the `artifact_store` setting (default "local"). "s3" is reserved
    for Phase 2 (presigned direct upload) and is not implemented yet.
    """
    with db.get_session() as session:
        row = session.get(db.Setting, _ARTIFACT_STORE_SETTING_KEY)
        kind = row.value if row is not None else "local"

    if kind == "local":
        return LocalStore(data_dir)
    if kind == "s3":
        raise ValueError(
            "artifact_store 's3' is reserved for Phase 2 (presigned direct upload); not implemented in Phase 1."
        )
    raise ValueError(f"Unknown artifact_store setting: {kind!r}")
