import { describe, expect, it } from 'vitest';

import en from '../i18n/en.json';
import zhTW from '../i18n/zh-TW.json';
import { parseReason } from './reasons';
import { parseWorkflow } from './workflow';

describe('parseReason', () => {
  it('parses a backend mismatch into wanted/actual', () => {
    expect(parseReason('backend:cuda!=rocm')).toEqual({
      key: 'backend',
      values: { wanted: 'cuda', actual: 'rocm' },
      tone: 'error',
    });
  });

  it('tolerates a worker that reports no backend at all', () => {
    expect(parseReason('backend:cuda!=').values).toEqual({ wanted: 'cuda', actual: '?' });
  });

  it('still parses the existing reason shapes', () => {
    expect(parseReason('missing_nodes:A,B').key).toBe('missing_nodes');
    expect(parseReason('missing_models:A').tone).toBe('warning');
    expect(parseReason('vram:46>8+16').values).toEqual({
      needed: '46 GB',
      available: '8 GB',
      ram: '16 GB',
    });
    expect(parseReason('override:min_vram_gb').key).toBe('override_min_vram');
    expect(parseReason('something_new:x').key).toBe('unknown');
  });

  it('parses vram_offload as a non-blocking warning, not an error', () => {
    // LIVE-3: ComfyUI offloads weights to system RAM, so being over VRAM is
    // a note about speed, not a refusal. Tone drives the colour, and a red
    // chip here would read as "this worker cannot run it" — which is wrong.
    const parsed = parseReason('vram_offload:25.4955>15.9');
    expect(parsed.key).toBe('vram_offload');
    expect(parsed.tone).toBe('warning');
    expect(parsed.values).toEqual({ needed: '25.5 GB', available: '15.9 GB' });
  });

  it('still parses a legacy vram reason with no +ram part', () => {
    // Emitted by a server predating the offload-aware gate.
    expect(parseReason('vram:18.4>12').values).toEqual({
      needed: '18.4 GB',
      available: '12 GB',
      ram: '0 GB',
    });
  });

  it('has a translation for every reason key it can emit, in both locales', () => {
    const raws = [
      'missing_nodes:A',
      'missing_models:A',
      'missing_models_unavailable:A',
      'vram:46>8+16',
      'vram_offload:25.49>15.9',
      'backend:cuda!=cpu',
      'override:min_vram_gb',
      'override:min_free_disk_gb',
      'override:gpu_name_contains',
      'mystery:1',
    ];
    for (const raw of raws) {
      const { key } = parseReason(raw);
      expect((en.reasons as Record<string, string>)[key], `en reasons.${key}`).toBeTruthy();
      expect((zhTW.reasons as Record<string, string>)[key], `zh reasons.${key}`).toBeTruthy();
    }
  });
});

describe('parseWorkflow asset detection', () => {
  it('mirrors the server: LoadAudio’s audio input is an asset', () => {
    const summary = parseWorkflow(
      JSON.stringify({
        '1': { class_type: 'LoadAudio', inputs: { audio: 'voice.wav' } },
        '2': { class_type: 'LoadImage', inputs: { image: 'ref.png' } },
        '3': { class_type: 'KSampler', inputs: { seed: 1 } },
      }),
    );
    expect(summary.assets).toEqual(['ref.png', 'voice.wav']);
    expect(summary.nodeCount).toBe(3);
  });

  it('ignores asset-shaped fields on nodes that do not load files', () => {
    const summary = parseWorkflow(
      JSON.stringify({ '1': { class_type: 'KSampler', inputs: { image: 'not-an-upload.png' } } }),
    );
    expect(summary.assets).toEqual([]);
  });
});
