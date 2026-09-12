import type { TFunction } from 'i18next';

/**
 * The assessment engine emits machine reason strings; the console turns them
 * into plain-language bilingual sentences. Shapes emitted by `assess.verdict`:
 *
 *   missing_nodes:A,B
 *   missing_models:A,B                (fetchable from a peer — soft)
 *   missing_models_unavailable:A,B    (nowhere in the federation — hard)
 *   vram:18.4>12                      (needs > has)
 *   backend:cuda!=rocm                (override wanted != worker reports)
 *   override:min_vram_gb | override:min_free_disk_gb | override:gpu_name_contains
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

    case 'vram': {
      const [needed, available] = rest.split('>');
      return {
        key: 'vram',
        values: {
          needed: formatGb(needed),
          available: formatGb(available),
        },
        tone: 'error',
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
