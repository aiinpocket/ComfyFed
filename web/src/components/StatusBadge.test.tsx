// @vitest-environment jsdom
/**
 * Task 6 (idle-pause-cli plan): the "paused" worker status badge.
 *
 * A worker whose heartbeat reports `paused` (manual pause via `comfyfed
 * pause`, or automatic idle detection) renders a distinct, non-pulsing
 * badge using the existing worker-status badge system, labelled 已暫停 /
 * Paused per the zh-TW-first i18n convention.
 */
import '@testing-library/jest-dom/vitest';

import { MantineProvider } from '@mantine/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import i18n from '../i18n';
import { theme } from '../theme';
import { WorkerStatusBadge } from './StatusBadge';

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

describe('WorkerStatusBadge: paused status', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders 已暫停 for status "paused" in zh-TW', async () => {
    await i18n.changeLanguage('zh-TW');
    render(
      <MantineProvider theme={theme}>
        <WorkerStatusBadge status="paused" disabled={false} />
      </MantineProvider>,
    );
    expect(await screen.findByText('已暫停')).toBeInTheDocument();
  });

  it('renders Paused for status "paused" in en', async () => {
    await i18n.changeLanguage('en');
    render(
      <MantineProvider theme={theme}>
        <WorkerStatusBadge status="paused" disabled={false} />
      </MantineProvider>,
    );
    expect(await screen.findByText('Paused')).toBeInTheDocument();
  });

  it('paints paused slate, never the offline grey', async () => {
    // Final review I1: the text-only assertions above stay green even if the
    // `paused: 'slate'` entry is deleted, because WorkerStatusBadge falls
    // back to 'gray' for unknown statuses. Pin the colour itself.
    await i18n.changeLanguage('en');
    const { container } = render(
      <MantineProvider theme={theme}>
        <WorkerStatusBadge status="paused" disabled={false} />
      </MantineProvider>,
    );

    const badge = container.querySelector('.mantine-Badge-root') as HTMLElement | null;
    expect(badge).not.toBeNull();
    expect(badge!.getAttribute('style') ?? '').toContain('slate');
    // The dot next to it, too -- both come from the one WORKER_COLORS map.
    const dot = container.querySelector('span[style*="border-radius"]') as HTMLElement | null;
    expect(dot).not.toBeNull();
    expect(dot!.getAttribute('style') ?? '').toContain('slate');
    expect(badge!.getAttribute('style') ?? '').not.toContain('gray');
    expect(dot!.getAttribute('style') ?? '').not.toContain('gray');
  });
});
