// @vitest-environment jsdom
/**
 * Reports page time window: the shared preset + from/to control, exercised
 * through the plain-user panel (one request, no tabs) against a mocked
 * `fetch`, so the assertions cover the real query string the backends see.
 */
import '@testing-library/jest-dom/vitest';

import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import dayjs from 'dayjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '../i18n';
import { theme } from '../theme';
import { Reports } from './Reports';

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

// Mantine's Combobox scrolls the active option into view; jsdom has no layout.
Element.prototype.scrollIntoView ??= () => {};

if (!('ResizeObserver' in window)) {
  class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
}

const USAGE = { user_id: 'u1', username: 'alice', jobs: 3, gpu_seconds: 120, unbilled_gpu_seconds: 0 };

/** Every `GET /api/reports/my-usage?...` call's parsed query params, in order. */
function stubMyUsage(): () => URLSearchParams[] {
  const calls: URLSearchParams[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://x');
      if (url.pathname === '/api/reports/my-usage') {
        calls.push(url.searchParams);
        return new Response(JSON.stringify(USAGE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    }),
  );
  return () => calls;
}

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

function renderReports() {
  return render(
    <MantineProvider theme={theme}>
      <Reports role="user" />
    </MantineProvider>,
  );
}

describe('Reports time window', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('defaults to the trailing 7 days and sends offset-aware bounds', async () => {
    const calls = stubMyUsage();
    renderReports();

    await waitFor(() => expect(calls()).toHaveLength(1));
    const [q] = calls();
    const from = q.get('from')!;
    const to = q.get('to')!;
    expect(from).toMatch(ISO_WITH_OFFSET);
    expect(to).toMatch(ISO_WITH_OFFSET);
    expect(dayjs(to).diff(dayjs(from), 'day')).toBe(7);
    expect(Math.abs(dayjs(to).diff(dayjs(), 'second'))).toBeLessThan(60);
  });

  it('switching the preset to "today" re-queries from local midnight', async () => {
    const calls = stubMyUsage();
    renderReports();
    await waitFor(() => expect(calls()).toHaveLength(1));

    fireEvent.click(screen.getByRole('textbox', { name: /區間|Range/ }));
    fireEvent.click(await screen.findByRole('option', { name: /今天|Today/ }));

    await waitFor(() => expect(calls()).toHaveLength(2));
    const from = calls()[1].get('from')!;
    expect(dayjs(from).toDate()).toEqual(dayjs().startOf('day').toDate());
  });

  it('clearing the "from" bound flips the preset to custom and drops the param', async () => {
    const calls = stubMyUsage();
    renderReports();
    await waitFor(() => expect(calls()).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: /清除起始時間|Clear start/ }));

    await waitFor(() => expect(calls()).toHaveLength(2));
    expect(calls()[1].has('from')).toBe(false);
    expect(calls()[1].get('to')).toMatch(ISO_WITH_OFFSET);
    const preset = screen.getByRole('textbox', { name: /區間|Range/ }) as HTMLInputElement;
    expect(preset.value).toMatch(/自訂|Custom/);
  });
});
