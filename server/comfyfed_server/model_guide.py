"""Pre-execution missing-model guidance for `POST /comfy/api/prompt`.

ComfyFed is a federation with no models of its own -- every model lives on a
worker's disk, and the frontend's stock "Download" buttons (a plain
`<a href>`) are useless here (see `templates.py`, which strips the download
metadata from every SERVED template so those buttons never render). Instead,
when a submitted prompt names a model that NOT ONE registered worker has --
offline and disabled ones included, so a sleeping GPU box still counts --
`comfyapi.post_prompt` rejects it with a ComfyUI-shaped error whose
`details` tell the admin exactly where to get each missing model and where to
put it (`guidance_message`) under a one-line `message` summary
(`guidance_summary`).

Two sources feed the model->download-info lookup, checked in this order:

1. `SOURCES` -- nine models curated by hand for the workflows ComfyFed ships
   or has verified (the FLUX.1-dev family and the MiniMax-H3 pipeline). Each
   entry carries an official page, a direct official download URL, our own
   GCS mirror as a backup, and whether the official source is access-gated.
2. `harvest()` -- every OTHER model referenced by the official template
   library's workflow JSONs (`official_templates.official_dir`), read
   straight off disk from `nodes[].properties.models` (the shape the real
   library uses). `templates.py` strips `url`/`hash` from what it SERVES to
   the browser, but the original files on disk still carry them (Task 2),
   which is exactly what this module needs and the browser must not see.

A model in neither source still gets a guidance block -- see
`guidance_message` -- just without a known size, official link, or backup.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass

from . import assess, official_templates

_GCS_BACKUP_BASE = "https://storage.googleapis.com/comfyfed-models/models"

_FLUX_GATED_NOTE = "（需登入 HuggingFace 並同意 FLUX.1-dev 授權）"

_HEADER = (
    "無法執行：聯邦裡所有已註冊的 worker 都缺少以下模型（含目前離線的）。"
    "請在 worker 主機下載後放到指定資料夾，worker 會在 10 分鐘內自動掃描並回報，不需重啟。"
)

# Files in `official_dir` that are never a template workflow (and so never
# carry model metadata worth harvesting).
_NON_TEMPLATE_PREFIXES = ("index",)
_NON_TEMPLATE_NAMES = {official_templates.MANIFEST_NAME}


@dataclass(frozen=True)
class ModelSource:
    name: str
    directory: str
    size_gb: float | None
    official_page: str | None
    official_url: str
    backup_url: str | None
    gated: bool


def _curated(
    name: str,
    directory: str,
    size_gb: float,
    official_page: str,
    filename: str,
    gated: bool = False,
) -> ModelSource:
    official_url = f"{official_page}/resolve/main/{filename}"
    backup_url = f"{_GCS_BACKUP_BASE}/{directory}/{name}"
    return ModelSource(
        name=name,
        directory=directory,
        size_gb=size_gb,
        official_page=official_page,
        official_url=official_url,
        backup_url=backup_url,
        gated=gated,
    )


# The nine curated models, verified 2026-09-13 -- see
# docs/superpowers/plans/2026-09-13-phase1_6-official-templates.md, "The
# curated model source registry".
SOURCES: dict[str, ModelSource] = {
    "flux1-dev.safetensors": _curated(
        "flux1-dev.safetensors",
        "diffusion_models",
        22.17,
        "https://huggingface.co/black-forest-labs/FLUX.1-dev",
        "flux1-dev.safetensors",
        gated=True,
    ),
    "ae.safetensors": _curated(
        "ae.safetensors",
        "vae",
        0.31,
        "https://huggingface.co/black-forest-labs/FLUX.1-dev",
        "ae.safetensors",
        gated=True,
    ),
    "clip_l.safetensors": _curated(
        "clip_l.safetensors",
        "text_encoders",
        0.23,
        "https://huggingface.co/comfyanonymous/flux_text_encoders",
        "clip_l.safetensors",
    ),
    "t5xxl_fp16.safetensors": _curated(
        "t5xxl_fp16.safetensors",
        "text_encoders",
        9.12,
        "https://huggingface.co/comfyanonymous/flux_text_encoders",
        "t5xxl_fp16.safetensors",
    ),
    "qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors": _curated(
        "qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors",
        "text_encoders",
        14.61,
        "https://huggingface.co/sakamakismile/Qwen3-VL-32B-Heretic-MiniMax-H3-NVFP4",
        "qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors",
    ),
    "minimax_h3_ref2va_pruned_int8_convrot.safetensors": ModelSource(
        name="minimax_h3_ref2va_pruned_int8_convrot.safetensors",
        directory="diffusion_models",
        size_gb=19.53,
        official_page="https://huggingface.co/Comfy-Org/MiniMax-H3",
        official_url=(
            "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/"
            "diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors"
        ),
        backup_url=f"{_GCS_BACKUP_BASE}/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors",
        gated=False,
    ),
    "minimax_h3_video_vae_fp16.safetensors": ModelSource(
        name="minimax_h3_video_vae_fp16.safetensors",
        directory="vae",
        size_gb=4.85,
        official_page="https://huggingface.co/Comfy-Org/MiniMax-H3",
        official_url=(
            "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/"
            "vae/minimax_h3_video_vae_fp16.safetensors"
        ),
        backup_url=f"{_GCS_BACKUP_BASE}/vae/minimax_h3_video_vae_fp16.safetensors",
        gated=False,
    ),
    "minimax_h3_audio_vae_fp32.safetensors": ModelSource(
        name="minimax_h3_audio_vae_fp32.safetensors",
        directory="vae",
        size_gb=0.56,
        official_page="https://huggingface.co/Comfy-Org/MiniMax-H3",
        official_url=(
            "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/"
            "vae/minimax_h3_audio_vae_fp32.safetensors"
        ),
        backup_url=f"{_GCS_BACKUP_BASE}/vae/minimax_h3_audio_vae_fp32.safetensors",
        gated=False,
    ),
    "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors": _curated(
        "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors",
        "loras",
        0.91,
        "https://huggingface.co/drbaph/MiniMax-H3-Turbo-Lora-ComfyUI",
        "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors",
    ),
}


# harvest() cache: official_dir path -> (mtime signature, result). The
# signature is the directory's own mtime, which changes on `fetch()`'s
# atomic `os.replace` swap (a fresh directory replaces the old one), so a
# re-fetch is always picked up without re-scanning on every lookup.
_harvest_cache: dict[str, tuple[float, dict[str, dict]]] = {}


def _is_template_file(filename: str) -> bool:
    if not filename.endswith(".json"):
        return False
    if filename in _NON_TEMPLATE_NAMES:
        return False
    if filename.startswith(_NON_TEMPLATE_PREFIXES):
        return False
    return True


def _model_entries(data: dict):
    """Every model-metadata dict in one workflow JSON, from both places the
    format puts them.

    The official library carries its download metadata per node, at
    `nodes[].properties.models` -- that is what the frontend's
    `getEmbeddedModels` reads and what all 550 workflow JSONs in
    `comfyui-workflow-templates-json` actually use. A top-level `models`
    list is also accepted so a hand-authored workflow that uses it is not
    silently ignored; the two are simply chained.
    """
    top_level = data.get("models")
    if isinstance(top_level, list):
        for entry in top_level:
            if isinstance(entry, dict):
                yield entry

    nodes = data.get("nodes")
    if not isinstance(nodes, list):
        return
    for node in nodes:
        if not isinstance(node, dict):
            continue
        properties = node.get("properties")
        if not isinstance(properties, dict):
            continue
        models = properties.get("models")
        if not isinstance(models, list):
            continue
        for entry in models:
            if isinstance(entry, dict):
                yield entry


def harvest(data_dir: str) -> dict[str, dict]:
    """Scan the official template library's workflow JSONs for model metadata.

    Returns `{name: {"url": ..., "directory": ...}}` for every model entry
    found in `nodes[].properties.models` (and in a top-level `models` list,
    if a workflow happens to use one), first-write-wins on a name collision
    across templates. Reads the ORIGINAL files on disk -- `templates.py` only
    strips `url`/`hash` from what it serves over HTTP, never from these files
    -- so this is the one place download links for non-curated models can
    still be found.
    """
    dir_path = official_templates.official_dir(data_dir)
    try:
        signature = os.path.getmtime(dir_path)
    except OSError:
        return {}

    cached = _harvest_cache.get(dir_path)
    if cached is not None and cached[0] == signature:
        return cached[1]

    result: dict[str, dict] = {}
    try:
        filenames = os.listdir(dir_path)
    except OSError:
        filenames = []

    for filename in sorted(filenames):
        if not _is_template_file(filename):
            continue
        path = os.path.join(dir_path, filename)
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        for entry in _model_entries(data):
            name = entry.get("name")
            if not isinstance(name, str) or not name:
                continue
            result.setdefault(
                name, {"url": entry.get("url"), "directory": entry.get("directory")}
            )

    _harvest_cache[dir_path] = (signature, result)
    return result


def lookup(name: str, data_dir: str) -> ModelSource | None:
    """Resolve a model name (as referenced by a workflow) to its download info.

    Curated `SOURCES` are checked first, then `harvest()`'s harvested
    entries. Both are matched with `assess.matches_model_name` semantics: a
    bare name (`clip_l.safetensors`) and a category-relative one
    (`text_encoders/clip_l.safetensors`) both resolve to the same curated or
    harvested entry, exactly like a worker inventory entry satisfies either
    form of a workflow's loader value.
    """
    for key, source in SOURCES.items():
        if assess.matches_model_name(name, key):
            return source

    for key, info in harvest(data_dir).items():
        if assess.matches_model_name(name, key):
            return ModelSource(
                name=key,
                directory=info.get("directory") or "",
                size_gb=None,
                official_page=None,
                official_url=info.get("url") or "",
                backup_url=None,
                gated=False,
            )

    return None


def _render_block(name: str, source: ModelSource | None) -> str:
    if source is None:
        return (
            f"【{name}】\n"
            "放置路徑：models/<資料夾依節點類型>/\n"
            "官方載點：請向工作流提供者取得下載來源"
        )

    header = f"【{name}】" if source.size_gb is None else f"【{name}】({source.size_gb} GB)"
    lines = [header, f"放置路徑：models/{source.directory}/"]

    official_line = f"官方載點：{source.official_url}"
    if source.gated:
        official_line += _FLUX_GATED_NOTE
    lines.append(official_line)

    if source.backup_url:
        lines.append(f"備份載點：{source.backup_url}")

    return "\n".join(lines)


def guidance_message(missing: list[str], data_dir: str) -> str:
    """Render the zh-TW `POST /prompt` rejection message for `missing` models.

    One block per model (curated, harvested, or unknown -- see
    `_render_block`), joined by blank lines, with the shared header first.
    """
    blocks = [_HEADER] + [_render_block(name, lookup(name, data_dir)) for name in missing]
    return "\n\n".join(blocks)


def guidance_summary(missing: list[str]) -> str:
    """One-line zh-TW summary of a missing-model rejection.

    This is the `error.message` of the `/prompt` refusal, deliberately short:
    the official frontend renders that field as the error card's *title* in
    the right-side Errors panel and as the leading half of the error
    dialog's `message + ": " + details`. The full `guidance_message` blocks
    go in `details`. See `comfyapi.post_prompt`.
    """
    if not missing:
        return "缺少模型，無法執行——詳見下方下載指引"
    head = missing[0]
    if len(missing) == 1:
        return f"缺少模型：{head}，無法執行——詳見下方下載指引"
    return f"缺少模型：{head} 等 {len(missing)} 項，無法執行——詳見下方下載指引"


def missing_nodes_note(missing_nodes: list[str]) -> str:
    """Trailing guidance line for node classes no registered worker has.

    Appended to `guidance_message` when the fleet is missing BOTH models and
    node classes, so an admin who downloads every listed model does not then
    discover the job still cannot run for a reason nothing mentioned.
    """
    return (
        "另外，所有 worker 也都缺少節點："
        + "、".join(missing_nodes)
        + "——需在 worker 端安裝對應 custom node。"
    )
