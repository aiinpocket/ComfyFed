/**
 * Pre-execution missing-model guidance for `POST /comfy/api/prompt`, ported
 * from `server/comfyfed_server/model_guide.py` (read in full -- see that
 * module's docstring for the two-source lookup rationale this file mirrors
 * exactly).
 *
 * ComfyFed is a federation with no models of its own -- every model lives on
 * a worker's disk. When a submitted prompt names a model that NOT ONE
 * registered worker has (offline and disabled ones included),
 * `routes/comfyapi.ts`'s `POST /prompt` rejects it with a ComfyUI-shaped
 * error whose `details` tell the admin exactly where to get each missing
 * model and where to put it (`guidanceMessage`) under a one-line `message`
 * summary (`guidanceSummary`).
 *
 * Two sources feed the model->download-info lookup, checked in this order:
 *
 * 1. `SOURCES` -- the same eleven models curated by hand in the Python
 *    source, copied VERBATIM (name/directory/size/official page/URL/gated).
 * 2. `harvest()` -- every OTHER model referenced by the official template
 *    library's workflow JSONs. Python reads these off local disk
 *    (`official_templates.official_dir`); this cloud port has no local
 *    filesystem, so it lists+reads R2 objects under the `official_templates/`
 *    prefix instead (see that function's docstring for the key-layout
 *    assumption and why it's a documented guess, not a verified parity
 *    fact -- Task 10, which owns the templates route, seeds that prefix).
 *
 * A model in neither source still gets a guidance block -- see
 * `renderBlock` -- just without a known size, official link, or backup.
 */

import { matchesModelName } from "./assess";

export interface ModelSource {
  name: string;
  directory: string;
  sizeGb: number | null;
  officialPage: string | null;
  officialUrl: string;
  backupUrl: string | null;
  gated: boolean;
  // Phase 3.2: operator-vouched trust anchor for the 11 curated entries
  // ONLY -- `model_manifest.entries()` uses these to sign a fetch-manifest
  // entry straight from the guide even when no worker's reported inventory
  // has ever established a learned consensus hash for this (name,
  // size_bytes) yet (the "zero-holder" case: every worker in the fleet is
  // missing the model, so no `model_hashes` row can exist). A learned
  // consensus row, once one exists, always wins over these -- see
  // model_manifest.py's docstring and the Phase 3.2 addendum. `harvest()`-
  // sourced entries never set these (no trustworthy value to curate for
  // them), so they keep going through the consensus-only path exactly as
  // before. Undefined (not just absent) mirrors Python's `sha256: str |
  // None = None` default for a harvested/manually-built ModelSource.
  sha256?: string;
  sizeBytes?: number;
}

const GCS_BACKUP_BASE = "https://storage.googleapis.com/comfyfed-models/models";
const FLUX_GATED_NOTE = "（需登入 HuggingFace 並同意 FLUX.1-dev 授權）";

const HEADER =
  "無法執行：聯邦裡所有已註冊的 worker 都缺少以下模型（含目前離線的）。" +
  "請在 worker 主機下載後放到指定資料夾，worker 會在 10 分鐘內自動掃描並回報，不需重啟。";

function curated(
  name: string,
  directory: string,
  sizeGb: number,
  officialPage: string,
  filename: string,
  gated = false,
  sha256?: string,
  sizeBytes?: number
): ModelSource {
  return {
    name,
    directory,
    sizeGb,
    officialPage,
    officialUrl: `${officialPage}/resolve/main/${filename}`,
    backupUrl: `${GCS_BACKUP_BASE}/${directory}/${name}`,
    gated,
    sha256,
    sizeBytes,
  };
}

// The eleven curated models -- copied verbatim from model_guide.py's
// `SOURCES` (see that module's comment for the verification date/plan
// references). DO NOT reorder/rename/reword any field: byte parity with the
// Python registry is the whole point (see test/model_guide.spec.ts).
export const SOURCES: Record<string, ModelSource> = {
  "flux1-dev.safetensors": curated(
    "flux1-dev.safetensors",
    "diffusion_models",
    22.17,
    "https://huggingface.co/black-forest-labs/FLUX.1-dev",
    "flux1-dev.safetensors",
    true,
    "4610115bb0c89560703c892c59ac2742fa821e60ef5871b33493ba544683abd7",
    23802932552
  ),
  "ae.safetensors": curated(
    "ae.safetensors",
    "vae",
    0.31,
    "https://huggingface.co/black-forest-labs/FLUX.1-dev",
    "ae.safetensors",
    true,
    "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38",
    335304388
  ),
  "clip_l.safetensors": curated(
    "clip_l.safetensors",
    "text_encoders",
    0.23,
    "https://huggingface.co/comfyanonymous/flux_text_encoders",
    "clip_l.safetensors",
    false,
    "660c6f5b1abae9dc498ac2d21e1347d2abdb0cf6c0c0c8576cd796491d9a6cdd",
    246144152
  ),
  "t5xxl_fp16.safetensors": curated(
    "t5xxl_fp16.safetensors",
    "text_encoders",
    9.12,
    "https://huggingface.co/comfyanonymous/flux_text_encoders",
    "t5xxl_fp16.safetensors",
    false,
    "6e480b09fae049a72d2a8c5fbccb8d3e92febeb233bbe9dfe7256958a9167635",
    9787841024
  ),
  "qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors": curated(
    "qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors",
    "text_encoders",
    14.61,
    "https://huggingface.co/sakamakismile/Qwen3-VL-32B-Heretic-MiniMax-H3-NVFP4",
    "qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors",
    false,
    "a166c7bbbe66a22065159e478335fee4a633c4a3e3bb34c8e8ac4cc91bf4996f",
    15683129587
  ),
  "minimax_h3_ref2va_pruned_int8_convrot.safetensors": {
    name: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    directory: "diffusion_models",
    sizeGb: 19.53,
    officialPage: "https://huggingface.co/Comfy-Org/MiniMax-H3",
    officialUrl:
      "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    backupUrl: `${GCS_BACKUP_BASE}/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors`,
    gated: false,
    sha256: "9255f52b6677845ad238f20dfaafa94727053694127ab7f255c048f0f9365779",
    sizeBytes: 20970379616,
  },
  "minimax_h3_video_vae_fp16.safetensors": {
    name: "minimax_h3_video_vae_fp16.safetensors",
    directory: "vae",
    sizeGb: 4.85,
    officialPage: "https://huggingface.co/Comfy-Org/MiniMax-H3",
    officialUrl: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors",
    backupUrl: `${GCS_BACKUP_BASE}/vae/minimax_h3_video_vae_fp16.safetensors`,
    gated: false,
    sha256: "7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522",
    sizeBytes: 5207808496,
  },
  "minimax_h3_audio_vae_fp32.safetensors": {
    name: "minimax_h3_audio_vae_fp32.safetensors",
    directory: "vae",
    sizeGb: 0.56,
    officialPage: "https://huggingface.co/Comfy-Org/MiniMax-H3",
    officialUrl: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors",
    backupUrl: `${GCS_BACKUP_BASE}/vae/minimax_h3_audio_vae_fp32.safetensors`,
    gated: false,
    sha256: "8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48",
    sizeBytes: 605254808,
  },
  "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors": curated(
    "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors",
    "loras",
    0.91,
    "https://huggingface.co/drbaph/MiniMax-H3-Turbo-Lora-ComfyUI",
    "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_resized_avg_rank_64_bf16.safetensors",
    false,
    "374dfbce47a9f44b19a4d78b44c63bf613ba74110077582603b3d74ad3d47254",
    978227408
  ),
  "qwen3vl_4b_bf16.safetensors": {
    name: "qwen3vl_4b_bf16.safetensors",
    directory: "text_encoders",
    sizeGb: 8.27,
    officialPage: "https://huggingface.co/Comfy-Org/Krea-2",
    officialUrl: "https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_bf16.safetensors",
    backupUrl: `${GCS_BACKUP_BASE}/text_encoders/qwen3vl_4b_bf16.safetensors`,
    gated: false,
    sha256: "36f3ff447ef59201722e8f9ce6020c9819fdcfba6aa2608c4e09b1c0ce114e34",
    sizeBytes: 8875719384,
  },
  "RealESRGAN_x4plus.pth": {
    name: "RealESRGAN_x4plus.pth",
    directory: "upscale_models",
    sizeGb: 0.06,
    officialPage: "https://github.com/xinntao/Real-ESRGAN",
    officialUrl: "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
    backupUrl: `${GCS_BACKUP_BASE}/upscale_models/RealESRGAN_x4plus.pth`,
    gated: false,
    sha256: "4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1",
    sizeBytes: 67040989,
  },
};

// ---------------------------------------------------------------------------
// harvest() -- R2 equivalent of Python's disk scan over `official_dir`.
//
// KEY-LAYOUT ASSUMPTION (documented, not yet verified against Task 10, which
// runs after this task and owns the templates route): official template
// workflow JSONs are expected to live in R2 under the `official_templates/`
// prefix, one object per template, same content shape as the files
// `official_templates.py` fetches into `<data_dir>/comfy_templates_official/`
// on the Python side. If Task 10 lands a different prefix, update
// `OFFICIAL_TEMPLATES_PREFIX` below -- the walk/cache logic needs no other
// change.

// Exported so `routes/templates.ts` (Task 10, which owns the R2 key layout
// this was a documented guess about) reads/writes the SAME prefix instead
// of duplicating the literal -- Task 10's ledger note confirms this prefix
// stays as-is.
export const OFFICIAL_TEMPLATES_PREFIX = "official_templates/";
const MANIFEST_NAME = "manifest.json";
const NON_TEMPLATE_PREFIXES = ["index"];

function isTemplateKey(key: string): boolean {
  const base = key.slice(OFFICIAL_TEMPLATES_PREFIX.length);
  if (!base.endsWith(".json")) return false;
  if (base === MANIFEST_NAME) return false;
  if (NON_TEMPLATE_PREFIXES.some((p) => base.startsWith(p))) return false;
  return true;
}

interface HarvestedInfo {
  url: string | null;
  directory: string | null;
}

/** Every model-metadata dict in one workflow JSON, wherever it hides --
 * ports model_guide.py's `_model_entries`. Fully recursive: per-node
 * `nodes[].properties.models`, a top-level `models` list, and subgraph-based
 * workflows' `definitions.subgraphs[].nodes[].properties.models` all fall
 * out of the same generic "any dict's `models` list-value yields its dict
 * entries" walk. */
function* modelEntries(data: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(data)) {
    for (const item of data) yield* modelEntries(item);
    return;
  }
  if (typeof data !== "object" || data === null) return;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (key === "models" && Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
          yield entry as Record<string, unknown>;
        }
      }
    } else {
      yield* modelEntries(value);
    }
  }
}

// Per-isolate harvest cache, keyed by a signature built from the R2 listing
// (sorted `key:etag` pairs joined) -- a fresh listing (new/changed/removed
// template) naturally misses. Unlike Python's per-`data_dir` mtime-keyed
// cache, this resets on every isolate recycle (cold start, new deploy) --
// documented, deliberate divergence: Workers has no long-lived process for a
// module-level cache to survive across, and the cost of a miss is one R2
// LIST + a handful of GETs, cheap enough not to need cross-isolate
// persistence (DO storage) for this.
let harvestCache: { signature: string; result: Record<string, HarvestedInfo> } | null = null;

export async function harvest(store: R2Bucket): Promise<Record<string, HarvestedInfo>> {
  const listed = await store.list({ prefix: OFFICIAL_TEMPLATES_PREFIX });
  const keys = listed.objects.map((o) => `${o.key}:${o.etag}`).sort();
  const signature = keys.join("|");

  if (harvestCache && harvestCache.signature === signature) {
    return harvestCache.result;
  }

  const result: Record<string, HarvestedInfo> = {};
  const templateKeys = listed.objects.map((o) => o.key).filter(isTemplateKey).sort();

  for (const key of templateKeys) {
    const obj = await store.get(key);
    if (!obj) continue;
    let data: unknown;
    try {
      data = JSON.parse(await obj.text());
    } catch {
      continue;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
    for (const entry of modelEntries(data)) {
      const name = entry.name;
      if (typeof name !== "string" || !name) continue;
      if (!(name in result)) {
        result[name] = {
          url: typeof entry.url === "string" ? entry.url : null,
          directory: typeof entry.directory === "string" ? entry.directory : null,
        };
      }
    }
  }

  harvestCache = { signature, result };
  return result;
}

/** Test-only escape hatch -- a fresh test's R2 seed under the same keys
 * (etags differ per put, but a same-key overwrite in a test bucket with a
 * dev-local etag scheme could theoretically collide) should never see a
 * previous test's cached harvest. */
export function clearHarvestCacheForTests(): void {
  harvestCache = null;
}

/** Resolve a model name (as referenced by a workflow) to its download info --
 * ports `lookup`. Curated `SOURCES` are checked first, then `harvest()`'s
 * entries, both matched with `matchesModelName` semantics (a bare name and a
 * category-relative one both resolve to the same entry). */
export async function lookup(name: string, store: R2Bucket): Promise<ModelSource | null> {
  for (const [key, source] of Object.entries(SOURCES)) {
    if (matchesModelName(name, key)) return source;
  }

  const harvested = await harvest(store);
  for (const [key, info] of Object.entries(harvested)) {
    if (matchesModelName(name, key)) {
      return {
        name: key,
        directory: info.directory ?? "",
        sizeGb: null,
        officialPage: null,
        officialUrl: info.url ?? "",
        backupUrl: null,
        gated: false,
      };
    }
  }

  return null;
}

function renderBlock(name: string, source: ModelSource | null): string {
  if (source === null) {
    return `【${name}】\n放置路徑：models/<資料夾依節點類型>/\n官方載點：請向工作流提供者取得下載來源`;
  }

  const header = source.sizeGb === null ? `【${name}】` : `【${name}】(${source.sizeGb} GB)`;
  const lines = [header, `放置路徑：models/${source.directory}/`];

  let officialLine = `官方載點：${source.officialUrl}`;
  if (source.gated) officialLine += FLUX_GATED_NOTE;
  lines.push(officialLine);

  if (source.backupUrl) lines.push(`備份載點：${source.backupUrl}`);

  return lines.join("\n");
}

/** The single-model guidance block (`【name】` + path/official/backup) --
 * ports `model_guidance_block`. Used both as one paragraph of
 * `guidanceMessage` and, standalone, as `node_errors[...].errors[].details`
 * in `routes/comfyapi.ts`'s `POST /prompt` -- same lookup, same rendering,
 * one source of truth. */
export async function modelGuidanceBlock(name: string, store: R2Bucket): Promise<string> {
  return renderBlock(name, await lookup(name, store));
}

/** Renders the zh-TW `POST /prompt` rejection message for `missing` models --
 * ports `guidance_message`. One block per model, joined by blank lines, with
 * the shared header first. */
export async function guidanceMessage(missing: string[], store: R2Bucket): Promise<string> {
  const blocks = [HEADER, ...(await Promise.all(missing.map((name) => modelGuidanceBlock(name, store))))];
  return blocks.join("\n\n");
}

/** One-line zh-TW summary of a missing-model rejection -- ports
 * `guidance_summary`. Synchronous: no source lookup needed, just the missing
 * list's shape. This is the `error.message` of the `/prompt` refusal AND
 * each `node_errors[...].errors[].message` -- deliberately short, see
 * comfyapi.py's `post_prompt` docstring comment for why. */
export function guidanceSummary(missing: string[]): string {
  if (missing.length === 0) return "缺少模型，無法執行——詳見下方下載指引";
  const head = missing[0];
  if (missing.length === 1) return `缺少模型：${head}，無法執行——詳見下方下載指引`;
  return `缺少模型：${head} 等 ${missing.length} 項，無法執行——詳見下方下載指引`;
}

/** Trailing guidance line for node classes no registered worker has --
 * ports `missing_nodes_note`. Appended to `guidanceMessage` when the fleet is
 * missing BOTH models and node classes. */
export function missingNodesNote(missingNodes: string[]): string {
  return `另外，所有 worker 也都缺少節點：${missingNodes.join("、")}——需在 worker 端安裝對應 custom node。`;
}
