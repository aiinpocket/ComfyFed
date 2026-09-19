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

import type { ApiToken, StagingFile } from '../api';
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
  trust_proxy: false,
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

  it('toggles trust_proxy and persists it', async () => {
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

    const toggle = await screen.findByLabelText(/Trust X-Forwarded-For/);
    fireEvent.click(toggle);

    await waitFor(() => expect(posted).toContainEqual({ trust_proxy: true }));
  });

  it('hides the trust_proxy switch when the platform does not expose it (cloud)', async () => {
    const { trust_proxy: _omitted, ...cloudState } = SETTINGS_STATE;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === '/api/settings' && method === 'GET') return jsonResponse(cloudState);
      if (url === '/api/staging') {
        return jsonResponse({ files: [], total_bytes: 0, quota_bytes: 0, userdata_bytes: 0 });
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSettings('admin');

    await screen.findByLabelText(/Split batches automatically/);
    expect(screen.queryByLabelText(/Trust X-Forwarded-For/)).not.toBeInTheDocument();
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

/* --------------------------------------------- API tokens (design §4.4) */

const ACTIVE_TOKEN: ApiToken = {
  id: 'tok-active-1',
  name: 'Claude desktop',
  prefix: 'cft_ab12cd34',
  created_at: '2026-09-19T00:00:00Z',
  expires_at: '2026-10-19T00:00:00Z',
  last_used_at: '2026-09-20T01:00:00Z',
  revoked_at: null,
  active: true,
};

const REVOKED_TOKEN: ApiToken = {
  id: 'tok-revoked-2',
  name: 'Old laptop',
  prefix: 'cft_ef56gh78',
  created_at: '2026-09-01T00:00:00Z',
  expires_at: '2026-10-01T00:00:00Z',
  last_used_at: null,
  revoked_at: '2026-09-18T00:00:00Z',
  active: false,
};

const EXPIRED_TOKEN: ApiToken = {
  id: 'tok-expired-3',
  name: 'Last month',
  prefix: 'cft_ij90kl12',
  created_at: '2026-07-20T00:00:00Z',
  expires_at: '2026-08-19T00:00:00Z',
  last_used_at: '2026-08-01T00:00:00Z',
  revoked_at: null,
  active: false,
};

const CREATED_TOKEN = {
  id: 'tok-new-9',
  name: 'Claude desktop',
  token: 'cft_ab12cd34ZZZZZZZZZZZZZZZZZZZZZZZZ',
  prefix: 'cft_ab12cd34',
  created_at: '2026-09-20T00:00:00Z',
  expires_at: '2026-10-20T00:00:00Z',
};

/**
 * `fetch` stub for the token card: `GET /api/auth/tokens` answers from a
 * mutable list, so a create/revoke can be seen to refresh it. The other
 * endpoints the Settings page touches on mount are stubbed out quietly.
 */
function stubTokenFetch(options: {
  tokens?: ApiToken[];
  createStatus?: number;
  createBody?: unknown;
}) {
  const state = { tokens: options.tokens ?? [] };
  const posted: unknown[] = [];
  const deleted: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (url === '/api/auth/tokens' && method === 'GET') return jsonResponse(state.tokens);
    if (url === '/api/auth/tokens' && method === 'POST') {
      posted.push(JSON.parse(String(init?.body)));
      if (options.createStatus && options.createStatus >= 400) {
        return jsonResponse(options.createBody, options.createStatus);
      }
      const created = CREATED_TOKEN;
      state.tokens = [
        ...state.tokens,
        {
          id: created.id,
          name: created.name,
          prefix: created.prefix,
          created_at: created.created_at,
          expires_at: created.expires_at,
          last_used_at: null,
          revoked_at: null,
          active: true,
        },
      ];
      return jsonResponse(created, 201);
    }
    const revokeMatch = /^\/api\/auth\/tokens\/([^/]+)$/.exec(url);
    if (revokeMatch && method === 'DELETE') {
      deleted.push(revokeMatch[1]);
      state.tokens = state.tokens.map((token) =>
        token.id === revokeMatch[1]
          ? { ...token, revoked_at: '2026-09-20T02:00:00Z', active: false }
          : token,
      );
      return jsonResponse({ revoked: true });
    }
    if (url === '/api/staging') {
      return jsonResponse({ files: [], total_bytes: 0, quota_bytes: 0, userdata_bytes: 0 });
    }
    if (url === '/api/settings' && method === 'GET') return jsonResponse(SETTINGS_STATE);
    return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, posted, deleted };
}

async function generateToken(name = 'Claude desktop') {
  const nameInput = await screen.findByLabelText('Token name');
  fireEvent.change(nameInput, { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
}

describe('Settings page: API tokens card', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists the caller’s tokens with prefix and a status per row', async () => {
    stubTokenFetch({ tokens: [ACTIVE_TOKEN, REVOKED_TOKEN, EXPIRED_TOKEN] });
    renderSettings('user');

    expect(await screen.findByText('Claude desktop')).toBeInTheDocument();
    expect(screen.getByText('cft_ab12cd34')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Revoked')).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
    // A token that was never used shows "Never" rather than an empty cell.
    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  it('shows the empty state when the caller has no tokens', async () => {
    stubTokenFetch({ tokens: [] });
    renderSettings('user');

    expect(await screen.findByText('No API tokens yet.')).toBeInTheDocument();
  });

  it('creates a token, shows the plaintext exactly once, and refreshes the list', async () => {
    const { posted } = stubTokenFetch({ tokens: [] });
    renderSettings('user');

    await generateToken();

    const plaintext = await screen.findByTestId('api-token-plaintext');
    expect(plaintext).toHaveTextContent(CREATED_TOKEN.token);
    expect(posted).toContainEqual({ name: 'Claude desktop' });

    // The new row lands in the list underneath.
    await waitFor(() => expect(screen.getByText('cft_ab12cd34')).toBeInTheDocument());

    // Dismissing it removes the plaintext for good -- it is never re-rendered.
    fireEvent.click(screen.getByRole('button', { name: 'I have saved it' }));
    await waitFor(() => expect(screen.queryByTestId('api-token-plaintext')).not.toBeInTheDocument());
    expect(screen.queryByText(CREATED_TOKEN.token)).not.toBeInTheDocument();
  });

  it('downloads comfyfed-mcp.json with platform_url, token and expires_at', async () => {
    stubTokenFetch({ tokens: [] });
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:mock-url';
    });
    const revokeObjectURL = vi.fn();
    // jsdom implements neither method, so they are defined (not spied) here
    // and removed again below.
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    // jsdom cannot follow a `blob:` download, and letting the anchor click
    // through prints a "navigation not implemented" error -- the assertions
    // below look at the anchor element itself instead.
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    renderSettings('user');
    await generateToken();

    fireEvent.click(await screen.findByTestId('api-token-download'));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe('application/json');
    expect(JSON.parse(await blobs[0].text())).toEqual({
      platform_url: 'https://example.test',
      token: CREATED_TOKEN.token,
      expires_at: CREATED_TOKEN.expires_at,
    });

    const anchor = clickSpy.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('comfyfed-mcp.json');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');

    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  });

  it('revokes a token after the confirm dialog and shows it as revoked', async () => {
    const { deleted } = stubTokenFetch({ tokens: [ACTIVE_TOKEN] });
    renderSettings('user');

    await screen.findByText('Claude desktop');
    fireEvent.click(screen.getByTestId(`api-token-revoke-${ACTIVE_TOKEN.id}`));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Claude desktop/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(deleted).toEqual([ACTIVE_TOKEN.id]));
    await waitFor(() => expect(screen.getByText('Revoked')).toBeInTheDocument());
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  it('dismissing the confirm dialog does not revoke anything', async () => {
    const { deleted } = stubTokenFetch({ tokens: [ACTIVE_TOKEN] });
    renderSettings('user');

    await screen.findByText('Claude desktop');
    fireEvent.click(screen.getByTestId(`api-token-revoke-${ACTIVE_TOKEN.id}`));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(deleted).toEqual([]);
  });

  it('surfaces auth.too_many_tokens instead of a plaintext panel', async () => {
    stubTokenFetch({
      tokens: [],
      createStatus: 409,
      createBody: { error: { code: 'auth.too_many_tokens', message: 'too many' } },
    });
    renderSettings('user');

    await generateToken();

    expect(
      await screen.findByText('You already have the maximum of 10 active tokens. Revoke one first.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Could not create the token')).toBeInTheDocument();
    expect(screen.queryByTestId('api-token-plaintext')).not.toBeInTheDocument();
  });

  it('surfaces auth.bad_token_name (400) and leaves the form usable', async () => {
    const { posted } = stubTokenFetch({
      tokens: [],
      createStatus: 400,
      createBody: { error: { code: 'auth.bad_token_name', message: 'name too long' } },
    });
    renderSettings('user');

    await generateToken('x'.repeat(80));

    expect(
      await screen.findByText('That token name is too long (64 characters at most).'),
    ).toBeInTheDocument();
    expect(screen.getByText('Could not create the token')).toBeInTheDocument();
    expect(screen.queryByTestId('api-token-plaintext')).not.toBeInTheDocument();

    // The form stays usable: the rejected name is still editable and a second
    // attempt goes out (the input is not disabled and the button is not stuck
    // in its loading state).
    const nameInput = screen.getByLabelText('Token name') as HTMLInputElement;
    expect(nameInput).toBeEnabled();
    fireEvent.change(nameInput, { target: { value: 'shorter' } });
    expect(nameInput.value).toBe('shorter');

    const generate = screen.getByRole('button', { name: 'Generate' });
    expect(generate).toBeEnabled();
    fireEvent.click(generate);
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toEqual({ name: 'shorter' });
  });
});
