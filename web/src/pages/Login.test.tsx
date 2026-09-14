// @vitest-environment jsdom
/**
 * Phase 3.0 Task 6: the login form now collects a username alongside the
 * password (multi-user auth). Exercises `Login` against a mocked `fetch`
 * (the same seam `api.ts` itself uses) to prove the submit handler posts
 * both fields to `POST /api/auth/login`, matching the server's
 * `LoginBody {username, password}` (see `server/comfyfed_server/auth.py`).
 */
import '@testing-library/jest-dom/vitest';

import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '../i18n';
import { theme } from '../theme';
import { Login } from './Login';

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

// jsdom has no ResizeObserver -- the language SegmentedControl's
// FloatingIndicator observes its container on mount.
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

function renderLogin(onAuthenticated: () => void) {
  return render(
    <MantineProvider theme={theme}>
      <Login onAuthenticated={onAuthenticated} />
    </MantineProvider>,
  );
}

describe('Login', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders a username field (autofocus, autocomplete) alongside the password field', () => {
    renderLogin(vi.fn());

    const username = screen.getByLabelText('Username');
    expect(username).toBeInTheDocument();
    expect(username).toHaveAttribute('autocomplete', 'username');

    const password = screen.getByLabelText('Password');
    expect(password).toBeInTheDocument();
    expect(password).toHaveAttribute('autocomplete', 'current-password');
  });

  it('disables submit until both username and password are filled in', () => {
    renderLogin(vi.fn());
    const submit = screen.getByRole('button', { name: 'Sign in' });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correcthorse' },
    });
    expect(submit).not.toBeDisabled();
  });

  it('submits {username, password} to POST /api/auth/login and calls onAuthenticated on success', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/auth/login' && init?.method === 'POST') {
        return jsonResponse({ csrf: 'csrf-token-1' });
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const onAuthenticated = vi.fn();
    renderLogin(onAuthenticated);

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correcthorse' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));

    const loginCall = fetchMock.mock.calls.find(([input]) => {
      const url = typeof input === 'string' ? input : input.toString();
      return url === '/api/auth/login';
    });
    expect(loginCall).toBeTruthy();
    const [, init] = loginCall as [RequestInfo | URL, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ username: 'alice', password: 'correcthorse' });
  });

  it('shows a translated error and does not call onAuthenticated on a wrong password', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/auth/login' && init?.method === 'POST') {
        return jsonResponse({ error: { code: 'auth.required', message: 'Invalid password.' } }, 401);
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const onAuthenticated = vi.fn();
    renderLogin(onAuthenticated);

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Wrong password.')).toBeInTheDocument();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });
});
