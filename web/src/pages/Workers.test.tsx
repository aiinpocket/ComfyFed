// @vitest-environment jsdom
/**
 * Phase 3.1 Task 7: the P2P sharing badge on the Workers page.
 *
 * A worker whose `peer_url` is set (opted into serving chunks to other
 * workers) shows a small "P2P sharing" badge next to its name; a worker
 * with `peer_url: null` shows no badge at all.
 */
import '@testing-library/jest-dom/vitest';

import { MantineProvider } from '@mantine/core';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Worker } from '../api';
import '../i18n';
import { theme } from '../theme';
import { Workers } from './Workers';

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

const BASE_WORKER: Worker = {
  id: 'w-0000000001',
  name: 'runner-sharing',
  status: 'online',
  last_seen: '2026-09-14T00:00:00Z',
  disabled: false,
  hardware: {},
  dynamic: {},
  backend: 'cuda',
  torch_version: '2.4.0',
  model_count: 3,
  peer_url: 'http://192.168.1.5:8850',
};

const QUIET_WORKER: Worker = {
  ...BASE_WORKER,
  id: 'w-0000000002',
  name: 'runner-quiet',
  peer_url: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderWorkers() {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter>
        <Workers />
      </MemoryRouter>
    </MantineProvider>,
  );
}

function stubFetch(workers: Worker[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/workers')) return jsonResponse(workers);
    return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Workers page: P2P sharing badge', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the P2P sharing badge and the advertised peer_url for a worker with peer_url set', async () => {
    stubFetch([BASE_WORKER]);
    renderWorkers();

    expect(await screen.findByText('runner-sharing')).toBeInTheDocument();
    expect(await screen.findByText('P2P sharing')).toBeInTheDocument();
    expect(await screen.findByText('http://192.168.1.5:8850')).toBeInTheDocument();
  });

  it('shows no badge and no peer_url text for a worker with peer_url null', async () => {
    stubFetch([QUIET_WORKER]);
    renderWorkers();

    expect(await screen.findByText('runner-quiet')).toBeInTheDocument();
    expect(screen.queryByText('P2P sharing')).not.toBeInTheDocument();
    expect(screen.queryByText('http://192.168.1.5:8850')).not.toBeInTheDocument();
  });
});
