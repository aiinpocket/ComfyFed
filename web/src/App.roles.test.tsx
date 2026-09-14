// @vitest-environment jsdom
/**
 * Phase 3.0 Task 6: role-based navigation and route guards.
 *
 * A `user` role must not see the Workers nav item, and navigating straight
 * to /workers (deep link, back button) must redirect to /dashboard rather
 * than render the page -- which would otherwise fire `GET /api/workers` and
 * get a 403 (admin-only, see server/comfyfed_server/workers.py's
 * `list_workers`). An `admin` role sees the nav item and the route renders.
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
      return jsonResponse([]);
    }
    if (url === '/api/workers' && method === 'GET') {
      if (role !== 'admin') {
        return jsonResponse({ error: { code: 'auth.forbidden', message: 'Admin role required.' } }, 403);
      }
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

  it('a "user" role has no Workers nav item and is redirected from /workers to /dashboard', async () => {
    const fetchMock = stubFetch('user');
    renderApp('/workers');

    // Redirected: dashboard content renders, the Workers page's own heading
    // ("Registered GPU workers...") does not.
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    expect(screen.queryByText('Registered GPU workers in this federation.')).not.toBeInTheDocument();

    // Nav hides the admin-only item entirely.
    expect(screen.queryByRole('link', { name: /Workers/i })).not.toBeInTheDocument();

    // The guard prevented the page (and its 403-prone fetch) from ever rendering.
    expect(fetchMock).not.toHaveBeenCalledWith('/api/workers', expect.anything());
  });

  it('an "admin" role sees the Workers nav item and /workers renders the page', async () => {
    stubFetch('admin');
    renderApp('/workers');

    expect(await screen.findByText('Registered GPU workers in this federation.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Workers/i })).toBeInTheDocument();
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
