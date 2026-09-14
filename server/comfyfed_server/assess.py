"""Automatic job-assessment engine.

Extracts a job's requirements (custom nodes, models, estimated VRAM, and
input assets) from a ComfyUI API-format workflow, and judges whether a given
worker can run it.

Model-name contract: the two sides of every inventory comparison are relative
to different roots. A worker's inventory is relative to the ComfyUI models
ROOT (`diffusion_models/flux1-dev.safetensors`), while a workflow's loader
value is relative to that node's CATEGORY folder (`flux1-dev.safetensors`).
Never compare them with `==` -- every lookup here goes through
`matches_model_name` / `find_model`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

_MODEL_FIELD_NAMES = {
    "ckpt_name",
    "unet_name",
    "clip_name",
    "clip_name1",
    "clip_name2",
    "vae_name",
    "lora_name",
    "model_name",
    "control_net_name",
    "style_model_name",
    "upscale_model_name",
}

_MODEL_EXTENSIONS = (".safetensors", ".ckpt", ".pt", ".pth", ".sft", ".gguf")

# Node classes whose inputs name a file the submitter must upload with the job.
# Mirrored client-side in web/src/lib/workflow.ts -- keep the two lists in step.
_ASSET_NODE_CLASSES = {"LoadImage", "LoadImageMask", "LoadAudio", "LoadVideo"}

# Input fields on those classes that carry an asset filename. The spec calls
# for image/audio/video fields; ComfyUI's core LoadAudio uses `audio` and
# core LoadVideo uses `file`.
_ASSET_FIELD_NAMES = ("image", "audio", "video", "file")

_VRAM_FUDGE_FACTOR = 1.15

# Phase 2.1: eligible_after_fetch (server-signed manifest auto-download).
# free_disk_gb must exceed the total download size by this factor -- not just
# clear it -- so a fetch never lands a worker at (near-)zero free disk.
_FETCH_DISK_MARGIN = 1.2

# hello.protocol below which an agent cannot receive fetch_models at all (it
# predates lazy hashing / lazy inventory sha256 -- see agentws._handle_hello).
_MIN_AUTO_FETCH_PROTOCOL = 3

# Phase 3.2 F1 fix: fallback budget assumed for a worker whose hello never
# reported `max_fetch_gb` at all -- either it's missing/malformed (an old or
# non-conforming agent), or hello simply predates the field. Mirrors the
# agent's own default (agent/comfyfed_agent/config.py AgentConfig.max_fetch_gb)
# so a fleet of agents that never customized the setting behaves identically
# whether the server knows about the field or not.
_DEFAULT_MAX_FETCH_GB = 30.0

# hello.protocol below which an agent cannot pull from a peer seeder at all
# (Phase 3.1 P2P -- mirrors peer._MIN_PEER_PROTOCOL, the same floor the
# platform requires of a SEEDER; a puller needs the matching capability, not
# just a newer hello field, to speak the peer-grant/chunk-pull protocol).
# Only required when a missing model's ONLY manifest source is a peer (see
# `_eligible_after_fetch`/`partition_fleet_fetchable`'s `peer_only_models`
# parameter) -- a URL-fetchable model stays reachable by a protocol>=3
# worker exactly as before this constant existed.
_MIN_PEER_FETCH_PROTOCOL = 4

_BYTES_PER_GB = 1024**3


@dataclass
class JobNeeds:
    nodes: set[str] = field(default_factory=set)
    models: set[str] = field(default_factory=set)
    est_vram_gb: float | None = None
    assets: set[str] = field(default_factory=set)


@dataclass
class Verdict:
    kind: str  # "eligible" | "eligible_after_fetch" | "ineligible"
    reasons: list[str] = field(default_factory=list)
    missing_models: list[str] = field(default_factory=list)
    # Non-blocking notes about an ELIGIBLE verdict: the job will run, but the
    # submitter should know something about how. Never affects `kind`, and
    # never appears in `reasons` -- the console renders reasons as the cause
    # of a refusal, and a warning is not one.
    warnings: list[str] = field(default_factory=list)


def _is_model_value(field_name: str, value) -> bool:
    if field_name not in _MODEL_FIELD_NAMES:
        return False
    if not isinstance(value, str):
        return False
    return value.endswith(_MODEL_EXTENSIONS)


def _iter_model_refs(workflow: dict):
    """Yield `(node_id, class_type, model_name)` for every model-valued input
    field in `workflow`, in the workflow's own iteration order.

    Single walker shared by `extract` (which only needs the set of names) and
    `model_nodes` (which needs the node each name came from) -- see the
    module's model-name contract docstring for why extraction rules must not
    be duplicated between them.
    """
    for node_id, node in (workflow or {}).items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type")
        class_type = class_type if isinstance(class_type, str) else ""

        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue

        for field_name, value in inputs.items():
            if _is_model_value(field_name, value):
                yield str(node_id), class_type, value


def extract(workflow: dict) -> JobNeeds:
    """Extract nodes/models/assets referenced by a ComfyUI API-format workflow.

    `workflow` maps node_id -> {"class_type": str, "inputs": {field: value}}.
    """
    nodes: set[str] = set()
    models: set[str] = set()
    assets: set[str] = set()

    for _node_id, node in (workflow or {}).items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type")
        if isinstance(class_type, str):
            nodes.add(class_type)

        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue

        if class_type in _ASSET_NODE_CLASSES:
            for asset_field in _ASSET_FIELD_NAMES:
                value = inputs.get(asset_field)
                if isinstance(value, str):
                    assets.add(value)

    for _node_id, _class_type, model_name in _iter_model_refs(workflow):
        models.add(model_name)

    return JobNeeds(nodes=nodes, models=models, est_vram_gb=None, assets=assets)


def model_nodes(prompt: dict) -> dict[str, list[tuple[str, str]]]:
    """Map each model name referenced by `prompt` to the nodes that reference it.

    Returns `{model_name: [(node_id, class_type), ...]}`, in workflow
    iteration order, using the same extraction rules as `extract` (both walk
    `_iter_model_refs` -- see its docstring). Used to build per-node
    `node_errors` entries for a missing-models rejection so the ComfyUI panel
    Errors tab can show guidance on the actual offending node(s).
    """
    result: dict[str, list[tuple[str, str]]] = {}
    for node_id, class_type, model_name in _iter_model_refs(prompt):
        result.setdefault(model_name, []).append((node_id, class_type))
    return result


def needs_from_job(job) -> JobNeeds:
    """Rebuild a `JobNeeds` from the requirements already persisted on a Job row.

    Single code path for dispatch and the assessment API: both need the same
    reparse of the job's `required_nodes` / `required_models` JSON columns plus
    its stored `est_vram_gb`. Bad/empty JSON degrades to an empty set rather
    than raising. `assets` is deliberately empty: input assets are uploaded at
    submission time and play no part in worker eligibility.
    """
    try:
        nodes = set(json.loads(job.required_nodes or "[]"))
    except (TypeError, ValueError):
        nodes = set()
    try:
        models = set(json.loads(job.required_models or "[]"))
    except (TypeError, ValueError):
        models = set()
    return JobNeeds(nodes=nodes, models=models, est_vram_gb=job.est_vram_gb, assets=set())


def model_inventory(worker) -> list[dict]:
    import json

    try:
        return json.loads(worker.model_inventory or "[]")
    except (TypeError, ValueError):
        return []


def _normalize_model_path(name: str) -> str:
    """Lower-friction form of a model path: forward slashes, no leading slash."""
    return str(name).replace("\\", "/").lstrip("/")


def matches_model_name(inventory_name: str, needed_name: str) -> bool:
    """Whether an inventory entry satisfies a model a workflow asks for.

    These two names are relative to DIFFERENT roots, which is the whole reason
    this helper exists:

    * The agent's inventory (`hardware.scan_models`) walks the ComfyUI models
      directory and reports paths relative to that ROOT, so entries look like
      `diffusion_models/flux1-dev.safetensors` or `loras/wuxia/x.safetensors`.
    * A workflow's loader value is relative to that node's own CATEGORY folder,
      so the same two models appear as `flux1-dev.safetensors` and
      `wuxia/x.safetensors`.

    Comparing them as exact strings judged every model on every real machine
    missing, so nothing was ever dispatched. A needed name `N` matches an
    inventory entry `I` when, after normalising separators:

    1. `I == N` -- already category-relative, or an agent that reports it that way.
    2. `I` minus its first path component == `N` -- strip the category dir.
       This is the normal case, and it keeps any deeper subfolder intact.
    3. `I` ends with `/N` -- lenient fallback for layouts that nest deeper than
       one category level (e.g. an extra_model_paths root).

    Deliberately one-directional: an inventory path may carry extra leading
    components, never the needed name.
    """
    inventory = _normalize_model_path(inventory_name)
    needed = _normalize_model_path(needed_name)
    if not inventory or not needed:
        return False

    if inventory == needed:
        return True

    _category, separator, remainder = inventory.partition("/")
    if separator and remainder == needed:
        return True

    return inventory.endswith("/" + needed)


def find_model(inventory: list, needed_name: str) -> tuple[bool, float | None]:
    """Look `needed_name` up in one worker's inventory.

    Returns `(found, best_known_size_gb)`. `(True, None)` means the model is
    present but its size is unknown/malformed; when several entries match (a
    model duplicated across categories) the largest known size wins, so a size
    estimate errs high rather than low.

    Single lookup primitive for every caller -- presence, VRAM estimation and
    fetch-from-a-peer sizing -- so the matching rule can never drift between
    "does this worker have it" and "how big is it".
    """
    found = False
    best_size: float | None = None

    for entry in inventory or []:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not matches_model_name(name, needed_name):
            continue

        found = True
        size = entry.get("size")
        if isinstance(size, (int, float)) and not isinstance(size, bool):
            if best_size is None or size > best_size:
                best_size = size

    return found, best_size


def _worker_dynamic(worker) -> dict:
    import json

    try:
        return json.loads(worker.dynamic or "{}")
    except (TypeError, ValueError):
        return {}


def _worker_hardware(worker) -> dict:
    import json

    try:
        return json.loads(worker.hardware or "{}")
    except (TypeError, ValueError):
        return {}


def worker_node_classes(worker) -> list[str]:
    import json

    try:
        return json.loads(worker.node_classes or "[]")
    except (TypeError, ValueError):
        return []


def estimate_vram(models: set[str], workers: list) -> float | None:
    """Estimate a job's peak VRAM: the LARGEST single referenced model x 1.15.

    Deliberately the largest model, not the sum of all of them. ComfyUI does
    not hold every referenced model in VRAM simultaneously -- it loads and
    offloads them around the diffusion pass, so text encoders and the VAE are
    generally not resident at the same time as the diffusion model. Peak usage
    is therefore dominated by the single biggest model.

    Summing instead (the original spec's rule) overstated a flux workflow at
    ~25.6 GB when it in fact runs on a 16 GB card, which made real jobs
    undispatchable. This gate exists to catch absurd mismatches -- a 24 GB
    model on an 8 GB card -- not to predict peak usage precisely.

    Each model's size is the largest value known for it anywhere in the
    federation. Inventory entries are matched with `matches_model_name`, not
    by string equality -- see that helper for why the two names differ in
    shape.

    Returns None if no referenced model has a known size anywhere.
    """
    largest: float | None = None
    for model_name in models:
        for worker in workers:
            _found, size = find_model(model_inventory(worker), model_name)
            if size is not None and (largest is None or size > largest):
                largest = size
    if largest is None:
        return None
    return largest * _VRAM_FUDGE_FACTOR


def verdict(
    worker,
    needs: JobNeeds,
    requirements_override: dict,
    all_workers: list,
    fetchable_models: dict[str, int] | None = None,
    peer_only_models: frozenset[str] | None = None,
) -> Verdict:
    """Judge whether `worker` can run a job needing `needs`.

    `requirements_override` is the job's advanced-override dict (optional
    keys: min_vram_gb, min_free_disk_gb, gpu_name_contains, backend).

    The `backend` key is compared against the worker's reported compute
    backend ("cuda"/"rocm"/"mps"/"cpu"). Phase 1 derives nothing automatically
    -- a workflow is never inspected for backend hints, so this check only
    fires when the submitter set the override explicitly.
    `all_workers` is the full federation worker list (kept for callers/other
    assessment helpers that need it; `verdict` itself no longer searches
    peer inventories for a missing model -- see `fetchable_models` below).

    `fetchable_models` maps a missing model's name (in the SAME shape as
    `needs.models` -- a workflow-declared, category-relative name, e.g.
    `flux1-dev.safetensors` -- not a worker-inventory-relative path) to its
    exact `size_bytes`, as published by the platform's signed
    `model_manifest.entries()`. It is None by default -- "nothing is
    fetchable" -- so a caller that doesn't compile it (every caller as of
    Phase 2.1 Task 3; Task 4 wires dispatch/comfyapi up) gets the exact same
    behavior as before this parameter existed: no missing model can ever
    turn `eligible_after_fetch` real.

    `eligible_after_fetch` requires ALL of: at least one required model
    missing from `worker`'s own inventory; EVERY missing model present in
    `fetchable_models`; `worker.protocol >= 3` (hello's opt-in fields did not
    exist before protocol 3); `worker.auto_fetch` (agent-side opt-in, off by
    default -- workers keep sovereignty over unattended downloads); and
    `worker.dynamic["free_disk_gb"] > 1.2 * sum(missing sizes, in GB)`. That
    margin is a hard gate with no "unknown -> warn" fallback (unlike the VRAM
    offload gate below) -- an unattended multi-GB download is a bigger risk
    to leave unproven than an offload is. When any missing model is
    peer-only (Phase 3.1 P2P, `peer_only_models` -- see `_eligible_after_fetch`),
    `worker.protocol >= 4` is additionally required for that model.
    """
    reasons: list[str] = []
    warnings: list[str] = []
    requirements_override = requirements_override or {}

    hardware = _worker_hardware(worker)
    dynamic = _worker_dynamic(worker)

    # Phase 1 workers that have never connected report node_classes == '[]'.
    # An empty list is "unknown", not "supports nothing" — skip the node
    # check entirely in that case, rather than flagging every job ineligible.
    worker_nodes = worker_node_classes(worker)
    if worker_nodes:
        missing_nodes = needs.nodes - set(worker_nodes)
        if missing_nodes:
            reasons.append(f"missing_nodes:{','.join(sorted(missing_nodes))}")

    # VRAM: a hard gate only when the weights fit NOWHERE. ComfyUI streams and
    # offloads weights to system RAM when they do not fit in VRAM -- slower,
    # but it runs, which is why a 15.9 GB card demonstrably executes a 22 GB
    # flux checkpoint (and a 33B video model). The old `est > vram` hard gate
    # contradicted that and left panel-submitted jobs queued forever with no
    # worker ever eligible. The real ceiling is VRAM PLUS system RAM; between
    # the two the job is eligible with a warning.
    vram_gb = hardware.get("vram_gb")
    ram_gb = hardware.get("ram_gb")
    if not isinstance(ram_gb, (int, float)) or isinstance(ram_gb, bool):
        # Older agents report no total RAM; free RAM from the last heartbeat is
        # the closest available stand-in.
        ram_gb = dynamic.get("free_ram_gb")
    if isinstance(ram_gb, bool) or not isinstance(ram_gb, (int, float)):
        ram_gb = None

    if (
        needs.est_vram_gb is not None
        and isinstance(vram_gb, (int, float))
        and not isinstance(vram_gb, bool)
        and needs.est_vram_gb > vram_gb
    ):
        if ram_gb is None:
            # RAM unknown (an older agent that reports neither total nor free
            # RAM). We cannot prove the weights do not fit, and refusing on a
            # missing datum is what stranded jobs before -- warn instead.
            warnings.append(f"vram_offload:{needs.est_vram_gb}>{vram_gb}")
        elif needs.est_vram_gb > vram_gb + ram_gb:
            reasons.append(f"vram:{needs.est_vram_gb}>{vram_gb}+{ram_gb}")
        else:
            warnings.append(f"vram_offload:{needs.est_vram_gb}>{vram_gb}")

    min_vram_gb = requirements_override.get("min_vram_gb")
    if min_vram_gb is not None:
        if not isinstance(vram_gb, (int, float)) or vram_gb < min_vram_gb:
            reasons.append("override:min_vram_gb")

    min_free_disk_gb = requirements_override.get("min_free_disk_gb")
    if min_free_disk_gb is not None:
        free_disk_gb = dynamic.get("free_disk_gb")
        if not isinstance(free_disk_gb, (int, float)) or free_disk_gb < min_free_disk_gb:
            reasons.append("override:min_free_disk_gb")

    want_backend = requirements_override.get("backend")
    if isinstance(want_backend, str) and want_backend:
        have_backend = getattr(worker, "backend", "") or ""
        if want_backend != have_backend:
            reasons.append(f"backend:{want_backend}!={have_backend}")

    gpu_name_contains = requirements_override.get("gpu_name_contains")
    if gpu_name_contains:
        gpu_name = hardware.get("gpu_name") or ""
        if gpu_name_contains not in gpu_name:
            reasons.append("override:gpu_name_contains")

    worker_inventory = model_inventory(worker)
    missing_models = sorted(
        name for name in needs.models if not find_model(worker_inventory, name)[0]
    )

    if reasons:
        # Hard reasons (nodes/vram/override) always win over model status. A
        # warning is dropped here on purpose: it explains how an eligible job
        # will run, and this one is not going to run at all.
        return Verdict(kind="ineligible", reasons=reasons, missing_models=missing_models)

    if not missing_models:
        return Verdict(kind="eligible", reasons=[], missing_models=[], warnings=warnings)

    if _eligible_after_fetch(worker, missing_models, fetchable_models, dynamic, peer_only_models):
        return Verdict(
            kind="eligible_after_fetch",
            reasons=[f"missing_models:{','.join(missing_models)}"],
            missing_models=missing_models,
            warnings=warnings,
        )

    # L6 final-review fix: a protocol<4 worker blocked specifically because a
    # missing model is peer-only (no URL at all, so it can ONLY ever be
    # fetched over the peer-grant/chunk-pull protocol this worker's protocol
    # version can't speak) gets a distinguishable reason from the generic
    # "unavailable" -- otherwise it's indistinguishable in the UI from "this
    # model doesn't exist in the federation" (spec: 判定透明列在 UI 原因裡，
    # 不是靜默失敗). This only covers the protocol gate, the one condition
    # `verdict` actually has direct evidence for; a peer-only model whose
    # seeder happens to be offline right now is not distinguishable here at
    # all (the manifest simply omits it, exactly like a model that never
    # existed -- see model_manifest._peer_only_entry), so it still falls into
    # the generic branch below.
    _fetchable = fetchable_models or {}
    _peer_only = peer_only_models or frozenset()
    blocked_by_peer_protocol = (
        all(name in _fetchable for name in missing_models)
        and any(name in _peer_only for name in missing_models)
        and _worker_protocol(worker) < _MIN_PEER_FETCH_PROTOCOL
    )
    if blocked_by_peer_protocol:
        return Verdict(
            kind="ineligible",
            reasons=[f"missing_models_peer_protocol:{','.join(missing_models)}"],
            missing_models=missing_models,
        )

    return Verdict(
        kind="ineligible",
        reasons=[f"missing_models_unavailable:{','.join(missing_models)}"],
        missing_models=missing_models,
    )


def _worker_protocol(worker) -> int:
    """`worker.protocol`, normalized the same way every fetch-eligibility
    gate here needs it: missing/non-int/bool degrades to 1 (the oldest,
    least-capable value), never raises. Single helper so
    `_worker_fetch_capacity_ok` and the peer-protocol check below can't drift
    on this normalization.
    """
    protocol = getattr(worker, "protocol", None)
    if not isinstance(protocol, int) or isinstance(protocol, bool):
        return 1
    return protocol


def _worker_max_fetch_gb(worker) -> float:
    """This worker's configured auto-fetch budget (hello's optional
    `max_fetch_gb`, Phase 3.2 F1 fix), stashed into the `hardware` JSON blob
    by `agentws._handle_hello` alongside the agent-reported hardware fields.
    Missing/non-numeric/non-positive (never reported it, an old agent, or a
    malformed value) degrades to `_DEFAULT_MAX_FETCH_GB` -- the same default
    the agent itself applies when the operator never customized the setting,
    so an old-or-silent agent is treated exactly like a fresh one, never as
    "unlimited".
    """
    value = _worker_hardware(worker).get("max_fetch_gb")
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
        return _DEFAULT_MAX_FETCH_GB
    return float(value)


def _worker_fetch_capacity_ok(worker, dynamic: dict, total_missing_gb: float) -> bool:
    """Protocol/auto_fetch/budget/disk-margin gate, independent of WHICH
    models are missing -- shared by `_eligible_after_fetch` (per-candidate
    gate inside `verdict`) and `partition_fleet_fetchable` (fleet-wide
    submission-time gate). `dynamic` is the caller's already-parsed
    `worker.dynamic` JSON (avoids re-parsing it once per candidate in
    `verdict`'s hot path).
    """
    if _worker_protocol(worker) < _MIN_AUTO_FETCH_PROTOCOL:
        return False

    if not getattr(worker, "auto_fetch", False):
        return False

    # Phase 3.2 F1 fix: a worker that would refuse the download itself
    # (fetcher._check_budget_and_disk's own max_fetch_gb check) must not be
    # counted fetch-capable here -- otherwise the platform queues a job that
    # is guaranteed to fail post-dispatch instead of 400ing at submission
    # time with an actionable reason (see assess.verdict's missing_models
    # reporting / partition_fleet_fetchable's callers).
    if total_missing_gb > _worker_max_fetch_gb(worker):
        return False

    free_disk_gb = dynamic.get("free_disk_gb")
    if not isinstance(free_disk_gb, (int, float)) or isinstance(free_disk_gb, bool):
        # Unknown free disk cannot prove the margin holds -- refuse rather
        # than warn (see the docstring on `verdict` for why this gate, unlike
        # VRAM offload, has no unknown-warns-instead fallback).
        return False

    return free_disk_gb > _FETCH_DISK_MARGIN * total_missing_gb


def _eligible_after_fetch(
    worker,
    missing_models: list[str],
    fetchable_models: dict[str, int] | None,
    dynamic: dict,
    peer_only_models: frozenset[str] | None = None,
) -> bool:
    """All the eligible_after_fetch gates -- see `verdict`'s docstring.

    `peer_only_models` (Phase 3.1 P2P; a subset of `fetchable_models`'
    keys, `model_manifest.peer_only_names`'s shape) names missing models
    whose ONLY manifest source is a peer seeder, no URL at all. When any
    missing model this worker needs falls in that set, the worker must ALSO
    be protocol>=4 (peer-pull capable) -- a protocol-3 worker can auto-fetch
    a URL-sourced model just fine, but has no way to speak the peer-grant/
    chunk-pull protocol for a peer-only one. None (every pre-3.1 caller)
    means "nothing is peer-only", identical to the pre-Task-6 behavior.
    """
    fetchable_models = fetchable_models or {}
    if not all(name in fetchable_models for name in missing_models):
        return False

    peer_only_models = peer_only_models or frozenset()
    if any(name in peer_only_models for name in missing_models):
        if _worker_protocol(worker) < _MIN_PEER_FETCH_PROTOCOL:
            return False

    total_missing_gb = sum(fetchable_models[name] for name in missing_models) / _BYTES_PER_GB
    return _worker_fetch_capacity_ok(worker, dynamic, total_missing_gb)


def partition_fleet_fetchable(
    missing_models: set[str],
    fetchable_models: dict[str, int] | None,
    online_enabled_workers: list,
    peer_only_models: frozenset[str] | None = None,
) -> tuple[set[str], set[str]]:
    """Split a fleet-wide "missing from every worker" model set into
    `(fetchable, unfetchable)` for the submission-relaxation matrix
    (`comfyapi.post_prompt`'s 400 predicate, `jobs.py`'s console submit
    predicate).

    This is a single COMBINED gate over the whole manifest-covered subset,
    not a per-model one: `_worker_fetch_capacity_ok`'s disk-margin check is
    against the sum of everything a worker would have to download for this
    job, exactly like `_eligible_after_fetch` -- "half of the missing set
    fits" is not a real answer to "can this worker actually run the job", so
    it is not a real answer here either. A model is only "fetchable" when
    (a) it has a manifest entry (`fetchable_models` -- name -> size_bytes,
    same shape `verdict` takes) AND (b) at least one worker in
    `online_enabled_workers` (caller-filtered: online, not disabled --
    matching `comfyapi._online_worker_hashes`'s definition of "online") can
    fetch the ENTIRE manifest-covered subset in one go. When no worker
    clears that combined bar, NONE of the manifest-covered subset counts as
    fetchable either -- it lands in `unfetchable` alongside models with no
    manifest entry at all, matching the brief's "no online opt-in worker"
    case.

    Models with no manifest entry are always unfetchable and never affect
    the combined-gate outcome for the ones that DO have an entry.

    `peer_only_models` (Phase 3.1 P2P, `model_manifest.peer_only_names`'s
    shape): when the manifest-covered subset includes any name with no URL
    source at all, a candidate worker must ALSO be protocol>=4 (peer-pull
    capable) -- same rule `_eligible_after_fetch` applies per-candidate, just
    evaluated once against the combined subset here. None means "nothing is
    peer-only", the pre-Task-6 behavior.
    """
    fetchable_models = fetchable_models or {}
    manifest_covered = {name for name in missing_models if name in fetchable_models}
    not_in_manifest = set(missing_models) - manifest_covered

    if not manifest_covered:
        return set(), set(missing_models)

    peer_only_models = peer_only_models or frozenset()
    requires_peer_protocol = bool(manifest_covered & peer_only_models)

    total_missing_gb = sum(fetchable_models[name] for name in manifest_covered) / _BYTES_PER_GB
    can_fetch = any(
        _worker_fetch_capacity_ok(worker, _worker_dynamic(worker), total_missing_gb)
        and (not requires_peer_protocol or _worker_protocol(worker) >= _MIN_PEER_FETCH_PROTOCOL)
        for worker in online_enabled_workers
    )
    if can_fetch:
        return manifest_covered, not_in_manifest

    return set(), set(missing_models)


def fleet_wide_gaps(needs: JobNeeds, all_workers: list) -> tuple[set[str], set[str]]:
    """`(models, node classes)` that NOT ONE worker in `all_workers` can supply.

    Shared by `comfyapi.post_prompt` and `jobs.py`'s console submit predicate
    so the two entry points can never drift on what "the fleet has no idea
    about this model/node" means. Deliberately every worker passed in,
    whatever its `status`/`disabled` -- the classic home federation is one
    big GPU box holding every model plus a small always-on box holding none,
    and refusing a prompt during the GPU box's ten-minute reboot -- for
    models the user already owns -- is strictly worse than queueing it. Only
    a model that exists nowhere in the federation is a real dead end.

    Matching is `find_model`, i.e. `matches_model_name` semantics, so a
    worker's `diffusion_models/flux1-dev.safetensors` satisfies a workflow's
    `flux1-dev.safetensors`.

    Node classes are computed the same way and returned alongside. A worker
    reporting an EMPTY `node_classes` list means "unknown", not "supports
    nothing" -- same rule as `verdict` -- so such workers are skipped for the
    node check, and if that leaves no informative worker the node set comes
    back empty.

    With zero workers passed in, both sets are empty: an install that has
    never had an agent connect keeps today's queue-and-wait behavior.
    """
    if not all_workers:
        return set(), set()

    inventories = [model_inventory(w) for w in all_workers]
    node_class_sets = [
        classes for classes in (set(worker_node_classes(w)) for w in all_workers) if classes
    ]

    missing_models = {
        name
        for name in needs.models
        if not any(find_model(inventory, name)[0] for inventory in inventories)
    }

    missing_nodes: set[str] = set()
    if node_class_sets:
        missing_nodes = {
            node for node in needs.nodes
            if not any(node in classes for classes in node_class_sets)
        }

    return missing_models, missing_nodes
