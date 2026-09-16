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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Role, TokenBundle, Worker } from '../api';
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
  peer_lan_url: 'http://10.0.0.5:8850',
  peer_nat: 'natpmp',
  peer_reachable: true,
};

const QUIET_WORKER: Worker = {
  ...BASE_WORKER,
  id: 'w-0000000002',
  name: 'runner-quiet',
  peer_url: null,
  peer_lan_url: null,
  peer_nat: 'none',
  peer_reachable: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderWorkers(role: Role = 'admin') {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter>
        <Workers role={role} />
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

const TOKEN_BUNDLE: TokenBundle = {
  platform_url: 'https://console.example.com',
  platform_pubkey: 'ed25519-pubkey-stub',
  register_token: 'tok_abc123XYZ',
};

function stubFetchWithTokenIssuance(workers: Worker[], bundle: TokenBundle = TOKEN_BUNDLE) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/workers/tokens') && init?.method === 'POST') {
      return jsonResponse({ bundle });
    }
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

describe('Workers page: add worker one-line install commands', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function issueToken() {
    stubFetchWithTokenIssuance([]);
    renderWorkers();

    fireEvent.click(await screen.findByRole('button', { name: 'Add worker' }));
    const nameInput = await screen.findByLabelText('Worker name');
    fireEvent.change(nameInput, { target: { value: 'studio-5080' } });
    fireEvent.click(screen.getByRole('button', { name: 'Issue bundle' }));

    await screen.findAllByText(TOKEN_BUNDLE.register_token, { exact: false });
  }

  it('renders the three one-line commands containing the token and platform_url', async () => {
    await issueToken();

    const ps1 = `irm "${TOKEN_BUNDLE.platform_url}/install.ps1?token=${TOKEN_BUNDLE.register_token}" | iex`;
    const cmd = `curl -fsSL "${TOKEN_BUNDLE.platform_url}/install.cmd?token=${TOKEN_BUNDLE.register_token}" -o install.cmd && install.cmd && del install.cmd`;
    const sh = `curl -fsSL "${TOKEN_BUNDLE.platform_url}/install.sh?token=${TOKEN_BUNDLE.register_token}" | bash`;

    expect(await screen.findByText(ps1)).toBeInTheDocument();
    expect(screen.getByText(cmd)).toBeInTheDocument();
    expect(screen.getByText(sh)).toBeInTheDocument();
  });

  it('shows a copy button for each install command and keeps the manual bundle fallback reachable', async () => {
    await issueToken();

    const copyButtons = screen.getAllByRole('button', { name: 'Copy' });
    // One per install command block, plus the manual-fallback copy button once expanded.
    expect(copyButtons.length).toBeGreaterThanOrEqual(3);

    fireEvent.click(screen.getByText('Manual install (advanced)'));
    expect(await screen.findByRole('button', { name: 'Copy bundle' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download .json' })).toBeInTheDocument();
  });
});

describe('Workers page: delete a worker', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /** Serves the list from a mutable array so the post-delete refetch returns
   * the shortened list the real API would -- the row must actually vanish,
   * not merely stop being clickable. */
  function stubFetchWithDelete(initial: Worker[]) {
    let workers = [...initial];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (init?.method === 'DELETE') {
        const id = decodeURIComponent(url.slice('/api/workers/'.length));
        workers = workers.filter((w) => w.id !== id);
        return jsonResponse({ ok: true });
      }
      if (url.startsWith('/api/workers')) return jsonResponse(workers);
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('asks for confirmation, then DELETEs the worker and drops the row', async () => {
    const fetchMock = stubFetchWithDelete([BASE_WORKER, QUIET_WORKER]);
    renderWorkers();

    expect(await screen.findByText('runner-sharing')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);

    // The confirm spells out that billing records survive.
    expect(
      await screen.findByText(
        'Delete worker "runner-sharing"? Billing records are kept, but it disappears from the list and can no longer connect.',
      ),
    ).toBeInTheDocument();

    const confirmButtons = screen.getAllByRole('button', { name: 'Delete' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            (typeof input === 'string' ? input : String(input)) === `/api/workers/${BASE_WORKER.id}` &&
            (init as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(true);
    });

    await waitFor(() => expect(screen.queryByText('runner-sharing')).not.toBeInTheDocument());
    expect(screen.getByText('runner-quiet')).toBeInTheDocument();
  });

  it('does not call DELETE when the confirm is cancelled', async () => {
    const fetchMock = stubFetchWithDelete([BASE_WORKER]);
    renderWorkers();

    expect(await screen.findByText('runner-sharing')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(
      fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'),
    ).toBe(false);
    expect(screen.getByText('runner-sharing')).toBeInTheDocument();
  });
});

describe('Workers page: role-gated mutation controls', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the read-only fleet list for a non-admin user without add/disable/delete controls', async () => {
    stubFetch([BASE_WORKER]);
    renderWorkers('user');

    // The list itself is visible: name, model column, P2P badge all render.
    expect(await screen.findByText('runner-sharing')).toBeInTheDocument();
    expect(screen.getByText('P2P sharing')).toBeInTheDocument();

    // None of the admin-only mutation controls are present for a user.
    expect(screen.queryByRole('button', { name: 'Add worker' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('renders the add/disable/delete controls for an admin', async () => {
    stubFetch([BASE_WORKER]);
    renderWorkers('admin');

    expect(await screen.findByText('runner-sharing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add worker' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });
});

describe('Phase 3.4: the P2P column', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the mapping method, external address and a verified badge', async () => {
    stubFetch([BASE_WORKER]);
    renderWorkers();

    expect(await screen.findByText('Auto port mapping (NAT-PMP)')).toBeInTheDocument();
    expect(screen.getByText('http://192.168.1.5:8850')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
  });

  it('shows "off" for a worker that does not share', async () => {
    stubFetch([QUIET_WORKER]);
    renderWorkers();
    expect(await screen.findByText('Off')).toBeInTheDocument();
  });

  it('shows "not reachable" when the platform could not connect', async () => {
    stubFetch([{ ...BASE_WORKER, peer_reachable: false }]);
    renderWorkers();
    expect(await screen.findByText('Not reachable')).toBeInTheDocument();
  });

  it('shows "not checked" before the first check', async () => {
    stubFetch([{ ...BASE_WORKER, peer_reachable: null }]);
    renderWorkers();
    expect(await screen.findByText('Not checked')).toBeInTheDocument();
  });

  it('shows LAN-only workers as LAN only', async () => {
    stubFetch([{ ...BASE_WORKER, peer_nat: 'lan', peer_url: 'http://192.168.1.5:8850', peer_reachable: false }]);
    renderWorkers();
    expect(await screen.findByText('LAN only')).toBeInTheDocument();
  });
});
