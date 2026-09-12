"""Automatic job-assessment engine.

Extracts a job's requirements (custom nodes, models, estimated VRAM, and
input assets) from a ComfyUI API-format workflow, and judges whether a given
worker can run it.
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
_ASSET_NODE_CLASSES = {"LoadImage", "LoadImageMask", "LoadAudio"}

# Input fields on those classes that carry an asset filename. The spec calls
# for image/audio/video fields; ComfyUI's core LoadAudio uses `audio`.
_ASSET_FIELD_NAMES = ("image", "audio", "video")

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


def _model_inventory(worker) -> list[dict]:
    import json

    try:
        return json.loads(worker.model_inventory or "[]")
    except (TypeError, ValueError):
        return []


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


def _worker_node_classes(worker) -> list[str]:
    import json

    try:
        return json.loads(worker.node_classes or "[]")
    except (TypeError, ValueError):
        return []


def estimate_vram(models: set[str], workers: list) -> float | None:
    """Sum the max known size (GB) of each model across all workers' inventories.

    Returns None if no referenced model has a known size anywhere.
    """
    total = 0.0
    found_any = False
    for model_name in models:
        best_size = None
        for worker in workers:
            for entry in _model_inventory(worker):
                if entry.get("name") == model_name:
                    size = entry.get("size")
                    if isinstance(size, (int, float)):
                        if best_size is None or size > best_size:
                            best_size = size
        if best_size is not None:
            found_any = True
            total += best_size
    if not found_any:
        return None
    return total * _VRAM_FUDGE_FACTOR


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
    requirements_override = requirements_override or {}

    hardware = _worker_hardware(worker)
    dynamic = _worker_dynamic(worker)

    # Phase 1 workers that have never connected report node_classes == '[]'.
    # An empty list is "unknown", not "supports nothing" — skip the node
    # check entirely in that case, rather than flagging every job ineligible.
    worker_nodes = _worker_node_classes(worker)
    if worker_nodes:
        missing_nodes = needs.nodes - set(worker_nodes)
        if missing_nodes:
            reasons.append(f"missing_nodes:{','.join(sorted(missing_nodes))}")

    vram_gb = hardware.get("vram_gb")
    if needs.est_vram_gb is not None and isinstance(vram_gb, (int, float)):
        if needs.est_vram_gb > vram_gb:
            reasons.append(f"vram:{needs.est_vram_gb}>{vram_gb}")

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

    worker_model_names = {e.get("name") for e in _model_inventory(worker)}
    missing_models = sorted(needs.models - worker_model_names)

    if reasons:
        # Hard reasons (nodes/vram/override) always win over model status.
        return Verdict(kind="ineligible", reasons=reasons, missing_models=missing_models)

    if not missing_models:
        return Verdict(kind="eligible", reasons=[], missing_models=[])

    # Can every missing model be fetched from some other worker, and does
    # this worker have enough free disk for the total size of what's missing?
    other_workers = [w for w in all_workers if w is not worker]
    total_missing_size = 0.0
    all_available_elsewhere = True
    for model_name in missing_models:
        found_size = None
        for other in other_workers:
            for entry in _model_inventory(other):
                if entry.get("name") == model_name:
                    size = entry.get("size")
                    if isinstance(size, (int, float)):
                        if found_size is None or size > found_size:
                            found_size = size
                    else:
                        found_size = found_size if found_size is not None else 0.0
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
        )

    return Verdict(
        kind="ineligible",
        reasons=[f"missing_models_unavailable:{','.join(missing_models)}"],
        missing_models=missing_models,
    )
