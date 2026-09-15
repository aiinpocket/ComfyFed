"""Admin-configurable upload limits and the per-user storage quota.

Two platform settings, both plain `settings` key-value rows (no migration --
the table is generic), both read through `read_limits` and never inlined at a
call site:

* `upload_max_file_mb` (default 50) -- the ceiling for ONE uploaded file, on
  every route that accepts user bytes: the panel's `/comfy/api/userdata`
  save and move, the panel's `/comfy/api/upload/image` staging upload, and
  the console's `POST /api/jobs` asset uploads. Before this module that cap
  was a hardcoded 5 MB on the userdata route alone; the other two had none.
* `upload_user_quota_gb` (default 5) -- the total a single user may keep in
  their own two personal namespaces, `comfy_staging/<uid>/` and
  `comfy_userdata/<uid>/`.

Both parse DEFENSIVELY: a settings row is editable by hand (and by a future
stack that writes the other's value shape), so anything unparseable, out of
range, or missing falls back to the default rather than raising deep inside
an upload route.

Job artifacts and job inputs (`artifacts/<job_id>/`, `job_inputs/<job_id>/`)
deliberately do NOT count toward the quota: they are RESULTS of work the
federation did, not files the user chose to keep, and reclaiming them is a
separate lifecycle concern (nothing prunes them yet either).

The cloud twin is `cloud/src/lib/limits.ts` -- same keys, same defaults, same
bounds, same error codes and messages.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

from . import db

UPLOAD_MAX_FILE_MB_KEY = "upload_max_file_mb"
UPLOAD_USER_QUOTA_GB_KEY = "upload_user_quota_gb"

DEFAULT_UPLOAD_MAX_FILE_MB = 50
DEFAULT_UPLOAD_USER_QUOTA_GB = 5.0

MIN_UPLOAD_MAX_FILE_MB = 1
MAX_UPLOAD_MAX_FILE_MB = 1024
MIN_UPLOAD_USER_QUOTA_GB = 0.1
MAX_UPLOAD_USER_QUOTA_GB = 1024.0

_BYTES_PER_MB = 1024 * 1024
_BYTES_PER_GB = 1024 * 1024 * 1024

# Shared error code for every quota refusal, on both stacks and every route:
# a client (or a human in devtools) should not have to learn a different code
# per upload surface to recognise "you are out of space".
QUOTA_EXCEEDED_CODE = "quota_exceeded"


@dataclass(frozen=True)
class UploadLimits:
    """Resolved, already-validated limits. `*_bytes` are what routes compare."""

    max_file_mb: int
    quota_gb: float

    @property
    def max_file_bytes(self) -> int:
        return int(self.max_file_mb) * _BYTES_PER_MB

    @property
    def quota_bytes(self) -> int:
        return int(self.quota_gb * _BYTES_PER_GB)


def parse_max_file_mb(raw: object) -> int:
    """`upload_max_file_mb` as an int in [1, 1024]; the default for anything else."""
    try:
        value = int(float(str(raw).strip()))
    except (TypeError, ValueError):
        return DEFAULT_UPLOAD_MAX_FILE_MB
    if value < MIN_UPLOAD_MAX_FILE_MB or value > MAX_UPLOAD_MAX_FILE_MB:
        return DEFAULT_UPLOAD_MAX_FILE_MB
    return value


def parse_user_quota_gb(raw: object) -> float:
    """`upload_user_quota_gb` as a float in [0.1, 1024]; the default otherwise.

    Decimals are meaningful here (0.5 GB is a reasonable quota on a small
    box), so unlike the MB cap this one is NOT rounded to an integer.
    """
    try:
        value = float(str(raw).strip())
    except (TypeError, ValueError):
        return DEFAULT_UPLOAD_USER_QUOTA_GB
    if value != value or value in (float("inf"), float("-inf")):  # NaN / inf
        return DEFAULT_UPLOAD_USER_QUOTA_GB
    if value < MIN_UPLOAD_USER_QUOTA_GB or value > MAX_UPLOAD_USER_QUOTA_GB:
        return DEFAULT_UPLOAD_USER_QUOTA_GB
    return value


def read_limits(session=None) -> UploadLimits:
    """Current limits from the `settings` table. Opens its own session when
    none is passed, so an upload route can call it without threading one."""
    if session is not None:
        return _read_limits(session)
    with db.get_session() as own:
        return _read_limits(own)


def _read_limits(session) -> UploadLimits:
    mb_row = session.get(db.Setting, UPLOAD_MAX_FILE_MB_KEY)
    gb_row = session.get(db.Setting, UPLOAD_USER_QUOTA_GB_KEY)
    return UploadLimits(
        max_file_mb=parse_max_file_mb(mb_row.value if mb_row is not None else None),
        quota_gb=parse_user_quota_gb(gb_row.value if gb_row is not None else None),
    )


_BYTE_UNITS = ("B", "KB", "MB", "GB", "TB")


def format_bytes(value: float) -> str:
    """Human-readable size, matching web/src/lib/format.ts's `formatBytes`
    exactly (1024-based, one decimal above bytes) so the number an error
    message quotes reads the same as the console's own usage line."""
    if value is None or value < 0:
        return "—"
    if value <= 0:
        return "0 B"
    exponent = 0
    scaled = float(value)
    while scaled >= 1024 and exponent < len(_BYTE_UNITS) - 1:
        scaled /= 1024
        exponent += 1
    rounded = round(scaled) if exponent == 0 else round(scaled * 10) / 10
    if rounded == int(rounded):
        rounded = int(rounded)
    return f"{rounded} {_BYTE_UNITS[exponent]}"


def too_large_message(limits: UploadLimits) -> str:
    return (
        f"檔案超過 {limits.max_file_mb} MB 單檔上限，無法上傳。"
        f" / File exceeds the {limits.max_file_mb} MB per-file upload limit."
    )


def quota_message(used_bytes: int, limits: UploadLimits) -> str:
    used = format_bytes(used_bytes)
    total = format_bytes(limits.quota_bytes)
    return (
        f"儲存空間不足（已用 {used} / 配額 {total}），請先刪除部分檔案。"
        f" / Storage quota exceeded (used {used} of {total}); delete some files first."
    )


def file_cap_exceeded(size_bytes: int, limits: UploadLimits) -> bool:
    """Does one file of `size_bytes` break the configured per-file cap?

    The single definition of that comparison, so a route never spells out
    `> mb * 1024 * 1024` itself: `comfyapi.upload_rejection` (panel userdata
    + staging) and `jobs.py`'s console asset upload both ask this, then each
    renders the refusal in the envelope ITS clients expect.
    """
    return size_bytes > limits.max_file_bytes


def dir_bytes(path: str) -> int:
    """Total bytes of every file under `path` (0 when it does not exist).

    Public because the console's `/api/staging` listing reports the userdata
    half of a user's usage with it, and that number must be computed exactly
    the way `usage_bytes` computes the one the quota is enforced on."""
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                # Raced with a delete, or a broken symlink -- an unreadable
                # file is not usage anyone can be charged for.
                continue
    return total


def usage_bytes(data_dir: str, uid: str) -> int:
    """Total bytes `uid` currently keeps in their two personal namespaces.

    Deliberately the sum of `comfy_staging/<uid>/` + `comfy_userdata/<uid>/`
    and nothing else -- see this module's docstring for why job artifacts and
    job inputs are excluded.

    Recomputed by walking the tree on every upload. At trusted-circle scale
    (a handful of users, a few hundred files each) that is a millisecond;
    a cached per-user counter row, invalidated on write and delete, is the
    obvious future work if a deployment ever outgrows it.
    """
    # Imported lazily: comfyapi owns the two directory-name constants and
    # already imports this module, so a top-level import would cycle.
    from . import comfyapi

    total = 0
    for directory in (comfyapi.staging_dir(data_dir, uid), comfyapi.userdata_dir(data_dir, uid)):
        total += dir_bytes(directory)
    return total


def quota_rejection(
    data_dir: str,
    uid: str,
    incoming_bytes: int,
    limits: UploadLimits,
    *,
    replacing_bytes: int = 0,
) -> Optional[str]:
    """The bilingual quota message if this write would not fit, else `None`.

    `replacing_bytes` is the size of the file this write OVERWRITES (0 for a
    fresh name): those bytes disappear when the write lands, so charging for
    them would make re-saving an unchanged workflow fail at exactly 100% of
    quota.
    """
    used = usage_bytes(data_dir, uid)
    projected = used - min(replacing_bytes, used) + incoming_bytes
    if projected > limits.quota_bytes:
        return quota_message(used, limits)
    return None


def file_size(path: str) -> int:
    """Existing size of `path`, or 0 when it is absent/unreadable -- the
    `replacing_bytes` argument for an overwrite."""
    try:
        return os.path.getsize(path)
    except OSError:
        return 0
