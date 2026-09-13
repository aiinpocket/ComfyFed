// @vitest-environment jsdom
/**
 * Phase 2.0 rider task: the cloud-only first-run Setup page.
 *
 * Exercises `App`'s bootstrap gate end to end against a mocked `fetch` (the
 * same seam `api.ts` itself uses): GET /api/setup/status decides whether the
 * Setup card or the normal Login form renders, and a 404/network failure
 * (the Python server, which has no `/api/setup/*` routes at all) must fall
 * through to the normal login flow silently.
 */
import '@testing-library/jest-dom/vitest';

import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

function renderApp() {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    </MantineProvider>,
  );
}

/** A fetch stub whose /api/setup/status response and /api/setup POST outcome
 * can be configured per test. Anything else (e.g. /api/auth/me) returns an
 * anonymous session, since these tests only care about the setup gate. */
function stubFetch(opts: {
  setupStatus: 'needed' | 'not_needed' | '404' | 'network_error';
  setupPostOk?: boolean;
}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url === '/api/setup/status' && method === 'GET') {
      if (opts.setupStatus === '404') {
        return jsonResponse({ error: { code: 'http_error', message: 'not found' } }, 404);
      }
      if (opts.setupStatus === 'network_error') {
        throw new TypeError('Failed to fetch');
      }
      return jsonResponse({ needed: opts.setupStatus === 'needed' });
    }
    if (url === '/api/setup' && method === 'POST') {
      if (opts.setupPostOk === false) {
        return jsonResponse({ error: { code: 'setup.bad_token', message: 'bad token' } }, 400);
      }
      return jsonResponse({ ok: true });
    }
    if (url === '/api/auth/me' && method === 'GET') {
      return jsonResponse({ authenticated: false, lang: 'en' });
    }
    return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('App bootstrap: first-run setup gate', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the normal login form when /api/setup/status 404s (Python server)', async () => {
    stubFetch({ setupStatus: '404' });
    renderApp();

    expect(await screen.findByLabelText('Admin password')).toBeInTheDocument();
    expect(screen.queryByLabelText('Setup token')).not.toBeInTheDocument();
  });

  it('renders the normal login form on a network error reaching /api/setup/status', async () => {
    stubFetch({ setupStatus: 'network_error' });
    renderApp();

    expect(await screen.findByLabelText('Admin password')).toBeInTheDocument();
  });

  it('renders the normal login form when setup is not needed', async () => {
    stubFetch({ setupStatus: 'not_needed' });
    renderApp();

    expect(await screen.findByLabelText('Admin password')).toBeInTheDocument();
  });

  it('renders the Setup form instead of Login when setup is needed', async () => {
    stubFetch({ setupStatus: 'needed' });
    renderApp();

    expect(await screen.findByLabelText('Setup token')).toBeInTheDocument();
    expect(screen.getByLabelText('New admin password')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm new password')).toBeInTheDocument();
    expect(screen.queryByLabelText('Admin password')).not.toBeInTheDocument();
  });

  it('blocks submission client-side when the two passwords do not match', async () => {
    const fetchMock = stubFetch({ setupStatus: 'needed' });
    renderApp();

    fireEvent.change(await screen.findByLabelText('Setup token'), {
      target: { value: 'tok-123' },
    });
    fireEvent.change(screen.getByLabelText('New admin password'), {
      target: { value: 'correcthorse' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'somethingelse' },
    });

    expect(await screen.findByText('The two passwords do not match.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create admin password' })).toBeDisabled();

    fetchMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Create admin password' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalledWith('/api/setup', expect.anything());
  });

  it('flows into the normal login form after a successful setup submission', async () => {
    stubFetch({ setupStatus: 'needed', setupPostOk: true });
    renderApp();

    fireEvent.change(await screen.findByLabelText('Setup token'), {
      target: { value: 'tok-123' },
    });
    fireEvent.change(screen.getByLabelText('New admin password'), {
      target: { value: 'correcthorse' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'correcthorse' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create admin password' }));

    expect(await screen.findByLabelText('Admin password')).toBeInTheDocument();
    expect(screen.queryByLabelText('Setup token')).not.toBeInTheDocument();
  });

  it('shows a bilingual-backed error and stays on the setup form when the token is rejected', async () => {
    stubFetch({ setupStatus: 'needed', setupPostOk: false });
    renderApp();

    fireEvent.change(await screen.findByLabelText('Setup token'), {
      target: { value: 'wrong-token' },
    });
    fireEvent.change(screen.getByLabelText('New admin password'), {
      target: { value: 'correcthorse' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'correcthorse' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create admin password' }));

    expect(await screen.findByText('Invalid setup token.')).toBeInTheDocument();
    expect(screen.getByLabelText('Setup token')).toBeInTheDocument();
  });
});
