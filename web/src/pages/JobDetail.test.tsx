// @vitest-environment jsdom
/**
 * Phase 1.9 Task 9: the console job detail page.
 *
 * The whole point of this page is the full-error-text fix for the
 * truncated-tooltip complaint on the Jobs table, plus rendering a .txt
 * artifact's content inline instead of forcing a download. Both are
 * exercised end to end against a mocked `fetch`, the same seam `api.ts`
 * itself uses.
 */
import '@testing-library/jest-dom/vitest';

import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JobDetail as JobDetailType, Worker } from '../api';
import '../i18n';
import { theme } from '../theme';
import { JobDetail } from './JobDetail';

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

const LONG_ERROR = (
  'CUDA out of memory. Tried to allocate 2.00 GiB. This is the full model guidance text that ' +
  'used to be truncated in the Jobs table tooltip and must now be readable in full on this page ' +
  'without any clipping whatsoever, repeated to make sure truncation would show up: '
)
  .repeat(3)
  .trim();

const BASE_JOB: JobDetailType = {
  id: 'job-aaaaaaaa-1111',
  status: 'failed',
  origin: 'console',
  progress: 0.4,
  worker_id: 'w1',
  created_at: '2026-09-13T00:00:00Z',
  error: LONG_ERROR,
  result_files: [],
  input_assets: ['ref.png'],
  est_vram_gb: null,
  workflow_json: {},
  requirements: {},
  required_nodes: [],
  required_models: [],
  started_at: '2026-09-13T00:00:01Z',
  finished_at: '2026-09-13T00:00:05Z',
  receipt: null,
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

/** Final review finding #3: `GET /api/workers` is admin-only on both
 * stacks -- a `user`-role session gets a real 403, which this stub must
 * honestly reproduce (it previously always answered 200, which is exactly
 * why the missing `isAdmin` guard in `JobDetail.tsx` went uncaught).
 * Defaults to `'user'`, matching `renderDetail`'s own default. */
function stubFetch(
  job: JobDetailType,
  opts: { workers?: Worker[]; artifacts?: Record<string, string>; role?: 'admin' | 'user' } = {},
) {
  const workers = opts.workers ?? [WORKER];
  const artifacts = opts.artifacts ?? {};
  const role = opts.role ?? 'user';
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (/^\/api\/jobs\/[^/]+$/.test(url) && method === 'GET') {
      return jsonResponse(job);
    }
    if (url === '/api/workers' && method === 'GET') {
      if (role !== 'admin') {
        return jsonResponse({ error: { code: 'auth.forbidden', message: 'Admin only.' } }, 403);
      }
      return jsonResponse(workers);
    }
    for (const [filename, content] of Object.entries(artifacts)) {
      if (url === `/api/jobs/${job.id}/artifacts/${filename}` && method === 'GET') {
        return new Response(content, { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
    }
    if (/\/cancel$/.test(url) && method === 'POST') {
      return jsonResponse({ status: 'cancelled' });
    }
    if (/\/retry$/.test(url) && method === 'POST') {
      return jsonResponse({ ok: true, job_id: job.id });
    }
    return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderDetail(id = BASE_JOB.id, role: 'admin' | 'user' = 'user') {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter initialEntries={[`/jobs/${id}`]}>
        <Routes>
          <Route path="/jobs/:id" element={<JobDetail role={role} />} />
        </Routes>
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe('JobDetail', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the full error text rather than a truncated version', async () => {
    stubFetch(BASE_JOB);
    renderDetail();

    expect(await screen.findByText(LONG_ERROR)).toBeInTheDocument();
  });

  it('renders a .txt artifact content inline in a copyable block', async () => {
    const doneJob: JobDetailType = {
      ...BASE_JOB,
      status: 'done',
      error: null,
      result_files: ['notes.txt'],
    };
    stubFetch(doneJob, { artifacts: { 'notes.txt': 'seed: 12345\nsteps: 20' } });
    renderDetail();

    expect(await screen.findByText(/seed: 12345/)).toBeInTheDocument();
  });

  it('shows a cancel action for a non-terminal (running) job', async () => {
    const runningJob: JobDetailType = { ...BASE_JOB, status: 'running', error: null };
    stubFetch(runningJob);
    renderDetail();

    expect(await screen.findByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('hides the cancel action for a terminal (done) job', async () => {
    const doneJob: JobDetailType = { ...BASE_JOB, status: 'done', error: null, result_files: [] };
    stubFetch(doneJob);
    renderDetail();

    await screen.findByText('Done');
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('posts to the cancel endpoint when the cancel action is confirmed', async () => {
    const queuedJob: JobDetailType = { ...BASE_JOB, status: 'queued', error: null };
    const fetchMock = stubFetch(queuedJob);
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Cancel job' }));

    await waitFor(() => {
      const cancelCall = fetchMock.mock.calls.find(([reqUrl, reqInit]) => {
        const url = typeof reqUrl === 'string' ? reqUrl : reqUrl.toString();
        return url === `/api/jobs/${queuedJob.id}/cancel` && reqInit?.method === 'POST';
      });
      expect(cancelCall).toBeDefined();
    });
  });

  it('shows a downloading-models line with progress bar while stage is fetching_models', async () => {
    const fetchingJob: JobDetailType = {
      ...BASE_JOB,
      status: 'running',
      error: null,
      stage: 'fetching_models',
      fetch_pct: 17,
      fetch_model: 'sd_xl_base_1.0.safetensors',
    };
    stubFetch(fetchingJob);
    renderDetail();

    expect(
      await screen.findByText(/Downloading model: sd_xl_base_1\.0\.safetensors \(17%\)/),
    ).toBeInTheDocument();
  });

  it('does not show a downloading-models line once stage is absent', async () => {
    const runningJob: JobDetailType = { ...BASE_JOB, status: 'running', error: null };
    stubFetch(runningJob);
    renderDetail();

    await screen.findByText('Running');
    expect(screen.queryByText(/Downloading model/)).not.toBeInTheDocument();
  });

  it('renders the receipt summary when one is present', async () => {
    const doneJob: JobDetailType = {
      ...BASE_JOB,
      status: 'done',
      error: null,
      result_files: [],
      receipt: { gpu_seconds: 42, kind: 'completed', billable: true, basis: 'exec', acked: true },
    };
    stubFetch(doneJob);
    renderDetail();

    expect(await screen.findByText('42s')).toBeInTheDocument();
  });

  it('shows the submitting user for an admin', async () => {
    const jobWithUser: JobDetailType = { ...BASE_JOB, username: 'alice' };
    stubFetch(jobWithUser, { role: 'admin' });
    renderDetail(BASE_JOB.id, 'admin');

    expect(await screen.findByText('alice')).toBeInTheDocument();
  });

  it('does not show a submitting-user field for a plain user', async () => {
    const jobWithUser: JobDetailType = { ...BASE_JOB, username: 'alice' };
    stubFetch(jobWithUser);
    renderDetail(BASE_JOB.id, 'user');

    await screen.findByText(LONG_ERROR);
    expect(screen.queryByText('alice')).not.toBeInTheDocument();
  });

  it('a plain user still sees their own job detail when /api/workers 403s (final review finding #3)', async () => {
    stubFetch(BASE_JOB, { role: 'user' });
    renderDetail(BASE_JOB.id, 'user');

    expect(await screen.findByText(LONG_ERROR)).toBeInTheDocument();
    expect(screen.queryByText('Could not load this job.')).not.toBeInTheDocument();
  });
});
