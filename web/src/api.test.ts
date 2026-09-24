// @vitest-environment jsdom
/**
 * Final review finding #4: `change-password` re-issues a fresh cookie AND a
 * fresh CSRF token (the epoch bump would otherwise invalidate the caller's
 * own session too), but the web client used to ignore `response.csrf` and
 * keep sending the stale token -- every subsequent state-changing request
 * then failed `403 auth.csrf` until the next full login. This exercises the
 * real seam (`api.ts`'s own `fetch`), not a mock of `../api`, so it proves
 * `changePassword` actually adopts the new token via `setCsrf` and that the
 * very next mutation (`api.logout`, chosen only because it is the simplest
 * `postJson` call) sends it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, getCsrf, setCsrf } from './api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api.changePassword', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setCsrf(null);
  });

  it('adopts the fresh csrf so the very next mutation sends it', async () => {
    setCsrf('old-csrf-token');

    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/auth/change-password') {
        return jsonResponse({ ok: true, csrf: 'new-csrf-token' });
      }
      if (url === '/api/auth/logout') {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.changePassword('old-pw-123', 'new-pw-12345');
    expect(result).toEqual({ ok: true, csrf: 'new-csrf-token' });
    expect(getCsrf()).toBe('new-csrf-token');

    fetchMock.mockClear();
    await api.logout();

    const logoutCall = fetchMock.mock.calls.find(([reqUrl]) => {
      const url = typeof reqUrl === 'string' ? reqUrl : reqUrl.toString();
      return url === '/api/auth/logout';
    });
    expect(logoutCall).toBeDefined();
    const headers = logoutCall?.[1]?.headers as Record<string, string>;
    expect(headers['X-CSRF']).toBe('new-csrf-token');
  });
});

describe('api request csrf recovery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setCsrf(null);
  });

  it('recovers a stale/missing csrf by refetching /api/auth/me and retries the request once', async () => {
    setCsrf('stale-csrf-token');

    let postCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === '/api/jobs/job-1/cancel' && method === 'POST') {
        postCount += 1;
        if (postCount === 1) {
          return jsonResponse({ error: { code: 'auth.csrf', message: 'bad csrf' } }, 403);
        }
        return jsonResponse({ status: 'cancelled' });
      }
      if (url === '/api/auth/me' && method === 'GET') {
        return jsonResponse({ authenticated: true, lang: 'en', csrf: 'fresh' });
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.cancelJob('job-1');

    expect(result).toEqual({ status: 'cancelled' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getCsrf()).toBe('fresh');

    const secondPostCall = fetchMock.mock.calls[2];
    const secondPostUrl = typeof secondPostCall[0] === 'string' ? secondPostCall[0] : secondPostCall[0].toString();
    expect(secondPostUrl).toBe('/api/jobs/job-1/cancel');
    const headers = secondPostCall[1]?.headers as Record<string, string>;
    expect(headers['X-CSRF']).toBe('fresh');
  });
});
