// @vitest-environment jsdom
/**
 * Phase 3.0 Task 6: role-based navigation and route guards.
 *
 * Workers are shared infrastructure, so EVERY role sees the Workers nav item
 * and /workers renders a read-only fleet view (`GET /api/workers` is
 * `require_user` on both stacks). What separates the roles is the mutation
 * UI: a `user` never gets the add-worker / disable / delete controls, whose
 * endpoints stay admin-only (`require_csrf` chains off `require_admin`).
 * /users remains admin-only: a `user` deep-linking there is redirected to
 * /dashboard and its `GET /api/users` never fires.
 */
import '@testing-library/jest-dom/vitest';

import { MantineProvider } from '@mantine/core';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import './i18n';
import { App } from './App';
import { theme } from './theme';

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderApp(initialEntry: string) {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <App />
      </MemoryRouter>
    </MantineProvider>,
  );
}

function stubFetch(role: 'admin' | 'user') {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url === '/api/setup/status' && method === 'GET') {
      return jsonResponse({ error: { code: 'http_error', message: 'not found' } }, 404);
    }
    if (url === '/api/auth/me' && method === 'GET') {
      return jsonResponse({ authenticated: true, username: 'alice', role, lang: 'en', platform_url: '' });
    }
    if (url.startsWith('/api/jobs') && method === 'GET') {
      return jsonResponse(url.includes('?page=') ? { jobs: [], total: 0, page: 1, limit: 25 } : []);
    }
    if (url === '/api/workers' && method === 'GET') {
      // require_user on both stacks: every role gets the fleet list. (The
      // 403 that used to live here was the OLD admin-only policy.)
      return jsonResponse([]);
    }
    if (url === '/api/users' && method === 'GET') {
      if (role !== 'admin') {
        return jsonResponse({ error: { code: 'auth.forbidden', message: 'Admin role required.' } }, 403);
      }
      return jsonResponse({ users: [] });
    }
    return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('App: role-based navigation and route guards', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('a "user" role sees the Workers nav item and /workers renders read-only (no admin controls)', async () => {
    const fetchMock = stubFetch('user');
    renderApp('/workers');

    // The read-only fleet page renders for a plain user -- no redirect.
    expect(await screen.findByText('Registered GPU workers in this federation.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Workers/i })).toBeInTheDocument();

    // The list fetch fires: GET /api/workers is require_user now, not admin-only.
    expect(fetchMock).toHaveBeenCalledWith('/api/workers', expect.anything());

    // What a user must NEVER get: the mutation controls whose endpoints 403
    // for a non-admin. Not CSS-hidden -- not rendered at all. `queryAllByRole`
    // so a stray second match can never mask this as a "multiple elements"
    // throw instead of a clean assertion.
    expect(screen.queryAllByRole('button', { name: /Add worker|新增 Worker/i })).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: /^Disable$|停用/i })).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: /^Delete$|刪除/i })).toHaveLength(0);
  });

  it('an "admin" role sees the Workers nav item and /workers renders the page', async () => {
    stubFetch('admin');
    renderApp('/workers');

    expect(await screen.findByText('Registered GPU workers in this federation.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Workers/i })).toBeInTheDocument();

    // Positive counterpart to the user-role negatives above: the same query
    // that must find NOTHING for a user finds the real control for an admin,
    // proving those negative assertions are matching a control that exists.
    // `getAllByRole`: "Add worker" renders twice on an empty fleet (the
    // header button AND the empty-state CTA), which would make `getByRole`
    // throw on multiple matches rather than pass.
    expect(screen.getAllByRole('button', { name: /Add worker|新增 Worker/i }).length).toBeGreaterThan(0);
  });

  it('a "user" role has no Users nav item and is redirected from /users to /dashboard', async () => {
    const fetchMock = stubFetch('user');
    renderApp('/users');

    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    expect(screen.queryByText('Manage login accounts for this federation console.')).not.toBeInTheDocument();

    expect(screen.queryByRole('link', { name: /Users/i })).not.toBeInTheDocument();

    expect(fetchMock).not.toHaveBeenCalledWith('/api/users', expect.anything());
  });

  it('an "admin" role sees the Users nav item and /users renders the page', async () => {
    stubFetch('admin');
    renderApp('/users');

    expect(await screen.findByText('Manage login accounts for this federation console.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Users/i })).toBeInTheDocument();
  });
});
