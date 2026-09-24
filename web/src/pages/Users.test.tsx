// @vitest-environment jsdom
/**
 * Phase 3.0 Task 7: the console's admin-only user-management page.
 *
 * Exercises `Users` against a mocked `fetch` (the same seam `api.ts` itself
 * uses), covering: rows rendered from `GET /api/users`, the create flow
 * (POSTs the entered body and surfaces the server's one-time password), and
 * the `last_admin` error surfacing its translated message instead of a raw
 * error code.
 */
import '@testing-library/jest-dom/vitest';

import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppUser } from '../api';
import '../i18n';
import { theme } from '../theme';
import { Users } from './Users';

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

const ADMIN_USER: AppUser = {
  id: 'u-admin-0001',
  username: 'alice',
  role: 'admin',
  disabled: false,
  created_at: '2026-09-01T00:00:00Z',
  jobs: 12,
};

const REGULAR_USER: AppUser = {
  id: 'u-user-0002',
  username: 'bob',
  role: 'user',
  disabled: false,
  created_at: '2026-09-02T00:00:00Z',
  jobs: 3,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderUsers() {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter>
        <Users />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe('Users page: listing', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders rows from the mocked GET /api/users', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === '/api/users' && method === 'GET') {
        return jsonResponse({ users: [ADMIN_USER, REGULAR_USER] });
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderUsers();

    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows each user\'s used bytes, and a dash from a server that omits them (2026-09-24)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/users' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({ users: [{ ...ADMIN_USER, used_bytes: 5 * 1024 * 1024 }, REGULAR_USER] });
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderUsers();

    expect(await screen.findByText('5 MB')).toBeInTheDocument();
    expect(screen.getByText('Used')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

describe('Users page: create flow', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('POSTs the entered username/role and shows the returned one-time password', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === '/api/users' && method === 'GET') {
        return jsonResponse({ users: [ADMIN_USER] });
      }
      if (url === '/api/users' && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        expect(body.username).toBe('carol');
        expect(body.role).toBe('user');
        return jsonResponse({ id: 'u-new', username: 'carol', role: 'user', password: 'r4nd0m-secret' });
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderUsers();
    await screen.findByText('alice');

    fireEvent.click(screen.getByRole('button', { name: 'Create user' }));

    const dialog = await screen.findByRole('dialog');
    const usernameInput = within(dialog).getByLabelText('Username');
    fireEvent.change(usernameInput, { target: { value: 'carol' } });

    const createButton = within(dialog).getByRole('button', { name: 'Create' });
    fireEvent.click(createButton);

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(([reqUrl, reqInit]) => {
        const url = typeof reqUrl === 'string' ? reqUrl : reqUrl.toString();
        return url === '/api/users' && reqInit?.method === 'POST';
      });
      expect(postCall).toBeDefined();
    });

    expect(await screen.findByText('r4nd0m-secret')).toBeInTheDocument();
    expect(screen.getByText('This password is shown only this once -- save it now.')).toBeInTheDocument();
  });
});

describe('Users page: error mapping', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('surfaces the translated last_admin message when disabling the last admin is rejected', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === '/api/users' && method === 'GET') {
        return jsonResponse({ users: [ADMIN_USER] });
      }
      if (url === `/api/users/${ADMIN_USER.id}` && method === 'PATCH') {
        return jsonResponse({ error: { code: 'last_admin', message: 'Cannot disable or demote the only active admin.' } }, 400);
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderUsers();
    await screen.findByText('alice');

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));

    const dialog = await screen.findByRole('dialog');
    const confirmButton = within(dialog).getByRole('button', { name: 'Disable' });
    fireEvent.click(confirmButton);

    expect(
      await screen.findByText('The last active admin cannot be disabled or demoted.'),
    ).toBeInTheDocument();
  });

  it('surfaces the translated last_admin message when demoting the last admin is rejected', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === '/api/users' && method === 'GET') {
        return jsonResponse({ users: [ADMIN_USER] });
      }
      if (url === `/api/users/${ADMIN_USER.id}` && method === 'PATCH') {
        const body = JSON.parse(String(init?.body));
        expect(body.role).toBe('user');
        return jsonResponse({ error: { code: 'last_admin', message: 'Cannot disable or demote the only active admin.' } }, 400);
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderUsers();
    await screen.findByText('alice');

    fireEvent.click(screen.getByRole('button', { name: 'Make regular user' }));

    const dialog = await screen.findByRole('dialog');
    const confirmButton = within(dialog).getByRole('button', { name: 'Save' });
    fireEvent.click(confirmButton);

    expect(
      await screen.findByText('The last active admin cannot be disabled or demoted.'),
    ).toBeInTheDocument();
  });
});

describe('Users page: per-user limits & NSFW (2026-09-20)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the override column and PATCHes the edited limits with null for blank fields', async () => {
    const restricted: AppUser = { ...REGULAR_USER, max_file_mb: 200, quota_gb: null, nsfw_allowed: false };
    const patches: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === '/api/users' && method === 'GET') return jsonResponse({ users: [ADMIN_USER, restricted] });
      if (url === '/api/settings' && method === 'GET') {
        return jsonResponse({ platform_url: '', lang: 'en', object_info_mode: 'union', upload_max_file_mb: 50, upload_user_quota_gb: 5, split_batches: true });
      }
      if (url === `/api/users/${restricted.id}` && method === 'PATCH') {
        patches.push(JSON.parse(String(init?.body)));
        return jsonResponse({ ...restricted, max_file_mb: 100, quota_gb: null, nsfw_allowed: null });
      }
      return jsonResponse({ error: { code: 'not_found', message: 'nope' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderUsers();
    expect(await screen.findByText('bob')).toBeInTheDocument();
    expect(screen.getByText('NSFW off')).toBeInTheDocument();
    expect(screen.getByText('200 MB / 5 GB')).toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();

    const bobRow = screen.getByText('bob').closest('tr')!;
    fireEvent.click(within(bobRow).getByRole('button', { name: 'Limits & NSFW' }));
    const dialog = await screen.findByRole('dialog');
    const mbInput = within(dialog).getByLabelText('Max file size (MB)') as HTMLInputElement;
    expect(mbInput.value).toBe('200');
    fireEvent.change(mbInput, { target: { value: '100' } });
    const nsfwSwitch = within(dialog).getByRole('switch', { name: /May submit NSFW work/ }) as HTMLInputElement;
    expect(nsfwSwitch.checked).toBe(false);
    fireEvent.click(nsfwSwitch);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ max_file_mb: 100, quota_gb: null, nsfw_allowed: null });
  });
});
