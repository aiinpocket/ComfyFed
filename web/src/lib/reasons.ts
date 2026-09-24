import type { TFunction } from 'i18next';

/**
 * The assessment engine emits machine reason strings; the console turns them
 * into plain-language bilingual sentences. Shapes emitted by `assess.verdict`:
 *
 *   missing_nodes:A,B
 *   missing_models:A,B                (fetchable from a peer — soft)
 *   missing_models_unavailable:A,B    (nowhere in the federation — hard)
 *   missing_models_peer_protocol:A,B  (peer-only model, worker's protocol
 *                                      too old to speak the peer-pull
 *                                      protocol — hard; final-review L6)
 *   vram:25.5>15.9+63.6               (needs > VRAM + system RAM — hard)
 *
 * ...and the shapes emitted as non-blocking `warnings` on an ELIGIBLE
 * verdict, which parse through the same function but are rendered as a dim
 * note rather than a refusal:
 *
 *   vram_offload:25.5>15.9            (over VRAM, fits in VRAM + RAM)
 *   backend:cuda!=rocm                (override wanted != worker reports)
 *   override:min_vram_gb | override:min_free_disk_gb | override:gpu_name_contains
 *   backend_unsupported:mps:A,B       (model job on a non-NVIDIA worker;
 *                                      the models are not marked for that
 *                                      backend -- hard, 2026-09-20)
 */

export interface ParsedReason {
  /** i18n key under `reasons.` */
  key: string;
  /** Interpolation values for that key. */
  values: Record<string, string>;
  /** How to colour the chip. */
  tone: 'warning' | 'error';
}

const LIST_SEPARATOR = ', ';

export function parseReason(raw: string): ParsedReason {
  const separatorIndex = raw.indexOf(':');
  const prefix = separatorIndex === -1 ? raw : raw.slice(0, separatorIndex);
  const rest = separatorIndex === -1 ? '' : raw.slice(separatorIndex + 1);

  switch (prefix) {
    case 'missing_nodes':
      return {
        key: 'missing_nodes',
        values: { items: rest.split(',').filter(Boolean).join(LIST_SEPARATOR) },
        tone: 'error',
      };

    case 'missing_models':
      return {
        key: 'missing_models',
        values: { items: rest.split(',').filter(Boolean).join(LIST_SEPARATOR) },
        tone: 'warning',
      };

    case 'missing_models_unavailable':
      return {
        key: 'missing_models_unavailable',
        values: { items: rest.split(',').filter(Boolean).join(LIST_SEPARATOR) },
        tone: 'error',
      };

    case 'backend_unsupported': {
      const [backend, models] = [rest.slice(0, rest.indexOf(':')), rest.slice(rest.indexOf(':') + 1)];
      return {
        key: 'backend_unsupported',
        values: { backend: backend || 'unknown', items: models.split(',').filter(Boolean).join(LIST_SEPARATOR) },
        tone: 'error',
      };
    }

    case 'missing_models_peer_protocol':
      return {
        key: 'missing_models_peer_protocol',
        values: { items: rest.split(',').filter(Boolean).join(LIST_SEPARATOR) },
        tone: 'error',
      };

    case 'vram': {
      // `needed>vram+ram`. Older servers emitted `needed>vram` with no `+`
      // part, so the second half is split defensively rather than assumed.
      const [needed, budget] = rest.split('>');
      const [vram, ram] = (budget ?? '').split('+');
      return {
        key: 'vram',
        values: {
          needed: formatGb(needed),
          available: formatGb(vram),
          ram: formatGb(ram ?? '0'),
        },
        tone: 'error',
      };
    }

    case 'vram_offload': {
      // Not a refusal: ComfyUI streams weights from system RAM when they do
      // not fit in VRAM. The job runs, just more slowly.
      const [needed, available] = rest.split('>');
      return {
        key: 'vram_offload',
        values: {
          needed: formatGb(needed),
          available: formatGb(available),
        },
        tone: 'warning',
      };
    }

    case 'backend': {
      const [wanted, actual] = rest.split('!=');
      return {
        key: 'backend',
        values: { wanted: wanted || '?', actual: actual || '?' },
        tone: 'error',
      };
    }

    case 'override':
      switch (rest) {
        case 'min_vram_gb':
          return { key: 'override_min_vram', values: {}, tone: 'error' };
        case 'min_free_disk_gb':
          return { key: 'override_min_free_disk', values: {}, tone: 'error' };
        case 'gpu_name_contains':
          return { key: 'override_gpu_name', values: {}, tone: 'error' };
        default:
          return { key: 'unknown', values: { raw }, tone: 'error' };
      }

    default:
      return { key: 'unknown', values: { raw }, tone: 'error' };
  }
}

function formatGb(value: string | undefined): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '?');
  return `${Math.round(n * 10) / 10} GB`;
}

/** Render a raw reason string as a translated sentence. */
export function translateReason(raw: string, t: TFunction): string {
  const parsed = parseReason(raw);
  return t(`reasons.${parsed.key}`, parsed.values);
}
