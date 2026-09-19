"""Panel "Download" button -> `kind=model_fetch` job (spec 2026-09-19 §5-§6).

Pure helpers only; the HTTP route lives in `comfyapi.py` and the dispatch/
job_done wiring in `agentws.py`. Trust model: a worker downloads only
platform-signed entries. A model the platform has no learned/curated hash
for is dispatched as an *unverified-source* entry -- the url itself is in
the signed payload, the url's origin must be in `TRUSTED_ORIGINS`, and the
worker reports the real sha256 on completion so the platform learns it.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Optional
from urllib.parse import urlsplit

import httpx

from . import assess, db, model_manifest, security

logger = logging.getLogger(__name__)

TRUSTED_ORIGINS: frozenset[str] = frozenset({"https://huggingface.co", "https://civitai.com"})
_HEAD_TIMEOUT_SECONDS = 10.0


def is_trusted_url(url: str) -> bool:
    """Whether `url`'s PARSED origin (scheme + host, lowercased) is in
    `TRUSTED_ORIGINS`.

    Deliberately not a string-prefix test: `https://huggingface.co.evil.com/x`
    starts with `https://huggingface.co` but is a wholly different origin, and
    the signed unverified entry's only trust root is "the platform approved
    THIS url" (§6), so the host must be matched exactly. A non-443 explicit
    port is rejected for the same reason -- it is a different endpoint than
    the origin the allowlist vouches for.
    """
    if not isinstance(url, str) or not url:
        return False
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    if parts.scheme.lower() != "https" or not parts.hostname:
        return False
    if port not in (None, 443):
        return False
    origin = f"{parts.scheme.lower()}://{parts.hostname.lower()}"
    return origin in TRUSTED_ORIGINS


class HeadError(Exception):
    """`code` is "gated" (401/403) or "size_unknown" (anything else)."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(detail or code)
        self.code = code


def head_size_bytes(url: str, *, client_factory=httpx.Client) -> int:
    """The exact byte length `url` advertises via `Content-Length`, probed
    with a redirect-following HEAD and a 10 s timeout.

    The signed entry pins `size_bytes` (§6) and an unverified entry has no
    sha256 for the agent to check instead -- so a source that will not state
    its length cannot be dispatched at all (`size_unknown`), and a source
    that demands a login (401/403) is `gated` and reported as such rather
    than being retried by a worker that has no credentials either.

    `client_factory` exists so tests can inject an `httpx.MockTransport`
    client; production passes the default `httpx.Client`.
    """
    try:
        with client_factory(
            timeout=httpx.Timeout(_HEAD_TIMEOUT_SECONDS), follow_redirects=True
        ) as client:
            resp = client.head(url)
    except httpx.HTTPError as exc:
        raise HeadError("size_unknown", str(exc)) from exc
    if resp.status_code in (401, 403):
        raise HeadError("gated", f"HTTP {resp.status_code}")
    if not (200 <= resp.status_code < 300):
        raise HeadError("size_unknown", f"HTTP {resp.status_code}")
    raw = resp.headers.get("content-length")
    try:
        size = int(raw) if raw is not None else 0
    except ValueError:
        size = 0
    if size <= 0:
        raise HeadError("size_unknown", "no Content-Length")
    return size


def unverified_payload(name: str, directory: str, url: str, size_bytes: int) -> str:
    """The Ed25519 payload for an unverified-source entry (spec §6).

    Byte-exact and mirrored by the agent's `fetcher._verify_entry_signature`
    and the cloud stack -- the trailing `|unverified` literal is what keeps
    it from ever colliding with the verified `name|directory|sha256|size`
    payload, so neither shape can be replayed as the other.
    """
    return f"{name}|{directory}|{url}|{size_bytes}|unverified"


def sign_unverified_entry(signing_key, *, name: str, directory: str, url: str, size_bytes: int) -> dict:
    """Sign an unverified-source manifest entry with the platform key.

    `sha256`/`backup_url` are explicitly None: there is no known content
    hash yet (that is the whole point -- the worker reports the real one on
    completion, §9) and no content-addressed fallback source exists without
    one, so no GCS mirror and no peer pull for this entry (§3).
    """
    sig = signing_key.sign(unverified_payload(name, directory, url, size_bytes).encode()).signature.hex()
    return {
        "name": name,
        "directory": directory,
        "url": url,
        "backup_url": None,
        "sha256": None,
        "size_bytes": size_bytes,
        "unverified": True,
        "sig": sig,
    }


def is_unverified_entry(entry: dict) -> bool:
    """Whether `entry` is an unverified-source entry -- the one flag both
    the agent's shape validator and the dispatch protocol gate key off."""
    return isinstance(entry, dict) and entry.get("unverified") is True


# --- the POST/GET /comfy/api/comfyfed/model-fetch decision sequence (§5.1) --

# "still going to happen" job statuses, for the reuse row of §5.1. The spec
# writes this set as (queued, dispatched, running); THIS stack's name for the
# claimed-but-not-yet-started state is `assigned` (see dispatch.assign_jobs /
# mark_running), so that is what is listed here.
_ACTIVE_STATUSES = ("queued", "assigned", "running")

_MESSAGES = {
    "bad_request": "請求格式錯誤：需要 name、directory、url / bad request: name, directory, url required",
    "already_present": "模型已在聯邦內，請重新整理面板 / model already present in the federation, reload the panel",
    "untrusted_url": "來源網域不在白名單（僅允許 huggingface.co、civitai.com）/ url origin not allowlisted (huggingface.co, civitai.com only)",
    "gated": "此模型為受限模型，需登入來源網站，無法由 worker 自動下載 / gated model: the source requires a login, workers cannot fetch it",
    "size_unknown": "無法取得檔案大小，無法派工下載 / could not determine file size, cannot dispatch a fetch",
    "no_worker": "目前沒有可下載的 worker（需在線、開啟 auto_fetch_models、agent ≥ 0.1.14、磁碟與 max_fetch_gb 足夠）/ no worker can fetch right now (online, auto_fetch_models on, agent >= 0.1.14, enough disk and max_fetch_gb)",
}


class FetchRequestError(Exception):
    """One of §5.1's refusal rows. `code` is the bare reason
    (`bad_request|already_present|untrusted_url|gated|size_unknown|no_worker`);
    the route prefixes it with `model_fetch.` for the wire.

    `detail` appends machine-readable specifics to the generic sentence --
    used by `no_worker`, which §5.1 row 7 requires to LIST why (the raw
    `assess` reason strings, so the panel and the console say the same thing
    about the same refusal).
    """

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.message = f"{_MESSAGES[code]}：{detail}" if detail else _MESSAGES[code]


# Characters that must never reach a signed field. `|` is the payload's own
# delimiter (`name|directory|url|size_bytes|unverified`) -- allowing it makes
# the concatenation non-injective across field boundaries, so two different
# (name, directory) pairs could produce one payload and therefore share a
# signature. Control characters (including NUL and newline) would ride the
# same payload into the worker's filesystem. `model_manifest` already refuses
# `|` in its own entry builders for exactly this reason; this is the same
# guard at the other place entries are minted.
_FORBIDDEN_FIELD_CHARS = re.compile(r"[|\x00-\x1f\x7f]")


def _safe_relative(path: str) -> bool:
    """The server-side twin of the agent's `fetcher._is_safe_relative_path`:
    an empty directory is fine (the model lands at the models root), anything
    absolute (leading slash/backslash or a `C:` drive letter) or containing a
    `.`/`..`/empty path segment is not. Kept here rather than imported so the
    server never depends on the agent package."""
    if not isinstance(path, str):
        return False
    if _FORBIDDEN_FIELD_CHARS.search(path):
        return False
    if path == "":
        return True
    if path.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", path):
        return False
    return all(part not in ("", ".", "..") for part in re.split(r"[\\/]", path))


def _safe_name(name) -> bool:
    """A bare model filename: no path separators at all (the `directory`
    field is the only place a path may appear), no `.`/`..`, no payload
    delimiter or control characters, bounded."""
    return (
        isinstance(name, str)
        and 0 < len(name) < 256
        and not re.search(r"[\\/]", name)
        and not _FORBIDDEN_FIELD_CHARS.search(name)
        and name not in (".", "..")
    )


def _fleet_has_model(name: str) -> bool:
    """Whether ANY registered worker -- online, offline or disabled -- already
    holds `name` (§5.1 row 2). Offline counts on purpose: the model IS in the
    federation, the panel's missing-models card is just stale, and dispatching
    a second copy of it to another worker would be pure waste."""
    from . import jobs  # local import: jobs -> agentws -> model_fetch cycle

    with db.get_session() as session:
        for worker in jobs._live_workers(session):
            if assess.find_model(assess.model_inventory(worker), name)[0]:
                return True
    return False


def _active_fetch_job_id(name: str) -> Optional[str]:
    """The oldest still-live `model_fetch` job for exactly `name` (§5.1 row
    3) -- two people pressing the same Download button share one job."""
    with db.get_session() as session:
        rows = (
            session.query(db.Job)
            .filter(db.Job.kind == "model_fetch", db.Job.status.in_(_ACTIVE_STATUSES))
            .order_by(db.Job.created_at.asc())
            .all()
        )
        for job in rows:
            try:
                required = json.loads(job.required_models or "[]")
            except (TypeError, ValueError):
                continue
            if required == [name]:
                return job.id
    return None


def _no_worker_detail(
    name: str,
    fetchable: dict[str, int],
    online_enabled_workers: list,
    peer_only: frozenset[str],
    unverified: frozenset[str],
) -> str:
    """§5.1 row 7's "message 列出原因": the distinct `assess` reason strings
    from re-judging this one model against every online, enabled worker.

    `partition_fleet_fetchable` answers only yes/no, so the per-candidate
    reasons are re-derived here with `assess.verdict` -- the SAME judge, so
    what the panel is told can never contradict why dispatch actually
    refused. Deliberately the raw reason strings (`missing_models_unverified_
    protocol:<name>`, `missing_models_unavailable:<name>`, the override/vram
    ones) rather than a prose translation: the console shows these verbatim
    already, and a second wording would be a second thing to keep in sync.

    Empty when nothing is online at all -- there is no candidate to have a
    reason about, and the generic sentence already says "needs an online
    worker".
    """
    needs = assess.JobNeeds(models={name}, nodes=set())
    reasons: list[str] = []
    for worker in online_enabled_workers:
        try:
            v = assess.verdict(worker, needs, {}, [], fetchable, peer_only, unverified)
        except Exception:  # pragma: no cover - a judge crash must not mask the 400
            logger.exception("model_fetch: verdict failed while explaining no_worker")
            continue
        for reason in v.reasons:
            if reason not in reasons:
                reasons.append(reason)
    return "；".join(reasons)


def create_fetch_job(
    *, name, directory, url, user_id: Optional[str], data_dir: str, head=None
) -> tuple[str, bool]:
    """Run §5.1's decision sequence and, if it survives, create the job.

    Returns `(job_id, reused)`; raises `FetchRequestError` for every refusal
    row. `head` is injectable purely for tests -- production resolves to this
    module's `head_size_bytes`.
    """
    from . import jobs  # local import: jobs -> agentws -> model_fetch cycle

    head = head or head_size_bytes

    if not (
        _safe_name(name)
        and isinstance(directory, str)
        and _safe_relative(directory)
        and isinstance(url, str)
    ):
        raise FetchRequestError("bad_request")

    if _fleet_has_model(name):
        raise FetchRequestError("already_present")

    existing = _active_fetch_job_id(name)
    if existing:
        return existing, True

    # Row 4: a name the signed manifest already covers (curated guide hash,
    # learned consensus, or peer-only) is dispatched as that VERIFIED entry --
    # the caller-supplied url is ignored outright, so a panel that offers a
    # bogus url for a model the platform already knows cannot redirect the
    # fetch. Rows 5-6 (allowlist + HEAD) only exist for names it does not.
    manifest_entries = model_manifest.entries(data_dir)
    by_name = {e["name"]: e for e in manifest_entries}
    unverified: frozenset[str] = frozenset()
    if name in by_name:
        entry = by_name[name]
        peer_only = model_manifest.peer_only_names([entry])
    else:
        if not is_trusted_url(url):
            raise FetchRequestError("untrusted_url")
        try:
            size_bytes = head(url)
        except HeadError as exc:
            raise FetchRequestError(exc.code) from exc
        signing_key, _verify_key = security.load_platform_keys(data_dir)
        entry = sign_unverified_entry(
            signing_key, name=name, directory=directory, url=url, size_bytes=size_bytes
        )
        peer_only = frozenset()
        unverified = frozenset({name})

    # Row 7: exactly the same fleet-wide gate the prompt-submission path uses,
    # so "the panel offered me this button" and "someone can actually fetch
    # it" can never drift apart.
    fetchable = {name: int(entry["size_bytes"])}
    with db.get_session() as session:
        online = jobs._online_enabled_workers(session)
    _ok, blocked = assess.partition_fleet_fetchable(
        {name}, fetchable, online, peer_only, unverified
    )
    if blocked:
        raise FetchRequestError(
            "no_worker", _no_worker_detail(name, fetchable, online, peer_only, unverified)
        )

    with db.get_session() as session:
        job = db.Job(
            workflow_json="{}",
            kind="model_fetch",
            fetch_entry=json.dumps(entry),
            required_models=json.dumps([name]),
            required_nodes="[]",
            input_assets="[]",
            origin="panel",
            user_id=user_id,
        )
        session.add(job)
        session.commit()
        return job.id, False


def fetch_status(job_id: str) -> Optional[dict]:
    """§5.2's payload, or None when `job_id` is unknown or is an ordinary
    prompt job (the route turns that into a 404).

    `stage`/`fetch_pct`/`fetch_model` come from `agentws`'s transient
    in-memory fetch-progress cache -- the same one the console's job payload
    reads -- and are explicit nulls here (not omitted) because the panel
    polls this shape every 2 s and wants one stable set of keys.
    """
    from . import agentws  # local import: agentws imports model_fetch (Task 5)

    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        if job is None or job.kind != "model_fetch":
            return None
        progress = agentws.get_fetch_progress(job_id) or {}
        try:
            entry = json.loads(job.fetch_entry or "{}")
        except (TypeError, ValueError):
            entry = {}
        if not isinstance(entry, dict):
            entry = {}
        return {
            "job_id": job.id,
            "status": job.status,
            "stage": progress.get("stage"),
            "fetch_pct": progress.get("fetch_pct"),
            "fetch_model": progress.get("fetch_model"),
            "worker_id": job.worker_id,
            "error": job.error,
            "name": entry.get("name"),
        }
