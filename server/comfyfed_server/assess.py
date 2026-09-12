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

_MODEL_EXTENSIONS = (".safetensors", ".ckpt", ".pt", ".sft", ".gguf")

# Node classes whose inputs name a file the submitter must upload with the job.
# Mirrored client-side in web/src/lib/workflow.ts -- keep the two lists in step.
_ASSET_NODE_CLASSES = {"LoadImage", "LoadImageMask", "LoadAudio", "LoadVideo"}

# Input fields on those classes that carry an asset filename. The spec calls
# for image/audio/video fields; ComfyUI's core LoadAudio uses `audio` and
# core LoadVideo uses `file`.
_ASSET_FIELD_NAMES = ("image", "audio", "video", "file")

_VRAM_FUDGE_FACTOR = 1.15


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

        for field_name, value in inputs.items():
            if _is_model_value(field_name, value):
                models.add(value)

        if class_type in _ASSET_NODE_CLASSES:
            for asset_field in _ASSET_FIELD_NAMES:
                value = inputs.get(asset_field)
                if isinstance(value, str):
                    assets.add(value)

    return JobNeeds(nodes=nodes, models=models, est_vram_gb=None, assets=assets)


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


def verdict(worker, needs: JobNeeds, requirements_override: dict, all_workers: list) -> Verdict:
    """Judge whether `worker` can run a job needing `needs`.

    `requirements_override` is the job's advanced-override dict (optional
    keys: min_vram_gb, min_free_disk_gb, gpu_name_contains, backend).

    The `backend` key is compared against the worker's reported compute
    backend ("cuda"/"rocm"/"mps"/"cpu"). Phase 1 derives nothing automatically
    -- a workflow is never inspected for backend hints, so this check only
    fires when the submitter set the override explicitly.
    `all_workers` is the full federation worker list, used to determine
    whether a model missing from `worker`'s inventory is fetchable from
    another worker.
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

    # Can every missing model be fetched from some other worker, and does
    # this worker have enough free disk for the total size of what's missing?
    #
    # This one really is a SUM, unlike the VRAM estimate above: every fetched
    # model lands on disk and stays there at the same time. Don't "correct"
    # it to a max to match estimate_vram -- they measure different resources.
    other_workers = [w for w in all_workers if w is not worker]
    total_missing_size = 0.0
    all_available_elsewhere = True
    for model_name in missing_models:
        found_size = None
        for other in other_workers:
            found, size = find_model(model_inventory(other), model_name)
            if not found:
                continue
            # Present but with an unknown size still counts as fetchable; it
            # just contributes nothing to the disk-headroom total.
            candidate = size if size is not None else 0.0
            if found_size is None or candidate > found_size:
                found_size = candidate
        if found_size is None:
            all_available_elsewhere = False
            break
        total_missing_size += found_size

    free_disk_gb = dynamic.get("free_disk_gb")
    disk_ok = True
    if isinstance(free_disk_gb, (int, float)):
        disk_ok = free_disk_gb >= total_missing_size

    if all_available_elsewhere and disk_ok:
        return Verdict(
            kind="eligible_after_fetch",
            reasons=[f"missing_models:{','.join(missing_models)}"],
            missing_models=missing_models,
            warnings=warnings,
        )

    return Verdict(
        kind="ineligible",
        reasons=[f"missing_models_unavailable:{','.join(missing_models)}"],
        missing_models=missing_models,
    )
