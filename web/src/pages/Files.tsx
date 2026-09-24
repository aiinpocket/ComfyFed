/**
 * 2026-09-20 檔案頁 §4: the console's personal Files page.
 *
 * Two halves, both scoped to the signed-in caller by default. An admin gets
 * a 「我的 / 全部使用者」 switch (2026-09-21 管理視角): in the 全部 view both
 * listings carry `?scope=all`, every row shows its owner, and deletes go
 * through the same routes on the owner's behalf (`?user=` for uploads; the
 * artifact routes already accept an admin).
 *
 * - **Uploads**: the staging card that used to live on Settings
 *   (`GET /api/staging` + `DELETE /api/staging/{name}`). Settings keeps only
 *   the quota bar, which reads the same listing. Rows can be ticked and
 *   deleted in one go (one DELETE per file -- there is no batch route, and
 *   the list is small).
 * - **Outputs**: `GET /api/me/artifacts` grouped into `label / YYYY-MM-DD /`
 *   folders with thumbnails, per-file download/delete, a per-folder
 *   "delete all" / "download all", and a tick-to-select model across folders
 *   for "delete selected" / "download selected". Deleting only drops bytes:
 *   the job row, its `result_hashes` and its receipt survive (ledger
 *   untouched, spec §3.2).
 *
 * Batch download is assembled in the browser: every ticked file is fetched
 * through the same `/api/jobs/<id>/artifacts/<name>` URL the tile links to,
 * packed into a store-only ZIP (`lib/zip.ts`, folder structure
 * `label/date/filename`), and handed to the browser as one download. That
 * keeps the server stateless about it and needs no new endpoint; the trade
 * is a `MAX_ZIP_BYTES` cap, checked against the listing's sizes before a
 * single byte is fetched.
 */
import {
  Accordion,
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Image,
  Modal,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconCheck,
  IconDownload,
  IconFile,
  IconFolder,
  IconPhoto,
  IconRefresh,
  IconTrash,
  IconUser,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  api,
  ApiError,
  artifactUrl,
  PAGE_SIZE,
  type ArtifactFile,
  type FilesScope,
  type Role,
  type StagingFile,
} from '../api';
import { Mono, SectionHeader } from '../components/Primitives';
import { formatBytes } from '../lib/format';
import { MAX_ZIP_BYTES, buildZip, saveBlob, type ZipEntry } from '../lib/zip';

/** One `YYYY-MM-DD` folder inside a name folder. */
export interface ArtifactDateGroup {
  date: string;
  files: ArtifactFile[];
}

/** One first-level folder: a job name (or a short job id when unnamed). */
export interface ArtifactLabelGroup {
  label: string;
  dates: ArtifactDateGroup[];
}

/** The server serialises naive UTC timestamps; append `Z` so `Date` does not
 * read them as local time (same trick as `lib/format`). */
function parseCreated(iso: string): Date {
  const normalized = /[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`;
  return new Date(normalized);
}

/** LOCAL calendar date of a timestamp, as `YYYY-MM-DD`. Local, not UTC: the
 * folder a user looks for is "the day I ran it" in their own timezone. */
function localDate(iso: string): string {
  const date = parseCreated(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function createdMillis(file: ArtifactFile): number {
  const value = parseCreated(file.created_at).getTime();
  return Number.isNaN(value) ? 0 : value;
}

/** Folder label of a file: its job label, else the job id's first 8 chars.
 * In the admin's 全部使用者 view (rows carry `username`) the owner comes
 * first, so one user's jobs sit together: `alice / chroma-t2i`. */
function labelOf(file: ArtifactFile): string {
  const base = file.label ?? file.job_id.slice(0, 8);
  const owner = file.username ?? (file.user_id ? file.user_id.slice(0, 8) : null);
  return owner ? `${owner} / ${base}` : base;
}

/**
 * Fold a flat `GET /api/me/artifacts` listing into the two-level folder tree
 * the page renders.
 *
 * - first level: `label`, falling back to the job id's first 8 characters so
 *   an unnamed job still lands in a folder of its own;
 * - second level: the local `YYYY-MM-DD` of `created_at`;
 * - name folders are ordered by their newest file (descending), dates
 *   descending, and files inside a date by filename ascending.
 */
export function groupArtifacts(files: ArtifactFile[]): ArtifactLabelGroup[] {
  const byLabel = new Map<string, Map<string, ArtifactFile[]>>();

  for (const file of files) {
    const label = labelOf(file);
    let dates = byLabel.get(label);
    if (!dates) {
      dates = new Map<string, ArtifactFile[]>();
      byLabel.set(label, dates);
    }
    const date = localDate(file.created_at);
    const bucket = dates.get(date);
    if (bucket) bucket.push(file);
    else dates.set(date, [file]);
  }

  const groups: ArtifactLabelGroup[] = [];
  for (const [label, dates] of byLabel) {
    const dateGroups: ArtifactDateGroup[] = [];
    for (const [date, bucket] of dates) {
      dateGroups.push({
        date,
        files: [...bucket].sort((a, b) => a.filename.localeCompare(b.filename)),
      });
    }
    dateGroups.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    groups.push({ label, dates: dateGroups });
  }

  const newest = (group: ArtifactLabelGroup) =>
    group.dates.reduce(
      (best, date) => Math.max(best, ...date.files.map(createdMillis)),
      Number.NEGATIVE_INFINITY,
    );
  groups.sort((a, b) => newest(b) - newest(a));
  return groups;
}

/** Stable identity of one output file across re-fetches of the listing. */
export function artifactKey(file: ArtifactFile): string {
  return `${file.job_id}/${file.filename}`;
}

/** Stable identity of one upload: two users can both have `ref.png`, so the
 * admin's 全部 view keys on owner + name (the personal view has no owner). */
export function uploadKey(file: StagingFile): string {
  return file.user_id ? `${file.user_id}/${file.name}` : file.name;
}

/**
 * Archive paths for a batch download: `label/date/filename`, mirroring the
 * folders on screen. Two jobs in the same folder can both emit
 * `ComfyUI_00001_.png`, so a path that would repeat gets the short job id
 * prefixed to its filename instead of silently overwriting the first.
 */
export function zipPathsFor(files: ArtifactFile[]): Map<string, string> {
  const paths = new Map<string, string>();
  const taken = new Set<string>();
  for (const file of files) {
    const folder = `${labelOf(file)}/${localDate(file.created_at)}`;
    let path = `${folder}/${file.filename}`;
    if (taken.has(path)) path = `${folder}/${file.job_id.slice(0, 8)}_${file.filename}`;
    taken.add(path);
    paths.set(artifactKey(file), path);
  }
  return paths;
}

/** `comfyfed-files-20260920-2245.zip` style archive name (local time). */
function zipFilename(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `comfyfed-files-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
}

const IMAGE_HEIGHT = 120;
const ZIP_NOTIFICATION_ID = 'files-zip';

type DeleteTarget =
  | { mode: 'one'; file: ArtifactFile }
  | { mode: 'folder'; label: string; date: string; files: ArtifactFile[] }
  | { mode: 'selected'; files: ArtifactFile[] };

interface FilesProps {
  /** Only an admin gets the 我的／全部使用者 switch; a plain user's page is
   * their own files, full stop (the server refuses `scope=all` anyway). */
  role?: Role;
}

export function Files({ role = 'user' }: FilesProps) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const isAdmin = role === 'admin';
  // Admin lands on 全部使用者 -- the same default as the Jobs page's list.
  const [scope, setScope] = useState<FilesScope>(isAdmin ? 'all' : 'mine');

  /* ------------------------------------------------------- uploads half */
  const [uploads, setUploads] = useState<StagingFile[]>([]);
  const [uploadsTotal, setUploadsTotal] = useState(0);
  const [uploadsLoaded, setUploadsLoaded] = useState(false);
  const [uploadsBusy, setUploadsBusy] = useState(false);
  const [uploadTarget, setUploadTarget] = useState<StagingFile | null>(null);
  const [uploadBatchOpen, setUploadBatchOpen] = useState(false);
  const [uploadSelected, setUploadSelected] = useState<Set<string>>(() => new Set());
  const [deletingUpload, setDeletingUpload] = useState(false);

  /* ------------------------------------------------------- outputs half */
  const [artifacts, setArtifacts] = useState<ArtifactFile[]>([]);
  const [artifactsLoaded, setArtifactsLoaded] = useState(false);
  // 2026-09-21 分頁：以 job 為單位，一頁 PAGE_SIZE 張單。`pagesLoaded` 是目前
  // 疊在畫面上的頁數；重新整理／刪除後會把 1..pagesLoaded 全部重抓，
  // 「載入更多」只抓下一頁往後疊。`totalJobs` 決定按鈕還要不要出現。
  const [pagesLoaded, setPagesLoaded] = useState(1);
  const [totalJobs, setTotalJobs] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [artifactsBusy, setArtifactsBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deletingArtifact, setDeletingArtifact] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [downloading, setDownloading] = useState(false);

  const notifyFailure = (title: string, caught: unknown) =>
    notifications.show({
      color: 'red',
      icon: <IconX size={16} />,
      title,
      message:
        caught instanceof ApiError
          ? t(`errors.${caught.code}`, { defaultValue: caught.message })
          : caught instanceof Error && caught.message.startsWith('zip.')
            ? t(`files.${caught.message.slice(4)}`)
            : t('errors.network'),
    });

  const loadUploads = useCallback(
    async (notifyOnFailure = true) => {
      setUploadsBusy(true);
      try {
        const listing = await api.listStaging(scope);
        setUploads(listing.files);
        setUploadsTotal(listing.total_bytes);
        setUploadsLoaded(true);
        // Drop ticks for files that no longer exist.
        setUploadSelected((prev) => {
          const keys = new Set(listing.files.map(uploadKey));
          return new Set([...prev].filter((key) => keys.has(key)));
        });
      } catch (caught) {
        if (notifyOnFailure) notifyFailure(t('settings.uploads_load_failed'), caught);
      } finally {
        setUploadsBusy(false);
      }
    },
    // `notifyFailure` closes over `t` only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, scope],
  );

  const loadArtifacts = useCallback(
    async (notifyOnFailure = true) => {
      setArtifactsBusy(true);
      try {
        const files: ArtifactFile[] = [];
        let total = 0;
        for (let page = 1; page <= pagesLoaded; page += 1) {
          const listing = await api.listMyArtifacts(page, PAGE_SIZE, scope);
          files.push(...(listing.files ?? []));
          total = listing.total_jobs ?? 0;
          if (page * PAGE_SIZE >= total) break;
        }
        setArtifacts(files);
        setTotalJobs(total);
        setArtifactsLoaded(true);
        setSelected((prev) => {
          const keys = new Set(files.map(artifactKey));
          return new Set([...prev].filter((key) => keys.has(key)));
        });
      } catch (caught) {
        if (notifyOnFailure) notifyFailure(t('files.outputs_load_failed'), caught);
      } finally {
        setArtifactsBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, pagesLoaded, scope],
  );

  const changeScope = (next: string) => {
    if (next !== 'mine' && next !== 'all') return;
    setScope(next);
    setUploadSelected(new Set());
    setSelected(new Set());
    setPagesLoaded(1);
  };

  const hasMoreArtifacts = pagesLoaded * PAGE_SIZE < totalJobs;
  const loadMoreArtifacts = async () => {
    const next = pagesLoaded + 1;
    setLoadingMore(true);
    try {
      const listing = await api.listMyArtifacts(next, PAGE_SIZE, scope);
      setArtifacts((prev) => {
        const seen = new Set(prev.map(artifactKey));
        return [...prev, ...(listing.files ?? []).filter((file) => !seen.has(artifactKey(file)))];
      });
      setTotalJobs(listing.total_jobs ?? 0);
      setPagesLoaded(next);
    } catch (caught) {
      notifyFailure(t('files.outputs_load_failed'), caught);
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    void loadUploads(false);
  }, [loadUploads]);

  useEffect(() => {
    void loadArtifacts(false);
  }, [loadArtifacts]);

  const groups = useMemo(() => groupArtifacts(artifacts), [artifacts]);
  const selectedFiles = useMemo(
    () => artifacts.filter((file) => selected.has(artifactKey(file))),
    [artifacts, selected],
  );

  /* ------------------------------------------------- uploads: selection */

  const toggleUpload = (name: string, checked: boolean) =>
    setUploadSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(name);
      else next.delete(name);
      return next;
    });

  const setAllUploads = (checked: boolean) =>
    setUploadSelected(checked ? new Set(uploads.map(uploadKey)) : new Set());

  const deleteUploads = async (files: StagingFile[], title: string) => {
    setDeletingUpload(true);
    try {
      // One DELETE per file: the staging API has no batch route, and the
      // list is a handful of reference images at most. In the admin's 全部
      // view each row names its owner, and the delete goes on their behalf.
      for (const file of files) await api.deleteStagingFile(file.name, file.user_id);
      notifications.show({
        color: 'teal',
        icon: <IconCheck size={16} />,
        title: t('settings.uploads_deleted'),
        message: title,
      });
      setUploadTarget(null);
      setUploadBatchOpen(false);
      await loadUploads();
    } catch (caught) {
      notifyFailure(t('settings.uploads_delete_failed'), caught);
    } finally {
      setDeletingUpload(false);
    }
  };

  const confirmDeleteUpload = () => {
    if (!uploadTarget) return;
    return deleteUploads([uploadTarget], uploadTarget.name);
  };

  const confirmDeleteUploadBatch = () => {
    const files = uploads.filter((file) => uploadSelected.has(uploadKey(file)));
    return deleteUploads(files, t('files.selected_count', { count: files.length }));
  };

  /* ------------------------------------------------- outputs: selection */

  const toggleArtifact = (file: ArtifactFile, checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const key = artifactKey(file);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });

  const setFilesSelected = (files: ArtifactFile[], checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const file of files) {
        if (checked) next.add(artifactKey(file));
        else next.delete(artifactKey(file));
      }
      return next;
    });

  const setAllArtifacts = (checked: boolean) =>
    setSelected(checked ? new Set(artifacts.map(artifactKey)) : new Set());

  const confirmDeleteArtifact = async () => {
    if (!deleteTarget) return;
    setDeletingArtifact(true);
    try {
      if (deleteTarget.mode === 'one') {
        await api.deleteArtifact(deleteTarget.file.job_id, deleteTarget.file.filename);
      } else if (deleteTarget.mode === 'folder') {
        // One call per job in the folder: a `label/date` folder can hold the
        // output of several jobs, and the batch route is per job.
        const jobIds = [...new Set(deleteTarget.files.map((file) => file.job_id))];
        for (const jobId of jobIds) await api.deleteJobArtifacts(jobId);
      } else {
        // A hand-picked selection may cover only part of a job's output, so
        // it goes file by file rather than through the per-job route.
        for (const file of deleteTarget.files) {
          await api.deleteArtifact(file.job_id, file.filename);
        }
      }
      notifications.show({
        color: 'teal',
        icon: <IconCheck size={16} />,
        title: t('files.deleted'),
        message:
          deleteTarget.mode === 'one'
            ? deleteTarget.file.filename
            : deleteTarget.mode === 'folder'
              ? `${deleteTarget.label} / ${deleteTarget.date}`
              : t('files.selected_count', { count: deleteTarget.files.length }),
      });
      setDeleteTarget(null);
      await loadArtifacts();
    } catch (caught) {
      notifyFailure(t('files.delete_failed'), caught);
    } finally {
      setDeletingArtifact(false);
    }
  };

  /**
   * Fetch every file in `files` and hand the browser one ZIP. The size cap is
   * checked first from the listing's byte counts, so an oversized selection
   * fails instantly instead of after minutes of downloading.
   */
  const downloadFiles = async (files: ArtifactFile[]) => {
    if (files.length === 0 || downloading) return;
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_ZIP_BYTES) {
      notifications.show({
        color: 'red',
        icon: <IconX size={16} />,
        title: t('files.zip_failed'),
        message: t('files.zip_too_large', {
          size: formatBytes(total),
          limit: formatBytes(MAX_ZIP_BYTES),
        }),
      });
      return;
    }

    setDownloading(true);
    notifications.show({
      id: ZIP_NOTIFICATION_ID,
      loading: true,
      autoClose: false,
      withCloseButton: false,
      title: t('files.zip_preparing', { count: files.length }),
      message: formatBytes(total),
    });
    try {
      const paths = zipPathsFor(files);
      const entries: ZipEntry[] = [];
      for (const file of files) {
        const response = await fetch(artifactUrl(file.job_id, file.filename), {
          credentials: 'include',
        });
        if (!response.ok) throw new Error('zip.fetch_failed');
        entries.push({
          path: paths.get(artifactKey(file)) ?? file.filename,
          data: new Uint8Array(await response.arrayBuffer()),
          modified: parseCreated(file.created_at),
        });
      }
      saveBlob(buildZip(entries), zipFilename());
      notifications.update({
        id: ZIP_NOTIFICATION_ID,
        loading: false,
        autoClose: 4000,
        withCloseButton: true,
        color: 'teal',
        icon: <IconCheck size={16} />,
        title: t('files.zip_ready'),
        message: t('files.selected_count', { count: files.length }),
      });
    } catch (caught) {
      notifications.hide(ZIP_NOTIFICATION_ID);
      notifyFailure(t('files.zip_failed'), caught);
    } finally {
      setDownloading(false);
    }
  };

  const cardStyle = {
    background: theme.other.surfaces.card,
    borderColor: theme.other.surfaces.border,
  };

  const allUploadsSelected = uploads.length > 0 && uploadSelected.size === uploads.length;
  const allArtifactsSelected = artifacts.length > 0 && selected.size === artifacts.length;

  return (
    <Stack gap="lg">
      <SectionHeader title={t('nav.files')} />

      {isAdmin && (
        <Group gap="sm" wrap="wrap">
          <SegmentedControl
            data-testid="files-scope"
            size="xs"
            value={scope}
            onChange={changeScope}
            data={[
              { value: 'mine', label: t('files.scope_mine') },
              { value: 'all', label: t('files.scope_all') },
            ]}
          />
          <Text size="xs" c="dimmed">
            {scope === 'all' ? t('files.scope_all_hint') : t('files.scope_mine_hint')}
          </Text>
        </Group>
      )}

      {/* -------------------------------------------------------- uploads */}
      <Card style={cardStyle}>
        <Stack gap="sm">
          <Group justify="space-between" wrap="nowrap">
            <Group gap="xs">
              <IconPhoto size={17} />
              <Text fw={600}>{t('files.heading_uploads')}</Text>
            </Group>
            <Group gap="xs" wrap="nowrap">
              {uploads.length > 0 && (
                <Checkbox
                  size="xs"
                  label={t('files.select_all')}
                  checked={allUploadsSelected}
                  indeterminate={uploadSelected.size > 0 && !allUploadsSelected}
                  onChange={(event) => setAllUploads(event.currentTarget.checked)}
                />
              )}
              <Button
                size="compact-sm"
                variant="light"
                color="red"
                leftSection={<IconTrash size={14} />}
                disabled={uploadSelected.size === 0}
                onClick={() => setUploadBatchOpen(true)}
              >
                {t('files.delete_selected', { count: uploadSelected.size })}
              </Button>
              <Button
                size="compact-sm"
                variant="subtle"
                color="gray"
                leftSection={<IconRefresh size={14} />}
                loading={uploadsBusy}
                onClick={() => void loadUploads()}
              >
                {t('settings.uploads_refresh')}
              </Button>
            </Group>
          </Group>
          <Text size="sm" c="dimmed">
            {t('settings.uploads_hint')}
          </Text>

          {uploadsLoaded && uploads.length === 0 && (
            <Text size="sm" c="dimmed">
              {t('settings.uploads_empty')}
            </Text>
          )}

          {uploads.length > 0 && (
            <Stack gap="xs">
              {uploads.map((file) => (
                <Group
                  key={uploadKey(file)}
                  justify="space-between"
                  gap="sm"
                  wrap="nowrap"
                  p="xs"
                  style={{
                    background: theme.other.surfaces.raised,
                    border: `1px solid ${theme.other.surfaces.border}`,
                    borderRadius: theme.radius.md,
                  }}
                >
                  <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                    <Checkbox
                      size="sm"
                      aria-label={`${t('files.select')} ${file.name}`}
                      checked={uploadSelected.has(uploadKey(file))}
                      onChange={(event) => toggleUpload(uploadKey(file), event.currentTarget.checked)}
                    />
                    <Stack gap={2} style={{ minWidth: 0 }}>
                      <Group gap={6} wrap="nowrap">
                        {file.user_id !== undefined && (
                          <Badge
                            size="xs"
                            variant="light"
                            color="federation"
                            tt="none"
                            fw={500}
                            leftSection={<IconUser size={10} />}
                          >
                            {file.username ?? file.user_id.slice(0, 8)}
                          </Badge>
                        )}
                        <Mono c="" size="sm">
                          {file.name}
                        </Mono>
                      </Group>
                      <Text size="xs" c="dimmed">
                        {formatBytes(file.size)} · {new Date(file.modified * 1000).toLocaleString()}
                      </Text>
                    </Stack>
                  </Group>
                  <Tooltip label={t('settings.uploads_delete')}>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={`${t('settings.uploads_delete')} ${file.name}`}
                      onClick={() => setUploadTarget(file)}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              ))}
              <Text size="xs" c="dimmed">
                {t('settings.uploads_total', {
                  count: uploads.length,
                  size: formatBytes(uploadsTotal),
                })}
              </Text>
            </Stack>
          )}
        </Stack>
      </Card>

      {/* -------------------------------------------------------- outputs */}
      <Card style={cardStyle}>
        <Stack gap="sm">
          <Group justify="space-between" wrap="nowrap">
            <Group gap="xs">
              <IconFolder size={17} />
              <Text fw={600}>{t('files.heading_outputs')}</Text>
            </Group>
            <Group gap="xs" wrap="nowrap">
              {artifacts.length > 0 && (
                <Checkbox
                  size="xs"
                  label={t('files.select_all')}
                  checked={allArtifactsSelected}
                  indeterminate={selected.size > 0 && !allArtifactsSelected}
                  onChange={(event) => setAllArtifacts(event.currentTarget.checked)}
                />
              )}
              <Button
                size="compact-sm"
                variant="light"
                leftSection={<IconDownload size={14} />}
                disabled={selectedFiles.length === 0}
                loading={downloading}
                onClick={() => void downloadFiles(selectedFiles)}
              >
                {t('files.download_selected', { count: selectedFiles.length })}
              </Button>
              <Button
                size="compact-sm"
                variant="light"
                color="red"
                leftSection={<IconTrash size={14} />}
                disabled={selectedFiles.length === 0}
                onClick={() => setDeleteTarget({ mode: 'selected', files: selectedFiles })}
              >
                {t('files.delete_selected', { count: selectedFiles.length })}
              </Button>
              <Button
                size="compact-sm"
                variant="subtle"
                color="gray"
                leftSection={<IconRefresh size={14} />}
                loading={artifactsBusy}
                onClick={() => void loadArtifacts()}
              >
                {t('settings.uploads_refresh')}
              </Button>
            </Group>
          </Group>
          <Text size="sm" c="dimmed">
            {t('files.outputs_hint')}
          </Text>

          {artifactsLoaded && groups.length === 0 && (
            <Text size="sm" c="dimmed">
              {t('files.outputs_empty')}
            </Text>
          )}

          {groups.length > 0 && (
            // Newest name folder open by default; everything else collapsed.
            <Accordion multiple defaultValue={[groups[0].label]} variant="separated">
              {groups.map((group) => (
                <Accordion.Item key={group.label} value={group.label}>
                  <Accordion.Control>
                    <Group gap="xs" wrap="nowrap">
                      <Text fw={600} size="sm">
                        {group.label}
                      </Text>
                      <Badge size="sm" variant="light" color="gray">
                        {group.dates.reduce((sum, date) => sum + date.files.length, 0)}
                      </Badge>
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Accordion
                      multiple
                      defaultValue={group.dates.length > 0 ? [group.dates[0].date] : []}
                      chevronPosition="left"
                    >
                      {group.dates.map((dateGroup) => {
                        const ticked = dateGroup.files.filter((file) =>
                          selected.has(artifactKey(file)),
                        ).length;
                        const folderAll = ticked === dateGroup.files.length;
                        return (
                          <Accordion.Item
                            key={dateGroup.date}
                            value={dateGroup.date}
                            style={{ border: 'none' }}
                          >
                            <Group justify="space-between" wrap="nowrap" gap="xs">
                              <Checkbox
                                size="sm"
                                aria-label={`${t('files.select_folder')} ${group.label} ${dateGroup.date}`}
                                checked={folderAll}
                                indeterminate={ticked > 0 && !folderAll}
                                onChange={(event) =>
                                  setFilesSelected(dateGroup.files, event.currentTarget.checked)
                                }
                              />
                              <Accordion.Control style={{ flex: 1 }}>
                                <Text size="sm">{dateGroup.date}</Text>
                              </Accordion.Control>
                              <Button
                                size="compact-xs"
                                variant="subtle"
                                leftSection={<IconDownload size={13} />}
                                aria-label={`${t('files.download_all')} ${group.label} ${dateGroup.date}`}
                                disabled={downloading}
                                onClick={() => void downloadFiles(dateGroup.files)}
                              >
                                {t('files.download_all')}
                              </Button>
                              <Button
                                size="compact-xs"
                                variant="subtle"
                                color="red"
                                leftSection={<IconTrash size={13} />}
                                aria-label={`${t('files.delete_all')} ${group.label} ${dateGroup.date}`}
                                onClick={() =>
                                  setDeleteTarget({
                                    mode: 'folder',
                                    label: group.label,
                                    date: dateGroup.date,
                                    files: dateGroup.files,
                                  })
                                }
                              >
                                {t('files.delete_all')}
                              </Button>
                            </Group>
                            <Accordion.Panel>
                              <SimpleGrid cols={{ base: 2, sm: 3, md: 4, lg: 6 }} spacing="sm">
                                {dateGroup.files.map((file) => (
                                  <ArtifactCard
                                    key={artifactKey(file)}
                                    file={file}
                                    selected={selected.has(artifactKey(file))}
                                    onToggle={(checked) => toggleArtifact(file, checked)}
                                    onDelete={() => setDeleteTarget({ mode: 'one', file })}
                                  />
                                ))}
                              </SimpleGrid>
                            </Accordion.Panel>
                          </Accordion.Item>
                        );
                      })}
                    </Accordion>
                  </Accordion.Panel>
                </Accordion.Item>
              ))}
            </Accordion>
          )}

          {hasMoreArtifacts && (
            <Group justify="center">
              <Button
                variant="default"
                size="sm"
                loading={loadingMore}
                onClick={() => void loadMoreArtifacts()}
              >
                {t('files.load_more', { count: totalJobs - pagesLoaded * PAGE_SIZE })}
              </Button>
            </Group>
          )}
        </Stack>
      </Card>

      <Modal
        opened={uploadTarget !== null}
        onClose={() => setUploadTarget(null)}
        title={t('settings.uploads_delete')}
      >
        <Stack gap="md">
          <Text size="sm">{t('settings.uploads_confirm', { name: uploadTarget?.name ?? '' })}</Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setUploadTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button color="red" loading={deletingUpload} onClick={() => void confirmDeleteUpload()}>
              {t('settings.uploads_delete')}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={uploadBatchOpen}
        onClose={() => setUploadBatchOpen(false)}
        title={t('files.delete_selected', { count: uploadSelected.size })}
      >
        <Stack gap="md">
          <Text size="sm">{t('files.confirm_delete_selected', { count: uploadSelected.size })}</Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setUploadBatchOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              color="red"
              loading={deletingUpload}
              onClick={() => void confirmDeleteUploadBatch()}
            >
              {t('settings.uploads_delete')}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={
          deleteTarget?.mode === 'folder'
            ? t('files.delete_all')
            : deleteTarget?.mode === 'selected'
              ? t('files.delete_selected', { count: deleteTarget.files.length })
              : t('files.delete')
        }
      >
        <Stack gap="md">
          <Text size="sm">
            {deleteTarget?.mode === 'folder'
              ? t('files.confirm_delete_all', { count: deleteTarget.files.length })
              : deleteTarget?.mode === 'selected'
                ? t('files.confirm_delete_selected', { count: deleteTarget.files.length })
                : t('files.confirm_delete', { name: deleteTarget?.file.filename ?? '' })}
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setDeleteTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              color="red"
              loading={deletingArtifact}
              onClick={() => void confirmDeleteArtifact()}
            >
              {t('files.delete')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

/** Extension of a filename, lowercased and without the dot (`''` if none). */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

/** One 160px output tile: tick box, preview, filename, size, job chip,
 * download, delete. */
function ArtifactCard({
  file,
  selected,
  onToggle,
  onDelete,
}: {
  file: ArtifactFile;
  selected: boolean;
  onToggle: (checked: boolean) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const url = artifactUrl(file.job_id, file.filename);

  return (
    <Stack
      gap={4}
      w={160}
      p="xs"
      style={{
        background: theme.other.surfaces.raised,
        border: `1px solid ${selected ? theme.colors.blue[5] : theme.other.surfaces.border}`,
        borderRadius: theme.radius.md,
      }}
    >
      {file.kind === 'image' && (
        <Image src={url} alt={file.filename} h={IMAGE_HEIGHT} fit="cover" radius="sm" />
      )}
      {file.kind === 'video' && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          src={url}
          preload="metadata"
          controls
          muted
          style={{ height: IMAGE_HEIGHT, width: '100%', borderRadius: theme.radius.sm }}
        />
      )}
      {file.kind !== 'image' && file.kind !== 'video' && (
        <Stack gap={2} align="center" justify="center" h={IMAGE_HEIGHT}>
          <IconFile size={28} />
          <Text size="xs" c="dimmed" tt="uppercase">
            {extensionOf(file.filename) || '—'}
          </Text>
        </Stack>
      )}

      <Group gap={6} wrap="nowrap">
        <Checkbox
          size="xs"
          aria-label={`${t('files.select')} ${file.filename}`}
          checked={selected}
          onChange={(event) => onToggle(event.currentTarget.checked)}
        />
        <Tooltip label={file.filename}>
          <Text size="xs" ff="monospace" truncate="end" title={file.filename} style={{ minWidth: 0 }}>
            {file.filename}
          </Text>
        </Tooltip>
      </Group>
      <Group gap={6} justify="space-between" wrap="nowrap">
        <Text size="xs" c="dimmed">
          {formatBytes(file.size)}
        </Text>
        <Badge size="xs" variant="light" color="gray" tt="none" fw={500}>
          {file.job_id.slice(0, 8)}
        </Badge>
      </Group>
      <Group gap={4} justify="space-between" wrap="nowrap">
        <Anchor
          href={url}
          download={file.filename}
          size="xs"
          aria-label={`${t('files.download')} ${file.filename}`}
        >
          <Group gap={3} wrap="nowrap">
            <IconDownload size={12} />
            {t('files.download')}
          </Group>
        </Anchor>
        <Tooltip label={t('files.delete')}>
          <ActionIcon
            variant="subtle"
            color="red"
            size="sm"
            aria-label={`${t('files.delete')} ${file.filename}`}
            onClick={onDelete}
          >
            <IconTrash size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Stack>
  );
}
