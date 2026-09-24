import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Code,
  Group,
  Image,
  Loader,
  Modal,
  Progress,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  ThemeIcon,
  useMantineTheme,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconCheck,
  IconDownload,
  IconRefresh,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';

import { ApiError, api, artifactUrl, type Role, type Worker } from '../api';
import { SectionHeader } from '../components/Primitives';
import { JobStatusBadge } from '../components/StatusBadge';
import { formatAbsolute, formatGpuSeconds, shortId } from '../lib/format';
import { usePolling } from '../lib/usePolling';

const POLL_MS = 5000;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const TEXT_EXTENSIONS = new Set(['.txt', '.log', '.json']);
const CANCELLABLE_STATUSES = new Set(['queued', 'assigned', 'running']);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

/** Duration between two ISO timestamps as "3m 12s"; null while incomplete. */
function durationBetween(startIso: string | null, endIso: string | null): string | null {
  if (!startIso || !endIso) return null;
  const normalize = (iso: string) => (/[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`);
  const start = new Date(normalize(startIso)).getTime();
  const end = new Date(normalize(endIso)).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return formatGpuSeconds((end - start) / 1000);
}

interface JobDetailProps {
  /** Only an admin's `GET /api/jobs/{id}` reflects the actual submitter --
   * a plain user's own jobs are all theirs anyway, so the field is shown
   * admin-only to avoid a redundant "you" line. */
  role: Role;
}

export function JobDetail({ role }: JobDetailProps) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const { id } = useParams<{ id: string }>();
  const isAdmin = role === 'admin';

  const loadAll = useCallback(async () => {
    if (!id) throw new Error('missing job id');
    // Final review finding #3: `GET /api/workers` is admin-only on both
    // stacks -- a non-admin's call threw `ApiError(403)`, which rejected
    // this whole loader and left a plain user's own job detail permanently
    // showing `job_detail.load_error`. Mirrors Dashboard's Task-6 pattern.
    const [job, workers] = await Promise.all([
      api.getJob(id),
      isAdmin ? api.listWorkers() : Promise.resolve<Worker[]>([]),
    ]);
    return { job, workers };
  }, [id, isAdmin]);

  const { data, loading, error, refresh } = usePolling(loadAll, POLL_MS);
  const job = data?.job ?? null;
  const workers = data?.workers ?? [];
  const workerName = new Map(workers.map((w) => [w.id, w.name] as const));

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const notifyFailure = (title: string, caught: unknown) =>
    notifications.show({
      color: 'red',
      icon: <IconX size={16} />,
      title,
      message:
        caught instanceof ApiError
          ? t(`errors.${caught.code}`, { defaultValue: caught.message })
          : t('errors.network'),
    });

  const confirmCancel = async () => {
    if (!job) return;
    setCancelling(true);
    try {
      await api.cancelJob(job.id);
      notifications.show({
        color: 'teal',
        icon: <IconCheck size={16} />,
        title: t('jobs.cancel_success'),
        message: job.id,
      });
      setCancelOpen(false);
      await refresh();
    } catch (caught) {
      notifyFailure(t('jobs.cancel_failed'), caught);
    } finally {
      setCancelling(false);
    }
  };

  const retry = async () => {
    if (!job) return;
    setRetrying(true);
    try {
      await api.retryJob(job.id);
      notifications.show({
        color: 'teal',
        icon: <IconCheck size={16} />,
        title: t('jobs.retry_success'),
        message: job.id,
      });
      await refresh();
    } catch (caught) {
      notifyFailure(t('jobs.retry_failed'), caught);
    } finally {
      setRetrying(false);
    }
  };

  const cardStyle = {
    background: theme.other.surfaces.card,
    borderColor: theme.other.surfaces.border,
  };

  return (
    <Stack gap="lg">
      <Group gap="xs">
        <Button
          component={Link}
          to="/jobs"
          variant="subtle"
          color="gray"
          size="compact-sm"
          leftSection={<IconArrowLeft size={15} />}
        >
          {t('job_detail.back')}
        </Button>
      </Group>

      <SectionHeader
        title={t('job_detail.title', { id: job ? shortId(job.id) : shortId(id ?? '') })}
        /* 檔案頁 §2: the job's own name under the short id, when it has one. */
        description={job?.label ?? undefined}
        action={
          job ? (
            <Group gap="xs" wrap="wrap">
              <JobStatusBadge status={job.status} />
              <Badge variant="light" color="grape" tt="none" fw={500}>
                {t(`job_detail.origin_${job.origin}`, { defaultValue: job.origin })}
              </Badge>
              {job.status === 'failed' && (
                <Button
                  size="compact-sm"
                  variant="light"
                  color="federation"
                  loading={retrying}
                  leftSection={<IconRefresh size={13} />}
                  onClick={() => void retry()}
                >
                  {t('jobs.retry')}
                </Button>
              )}
              {CANCELLABLE_STATUSES.has(job.status) && (
                <Button
                  size="compact-sm"
                  variant="light"
                  color="red"
                  leftSection={<IconX size={13} />}
                  onClick={() => setCancelOpen(true)}
                >
                  {t('jobs.cancel')}
                </Button>
              )}
            </Group>
          ) : undefined
        }
      />

      {error && !job && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
          {t('job_detail.load_error')}
        </Alert>
      )}

      {loading ? (
        <Skeleton height={220} radius="md" />
      ) : !job ? (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
          {t('job_detail.not_found')}
        </Alert>
      ) : (
        <>
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
            <Card style={cardStyle}>
              <Stack gap="sm">
                <Text fw={600}>{t('job_detail.section_timeline')}</Text>
                <SimpleGrid cols={2} spacing="xs">
                  <Text size="xs" c="dimmed">
                    {t('job_detail.created')}
                  </Text>
                  <Text size="sm">{formatAbsolute(job.created_at)}</Text>

                  <Text size="xs" c="dimmed">
                    {t('job_detail.started')}
                  </Text>
                  <Text size="sm" c={job.started_at ? undefined : 'dimmed'}>
                    {job.started_at ? formatAbsolute(job.started_at) : t('job_detail.not_started')}
                  </Text>

                  <Text size="xs" c="dimmed">
                    {t('job_detail.finished')}
                  </Text>
                  <Text size="sm" c={job.finished_at ? undefined : 'dimmed'}>
                    {job.finished_at ? formatAbsolute(job.finished_at) : t('job_detail.not_finished')}
                  </Text>

                  <Text size="xs" c="dimmed">
                    {t('job_detail.duration')}
                  </Text>
                  <Text size="sm">
                    {durationBetween(job.started_at, job.finished_at) ?? '—'}
                  </Text>
                </SimpleGrid>

                {job.stage === 'fetching_models' && (
                  <Stack gap={4}>
                    <Text size="sm">
                      {t('job_detail.fetching_models', {
                        model: job.fetch_model ?? '',
                        pct: Math.round(Math.max(0, Math.min(100, job.fetch_pct ?? 0))),
                      })}
                    </Text>
                    <Progress
                      value={Math.round(Math.max(0, Math.min(100, job.fetch_pct ?? 0)))}
                      color="federation"
                      size="sm"
                      radius="xl"
                      animated
                    />
                  </Stack>
                )}
              </Stack>
            </Card>

            <Card style={cardStyle}>
              <Stack gap="sm">
                <Text fw={600}>{t('job_detail.section_worker')}</Text>
                <Text size="sm" c={job.worker_id ? undefined : 'dimmed'}>
                  {job.worker_id
                    ? (workerName.get(job.worker_id) ?? shortId(job.worker_id))
                    : t('job_detail.no_worker')}
                </Text>
                {isAdmin && (
                  <>
                    <Text size="xs" c="dimmed">
                      {t('job_detail.submitted_by')}
                    </Text>
                    <Text size="sm" c={job.username ? undefined : 'dimmed'}>
                      {job.username ?? '—'}
                    </Text>
                  </>
                )}
              </Stack>
            </Card>
          </SimpleGrid>

          {(job.retry_count > 0 || Object.keys(job.attempts).length > 0) && (
            <Card style={cardStyle}>
              <Stack gap="sm">
                <Text fw={600}>{t('job_detail.section_attempts')}</Text>
                <Text size="sm">{t('job_detail.requeued_count', { count: job.retry_count })}</Text>
                {Object.keys(job.attempts).length > 0 && (
                  <Table verticalSpacing="xs" horizontalSpacing="md">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('job_detail.attempts_worker')}</Table.Th>
                        <Table.Th>{t('job_detail.attempts_failures')}</Table.Th>
                        <Table.Th>{t('job_detail.attempts_last_error')}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {Object.entries(job.attempts).map(([workerId, failures]) => {
                        const attemptError = (job.attempt_errors ?? {})[workerId];
                        return (
                          <Table.Tr key={workerId}>
                            <Table.Td>
                              <Text size="sm">{workerName.get(workerId) ?? shortId(workerId)}</Text>
                            </Table.Td>
                            <Table.Td>
                              <Text size="sm">{failures}</Text>
                            </Table.Td>
                            <Table.Td>
                              <Text size="xs" c="dimmed" title={attemptError ?? undefined} lineClamp={2}>
                                {attemptError ? attemptError.slice(0, 120) : '—'}
                              </Text>
                            </Table.Td>
                          </Table.Tr>
                        );
                      })}
                    </Table.Tbody>
                  </Table>
                )}
                {job.status === 'queued' && job.retry_count > 0 && job.error && (
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed">
                      {t('job_detail.last_error')}
                    </Text>
                    <Box
                      style={{
                        maxHeight: 200,
                        overflow: 'auto',
                        borderRadius: theme.radius.md,
                        border: `1px solid ${theme.other.surfaces.border}`,
                      }}
                    >
                      <Code
                        block
                        style={{ background: theme.other.surfaces.raised, fontSize: 12, whiteSpace: 'pre-wrap' }}
                      >
                        {job.error}
                      </Code>
                    </Box>
                  </Stack>
                )}
              </Stack>
            </Card>
          )}

          {job.error && (
            <Card style={cardStyle}>
              <Stack gap="sm">
                <Group gap="xs">
                  <ThemeIcon variant="light" color="red" size={22} radius="md">
                    <IconAlertTriangle size={13} />
                  </ThemeIcon>
                  <Text fw={600}>{t('job_detail.section_error')}</Text>
                </Group>
                <Box
                  style={{
                    maxHeight: 320,
                    overflow: 'auto',
                    borderRadius: theme.radius.md,
                    border: `1px solid ${theme.other.surfaces.border}`,
                  }}
                >
                  <Code block style={{ background: theme.other.surfaces.raised, fontSize: 12, whiteSpace: 'pre-wrap' }}>
                    {job.error}
                  </Code>
                </Box>
              </Stack>
            </Card>
          )}

          {job.kind === 'model_fetch' && job.fetch_entry && (
            <Card style={cardStyle}>
              <Stack gap="sm">
                <Text fw={600}>{t('jobs.fetch_entry_title')}</Text>
                <SimpleGrid cols={2} spacing="xs">
                  <Text size="xs" c="dimmed">
                    {t('job_detail.fetch_name')}
                  </Text>
                  <Text size="sm" ff="monospace">
                    {job.fetch_entry.name}
                  </Text>

                  <Text size="xs" c="dimmed">
                    {t('job_detail.fetch_directory')}
                  </Text>
                  <Text size="sm" ff="monospace">
                    {job.fetch_entry.directory}
                  </Text>

                  <Text size="xs" c="dimmed">
                    {t('job_detail.fetch_url')}
                  </Text>
                  <Anchor href={job.fetch_entry.url} target="_blank" rel="noopener noreferrer" size="sm">
                    {job.fetch_entry.url}
                  </Anchor>

                  <Text size="xs" c="dimmed">
                    {t('job_detail.fetch_size')}
                  </Text>
                  <Text size="sm">{(job.fetch_entry.size_bytes / 1024 / 1024 / 1024).toFixed(2)} GB</Text>

                  {job.fetch_entry.sha256 && (
                    <>
                      <Text size="xs" c="dimmed">
                        {t('job_detail.fetch_sha256')}
                      </Text>
                      <Text size="sm" ff="monospace">
                        {job.fetch_entry.sha256}
                      </Text>
                    </>
                  )}
                </SimpleGrid>
                {job.fetch_entry.unverified && (
                  <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />}>
                    {t('jobs.fetch_unverified')}
                  </Alert>
                )}
              </Stack>
            </Card>
          )}

          <Card style={cardStyle}>
            <Stack gap="sm">
              <Text fw={600}>{t('job_detail.section_inputs')}</Text>
              {job.input_assets.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('job_detail.no_inputs')}
                </Text>
              ) : (
                <Stack gap={4}>
                  {job.input_assets.map((name) => (
                    <Text key={name} size="sm" ff="monospace">
                      {name}
                    </Text>
                  ))}
                </Stack>
              )}
            </Stack>
          </Card>

          <Card style={cardStyle}>
            <Stack gap="sm">
              <Text fw={600}>{t('job_detail.section_outputs')}</Text>
              {job.outputs ? (
                job.outputs.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    {t('job_detail.no_outputs')}
                  </Text>
                ) : (
                  <Stack gap="md">
                    {job.outputs.map((output) => (
                      <OutputArtifact
                        key={`${output.job_id}:${output.filename}`}
                        jobId={output.job_id}
                        filename={output.filename}
                      />
                    ))}
                  </Stack>
                )
              ) : job.result_files.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('job_detail.no_outputs')}
                </Text>
              ) : (
                <Stack gap="md">
                  {job.result_files.map((filename) => (
                    <OutputArtifact key={filename} jobId={job.id} filename={filename} />
                  ))}
                </Stack>
              )}
            </Stack>
          </Card>

          {job.children.length > 0 && (
            <Card style={cardStyle}>
              <Stack gap="sm">
                <Text fw={600}>{t('job_detail.section_children')}</Text>
                <Text size="xs" c="dimmed">
                  {t('job_detail.children_hint')}
                </Text>
                <Table.ScrollContainer minWidth={520}>
                  <Table verticalSpacing="xs" horizontalSpacing="md">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('job_detail.child_index')}</Table.Th>
                        <Table.Th>{t('job_detail.child_worker')}</Table.Th>
                        <Table.Th>{t('job_detail.child_status')}</Table.Th>
                        <Table.Th>{t('job_detail.child_progress')}</Table.Th>
                        <Table.Th>{t('job_detail.child_gpu_seconds')}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {job.children.map((child) => (
                        <Table.Tr key={child.id}>
                          <Table.Td>
                            <Text size="sm" ff="monospace">
                              {child.id}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {child.split_index + 1} / {job.children.length}
                            </Text>
                          </Table.Td>
                          <Table.Td>{child.worker_id ?? '—'}</Table.Td>
                          <Table.Td>
                            <JobStatusBadge status={child.status} />
                            {child.error && (
                              <Text size="xs" c="red">
                                {child.error}
                              </Text>
                            )}
                          </Table.Td>
                          <Table.Td>{Math.round(child.progress * 100)}%</Table.Td>
                          <Table.Td>
                            {child.gpu_seconds === null ? '—' : formatGpuSeconds(child.gpu_seconds)}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">
                    {t('job_detail.gpu_seconds_total')}
                  </Text>
                  <Text size="sm">{formatGpuSeconds(job.gpu_seconds_total)}</Text>
                </Group>
              </Stack>
            </Card>
          )}

          {job.status === 'queued' && typeof job.dispatch_info.held_for === 'string' && (
            <Card style={cardStyle}>
              <Stack gap="sm">
                <Text fw={600}>{t('job_detail.section_hold')}</Text>
                <Text size="sm">
                  {t('job_detail.hold_explanation', {
                    worker: job.dispatch_info.held_for_name || job.dispatch_info.held_for,
                    wait: formatGpuSeconds(job.dispatch_info.wait_seconds ?? 0),
                    run_now:
                      typeof job.dispatch_info.run_now_seconds === 'number'
                        ? formatGpuSeconds(job.dispatch_info.run_now_seconds)
                        : t('job_detail.hold_no_idle'),
                  })}
                </Text>
              </Stack>
            </Card>
          )}

          {typeof job.dispatch_info.basis === 'string' && (
            <Card style={cardStyle}>
              <Stack gap="sm">
                <Text fw={600}>{t('job_detail.section_dispatch')}</Text>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">
                    {t('job_detail.dispatch_predicted')}
                  </Text>
                  <Text size="sm">{formatGpuSeconds(job.dispatch_info.predicted_seconds ?? 0)}</Text>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">
                    {t('job_detail.dispatch_basis')}
                  </Text>
                  <Text size="sm">
                    {t(`job_detail.dispatch_basis_${job.dispatch_info.basis}`, {
                      defaultValue: job.dispatch_info.basis,
                    })}
                  </Text>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">
                    {t('job_detail.dispatch_load_seconds')}
                  </Text>
                  <Text size="sm">{formatGpuSeconds(job.dispatch_info.load_seconds ?? 0)}</Text>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">
                    {t('job_detail.dispatch_fetch_seconds')}
                  </Text>
                  <Text size="sm">{formatGpuSeconds(job.dispatch_info.fetch_seconds ?? 0)}</Text>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">
                    {t('job_detail.dispatch_candidates')}
                  </Text>
                  <Text size="sm">{job.dispatch_info.candidates ?? 0}</Text>
                </Group>
              </Stack>
            </Card>
          )}

          <Card style={cardStyle}>
            <Stack gap="sm">
              <Text fw={600}>{t('job_detail.section_receipt')}</Text>
              {!job.receipt ? (
                <Text size="sm" c="dimmed">
                  {t('job_detail.no_receipt')}
                </Text>
              ) : (
                <SimpleGrid cols={2} spacing="xs">
                  <Text size="xs" c="dimmed">
                    {t('job_detail.receipt_gpu_seconds')}
                  </Text>
                  <Text size="sm">{formatGpuSeconds(job.receipt.gpu_seconds)}</Text>

                  <Text size="xs" c="dimmed">
                    {t('job_detail.receipt_kind')}
                  </Text>
                  <Text size="sm">
                    {t(`job_detail.receipt_kind_${job.receipt.kind}`, { defaultValue: job.receipt.kind })}
                  </Text>

                  <Text size="xs" c="dimmed">
                    {t('job_detail.receipt_billable')}
                  </Text>
                  <Text size="sm">{job.receipt.billable ? t('job_detail.yes') : t('job_detail.no')}</Text>

                  <Text size="xs" c="dimmed">
                    {t('job_detail.receipt_basis')}
                  </Text>
                  <Text size="sm">
                    {t(`job_detail.receipt_basis_${job.receipt.basis}`, { defaultValue: job.receipt.basis })}
                  </Text>

                  <Text size="xs" c="dimmed">
                    {t('job_detail.receipt_acked')}
                  </Text>
                  <Text size="sm">{job.receipt.acked ? t('job_detail.yes') : t('job_detail.no')}</Text>
                </SimpleGrid>
              )}
            </Stack>
          </Card>
        </>
      )}

      <Modal
        opened={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title={t('jobs.cancel_confirm_title')}
      >
        <Stack gap="md">
          <Text size="sm">
            {t('jobs.cancel_confirm_body', { id: job ? shortId(job.id) : '' })}
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setCancelOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button color="red" onClick={() => void confirmCancel()} loading={cancelling}>
              {t('jobs.cancel_confirm_action')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

/** One output artifact: an image renders inline, a .txt/.log/.json shows its
 * content in a copyable block, anything else is a plain download link. */
function OutputArtifact({ jobId, filename }: { jobId: string; filename: string }) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const ext = extensionOf(filename);
  const url = artifactUrl(jobId, filename);

  const [text, setText] = useState<string | null>(null);
  const [textFailed, setTextFailed] = useState(false);

  useEffect(() => {
    if (!TEXT_EXTENSIONS.has(ext)) return;
    let cancelled = false;
    setText(null);
    setTextFailed(false);
    fetch(url, { credentials: 'include' })
      .then((response) => {
        if (!response.ok) throw new Error('failed');
        return response.text();
      })
      .then((content) => {
        if (!cancelled) setText(content);
      })
      .catch(() => {
        if (!cancelled) setTextFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ext]);

  if (IMAGE_EXTENSIONS.has(ext)) {
    return (
      <Stack gap={4}>
        <Group justify="space-between" gap="xs">
          <Text size="sm" ff="monospace">
            {filename}
          </Text>
          <Anchor href={url} download={filename} size="xs">
            <Group gap={3} wrap="nowrap">
              <IconDownload size={12} />
              {t('job_detail.output_download')}
            </Group>
          </Anchor>
        </Group>
        <Image src={url} radius="md" mah={360} w="auto" fit="contain" alt={filename} />
      </Stack>
    );
  }

  if (TEXT_EXTENSIONS.has(ext)) {
    return (
      <Stack gap={4}>
        <Group justify="space-between" gap="xs">
          <Text size="sm" ff="monospace">
            {filename}
          </Text>
          <Anchor href={url} download={filename} size="xs">
            <Group gap={3} wrap="nowrap">
              <IconDownload size={12} />
              {t('job_detail.output_download')}
            </Group>
          </Anchor>
        </Group>
        {textFailed ? (
          <Text size="xs" c="red">
            {t('job_detail.output_load_failed')}
          </Text>
        ) : text === null ? (
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="xs" c="dimmed">
              {t('job_detail.output_loading')}
            </Text>
          </Group>
        ) : (
          <Box
            style={{
              maxHeight: 260,
              overflow: 'auto',
              borderRadius: theme.radius.md,
              border: `1px solid ${theme.other.surfaces.border}`,
            }}
          >
            <Code block style={{ background: theme.other.surfaces.raised, fontSize: 12, whiteSpace: 'pre-wrap' }}>
              {text}
            </Code>
          </Box>
        )}
      </Stack>
    );
  }

  return (
    <Group gap="xs">
      <Anchor href={url} download={filename} size="sm">
        <Group gap={4} wrap="nowrap">
          <IconDownload size={13} />
          {filename}
        </Group>
      </Anchor>
    </Group>
  );
}
