// @vitest-environment jsdom
/**
 * Phase 3.0 Task 8: role-conditional Reports page.
 *
 * An admin gets three tabs (Worker contributions / User usage / Payout
 * estimate); a plain user gets only their own usage, with no tabs and,
 * critically, no call to the admin-only `/api/reports/contributions` (or
 * `/usage`, `/payout`) endpoints -- those would 403 for a non-admin.
 */
import '@testing-library/jest-dom/vitest';

import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Contribution, PayoutResult, UsageRow } from '../api';
import '../i18n';
import { theme } from '../theme';
import { Reports } from './Reports';

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

const CONTRIBUTIONS: Contribution[] = [
  { worker_id: 'w1', name: 'runner-1', jobs: 3, gpu_seconds: 120 },
];

const USAGE_ROWS: UsageRow[] = [
  { user_id: 'u1', username: 'alice', jobs: 3, gpu_seconds: 120, unbilled_gpu_seconds: 5 },
  { user_id: null, username: null, jobs: 1, gpu_seconds: 10, unbilled_gpu_seconds: 0 },
];

const MY_USAGE: UsageRow = {
  user_id: 'u2',
  username: 'bob',
  jobs: 4,
  gpu_seconds: 200,
  unbilled_gpu_seconds: 15,
};

const PAYOUT_RESULT: PayoutResult = {
  total_gpu_seconds: 120,
  pool: 100,
  workers: [{ worker_id: 'w1', name: 'runner-1', gpu_seconds: 120, ratio: 1, amount: 100 }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderReports(role: 'admin' | 'user') {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter>
        <Reports role={role} />
      </MemoryRouter>
    </MantineProvider>,
  );
}

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.startsWith('/api/reports/contributions')) return jsonResponse(CONTRIBUTIONS);
    if (url.startsWith('/api/reports/usage')) return jsonResponse(USAGE_ROWS);
    if (url.startsWith('/api/reports/my-usage')) return jsonResponse(MY_USAGE);
    if (url.startsWith('/api/reports/payout')) return jsonResponse(PAYOUT_RESULT);
    return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Reports page: admin role', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows three tabs and loads worker contributions by default', async () => {
    stubFetch();
    renderReports('admin');

    expect(await screen.findByRole('tab', { name: /Worker contributions/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /User usage/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Payout estimate/ })).toBeInTheDocument();

    expect(await screen.findByText('runner-1')).toBeInTheDocument();
  });

  it('switching to the 使用者用量 tab loads /api/reports/usage and renders a legacy row', async () => {
    const fetchMock = stubFetch();
    renderReports('admin');

    fireEvent.click(await screen.findByRole('tab', { name: /User usage/ }));

    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(await screen.findByText('(historical)')).toBeInTheDocument();

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([reqUrl]) => {
        const url = typeof reqUrl === 'string' ? reqUrl : reqUrl.toString();
        return url.startsWith('/api/reports/usage');
      })).toBe(true);
    });
  });

  it('分潤試算 tab only calls the payout endpoint after Calculate is clicked', async () => {
    const fetchMock = stubFetch();
    renderReports('admin');

    fireEvent.click(await screen.findByRole('tab', { name: /Payout estimate/ }));
    // No payout call yet -- it's on-demand, not auto-loaded like the other tabs.
    expect(fetchMock.mock.calls.some(([reqUrl]) => {
      const url = typeof reqUrl === 'string' ? reqUrl : reqUrl.toString();
      return url.startsWith('/api/reports/payout');
    })).toBe(false);

    fireEvent.click(await screen.findByRole('button', { name: 'Calculate' }));

    expect(await screen.findByText('100.00')).toBeInTheDocument();
    expect(await screen.findByText('100.00%')).toBeInTheDocument();
  });
});

describe('Reports page: plain user role', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows only my-usage, without tabs, and never calls admin-only report endpoints', async () => {
    const fetchMock = stubFetch();
    renderReports('user');

    expect(await screen.findByText('My usage')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([reqUrl]) => {
        const url = typeof reqUrl === 'string' ? reqUrl : reqUrl.toString();
        return url.startsWith('/api/reports/my-usage');
      })).toBe(true);
    });

    const calledUrls = fetchMock.mock.calls.map(([reqUrl]) =>
      typeof reqUrl === 'string' ? reqUrl : reqUrl.toString(),
    );
    expect(calledUrls.some((url) => url.startsWith('/api/reports/contributions'))).toBe(false);
    expect(calledUrls.some((url) => url.startsWith('/api/reports/usage'))).toBe(false);
    expect(calledUrls.some((url) => url.startsWith('/api/reports/payout'))).toBe(false);
  });

  it('renders the my-usage stat values', async () => {
    stubFetch();
    renderReports('user');

    expect(await screen.findByText('4')).toBeInTheDocument();
    expect(await screen.findByText('3m 20s')).toBeInTheDocument();
    expect(await screen.findByText('15s')).toBeInTheDocument();
  });
});
