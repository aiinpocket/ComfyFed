// @vitest-environment jsdom
/**
 * Phase 1.7 Task 2: the console's job cancellation entry point.
 *
 * Exercises `Jobs` end to end against a mocked `fetch` (the same seam
 * `api.ts` itself uses), rather than mocking `../api`, so the test also
 * proves the button is wired to the real `POST /api/jobs/{id}/cancel` call.
 */
import '@testing-library/jest-dom/vitest';

import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Job, Worker } from '../api';
import '../i18n';
import { theme } from '../theme';
import { Jobs } from './Jobs';

// jsdom has no matchMedia implementation; Mantine's color-scheme handling
// reads it on mount regardless of the `forceColorScheme` prop upstream sets.
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

// jsdom also has no ResizeObserver -- Mantine's ScrollArea (used by the jobs
// table) observes its container on mount.
if (!('ResizeObserver' in window)) {
  class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
}

const RUNNING_JOB: Job = {
  id: 'job-running-0001',
  status: 'running',
  origin: 'console',
  progress: 0.5,
  worker_id: 'w1',
  created_at: '2026-09-13T00:00:00Z',
  error: null,
  result_files: [],
  input_assets: [],
  est_vram_gb: null,
};

const DONE_JOB: Job = {
  id: 'job-done-0002',
  status: 'done',
  origin: 'console',
  progress: 1,
  worker_id: 'w1',
  created_at: '2026-09-13T00:00:00Z',
  error: null,
  result_files: [],
  input_assets: [],
  est_vram_gb: null,
};

const CANCELLED_JOB: Job = {
  id: 'job-cancelled-0003',
  status: 'cancelled',
  origin: 'console',
  progress: 0,
  worker_id: 'w1',
  created_at: '2026-09-13T00:00:00Z',
  error: 'cancelled by admin',
  result_files: [],
  input_assets: [],
  est_vram_gb: null,
};

const WORKER: Worker = {
  id: 'w1',
  name: 'runner-1',
  status: 'busy',
  last_seen: '2026-09-13T00:00:00Z',
  disabled: false,
  hardware: {},
  dynamic: {},
  backend: 'cuda',
  torch_version: '2.0',
  model_count: 0,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderJobs() {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter>
        <Jobs />
      </MemoryRouter>
    </MantineProvider>,
  );
}

/** A fetch stub whose /api/jobs listing can be swapped between calls. */
function stubFetch(jobsSequence: Job[][]) {
  let call = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url.startsWith('/api/jobs') && method === 'GET') {
      const jobs = jobsSequence[Math.min(call, jobsSequence.length - 1)];
      call += 1;
      return jsonResponse(jobs);
    }
    if (url === '/api/workers' && method === 'GET') {
      return jsonResponse([WORKER]);
    }
    if (/\/api\/jobs\/[^/]+\/cancel$/.test(url) && method === 'POST') {
      return jsonResponse({ status: 'cancelled' });
    }
    return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const FETCHING_JOB: Job = {
  id: 'job-fetching-0004',
  status: 'running',
  origin: 'console',
  progress: 0,
  worker_id: 'w1',
  created_at: '2026-09-13T00:00:00Z',
  error: null,
  result_files: [],
  input_assets: [],
  est_vram_gb: null,
  stage: 'fetching_models',
  fetch_pct: 42,
  fetch_model: 'sd_xl_base_1.0.safetensors',
};

describe('Jobs page: model auto-fetch progress', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows a downloading-models chip with percentage while stage is fetching_models', async () => {
    stubFetch([[FETCHING_JOB]]);
    renderJobs();

    expect(await screen.findByText(/Downloading model.*42%/)).toBeInTheDocument();
  });

  it('does not show the fetch chip once stage is absent (normal progress rendering)', async () => {
    stubFetch([[RUNNING_JOB]]);
    renderJobs();

    await screen.findByText('Running');
    expect(screen.queryByText(/Downloading model/)).not.toBeInTheDocument();
  });
});

describe('Jobs page: cancellation', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows a cancel action for a running job and posts to the cancel endpoint on confirm', async () => {
    const fetchMock = stubFetch([[RUNNING_JOB], [CANCELLED_JOB]]);
    renderJobs();

    const cancelRowButton = await screen.findByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelRowButton);

    const dialog = await screen.findByRole('dialog');
    const confirmButton = await within(dialog).findByRole('button', { name: 'Cancel job' });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      const cancelCall = fetchMock.mock.calls.find(([reqUrl, reqInit]) => {
        const url = typeof reqUrl === 'string' ? reqUrl : reqUrl.toString();
        return url === `/api/jobs/${RUNNING_JOB.id}/cancel` && reqInit?.method === 'POST';
      });
      expect(cancelCall).toBeDefined();
    });

    // A successful cancel refreshes the list -- the cancelled status chip
    // (from the server's next GET /api/jobs) should now be on screen.
    await waitFor(() => {
      expect(screen.getByText('Cancelled')).toBeInTheDocument();
    });
  });

  it('does not show a cancel action once a job is terminal (done)', async () => {
    stubFetch([[DONE_JOB]]);
    renderJobs();

    await screen.findByText('Done');
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('renders a distinct status chip for a cancelled job', async () => {
    stubFetch([[CANCELLED_JOB]]);
    renderJobs();

    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('dismissing the confirm dialog does not call the cancel endpoint', async () => {
    const fetchMock = stubFetch([[RUNNING_JOB]]);
    renderJobs();

    const cancelRowButton = await screen.findByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelRowButton);

    const dialog = await screen.findByRole('dialog');
    // The dismiss button in the dialog is the plain "Cancel" label (common.cancel).
    const dismissButton = await within(dialog).findByRole('button', { name: 'Cancel' });
    fireEvent.click(dismissButton);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    const cancelCalls = fetchMock.mock.calls.filter(([reqUrl]) => {
      const url = typeof reqUrl === 'string' ? reqUrl : reqUrl.toString();
      return url.endsWith('/cancel');
    });
    expect(cancelCalls).toHaveLength(0);
  });
});
