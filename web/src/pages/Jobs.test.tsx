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
import { shortId } from '../lib/format';
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
  label: null,
  status: 'running',
  origin: 'console',
  progress: 0.5,
  worker_id: 'w1',
  created_at: '2026-09-13T00:00:00Z',
  error: null,
  result_files: [],
  input_assets: [],
  est_vram_gb: null,
  split_count: 0,
  dispatch_info: {},
  attempts: {},
  retry_count: 0,
  kind: 'prompt',
};

const DONE_JOB: Job = {
  id: 'job-done-0002',
  label: null,
  status: 'done',
  origin: 'console',
  progress: 1,
  worker_id: 'w1',
  created_at: '2026-09-13T00:00:00Z',
  error: null,
  result_files: [],
  input_assets: [],
  est_vram_gb: null,
  split_count: 0,
  dispatch_info: {},
  attempts: {},
  retry_count: 0,
  kind: 'prompt',
};

const CANCELLED_JOB: Job = {
  id: 'job-cancelled-0003',
  label: null,
  status: 'cancelled',
  origin: 'console',
  progress: 0,
  worker_id: 'w1',
  created_at: '2026-09-13T00:00:00Z',
  error: 'cancelled by admin',
  result_files: [],
  input_assets: [],
  est_vram_gb: null,
  split_count: 0,
  dispatch_info: {},
  attempts: {},
  retry_count: 0,
  kind: 'prompt',
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
  peer_url: null,
  peer_lan_url: null,
  peer_nat: 'none',
  peer_reachable: null,
  unsuitable: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderJobs(role: 'admin' | 'user' = 'user') {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter>
        <Jobs role={role} />
      </MemoryRouter>
    </MantineProvider>,
  );
}

/** A fetch stub whose /api/jobs listing can be swapped between calls.
 *
 * Final review finding #3: `GET /api/workers` is admin-only on both
 * stacks -- a `user`-role session gets a real 403 from the server, which
 * these tests must honestly reproduce (they previously always answered 200,
 * which is exactly why the missing `isAdmin` guard in `Jobs.tsx` went
 * uncaught). Defaults to `'user'`, matching `renderJobs`'s own default. */
function stubFetch(jobsSequence: Job[][], role: 'admin' | 'user' = 'user') {
  let call = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (/\/api\/jobs\/[^/]+\/assessment$/.test(url) && method === 'GET') {
      return jsonResponse({ workers: [] });
    }
    if (url.startsWith('/api/jobs') && method === 'GET') {
      const jobs = jobsSequence[Math.min(call, jobsSequence.length - 1)];
      call += 1;
      // 2026-09-21: the page asks for `?page=` and gets the paged envelope.
      return jsonResponse({ jobs, total: jobs.length, page: 1, limit: 25 });
    }
    if (url === '/api/workers' && method === 'GET') {
      if (role !== 'admin') {
        return jsonResponse({ error: { code: 'auth.forbidden', message: 'Admin only.' } }, 403);
      }
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
  label: null,
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
  split_count: 0,
  dispatch_info: {},
  attempts: {},
  retry_count: 0,
  kind: 'prompt',
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

describe('Jobs page: read-only console (design §8)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the hint that submissions come from the AI (MCP) or the ComfyUI panel', async () => {
    stubFetch([[RUNNING_JOB]]);
    renderJobs();

    const hint = await screen.findByTestId('jobs-submit-hint');
    expect(hint).toHaveTextContent(/AI assistant \(MCP\)/);
    expect(hint).toHaveTextContent(/ComfyUI/);
  });

  it('has no submit panel: no paste box, no advanced override, no submit button', async () => {
    stubFetch([[RUNNING_JOB]]);
    renderJobs();

    await screen.findByText('Running');
    expect(screen.queryByTestId('submit-panel')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit job' })).not.toBeInTheDocument();
    expect(screen.queryByText('Paste API JSON instead')).not.toBeInTheDocument();
    expect(screen.queryByText('Advanced override')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('keeps the ComfyUI editor link as the panel entry point', async () => {
    stubFetch([[RUNNING_JOB]]);
    renderJobs();

    const link = await screen.findByRole('link', { name: /Open workflow editor/ });
    expect(link).toHaveAttribute('href', '/comfy');
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

describe('Jobs page: non-admin resilience to /api/workers 403 (final review finding #3)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('a plain user still sees their own jobs list when /api/workers 403s', async () => {
    stubFetch([[RUNNING_JOB]], 'user');
    renderJobs('user');

    expect(await screen.findByText('Running')).toBeInTheDocument();
    expect(screen.queryByText('Could not load jobs. Retrying automatically.')).not.toBeInTheDocument();
  });
});

describe('Jobs page: 使用者 column (Task 8)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const JOB_WITH_USER: Job = { ...RUNNING_JOB, username: 'alice' };
  const JOB_LEGACY: Job = { ...DONE_JOB, id: 'job-legacy-0005', username: null };

  it('shows the 使用者 column for an admin, including a dash for a null username', async () => {
    stubFetch([[JOB_WITH_USER, JOB_LEGACY]], 'admin');
    renderJobs('admin');

    expect(await screen.findByText('Username')).toBeInTheDocument();
    expect(await screen.findByText('alice')).toBeInTheDocument();
    // The legacy job's null username renders as a muted dash, not blank/undefined.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('hides the 使用者 column entirely for a plain user', async () => {
    stubFetch([[JOB_WITH_USER]]);
    renderJobs('user');

    await screen.findByText('Running');
    expect(screen.queryByText('Username')).not.toBeInTheDocument();
    expect(screen.queryByText('alice')).not.toBeInTheDocument();
  });
});

describe('Jobs page: split badge (Phase 3.3 Task 8)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows a split badge with the child count on a parent job', async () => {
    stubFetch([[{ ...RUNNING_JOB, id: 'job-parent-0006', split_count: 3 }]]);
    renderJobs();

    expect(await screen.findByText('Split ×3')).toBeInTheDocument();
  });

  it('shows no split badge on a plain job', async () => {
    stubFetch([[{ ...RUNNING_JOB, split_count: 0 }]]);
    renderJobs();

    await screen.findByText('Running');
    expect(screen.queryByText(/Split ×/)).not.toBeInTheDocument();
  });
});

describe('Jobs page: model_fetch jobs (panel Download button)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const MODEL_FETCH_JOB: Job = {
    ...RUNNING_JOB,
    id: 'job-fetch-0007',
    kind: 'model_fetch',
    est_vram_gb: null,
  };

  it('shows a "Model fetch" badge for a kind: model_fetch job', async () => {
    stubFetch([[MODEL_FETCH_JOB]]);
    renderJobs();

    expect(await screen.findByText('Model fetch')).toBeInTheDocument();
  });

  it('shows no "Model fetch" badge for an ordinary prompt job', async () => {
    stubFetch([[RUNNING_JOB]]);
    renderJobs();

    await screen.findByText('Running');
    expect(screen.queryByText('Model fetch')).not.toBeInTheDocument();
  });

  // Spec §11: a model_fetch job shows the "Model fetch" label and NO VRAM
  // column -- not even as a "—". It runs no inference, so an estimated-VRAM
  // figure is not a fact about it at all. (Final-review I3: the Task 9 fix
  // round scoped the badge TO model_fetch jobs instead of away from them.)
  it('shows no VRAM badge on a queued model_fetch job assessment panel', async () => {
    const queuedFetchJob: Job = { ...MODEL_FETCH_JOB, status: 'queued', progress: 0 };
    stubFetch([[queuedFetchJob]]);
    renderJobs();

    const expandButton = await screen.findByRole('button', { name: 'Worker assessment' });
    fireEvent.click(expandButton);

    await screen.findByText('Worker assessment');
    expect(screen.queryByText(/Estimated VRAM/)).not.toBeInTheDocument();
  });

  // ...and a model_fetch job with a (spurious) non-null estimate still shows
  // nothing: the gate is the job kind, not the value.
  it('shows no VRAM badge on a model_fetch job even with a non-null estimate', async () => {
    const queuedFetchJob: Job = { ...MODEL_FETCH_JOB, status: 'queued', progress: 0, est_vram_gb: 12 };
    stubFetch([[queuedFetchJob]]);
    renderJobs();

    const expandButton = await screen.findByRole('button', { name: 'Worker assessment' });
    fireEvent.click(expandButton);

    await screen.findByText('Worker assessment');
    expect(screen.queryByText(/Estimated VRAM/)).not.toBeInTheDocument();
  });

  // Regression lock (review round 1): the VRAM badge must stay hidden for an
  // ordinary prompt job with a null estimate.
  it('shows no VRAM badge on a queued ordinary prompt job with a null estimate', async () => {
    const queuedPromptJob: Job = { ...RUNNING_JOB, id: 'job-queued-0010', status: 'queued', progress: 0, est_vram_gb: null };
    stubFetch([[queuedPromptJob]]);
    renderJobs();

    const expandButton = await screen.findByRole('button', { name: 'Worker assessment' });
    fireEvent.click(expandButton);

    await screen.findByText('Worker assessment');
    expect(screen.queryByText(/Estimated VRAM/)).not.toBeInTheDocument();
  });

  // ...and is still SHOWN for an ordinary prompt job that HAS an estimate,
  // the pre-model_fetch behaviour this feature must not disturb.
  it('shows the VRAM badge on a queued ordinary prompt job with an estimate', async () => {
    const queuedPromptJob: Job = { ...RUNNING_JOB, id: 'job-queued-0011', status: 'queued', progress: 0, est_vram_gb: 8.5 };
    stubFetch([[queuedPromptJob]]);
    renderJobs();

    const expandButton = await screen.findByRole('button', { name: 'Worker assessment' });
    fireEvent.click(expandButton);

    expect(await screen.findByText(/Estimated VRAM/)).toBeInTheDocument();
  });
});

/* ------------------------------------------------ 2026-09-21 pagination */

const DONE_JOB_OLDER: Job = {
  ...RUNNING_JOB,
  id: 'job-older-0002',
  status: 'done',
  progress: 1,
  created_at: '2026-09-12T00:00:00Z',
};

describe('Jobs page: pagination (2026-09-21)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function stubPaged(pages: Record<number, Job[]>, total: number, limit = 25) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.startsWith('/api/jobs?') && method === 'GET') {
        const page = Number(new URLSearchParams(url.slice(url.indexOf('?'))).get('page'));
        return jsonResponse({ jobs: pages[page] ?? [], total, page, limit });
      }
      if (url === '/api/workers' && method === 'GET') {
        return jsonResponse({ error: { code: 'auth.forbidden', message: 'Admin only.' } }, 403);
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('asks the server for page 1 with the default limit and keeps the rows in server order (newest first)', async () => {
    const fetchMock = stubPaged({ 1: [RUNNING_JOB, DONE_JOB_OLDER] }, 2);
    renderJobs();

    await screen.findByText(shortId(RUNNING_JOB.id));
    const urls = fetchMock.mock.calls.map(([input]) => (typeof input === 'string' ? input : input.toString()));
    expect(urls).toContain('/api/jobs?page=1&limit=25');

    const rows = screen.getAllByRole('row').filter((row) => within(row).queryAllByRole('cell').length > 0);
    expect(within(rows[0]).getByText(shortId(RUNNING_JOB.id))).toBeInTheDocument();
    expect(within(rows[1]).getByText(shortId(DONE_JOB_OLDER.id))).toBeInTheDocument();
  });

  it('shows no pager when everything fits on one page', async () => {
    stubPaged({ 1: [RUNNING_JOB] }, 1);
    renderJobs();
    await screen.findByText(shortId(RUNNING_JOB.id));
    expect(screen.queryByRole('button', { name: '2' })).not.toBeInTheDocument();
  });

  it('renders a pager when there are more jobs than one page, and fetches the chosen page', async () => {
    const fetchMock = stubPaged({ 1: [RUNNING_JOB], 2: [DONE_JOB_OLDER] }, 30);
    renderJobs();
    await screen.findByText(shortId(RUNNING_JOB.id));

    fireEvent.click(screen.getByRole('button', { name: '2' }));

    await screen.findByText(shortId(DONE_JOB_OLDER.id));
    const urls = fetchMock.mock.calls.map(([input]) => (typeof input === 'string' ? input : input.toString()));
    expect(urls).toContain('/api/jobs?page=2&limit=25');
    expect(screen.queryByText(shortId(RUNNING_JOB.id))).not.toBeInTheDocument();
  });
});
