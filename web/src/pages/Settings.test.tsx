// @vitest-environment jsdom
/**
 * The Settings page's「我的上傳檔案 / My uploads」card: the per-user staging
 * management UI over `GET /api/staging` and `DELETE /api/staging/{name}`.
 *
 * Exercised against a mocked `fetch` (the same seam `api.ts` uses), covering:
 * the list rendered from the API, the empty state, and the delete flow
 * actually calling the endpoint and refreshing afterwards.
 */
import '@testing-library/jest-dom/vitest';

import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StagingFile } from '../api';
import '../i18n';
import { theme } from '../theme';
import { Settings } from './Settings';

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

const REF_PNG: StagingFile = { name: 'reference.png', size: 2048, modified: 1757800000 };
const MASK_PNG: StagingFile = { name: 'mask.png', size: 1024, modified: 1757800100 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderSettings() {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter>
        <Settings platformUrl="https://example.test" role="user" />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe('Settings page: my uploads card', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the caller’s staged files from GET /api/staging', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/staging' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({ files: [MASK_PNG, REF_PNG], total_bytes: 3072 });
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSettings();

    expect(await screen.findByText('mask.png')).toBeInTheDocument();
    expect(screen.getByText('reference.png')).toBeInTheDocument();
    // Human sizes, plus the total usage line.
    expect(screen.getByText(/1 KB/)).toBeInTheDocument();
    expect(screen.getByText('2 file(s), 3 KB')).toBeInTheDocument();
  });

  it('shows the empty state when the caller has uploaded nothing', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/staging') return jsonResponse({ files: [], total_bytes: 0 });
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSettings();

    expect(await screen.findByText('You have not uploaded any files yet.')).toBeInTheDocument();
  });

  it('deletes a file through DELETE /api/staging/{name} and refreshes the list', async () => {
    let deleted = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === '/api/staging' && method === 'GET') {
        return jsonResponse(
          deleted ? { files: [MASK_PNG], total_bytes: 1024 } : { files: [MASK_PNG, REF_PNG], total_bytes: 3072 },
        );
      }
      if (url === '/api/staging/reference.png' && method === 'DELETE') {
        deleted = true;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSettings();
    await screen.findByText('reference.png');

    fireEvent.click(screen.getByRole('button', { name: 'Delete reference.png' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Delete .reference\.png/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([reqUrl, reqInit]) => {
        const url = typeof reqUrl === 'string' ? reqUrl : reqUrl.toString();
        return url === '/api/staging/reference.png' && reqInit?.method === 'DELETE';
      });
      expect(call).toBeDefined();
    });

    await waitFor(() => expect(screen.queryByText('reference.png')).not.toBeInTheDocument());
    expect(screen.getByText('mask.png')).toBeInTheDocument();
  });
});
