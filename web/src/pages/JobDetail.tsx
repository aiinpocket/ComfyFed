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

import { ApiError, api, artifactUrl, type Role } from '../api';
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
    const [job, workers] = await Promise.all([api.getJob(id), api.listWorkers()]);
    return { job, workers };
  }, [id]);

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
              {job.result_files.length === 0 ? (
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
