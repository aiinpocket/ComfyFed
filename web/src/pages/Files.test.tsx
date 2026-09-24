// @vitest-environment jsdom
/**
 * 2026-09-20 檔案頁 Task 3: the console's `/files` page.
 *
 * Two halves, both exercised against a mocked `fetch` (the same seam `api.ts`
 * uses) rather than a mocked `../api`, so the tests also prove the buttons
 * are wired to the real endpoints:
 *
 * - uploads: the staging list/delete cases moved here from `Settings.test.tsx`
 *   when the card left the Settings page;
 * - outputs: `GET /api/me/artifacts` grouped into `label / YYYY-MM-DD`
 *   folders, the three preview kinds, download links, and both delete flows.
 *
 * `groupArtifacts` also gets direct unit coverage for its ordering rules --
 * the rendering tests can only see one arrangement at a time.
 */
import '@testing-library/jest-dom/vitest';

import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ArtifactFile, StagingFile } from '../api';
import '../i18n';
import { theme } from '../theme';
import { Files, groupArtifacts } from './Files';

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

// jsdom has neither. `saveBlob` (lib/zip.ts) revokes its object URL on a
// 1-second timer, which on a slow CI box fires AFTER the zip test's
// `vi.unstubAllGlobals()` has restored this bare `URL` -- so without these
// no-ops the timer throws `URL.revokeObjectURL is not a function` as an
// unhandled error attributed to whichever later test happens to be running.
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:jsdom';
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = () => {};
}

const REF_PNG: StagingFile = { name: 'reference.png', size: 2048, modified: 1757800000 };
const MASK_PNG: StagingFile = { name: 'mask.png', size: 1024, modified: 1757800100 };

const EMPTY_STAGING = { files: [], total_bytes: 0, quota_bytes: 0, userdata_bytes: 0 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderFiles() {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter>
        <Files />
      </MemoryRouter>
    </MantineProvider>,
  );
}

/** Noon local time on the given day, so the page's LOCAL-date grouping lands
 * on that calendar day in every timezone the CI box might be set to. */
function localNoon(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day, 12, 0, 0).toISOString();
}

function artifact(overrides: Partial<ArtifactFile> = {}): ArtifactFile {
  return {
    job_id: 'job-aaaaaaaa-1111',
    label: 'chroma-t2i',
    created_at: localNoon(2026, 9, 20),
    filename: 'ComfyUI_00001_.png',
    size: 4096,
    kind: 'image',
    ...overrides,
  };
}

/* ------------------------------------------------------------- uploads */

describe('Files page: my uploads card', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the caller’s staged files from GET /api/staging', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/staging' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({ files: [MASK_PNG, REF_PNG], total_bytes: 3072 });
      }
      if (url.startsWith('/api/me/artifacts')) return jsonResponse({ files: [] });
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderFiles();

    expect(await screen.findByText('mask.png')).toBeInTheDocument();
    expect(screen.getByText('reference.png')).toBeInTheDocument();
    // Human sizes, plus the total usage line.
    expect(screen.getByText(/1 KB/)).toBeInTheDocument();
    expect(screen.getByText('2 file(s), 3 KB')).toBeInTheDocument();
  });

  it('shows the empty state when the caller has uploaded nothing', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/staging') return jsonResponse({ files: [], total_bytes: 0 });
      if (url.startsWith('/api/me/artifacts')) return jsonResponse({ files: [] });
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderFiles();

    expect(await screen.findByText('You have not uploaded any files yet.')).toBeInTheDocument();
  });

  it('deletes a file through DELETE /api/staging/{name} and refreshes the list', async () => {
    let deleted = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === '/api/staging' && method === 'GET') {
        return jsonResponse(
          deleted
            ? { files: [MASK_PNG], total_bytes: 1024 }
            : { files: [MASK_PNG, REF_PNG], total_bytes: 3072 },
        );
      }
      if (url.startsWith('/api/me/artifacts')) return jsonResponse({ files: [] });
      if (url === '/api/staging/reference.png' && method === 'DELETE') {
        deleted = true;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderFiles();
    await screen.findByText('reference.png');

    fireEvent.click(screen.getByRole('button', { name: 'Delete reference.png' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Delete .reference\.png/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([reqUrl, reqInit]) => {
        const url = typeof reqUrl === 'string' ? reqUrl : reqUrl.toString();
        return url === '/api/staging/reference.png' && reqInit?.method === 'DELETE';
      });
      expect(call).toBeDefined();
    });

    await waitFor(() => expect(screen.queryByText('reference.png')).not.toBeInTheDocument());
    expect(screen.getByText('mask.png')).toBeInTheDocument();
  });

  it('deletes every ticked file through one DELETE /api/staging/{name} each', async () => {
    const deleted: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === '/api/staging' && method === 'GET') {
        const files = [MASK_PNG, REF_PNG].filter((file) => !deleted.includes(file.name));
        return jsonResponse({ files, total_bytes: files.reduce((sum, f) => sum + f.size, 0) });
      }
      if (url.startsWith('/api/me/artifacts')) return jsonResponse({ files: [] });
      const match = /^\/api\/staging\/(.+)$/.exec(url);
      if (match && method === 'DELETE') {
        deleted.push(decodeURIComponent(match[1]));
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderFiles();
    await screen.findByText('reference.png');

    // Nothing ticked: the batch button is disabled.
    // Both cards carry a batch button; the uploads one comes first in the DOM.
    expect(screen.getAllByRole('button', { name: 'Delete selected (0)' })[0]).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select mask.png' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select reference.png' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected (2)' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/2 selected file\(s\)/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleted).toEqual(['mask.png', 'reference.png']));
    expect(await screen.findByText('You have not uploaded any files yet.')).toBeInTheDocument();
  });

  it('"select all" ticks every upload at once', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/staging') return jsonResponse({ files: [MASK_PNG, REF_PNG], total_bytes: 3072 });
      if (url.startsWith('/api/me/artifacts')) return jsonResponse({ files: [] });
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderFiles();
    await screen.findByText('reference.png');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }));
    expect(screen.getByRole('checkbox', { name: 'Select mask.png' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select reference.png' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Delete selected (2)' })).toBeEnabled();
  });
});

/* ------------------------------------------------------------- outputs */

describe('Files page: outputs browser', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function stubArtifacts(files: ArtifactFile[], extra?: (url: string, init?: RequestInit) => Response | null) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const override = extra?.(url, init);
      if (override) return override;
      if (url === '/api/staging') return jsonResponse(EMPTY_STAGING);
      if (url.startsWith('/api/me/artifacts')) return jsonResponse({ files });
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('groups artifacts into label / date folders', async () => {
    stubArtifacts([
      artifact(),
      artifact({ filename: 'ComfyUI_00002_.png', created_at: localNoon(2026, 9, 19) }),
    ]);

    renderFiles();

    expect(await screen.findByText('chroma-t2i')).toBeInTheDocument();
    expect(screen.getByText('2026-09-20')).toBeInTheDocument();
    expect(screen.getByText('2026-09-19')).toBeInTheDocument();
  });

  it('falls back to the short job id when a job has no label', async () => {
    stubArtifacts([artifact({ label: null })]);

    renderFiles();

    // Both the folder heading and the tile's job chip read the short id.
    expect(await screen.findAllByText('job-aaaa')).toHaveLength(2);
  });

  it('previews an image with <img src="/api/jobs/<id>/artifacts/<name>">', async () => {
    stubArtifacts([artifact()]);

    const { container } = renderFiles();
    await screen.findByText('chroma-t2i');

    await waitFor(() =>
      expect(
        container.querySelector('img[src="/api/jobs/job-aaaaaaaa-1111/artifacts/ComfyUI_00001_.png"]'),
      ).not.toBeNull(),
    );
  });

  it('previews a video with a <video> element and shows a plain tile for anything else', async () => {
    stubArtifacts([
      artifact({ filename: 'clip.mp4', kind: 'video' }),
      artifact({ filename: 'notes.txt', kind: 'other' }),
    ]);

    const { container } = renderFiles();
    await screen.findByText('chroma-t2i');

    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    expect(container.querySelector('video')).toHaveAttribute(
      'src',
      '/api/jobs/job-aaaaaaaa-1111/artifacts/clip.mp4',
    );
    // The "other" tile carries no preview element, only the name + extension.
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    expect(screen.getByText('txt')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('offers each file as a download link', async () => {
    stubArtifacts([artifact()]);

    renderFiles();

    const link = await screen.findByRole('link', { name: /Download ComfyUI_00001_\.png/ });
    expect(link).toHaveAttribute('href', '/api/jobs/job-aaaaaaaa-1111/artifacts/ComfyUI_00001_.png');
    expect(link).toHaveAttribute('download', 'ComfyUI_00001_.png');
  });

  it('deletes one file through DELETE /api/jobs/{id}/artifacts/{name} after confirming', async () => {
    let deleted = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === '/api/staging') return jsonResponse(EMPTY_STAGING);
      if (url.startsWith('/api/me/artifacts')) {
        return jsonResponse({ files: deleted ? [] : [artifact()] });
      }
      if (
        url === '/api/jobs/job-aaaaaaaa-1111/artifacts/ComfyUI_00001_.png' &&
        method === 'DELETE'
      ) {
        deleted = true;
        return jsonResponse({ ok: true, result_files: [] });
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderFiles();
    await screen.findByText('ComfyUI_00001_.png');

    fireEvent.click(screen.getByRole('button', { name: 'Delete ComfyUI_00001_.png' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([reqUrl, reqInit]) => {
        const url = typeof reqUrl === 'string' ? reqUrl : reqUrl.toString();
        return (
          url === '/api/jobs/job-aaaaaaaa-1111/artifacts/ComfyUI_00001_.png' &&
          reqInit?.method === 'DELETE'
        );
      });
      expect(call).toBeDefined();
    });
    // Refreshed afterwards: the tile is gone and the empty state took over.
    expect(await screen.findByText('No output files yet.')).toBeInTheDocument();
  });

  it('deletes a whole date folder with one DELETE /api/jobs/{id}/artifacts per job', async () => {
    let deleted = false;
    const files = [
      artifact({ job_id: 'job-one', filename: 'a.png' }),
      artifact({ job_id: 'job-one', filename: 'b.png' }),
      artifact({ job_id: 'job-two', filename: 'c.png' }),
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === '/api/staging') return jsonResponse(EMPTY_STAGING);
      if (url.startsWith('/api/me/artifacts')) return jsonResponse({ files: deleted ? [] : files });
      if (/^\/api\/jobs\/job-(one|two)\/artifacts$/.test(url) && method === 'DELETE') {
        deleted = true;
        return jsonResponse({ ok: true, result_files: [] });
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderFiles();
    await screen.findByText('a.png');

    fireEvent.click(
      screen.getByRole('button', { name: 'Delete all chroma-t2i 2026-09-20' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/3 file\(s\)/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      const batchCalls = fetchMock.mock.calls.filter(([reqUrl, reqInit]) => {
        const url = typeof reqUrl === 'string' ? reqUrl : reqUrl.toString();
        return /\/artifacts$/.test(url) && reqInit?.method === 'DELETE';
      });
      const urls = batchCalls.map(([reqUrl]) =>
        typeof reqUrl === 'string' ? reqUrl : reqUrl.toString(),
      );
      // Once per job in that folder -- not once per file.
      expect(urls).toEqual(['/api/jobs/job-one/artifacts', '/api/jobs/job-two/artifacts']);
    });
  });

  it('deletes a hand-picked selection file by file, leaving unticked files alone', async () => {
    const deleted: string[] = [];
    const files = [
      artifact({ job_id: 'job-one', filename: 'a.png' }),
      artifact({ job_id: 'job-one', filename: 'b.png' }),
      artifact({ job_id: 'job-two', filename: 'c.png' }),
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === '/api/staging') return jsonResponse(EMPTY_STAGING);
      if (url.startsWith('/api/me/artifacts')) {
        return jsonResponse({
          files: files.filter((file) => !deleted.includes(`${file.job_id}/${file.filename}`)),
        });
      }
      const match = /^\/api\/jobs\/(job-[a-z]+)\/artifacts\/(.+)$/.exec(url);
      if (match && method === 'DELETE') {
        deleted.push(`${match[1]}/${match[2]}`);
        return jsonResponse({ ok: true, result_files: [] });
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderFiles();
    await screen.findByText('a.png');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select a.png' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select c.png' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected (2)' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/2 selected file\(s\)/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    // Per file, not per job: b.png shares job-one with a.png and must survive.
    await waitFor(() => expect(deleted).toEqual(['job-one/a.png', 'job-two/c.png']));
    const jobWide = fetchMock.mock.calls.filter(([reqUrl, reqInit]) => {
      const url = typeof reqUrl === 'string' ? reqUrl : reqUrl.toString();
      return /\/artifacts$/.test(url) && reqInit?.method === 'DELETE';
    });
    expect(jobWide).toHaveLength(0);
    expect(await screen.findByText('b.png')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('a.png')).not.toBeInTheDocument());
  });

  function stubObjectUrls(saved: Blob[]) {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn((blob: Blob) => {
        saved.push(blob);
        return 'blob:zip';
      }),
      revokeObjectURL: vi.fn(),
    });
    return vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  }

  it('packs a whole date folder into one zip download, fetched through the artifact URLs', async () => {
    const files = [
      artifact({ job_id: 'job-one', filename: 'a.png', size: 3 }),
      artifact({ job_id: 'job-two', filename: 'a.png', size: 3 }),
      artifact({ job_id: 'job-two', filename: 'clip.mp4', kind: 'video', size: 4 }),
    ];
    const fetched: string[] = [];
    stubArtifacts(files, (url) => {
      if (!/^\/api\/jobs\/job-[a-z]+\/artifacts\/.+$/.test(url)) return null;
      fetched.push(url);
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    const saved: Blob[] = [];
    const click = stubObjectUrls(saved);

    try {
      renderFiles();
      await screen.findByText('clip.mp4');

      fireEvent.click(screen.getByRole('button', { name: 'Download all chroma-t2i 2026-09-20' }));

      await waitFor(() => expect(saved).toHaveLength(1));
      expect(fetched).toEqual([
        '/api/jobs/job-one/artifacts/a.png',
        '/api/jobs/job-two/artifacts/a.png',
        '/api/jobs/job-two/artifacts/clip.mp4',
      ]);
      expect(click).toHaveBeenCalledTimes(1);

      // Three entries, laid out as label/date/filename; the second a.png is
      // disambiguated with its short job id instead of overwriting the first.
      const bytes = new Uint8Array(await saved[0].arrayBuffer());
      const view = new DataView(bytes.buffer);
      const eocd = bytes.length - 22;
      expect(view.getUint32(eocd, true)).toBe(0x06054b50);
      expect(view.getUint16(eocd + 10, true)).toBe(3);
      const text = new TextDecoder().decode(bytes);
      expect(text).toContain('chroma-t2i/2026-09-20/a.png');
      expect(text).toContain('chroma-t2i/2026-09-20/job-two_a.png');
      expect(text).toContain('chroma-t2i/2026-09-20/clip.mp4');
    } finally {
      click.mockRestore();
    }
  });

  it('downloads the ticked files across folders as one zip', async () => {
    const files = [
      artifact({ job_id: 'job-one', filename: 'a.png', size: 3 }),
      artifact({ job_id: 'job-two', filename: 'b.png', size: 3, created_at: localNoon(2026, 9, 19) }),
      artifact({ job_id: 'job-three', filename: 'c.png', size: 3, label: 'other' }),
    ];
    const fetched: string[] = [];
    stubArtifacts(files, (url) => {
      if (!/^\/api\/jobs\/job-[a-z]+\/artifacts\/.+$/.test(url)) return null;
      fetched.push(url);
      return new Response(new Uint8Array([9]), { status: 200 });
    });
    const saved: Blob[] = [];
    const click = stubObjectUrls(saved);

    try {
      renderFiles();
      await screen.findByText('c.png');

      expect(screen.getByRole('button', { name: 'Download selected (0)' })).toBeDisabled();
      // Only the newest folder is expanded by default; open the other two.
      fireEvent.click(screen.getByRole('button', { name: /^other/ }));
      fireEvent.click(screen.getByRole('button', { name: '2026-09-19' }));
      fireEvent.click(await screen.findByRole('checkbox', { name: 'Select b.png' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select c.png' }));
      fireEvent.click(screen.getByRole('button', { name: 'Download selected (2)' }));

      await waitFor(() => expect(saved).toHaveLength(1));
      expect([...fetched].sort()).toEqual([
        '/api/jobs/job-three/artifacts/c.png',
        '/api/jobs/job-two/artifacts/b.png',
      ]);
      const text = new TextDecoder().decode(new Uint8Array(await saved[0].arrayBuffer()));
      expect(text).toContain('chroma-t2i/2026-09-19/b.png');
      expect(text).toContain('other/2026-09-20/c.png');
      expect(text).not.toContain('a.png');
    } finally {
      click.mockRestore();
    }
  });

  it('shows the empty state when the caller has no outputs', async () => {
    stubArtifacts([]);

    renderFiles();

    expect(await screen.findByText('No output files yet.')).toBeInTheDocument();
  });
});

/* -------------------------------------------------------- groupArtifacts */

describe('groupArtifacts', () => {
  it('keys the first level on the label, falling back to the short job id', () => {
    const groups = groupArtifacts([
      artifact({ label: 'named', filename: 'a.png' }),
      artifact({ label: null, job_id: 'deadbeefcafe', filename: 'b.png' }),
    ]);
    expect(groups.map((group) => group.label).sort()).toEqual(['deadbeef', 'named']);
  });

  it('orders name folders by their newest file, dates newest first, files by name', () => {
    const groups = groupArtifacts([
      artifact({ label: 'old', filename: 'z.png', created_at: localNoon(2026, 9, 1) }),
      artifact({ label: 'new', filename: 'b.png', created_at: localNoon(2026, 9, 18) }),
      artifact({ label: 'new', filename: 'a.png', created_at: localNoon(2026, 9, 18) }),
      artifact({ label: 'new', filename: 'c.png', created_at: localNoon(2026, 9, 20) }),
    ]);

    expect(groups.map((group) => group.label)).toEqual(['new', 'old']);
    expect(groups[0].dates.map((date) => date.date)).toEqual(['2026-09-20', '2026-09-18']);
    expect(groups[0].dates[1].files.map((file) => file.filename)).toEqual(['a.png', 'b.png']);
  });

  it('returns an empty list for an empty listing', () => {
    expect(groupArtifacts([])).toEqual([]);
  });
});

/* ------------------------------------------------ 2026-09-21 pagination */

describe('Files page: outputs pagination (2026-09-21)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function stubPagedArtifacts(pages: Record<number, ArtifactFile[]>, totalJobs: number, limit = 25) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/staging') return jsonResponse(EMPTY_STAGING);
      if (url.startsWith('/api/me/artifacts?')) {
        const page = Number(new URLSearchParams(url.slice(url.indexOf('?'))).get('page'));
        return jsonResponse({ files: pages[page] ?? [], total_jobs: totalJobs, page, limit });
      }
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('loads the first page of outputs (25 jobs) and hides "load more" when nothing older remains', async () => {
    const fetchMock = stubPagedArtifacts({ 1: [artifact()] }, 1);
    renderFiles();
    expect(await screen.findByText('chroma-t2i')).toBeInTheDocument();
    const urls = fetchMock.mock.calls.map(([input]) => (typeof input === 'string' ? input : input.toString()));
    expect(urls).toContain('/api/me/artifacts?page=1&limit=25');
    expect(screen.queryByRole('button', { name: /load more|載入更多/i })).not.toBeInTheDocument();
  });

  it('offers "load more" when older jobs remain, and appends the next page on click', async () => {
    const older = artifact({ job_id: 'job-bbbbbbbb-2222', label: 'older-run', created_at: localNoon(2026, 9, 1) });
    const fetchMock = stubPagedArtifacts({ 1: [artifact()], 2: [older] }, 26);
    renderFiles();
    expect(await screen.findByText('chroma-t2i')).toBeInTheDocument();

    const more = screen.getByRole('button', { name: /load more|載入更多/i });
    fireEvent.click(more);

    expect(await screen.findByText('older-run')).toBeInTheDocument();
    // The first page is still on screen: pages accumulate rather than replace.
    expect(screen.getByText('chroma-t2i')).toBeInTheDocument();
    const urls = fetchMock.mock.calls.map(([input]) => (typeof input === 'string' ? input : input.toString()));
    expect(urls).toContain('/api/me/artifacts?page=2&limit=25');
    // 26 jobs, 25 per page: page 2 was the last one.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /load more|載入更多/i })).not.toBeInTheDocument(),
    );
  });
});

/* -------------------------------------------- admin scope (2026-09-21) */

function renderFilesAs(role: 'admin' | 'user') {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter>
        <Files role={role} />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe('Files page: admin 全部使用者 view (2026-09-21 管理視角)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const ALICE_REF: StagingFile = { ...REF_PNG, user_id: 'uid-alice-1111', username: 'alice' };
  const BOB_REF: StagingFile = { ...REF_PNG, user_id: 'uid-bob-2222', username: 'bob' };

  function stubScoped(opts: { onDelete?: (url: string) => void } = {}) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (method === 'DELETE') {
        opts.onDelete?.(url);
        return jsonResponse({ ok: true });
      }
      if (url === '/api/staging?scope=all') {
        return jsonResponse({ files: [ALICE_REF, BOB_REF], total_bytes: 4096, quota_bytes: 0, userdata_bytes: 0 });
      }
      if (url === '/api/staging') return jsonResponse(EMPTY_STAGING);
      if (url.startsWith('/api/me/artifacts') && url.includes('scope=all')) {
        return jsonResponse({
          files: [
            artifact({ user_id: 'uid-alice-1111', username: 'alice' }),
            artifact({
              job_id: 'job-bbbbbbbb-2222',
              filename: 'ComfyUI_00009_.png',
              label: null,
              user_id: 'uid-bob-2222',
              username: 'bob',
            }),
          ],
          total_jobs: 2,
          page: 1,
          limit: 25,
        });
      }
      if (url.startsWith('/api/me/artifacts')) return jsonResponse({ files: [], total_jobs: 0, page: 1, limit: 25 });
      return jsonResponse({ error: { code: 'http_error', message: 'not stubbed' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('a plain user gets no scope switch and only the personal endpoints', async () => {
    const fetchMock = stubScoped();
    renderFilesAs('user');
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId('files-scope')).not.toBeInTheDocument();
    const urls = fetchMock.mock.calls.map(([input]) => (typeof input === 'string' ? input : input.toString()));
    expect(urls.some((url) => url.includes('scope=all'))).toBe(false);
  });

  it('an admin lands on 全部使用者: both listings carry scope=all and every row shows its owner', async () => {
    stubScoped();
    renderFilesAs('admin');

    expect(await screen.findByTestId('files-scope')).toBeInTheDocument();
    // Two users both uploaded `reference.png`; both rows render, each with its owner.
    expect(await screen.findAllByText('reference.png')).toHaveLength(2);
    expect(screen.getAllByText('alice').length).toBeGreaterThan(0);
    expect(screen.getAllByText('bob').length).toBeGreaterThan(0);
    // Output folders are owner-prefixed, the unnamed job falling back to its short id.
    expect(screen.getByText('alice / chroma-t2i')).toBeInTheDocument();
    expect(screen.getByText('bob / job-bbbb')).toBeInTheDocument();
  });

  it('deletes another user’s upload through DELETE /api/staging/{name}?user=<uid>', async () => {
    const deleted: string[] = [];
    stubScoped({ onDelete: (url) => deleted.push(url) });
    renderFilesAs('admin');
    await screen.findAllByText('reference.png');

    const [aliceDelete] = screen.getAllByRole('button', { name: 'Delete reference.png' });
    fireEvent.click(aliceDelete);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleted).toEqual(['/api/staging/reference.png?user=uid-alice-1111']));
  });

  it('switching to 我的檔案 refetches without scope=all', async () => {
    const fetchMock = stubScoped();
    renderFilesAs('admin');
    await screen.findAllByText('reference.png');

    fireEvent.click(screen.getByRole('radio', { name: 'My files' }));

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([input]) => (typeof input === 'string' ? input : input.toString()));
      expect(urls).toContain('/api/staging');
      expect(urls.some((url) => url.startsWith('/api/me/artifacts?') && !url.includes('scope=all'))).toBe(true);
    });
    expect(await screen.findByText('You have not uploaded any files yet.')).toBeInTheDocument();
  });
});
