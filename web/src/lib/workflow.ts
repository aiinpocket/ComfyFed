/**
 * Client-side mirror of the server's `assess.extract` (server/comfyfed_server/assess.py).
 *
 * Used only to preview a pasted workflow before submission — the server
 * re-extracts authoritatively — so the two lists must stay in step.
 */

const MODEL_FIELD_NAMES = new Set([
  'ckpt_name',
  'unet_name',
  'clip_name',
  'clip_name1',
  'clip_name2',
  'vae_name',
  'lora_name',
  'model_name',
  'control_net_name',
  'style_model_name',
  'upscale_model_name',
]);

const MODEL_EXTENSIONS = ['.safetensors', '.ckpt', '.pt', '.sft', '.gguf'];

const ASSET_NODE_CLASSES = new Set(['LoadImage', 'LoadImageMask', 'LoadAudio']);

/** Input fields on those classes that name an uploaded file. */
const ASSET_FIELD_NAMES = ['image', 'audio', 'video'];

export interface WorkflowSummary {
  nodeCount: number;
  nodeClasses: string[];
  models: string[];
  assets: string[];
}

export class WorkflowParseError extends Error {}

function isModelValue(field: string, value: unknown): value is string {
  if (!MODEL_FIELD_NAMES.has(field)) return false;
  if (typeof value !== 'string') return false;
  return MODEL_EXTENSIONS.some((ext) => value.endsWith(ext));
}

/** Parse ComfyUI API-format JSON text into a submission preview. */
export function parseWorkflow(text: string): WorkflowSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WorkflowParseError('invalid_json');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WorkflowParseError('not_api_format');
  }

  const nodeClasses = new Set<string>();
  const models = new Set<string>();
  const assets = new Set<string>();
  let nodeCount = 0;

  for (const node of Object.values(parsed as Record<string, unknown>)) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) continue;
    nodeCount += 1;
    const record = node as Record<string, unknown>;

    const classType = record.class_type;
    if (typeof classType === 'string') nodeClasses.add(classType);

    const inputs = record.inputs;
    if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) continue;
    const inputRecord = inputs as Record<string, unknown>;

    for (const [field, value] of Object.entries(inputRecord)) {
      if (isModelValue(field, value)) models.add(value);
    }

    if (typeof classType === 'string' && ASSET_NODE_CLASSES.has(classType)) {
      for (const field of ASSET_FIELD_NAMES) {
        const value = inputRecord[field];
        if (typeof value === 'string') assets.add(value);
      }
    }
  }

  if (nodeCount === 0) throw new WorkflowParseError('not_api_format');

  return {
    nodeCount,
    nodeClasses: [...nodeClasses].sort(),
    models: [...models].sort(),
    assets: [...assets].sort(),
  };
}
