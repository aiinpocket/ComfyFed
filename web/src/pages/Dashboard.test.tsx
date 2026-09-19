// @vitest-environment jsdom
/**
 * Users get read-only Workers view + fleet visibility on the dashboard.
 *
 * `GET /api/workers` is now a read-only listing any logged-in user may load
 * (workers are shared infrastructure), so a non-admin's dashboard fetches the
 * fleet and renders the worker cards -- the section that used to be gated
 * behind `isAdmin`. No mutation controls exist on the dashboard, so nothing
 * admin-only is exposed by showing it.
 */
import '@testing-library/jest-dom/vitest';

import { MantineProvider } from '@mantine/core';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Role, Worker } from '../api';
import '../i18n';
import { theme } from '../theme';
import { Dashboard } from './Dashboard';

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

if (!('ResizeObserver' in window)) {
  class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
}

const WORKER: Worker = {
  id: 'w-0000000001',
  name: 'runner-shared',
  status: 'online',
  last_seen: '2026-09-14T00:00:00Z',
  disabled: false,
  hardware: { gpu_name: 'RTX 5080' },
  dynamic: {},
  backend: 'cuda',
  torch_version: '2.4.0',
  model_count: 3,
  peer_url: null,
  peer_lan_url: null,
  peer_nat: 'none',
  peer_reachable: null,
  unsuitable: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Serves the fleet from `/api/workers` and an empty active-job queue. */
function stubFetch(workers: Worker[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/workers')) return jsonResponse(workers);
    if (url.startsWith('/api/jobs')) return jsonResponse([]);
    return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderDashboard(role: Role = 'user') {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter>
        <Dashboard role={role} />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe('Dashboard: KPI tiles agree with the row badge', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function tileValue(label: string): string {
    // StatCard renders label + value inside one Mantine Card; scope the
    // lookup to that card so the page's other numbers (queued/running) can
    // never satisfy the assertion by accident.
    const card = screen.getByText(label).closest('.mantine-Card-root') as HTMLElement;
    expect(card).not.toBeNull();
    return within(card).getByText(/^\d+$/).textContent ?? '';
  }

  it('counts a paused worker under "busy", not "online" (badge says worker 繁忙)', async () => {
    stubFetch([
      { ...WORKER, id: 'w-online', name: 'idle-box', status: 'online' },
      { ...WORKER, id: 'w-busy', name: 'render-box', status: 'busy' },
      { ...WORKER, id: 'w-paused', name: 'human-box', status: 'paused' },
    ]);
    renderDashboard('admin'); // the KPI tiles are admin-only

    expect(await screen.findByText('human-box')).toBeInTheDocument();
    // Owner-reported: the list showed "worker 繁忙" while these tiles kept
    // counting the paused worker as online, so the numbers never moved.
    expect(tileValue('Workers online')).toBe('1');
    expect(tileValue('Workers busy')).toBe('2');
  });

  it('does not count a disabled worker in either tile', async () => {
    stubFetch([
      { ...WORKER, id: 'w-online', name: 'idle-box', status: 'online' },
      { ...WORKER, id: 'w-off', name: 'parked-box', status: 'paused', disabled: true },
    ]);
    renderDashboard('admin');

    expect(await screen.findByText('idle-box')).toBeInTheDocument();
    expect(tileValue('Workers online')).toBe('1');
    expect(tileValue('Workers busy')).toBe('0');
  });
});

describe('Dashboard: fleet visibility for a non-admin user', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("fetches /api/workers and renders the fleet section for a user", async () => {
    const fetchMock = stubFetch([WORKER]);
    renderDashboard('user');

    // The worker card renders for a user -- the fleet section is no longer
    // gated behind admin.
    expect(await screen.findByText('runner-shared')).toBeInTheDocument();

    // The user's dashboard actually issued the workers fetch (not skipped).
    expect(
      fetchMock.mock.calls.some(
        ([input]) => (typeof input === 'string' ? input : String(input)).startsWith('/api/workers'),
      ),
    ).toBe(true);
  });
});
