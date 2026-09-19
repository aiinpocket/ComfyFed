import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Collapse,
  Group,
  Loader,
  Modal,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCircleCheck,
  IconCircleX,
  IconClipboardText,
  IconDownload,
  IconExternalLink,
  IconInbox,
  IconInfoCircle,
  IconRefresh,
  IconSitemap,
  IconX,
} from '@tabler/icons-react';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import {
  ApiError,
  api,
  artifactUrl,
  type Assessment,
  type Job,
  type Role,
  type Worker,
} from '../api';
import { EmptyState, Mono, SectionHeader, TableSkeleton } from '../components/Primitives';
import { JobStatusBadge } from '../components/StatusBadge';
import { formatAbsolute, formatGb, formatRelative, shortId } from '../lib/format';
import { translateReason, parseReason } from '../lib/reasons';
import { usePolling } from '../lib/usePolling';
import { ProgressCell } from './Dashboard';

const POLL_MS = 5000;

interface JobsProps {
  /** Only an admin's `GET /api/jobs` includes other users' rows, so the
   * 使用者 column is admin-only -- a plain user's jobs are all their own
   * already, and the server always echoes their own username there anyway. */
  role: Role;
}

export function Jobs({ role }: JobsProps) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const isAdmin = role === 'admin';

  const loadAll = useCallback(async () => {
    // Final review finding #3: `GET /api/workers` is admin-only on both
    // stacks -- a non-admin's call throws `ApiError(403)`, which used to
    // reject this whole loader and leave a plain user with a permanent
    // `jobs.load_error` and never their own jobs. Mirrors Dashboard's
    // Task-6 pattern: skip the call entirely for a non-admin session.
    const [jobs, workers] = await Promise.all([
      api.listJobs(),
      isAdmin ? api.listWorkers() : Promise.resolve<Worker[]>([]),
    ]);
    return { jobs, workers };
  }, [isAdmin]);
  const { data, loading, error, refresh } = usePolling(loadAll, POLL_MS);

  const jobs = data?.jobs ?? [];
  const workers = data?.workers ?? [];

  return (
    <Stack gap="lg">
      <SectionHeader title={t('jobs.title')} description={t('jobs.subtitle')} />

      <Alert
        data-testid="jobs-submit-hint"
        variant="light"
        color="federation"
        icon={<IconInfoCircle size={16} />}
      >
        {t('jobs.readonly_hint')}
      </Alert>

      <EditorPanel />

      <Stack gap="sm">
        <Text fw={600} fz="md">
          {t('jobs.list_heading')}
        </Text>

        {error && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
            {t('jobs.load_error')}
          </Alert>
        )}

        <Card
          padding={0}
          style={{
            background: theme.other.surfaces.card,
            borderColor: theme.other.surfaces.border,
            overflow: 'hidden',
          }}
        >
          {loading ? (
            <TableSkeleton rows={4} cols={isAdmin ? 7 : 6} />
          ) : jobs.length === 0 ? (
            <EmptyState
              icon={<IconInbox size={26} />}
              title={t('jobs.empty')}
              description={t('jobs.empty_hint')}
            />
          ) : (
            <JobsTable jobs={jobs} workers={workers} onChanged={refresh} showUser={isAdmin} />
          )}
        </Card>
      </Stack>
    </Stack>
  );
}

/* ------------------------------------------------------------ editor panel */

/** Primary call to action: the embedded ComfyUI workflow editor at `/comfy`.
 *
 * A plain link rather than a router navigation — `/comfy` is served by the
 * platform itself (the official ComfyUI frontend bundle), not by this SPA, so
 * it opens in its own tab and keeps the console where it is.
 */
function EditorPanel() {
  const { t } = useTranslation();
  const theme = useMantineTheme();

  return (
    <Card
      style={{ background: theme.other.surfaces.card, borderColor: theme.other.surfaces.border }}
    >
      <Group justify="space-between" align="center" wrap="wrap" gap="md">
        <Group gap="sm" align="flex-start" wrap="nowrap">
          <ThemeIcon variant="light" color="federation" size={38} radius="md">
            <IconSitemap size={20} />
          </ThemeIcon>
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Text fw={600}>{t('jobs.editor_heading')}</Text>
            <Text size="sm" c="dimmed">
              {t('jobs.editor_hint')}
            </Text>
            <Text size="xs" c="dimmed">
              {t('jobs.editor_workers_note')}
            </Text>
          </Stack>
        </Group>
        <Button
          component="a"
          href="/comfy"
          target="_blank"
          rel="noopener noreferrer"
          size="md"
          leftSection={<IconSitemap size={17} />}
          rightSection={<IconExternalLink size={15} />}
        >
          {t('jobs.open_editor')}
        </Button>
      </Group>
    </Card>
  );
}

/* -------------------------------------------------------------- jobs table */

/** Statuses a row's cancel action applies to -- anything already terminal
 * (done/failed/cancelled) has nothing left to cancel. */
const CANCELLABLE_STATUSES = new Set(['queued', 'assigned', 'running']);

/** Requeue a failed job. Sits in the results cell of a failed row. */
function RetryButton({ jobId, onRetried }: { jobId: string; onRetried: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const retry = async (event: React.MouseEvent) => {
    event.stopPropagation();
    setBusy(true);
    try {
      await api.retryJob(jobId);
      notifications.show({
        color: 'teal',
        icon: <IconCheck size={16} />,
        title: t('jobs.retry_success'),
        message: jobId,
      });
      onRetried();
    } catch (caught) {
      notifications.show({
        color: 'red',
        icon: <IconX size={16} />,
        title: t('jobs.retry_failed'),
        message:
          caught instanceof ApiError
            ? t(`errors.${caught.code}`, { defaultValue: caught.message })
            : t('errors.network'),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      size="compact-xs"
      variant="light"
      color="federation"
      loading={busy}
      leftSection={<IconRefresh size={13} />}
      onClick={retry}
    >
      {t('jobs.retry')}
    </Button>
  );
}

/** Row action for a queued/assigned/running job: opens the confirm dialog. */
function CancelButton({ onClick }: { onClick: (event: React.MouseEvent) => void }) {
  const { t } = useTranslation();

  return (
    <Button
      size="compact-xs"
      variant="light"
      color="red"
      leftSection={<IconX size={13} />}
      onClick={onClick}
    >
      {t('jobs.cancel')}
    </Button>
  );
}

function JobsTable({
  jobs,
  workers,
  onChanged,
  showUser,
}: {
  jobs: Job[];
  workers: Worker[];
  onChanged: () => void;
  showUser: boolean;
}) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Job | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const workerName = new Map(workers.map((w) => [w.id, w.name] as const));
  const ordered = [...jobs].reverse();

  const confirmCancel = async () => {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      await api.cancelJob(cancelTarget.id);
      notifications.show({
        color: 'teal',
        icon: <IconCheck size={16} />,
        title: t('jobs.cancel_success'),
        message: cancelTarget.id,
      });
      setCancelTarget(null);
      onChanged();
    } catch (caught) {
      notifications.show({
        color: 'red',
        icon: <IconX size={16} />,
        title: t('jobs.cancel_failed'),
        message:
          caught instanceof ApiError
            ? t(`errors.${caught.code}`, { defaultValue: caught.message })
            : t('errors.network'),
      });
    } finally {
      setCancelling(false);
    }
  };

  return (
    <>
    <Table.ScrollContainer minWidth={860}>
      <Table verticalSpacing="sm" horizontalSpacing="md">
        <Table.Thead style={{ background: theme.other.surfaces.raised }}>
          <Table.Tr>
            <Table.Th w={34} />
            <Table.Th>{t('jobs.col_id')}</Table.Th>
            {showUser && <Table.Th>{t('jobs.col_username')}</Table.Th>}
            <Table.Th>{t('jobs.col_status')}</Table.Th>
            <Table.Th>{t('jobs.col_progress')}</Table.Th>
            <Table.Th>{t('jobs.col_worker')}</Table.Th>
            <Table.Th>{t('jobs.col_created')}</Table.Th>
            <Table.Th>{t('jobs.col_results')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {ordered.map((job) => {
            const expandable = job.status === 'queued';
            const isOpen = expanded === job.id;
            return (
              <Fragment key={job.id}>
                <Table.Tr
                  style={{ cursor: expandable ? 'pointer' : 'default' }}
                  onClick={() => expandable && setExpanded(isOpen ? null : job.id)}
                >
                  <Table.Td>
                    {expandable && (
                      <ActionIcon variant="subtle" color="gray" size="sm" aria-label={t('jobs.assessment')}>
                        {isOpen ? <IconChevronDown size={15} /> : <IconChevronRight size={15} />}
                      </ActionIcon>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Anchor
                      component={Link}
                      to={`/jobs/${job.id}`}
                      size="sm"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Mono title={job.id} c="">
                        {shortId(job.id)}
                      </Mono>
                    </Anchor>
                  </Table.Td>
                  {showUser && (
                    <Table.Td>
                      <Text size="sm" c={job.username ? undefined : 'dimmed'}>
                        {job.username ?? '—'}
                      </Text>
                    </Table.Td>
                  )}
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <JobStatusBadge status={job.status} />
                      {job.kind === 'model_fetch' && (
                        <Badge size="sm" variant="light" color="blue" tt="none" fw={500}>
                          {t('jobs.kind_model_fetch')}
                        </Badge>
                      )}
                      {job.split_count > 0 && (
                        <Tooltip label={t('jobs.split_badge_tooltip', { count: job.split_count })}>
                          <Badge size="sm" variant="light" color="grape">
                            {t('jobs.split_badge', { count: job.split_count })}
                          </Badge>
                        </Tooltip>
                      )}
                      {job.error && (
                        <Tooltip label={job.error} multiline maw={320}>
                          <ThemeIcon variant="subtle" color="red" size="sm">
                            <IconAlertTriangle size={14} />
                          </ThemeIcon>
                        </Tooltip>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td style={{ minWidth: 150 }}>
                    <ProgressCell
                      value={job.progress}
                      status={job.status}
                      fetchPct={job.stage === 'fetching_models' ? job.fetch_pct : undefined}
                      fetchModel={job.stage === 'fetching_models' ? job.fetch_model : undefined}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c={job.worker_id ? undefined : 'dimmed'}>
                      {job.worker_id ? (workerName.get(job.worker_id) ?? shortId(job.worker_id)) : '—'}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={formatAbsolute(job.created_at)}>
                      <Text size="sm" c="dimmed">
                        {formatRelative(job.created_at, t)}
                      </Text>
                    </Tooltip>
                  </Table.Td>
                  <Table.Td>
                    {job.status === 'failed' ? (
                      <RetryButton jobId={job.id} onRetried={onChanged} />
                    ) : CANCELLABLE_STATUSES.has(job.status) ? (
                      <CancelButton
                        onClick={(event) => {
                          event.stopPropagation();
                          setCancelTarget(job);
                        }}
                      />
                    ) : job.result_files.length === 0 ? (
                      <Text size="sm" c="dimmed">
                        —
                      </Text>
                    ) : (
                      <Group gap={6} wrap="wrap">
                        {job.result_files.map((filename) => (
                          <Anchor
                            key={filename}
                            href={artifactUrl(job.id, filename)}
                            download={filename}
                            size="xs"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <Group gap={3} wrap="nowrap">
                              <IconDownload size={12} />
                              {filename}
                            </Group>
                          </Anchor>
                        ))}
                      </Group>
                    )}
                  </Table.Td>
                </Table.Tr>
                {expandable && (
                  <Table.Tr>
                    <Table.Td
                      colSpan={showUser ? 8 : 7}
                      p={0}
                      style={{ borderBottom: isOpen ? undefined : 'none' }}
                    >
                      <Collapse in={isOpen}>
                        {isOpen && (
                          <AssessmentPanel
                            jobId={job.id}
                            estVram={job.est_vram_gb}
                            isModelFetch={job.kind === 'model_fetch'}
                          />
                        )}
                      </Collapse>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Fragment>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>

    <Modal
      opened={cancelTarget !== null}
      onClose={() => setCancelTarget(null)}
      title={t('jobs.cancel_confirm_title')}
    >
      <Stack gap="md">
        <Text size="sm">
          {t('jobs.cancel_confirm_body', { id: cancelTarget ? shortId(cancelTarget.id) : '' })}
        </Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={() => setCancelTarget(null)}>
            {t('common.cancel')}
          </Button>
          <Button color="red" onClick={confirmCancel} loading={cancelling}>
            {t('jobs.cancel_confirm_action')}
          </Button>
        </Group>
      </Stack>
    </Modal>
    </>
  );
}

/* --------------------------------------------------------- assessment view */

const VERDICT_META: Record<string, { color: string; icon: typeof IconCircleCheck }> = {
  eligible: { color: 'teal', icon: IconCircleCheck },
  eligible_after_fetch: { color: 'yellow', icon: IconDownload },
  ineligible: { color: 'red', icon: IconCircleX },
};

function AssessmentPanel({
  jobId,
  estVram,
  isModelFetch,
}: {
  jobId: string;
  estVram: number | null;
  /** Spec §11: a `kind=model_fetch` job does NOT show the VRAM column at
   * all -- it runs no inference, so "estimated VRAM" is not a fact about it,
   * not even as a "—". A `prompt` job is unchanged: the badge is hidden when
   * the estimate is null (see `assess.estimate_vram`) and shown when it is
   * not, exactly as before model_fetch existed. */
  isModelFetch: boolean;
}) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAssessment(null);
    setFailed(false);
    api
      .getAssessment(jobId)
      .then((result) => {
        if (!cancelled) setAssessment(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  return (
    <Box p="md" style={{ background: theme.other.surfaces.base }}>
      <Group justify="space-between" mb="sm" wrap="wrap" gap="xs">
        <Text size="sm" fw={600}>
          {t('jobs.assessment')}
        </Text>
        {estVram !== null && !isModelFetch && (
          <Badge variant="default" tt="none" fw={400} size="sm">
            {t('jobs.est_vram', { value: formatGb(estVram) })}
          </Badge>
        )}
      </Group>

      {failed ? (
        <Alert color="red" variant="light" p="sm">
          {t('jobs.assessment_error')}
        </Alert>
      ) : !assessment ? (
        <Group gap="xs" py="xs">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            {t('jobs.assessment_loading')}
          </Text>
        </Group>
      ) : assessment.workers.length === 0 ? (
        <EmptyState
          compact
          icon={<IconClipboardText size={20} />}
          title={t('jobs.assessment_no_workers')}
          description={t('jobs.assessment_no_workers_hint')}
        />
      ) : (
        <Stack gap="xs">
          {assessment.workers.map((entry) => {
            const meta = VERDICT_META[entry.verdict] ?? VERDICT_META.ineligible;
            const Icon = meta.icon;
            return (
              <Group
                key={entry.worker_id}
                align="flex-start"
                wrap="nowrap"
                gap="sm"
                p="sm"
                style={{
                  background: theme.other.surfaces.card,
                  border: `1px solid ${theme.other.surfaces.border}`,
                  borderRadius: theme.radius.md,
                }}
              >
                <ThemeIcon variant="light" color={meta.color} size={26} radius="md" mt={2}>
                  <Icon size={15} />
                </ThemeIcon>
                <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                  <Group gap="xs" wrap="wrap">
                    <Text size="sm" fw={600}>
                      {entry.name}
                    </Text>
                    <Badge size="sm" color={meta.color} variant="light" tt="none" fw={500}>
                      {t(`verdict.${entry.verdict}`, { defaultValue: entry.verdict })}
                    </Badge>
                  </Group>
                  {entry.reasons.length === 0 && (entry.warnings?.length ?? 0) === 0 ? (
                    <Text size="xs" c="dimmed">
                      {t('verdict.eligible_detail')}
                    </Text>
                  ) : (
                    <Stack gap={2}>
                      {entry.reasons.map((reason) => (
                        <Text
                          key={reason}
                          size="xs"
                          c={parseReason(reason).tone === 'warning' ? 'yellow.4' : 'red.4'}
                        >
                          {translateReason(reason, t)}
                        </Text>
                      ))}
                      {/* Warnings describe how an ELIGIBLE job will run, so
                          they are always the dim/yellow note, never red. */}
                      {(entry.warnings ?? []).map((warning) => (
                        <Text key={warning} size="xs" c="yellow.4">
                          {translateReason(warning, t)}
                        </Text>
                      ))}
                    </Stack>
                  )}
                </Stack>
              </Group>
            );
          })}
        </Stack>
      )}
    </Box>
  );
}
