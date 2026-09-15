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

function renderSettings(role: 'admin' | 'user' = 'user') {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter>
        <Settings platformUrl="https://example.test" role={role} />
      </MemoryRouter>
    </MantineProvider>,
  );
}

const SETTINGS_STATE = {
  platform_url: 'https://example.test',
  lang: 'en',
  object_info_mode: 'union',
  upload_max_file_mb: 50,
  upload_user_quota_gb: 5,
  split_batches: true,
};

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

describe('Settings page: admin upload limits', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders both limit fields seeded from GET /api/settings and saves them', async () => {
    const posted: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === '/api/settings' && method === 'GET') return jsonResponse(SETTINGS_STATE);
      if (url === '/api/settings' && method === 'POST') {
        posted.push(JSON.parse(String(init?.body)));
        return jsonResponse({ ...SETTINGS_STATE, upload_max_file_mb: 120, upload_user_quota_gb: 5 });
      }
      if (url === '/api/staging') {
        return jsonResponse({ files: [], total_bytes: 0, quota_bytes: 0, userdata_bytes: 0 });
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSettings('admin');

    const maxFile = (await screen.findByLabelText('Max file size (MB)')) as HTMLInputElement;
    const quota = screen.getByLabelText('Per-user storage quota (GB)') as HTMLInputElement;
    await waitFor(() => expect(maxFile.value).toBe('50'));
    expect(quota.value).toBe('5');

    fireEvent.change(maxFile, { target: { value: '120' } });
    // The platform-URL card has its own "Save" -- scope to this card's form.
    const limitsForm = maxFile.closest('form') as HTMLFormElement;
    fireEvent.click(within(limitsForm).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(posted).toContainEqual({ upload_max_file_mb: 120, upload_user_quota_gb: 5 }),
    );
  });

  it('hides the limits card from a non-admin', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/staging') {
        return jsonResponse({ files: [], total_bytes: 0, quota_bytes: 0, userdata_bytes: 0 });
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSettings('user');

    await screen.findByText('You have not uploaded any files yet.');
    expect(screen.queryByLabelText('Max file size (MB)')).not.toBeInTheDocument();
  });
});

describe('Settings page: uploads quota line', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows used-of-quota and a progress bar over staging + userdata', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/staging') {
        return jsonResponse({
          files: [REF_PNG],
          total_bytes: 2048,
          userdata_bytes: 1024,
          quota_bytes: 1024 * 1024 * 10,
        });
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSettings('user');

    // 2 KB staging + 1 KB userdata against a 10 MB quota.
    expect(await screen.findByText('Used 3 KB of 10 MB')).toBeInTheDocument();
    expect(screen.getByLabelText('Storage usage')).toBeInTheDocument();
  });
});

describe('Settings page: split_batches switch (Phase 3.3 Task 8)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('toggles split_batches and persists it', async () => {
    const posted: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === '/api/settings' && method === 'GET') return jsonResponse(SETTINGS_STATE);
      if (url === '/api/settings' && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        posted.push(body);
        return jsonResponse({ ...SETTINGS_STATE, ...body });
      }
      if (url === '/api/staging') {
        return jsonResponse({ files: [], total_bytes: 0, quota_bytes: 0, userdata_bytes: 0 });
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSettings('admin');

    const toggle = await screen.findByLabelText(/Split batches automatically/);
    fireEvent.click(toggle);

    await waitFor(() => expect(posted).toContainEqual({ split_batches: false }));
  });

  it('does not show the split_batches switch for a non-admin', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/staging') {
        return jsonResponse({ files: [], total_bytes: 0, quota_bytes: 0, userdata_bytes: 0 });
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSettings('user');

    await screen.findByText('You have not uploaded any files yet.');
    expect(screen.queryByLabelText(/Split batches automatically/)).not.toBeInTheDocument();
  });
});
