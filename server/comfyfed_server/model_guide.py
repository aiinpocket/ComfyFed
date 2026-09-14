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

1. `SOURCES` -- models curated by hand for the workflows ComfyFed ships
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
    # Phase 3.2: operator-vouched trust anchor for the 11 curated entries
    # ONLY -- `model_manifest.entries()` uses these to sign a fetch-manifest
    # entry straight from the guide even when no worker's reported inventory
    # has ever established a learned consensus hash for this (name,
    # size_bytes) yet (the "zero-holder" case: every worker in the fleet is
    # missing the model, so no `model_hashes` row can exist). A learned
    # consensus row, once one exists, always wins over these -- see that
    # module's docstring and the Phase 3.2 addendum. `harvest()`-sourced
    # entries never set these (no trustworthy value to curate for them), so
    # they keep going through the consensus-only path exactly as before.
    sha256: str | None = None
    size_bytes: int | None = None


def _curated(
    name: str,
    directory: str,
    size_gb: float,
    official_page: str,
    filename: str,
    gated: bool = False,
    sha256: str | None = None,
    size_bytes: int | None = None,
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
        sha256=sha256,
        size_bytes=size_bytes,
    )


# The eleven curated models, verified 2026-09-13 -- see
# docs/superpowers/plans/2026-09-13-phase1_6-official-templates.md, "The
# curated model source registry", and the Phase 1.8b addendum's model
# registry table for entry #10 (qwen3vl_4b_bf16.safetensors).
SOURCES: dict[str, ModelSource] = {
    "flux1-dev.safetensors": _curated(
        "flux1-dev.safetensors",
        "diffusion_models",
        22.17,
        "https://huggingface.co/black-forest-labs/FLUX.1-dev",
        "flux1-dev.safetensors",
        gated=True,
        sha256="4610115bb0c89560703c892c59ac2742fa821e60ef5871b33493ba544683abd7",
        size_bytes=23802932552,
    ),
    "ae.safetensors": _curated(
        "ae.safetensors",
        "vae",
        0.31,
        "https://huggingface.co/black-forest-labs/FLUX.1-dev",
        "ae.safetensors",
        gated=True,
        sha256="afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38",
        size_bytes=335304388,
    ),
    "clip_l.safetensors": _curated(
        "clip_l.safetensors",
        "text_encoders",
        0.23,
        "https://huggingface.co/comfyanonymous/flux_text_encoders",
        "clip_l.safetensors",
        sha256="660c6f5b1abae9dc498ac2d21e1347d2abdb0cf6c0c0c8576cd796491d9a6cdd",
        size_bytes=246144152,
    ),
    "t5xxl_fp16.safetensors": _curated(
        "t5xxl_fp16.safetensors",
        "text_encoders",
        9.12,
        "https://huggingface.co/comfyanonymous/flux_text_encoders",
        "t5xxl_fp16.safetensors",
        sha256="6e480b09fae049a72d2a8c5fbccb8d3e92febeb233bbe9dfe7256958a9167635",
        size_bytes=9787841024,
    ),
    "qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors": _curated(
        "qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors",
        "text_encoders",
        14.61,
        "https://huggingface.co/sakamakismile/Qwen3-VL-32B-Heretic-MiniMax-H3-NVFP4",
        "qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors",
        sha256="a166c7bbbe66a22065159e478335fee4a633c4a3e3bb34c8e8ac4cc91bf4996f",
        size_bytes=15683129587,
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
        sha256="9255f52b6677845ad238f20dfaafa94727053694127ab7f255c048f0f9365779",
        size_bytes=20970379616,
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
        sha256="7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522",
        size_bytes=5207808496,
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
        sha256="8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48",
        size_bytes=605254808,
    ),
    "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors": _curated(
        "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors",
        "loras",
        0.91,
        "https://huggingface.co/drbaph/MiniMax-H3-Turbo-Lora-ComfyUI",
        "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors",
        sha256="374dfbce47a9f44b19a4d78b44c63bf613ba74110077582603b3d74ad3d47254",
        size_bytes=978227408,
    ),
    # Direct URL has a `text_encoders/` path segment before the filename
    # (unlike the flat FLUX text-encoder layout), so this is built manually
    # rather than via `_curated`, same as the MiniMax-H3 entries above.
    "qwen3vl_4b_bf16.safetensors": ModelSource(
        name="qwen3vl_4b_bf16.safetensors",
        directory="text_encoders",
        size_gb=8.27,
        official_page="https://huggingface.co/Comfy-Org/Krea-2",
        official_url=(
            "https://huggingface.co/Comfy-Org/Krea-2/resolve/main/"
            "text_encoders/qwen3vl_4b_bf16.safetensors"
        ),
        backup_url=f"{_GCS_BACKUP_BASE}/text_encoders/qwen3vl_4b_bf16.safetensors",
        gated=False,
        sha256="36f3ff447ef59201722e8f9ce6020c9819fdcfba6aa2608c4e09b1c0ce114e34",
        size_bytes=8875719384,
    ),
    # Entry #11, Phase 1.10 -- a GitHub release asset rather than a HuggingFace
    # `resolve/main/` URL, so this is built manually like the MiniMax-H3
    # entries above instead of via `_curated`.
    "RealESRGAN_x4plus.pth": ModelSource(
        name="RealESRGAN_x4plus.pth",
        directory="upscale_models",
        size_gb=0.06,
        official_page="https://github.com/xinntao/Real-ESRGAN",
        official_url="https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
        backup_url=f"{_GCS_BACKUP_BASE}/upscale_models/RealESRGAN_x4plus.pth",
        gated=False,
        sha256="4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1",
        size_bytes=67040989,
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


def _model_entries(data):
    """Every model-metadata dict in one workflow JSON, wherever it hides.

    The walk is fully recursive because the official library keeps model
    metadata in more places than the documented ones: per node at
    `nodes[].properties.models` for plain graphs, a top-level `models` list
    in the schema, and inside `definitions.subgraphs[].nodes[].properties.
    models` for subgraph-based workflows (`image_z_image_turbo` is one) --
    live verification caught that last shape slipping through an
    enumerating version of this walk. Mirror of the recursive strip in
    `templates._strip_download_metadata`: any dict's `models` key whose
    value is a list yields its dict entries.
    """
    if isinstance(data, list):
        for item in data:
            yield from _model_entries(item)
        return
    if not isinstance(data, dict):
        return
    for key, value in data.items():
        if key == "models" and isinstance(value, list):
            for entry in value:
                if isinstance(entry, dict):
                    yield entry
        else:
            yield from _model_entries(value)


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
    blocks = [_HEADER] + [model_guidance_block(name, data_dir) for name in missing]
    return "\n\n".join(blocks)


def model_guidance_block(name: str, data_dir: str) -> str:
    """The single-model guidance block (`【name】` + path/official/backup)
    used both as one paragraph of `guidance_message` and, standalone, as the
    per-node `node_errors[...].errors[].details` string in
    `comfyapi.post_prompt` -- same lookup, same rendering, one source of
    truth for what an admin is told about a given model.
    """
    return _render_block(name, lookup(name, data_dir))


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
