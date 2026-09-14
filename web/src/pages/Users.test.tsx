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
