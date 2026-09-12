import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Collapse,
  Divider,
  FileInput,
  Group,
  Loader,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
  useMantineTheme,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAdjustments,
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCircleCheck,
  IconCircleX,
  IconClipboardText,
  IconCode,
  IconDownload,
  IconExternalLink,
  IconFileUpload,
  IconInbox,
  IconRefresh,
  IconSend,
  IconSitemap,
  IconX,
} from '@tabler/icons-react';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  ApiError,
  api,
  artifactUrl,
  type Assessment,
  type Backend,
  type Job,
  type RequirementsOverride,
  type Worker,
} from '../api';
import { EmptyState, Mono, SectionHeader, TableSkeleton } from '../components/Primitives';
import { JobStatusBadge } from '../components/StatusBadge';
import { formatAbsolute, formatGb, formatRelative, shortId } from '../lib/format';
import { translateReason, parseReason } from '../lib/reasons';
import { usePolling } from '../lib/usePolling';
import { parseWorkflow, WorkflowParseError, type WorkflowSummary } from '../lib/workflow';
import { ProgressCell } from './Dashboard';

const POLL_MS = 5000;

export function Jobs() {
  const { t } = useTranslation();
  const theme = useMantineTheme();

  const loadAll = useCallback(
    async () => ({ jobs: await api.listJobs(), workers: await api.listWorkers() }),
    [],
  );
  const { data, loading, error, refresh } = usePolling(loadAll, POLL_MS);

  const jobs = data?.jobs ?? [];
  const workers = data?.workers ?? [];

  return (
    <Stack gap="lg">
      <SectionHeader title={t('jobs.title')} description={t('jobs.subtitle')} />

      <EditorPanel />

      <SubmitPanel onSubmitted={refresh} />

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
            <TableSkeleton rows={4} cols={6} />
          ) : jobs.length === 0 ? (
            <EmptyState
              icon={<IconInbox size={26} />}
              title={t('jobs.empty')}
              description={t('jobs.empty_hint')}
            />
          ) : (
            <JobsTable jobs={jobs} workers={workers} onChanged={refresh} />
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

/* ------------------------------------------------------------ submit panel */

/** Secondary path: paste an already-exported API-format workflow.
 *
 * Collapsed by default since Phase 1.5 — the editor above is the primary way
 * in, and this whole panel is the escape hatch for a workflow that already
 * exists as JSON.
 */
function SubmitPanel({ onSubmitted }: { onSubmitted: () => void }) {
  const { t } = useTranslation();
  const theme = useMantineTheme();

  const [text, setText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [summary, setSummary] = useState<WorkflowSummary | null>(null);
  const [assetFiles, setAssetFiles] = useState<Record<string, File | null>>({});
  const [pasteOpen, setPasteOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [minVram, setMinVram] = useState<number | ''>('');
  const [minDisk, setMinDisk] = useState<number | ''>('');
  const [gpuContains, setGpuContains] = useState('');
  const [backend, setBackend] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Re-parse whenever the pasted JSON changes; asset slots follow the parse.
  useEffect(() => {
    if (!text.trim()) {
      setSummary(null);
      setParseError(null);
      setAssetFiles({});
      return;
    }
    try {
      const parsed = parseWorkflow(text);
      setSummary(parsed);
      setParseError(null);
      setAssetFiles((previous) => {
        const next: Record<string, File | null> = {};
        for (const name of parsed.assets) next[name] = previous[name] ?? null;
        return next;
      });
    } catch (caught) {
      setSummary(null);
      setAssetFiles({});
      setParseError(caught instanceof WorkflowParseError ? caught.message : 'invalid_json');
    }
  }, [text]);

  const missingAssets = useMemo(
    () => (summary?.assets ?? []).filter((name) => !assetFiles[name]),
    [summary, assetFiles],
  );

  const canSubmit = Boolean(summary) && missingAssets.length === 0 && !submitting;

  const readFile = async (file: File) => {
    const content = await file.text();
    setText(content);
  };

  const submit = async () => {
    if (!summary || !canSubmit) return;
    setSubmitting(true);

    const overrides: RequirementsOverride = {};
    if (minVram !== '') overrides.min_vram_gb = Number(minVram);
    if (minDisk !== '') overrides.min_free_disk_gb = Number(minDisk);
    if (gpuContains.trim()) overrides.gpu_name_contains = gpuContains.trim();
    if (backend) overrides.backend = backend as Backend;

    const files = summary.assets
      .map((name) => assetFiles[name])
      .filter((file): file is File => file instanceof File);

    try {
      const result = await api.submitJob(text, overrides, files);
      notifications.show({
        color: 'teal',
        icon: <IconCheck size={16} />,
        title: t('jobs.submit_success'),
        message: result.job_id,
      });
      setText('');
      setMinVram('');
      setMinDisk('');
      setGpuContains('');
      setBackend(null);
      setAdvancedOpen(false);
      onSubmitted();
    } catch (caught) {
      notifications.show({
        color: 'red',
        icon: <IconX size={16} />,
        title: t('jobs.submit_failed'),
        message:
          caught instanceof ApiError
            ? t(`errors.${caught.code}`, { defaultValue: caught.message })
            : t('errors.network'),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card
      style={{ background: theme.other.surfaces.card, borderColor: theme.other.surfaces.border }}
    >
      <Stack gap="md">
        <UnstyledButton onClick={() => setPasteOpen((open) => !open)}>
          <Group gap={8} wrap="nowrap">
            {pasteOpen ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
            <IconCode size={16} />
            <Text fw={600} size="sm">
              {t('jobs.paste_section')}
            </Text>
            <Text size="xs" c="dimmed">
              {t('jobs.paste_section_hint')}
            </Text>
          </Group>
        </UnstyledButton>

        <Collapse in={pasteOpen}>
          <Stack gap="md">
            <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
              <Stack gap={2}>
                <Text fw={600}>{t('jobs.submit_heading')}</Text>
                <Text size="sm" c="dimmed">
                  {t('jobs.submit_hint')}
                </Text>
              </Stack>
              <FileInput
                placeholder={t('jobs.upload_json')}
                leftSection={<IconFileUpload size={16} />}
                accept="application/json,.json"
                clearable
                w={230}
                value={null}
                onChange={(file) => {
                  if (file) void readFile(file);
                }}
              />
            </Group>

            <Textarea
              placeholder={t('jobs.paste_placeholder')}
              value={text}
              onChange={(event) => setText(event.currentTarget.value)}
              autosize
              minRows={5}
              maxRows={12}
              styles={{
                input: {
                  fontFamily: theme.fontFamilyMonospace,
                  fontSize: 12,
                  background: theme.other.surfaces.raised,
                },
              }}
            />

            {parseError && (
              <Alert color="red" variant="light" p="sm" icon={<IconAlertTriangle size={16} />}>
                <Text size="sm">{t(`jobs.parse_${parseError}`, { defaultValue: t('jobs.parse_invalid_json') })}</Text>
              </Alert>
            )}

            {summary && (
              <Stack gap="sm">
                <Group gap="xs" wrap="wrap">
                  <Badge variant="light" color="federation" tt="none" fw={500}>
                    {t('jobs.chip_nodes', { count: summary.nodeCount })}
                  </Badge>
                  <Badge variant="light" color="grape" tt="none" fw={500}>
                    {t('jobs.chip_classes', { count: summary.nodeClasses.length })}
                  </Badge>
                  <Badge variant="light" color="teal" tt="none" fw={500}>
                    {t('jobs.chip_models', { count: summary.models.length })}
                  </Badge>
                  <Badge variant="light" color="blue" tt="none" fw={500}>
                    {t('jobs.chip_assets', { count: summary.assets.length })}
                  </Badge>
                </Group>

                {summary.models.length > 0 && (
                  <Box
                    p="sm"
                    style={{
                      background: theme.other.surfaces.raised,
                      borderRadius: theme.radius.md,
                      border: `1px solid ${theme.other.surfaces.border}`,
                    }}
                  >
                    <Text size="xs" c="dimmed" fw={600} tt="uppercase" mb={6} style={{ letterSpacing: '0.06em' }}>
                      {t('jobs.detected_models')}
                    </Text>
                    <Group gap={6} wrap="wrap">
                      {summary.models.map((model) => (
                        <Mono key={model} size="xs" c="">
                          {model}
                        </Mono>
                      ))}
                    </Group>
                  </Box>
                )}

                {summary.assets.length > 0 && (
                  <Stack gap="xs">
                    <Group gap="xs">
                      <Text size="sm" fw={600}>
                        {t('jobs.assets_heading')}
                      </Text>
                      {missingAssets.length > 0 && (
                        <Badge color="yellow" variant="light" size="sm" tt="none" fw={500}>
                          {t('jobs.assets_missing_count', { count: missingAssets.length })}
                        </Badge>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed">
                      {t('jobs.assets_hint')}
                    </Text>
                    <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
                      {summary.assets.map((name) => (
                        <FileInput
                          key={name}
                          label={<Mono size="xs">{name}</Mono>}
                          placeholder={t('jobs.asset_choose')}
                          value={assetFiles[name] ?? null}
                          error={!assetFiles[name] ? t('jobs.asset_required') : undefined}
                          clearable
                          leftSection={<IconFileUpload size={15} />}
                          onChange={(file) => setAssetFiles((prev) => ({ ...prev, [name]: file }))}
                        />
                      ))}
                    </SimpleGrid>
                  </Stack>
                )}
              </Stack>
            )}

            <Divider variant="dashed" />

            <Box>
              <UnstyledButton onClick={() => setAdvancedOpen((open) => !open)}>
                <Group gap={6}>
                  {advancedOpen ? <IconChevronDown size={15} /> : <IconChevronRight size={15} />}
                  <IconAdjustments size={15} />
                  <Text size="sm" fw={500}>
                    {t('jobs.advanced')}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {t('jobs.advanced_hint')}
                  </Text>
                </Group>
              </UnstyledButton>
              <Collapse in={advancedOpen}>
                <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm" mt="sm">
                  <NumberInput
                    label={t('jobs.min_vram')}
                    placeholder={t('jobs.auto')}
                    value={minVram}
                    onChange={(value) => setMinVram(value === '' ? '' : Number(value))}
                    min={0}
                    step={1}
                    suffix=" GB"
                  />
                  <NumberInput
                    label={t('jobs.min_disk')}
                    placeholder={t('jobs.auto')}
                    value={minDisk}
                    onChange={(value) => setMinDisk(value === '' ? '' : Number(value))}
                    min={0}
                    step={1}
                    suffix=" GB"
                  />
                  <TextInput
                    label={t('jobs.gpu_contains')}
                    placeholder="RTX 5080"
                    value={gpuContains}
                    onChange={(event) => setGpuContains(event.currentTarget.value)}
                  />
                  <Select
                    label={t('jobs.backend')}
                    placeholder={t('jobs.auto')}
                    description={t('jobs.backend_hint')}
                    value={backend}
                    onChange={setBackend}
                    clearable
                    data={[
                      { value: 'cuda', label: 'CUDA (NVIDIA)' },
                      { value: 'rocm', label: 'ROCm (AMD)' },
                      { value: 'mps', label: 'MPS (Apple)' },
                      { value: 'cpu', label: 'CPU' },
                    ]}
                  />
                </SimpleGrid>
              </Collapse>
            </Box>

            <Group justify="flex-end" gap="sm">
              {missingAssets.length > 0 && (
                <Text size="xs" c="yellow">
                  {t('jobs.blocked_by_assets')}
                </Text>
              )}
              <Button
                leftSection={<IconSend size={16} />}
                onClick={submit}
                disabled={!canSubmit}
                loading={submitting}
              >
                {t('jobs.submit')}
              </Button>
            </Group>
          </Stack>
        </Collapse>
      </Stack>
    </Card>
  );
}

/* -------------------------------------------------------------- jobs table */

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

function JobsTable({
  jobs,
  workers,
  onChanged,
}: {
  jobs: Job[];
  workers: Worker[];
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const [expanded, setExpanded] = useState<string | null>(null);

  const workerName = new Map(workers.map((w) => [w.id, w.name] as const));
  const ordered = [...jobs].reverse();

  return (
    <Table.ScrollContainer minWidth={860}>
      <Table verticalSpacing="sm" horizontalSpacing="md">
        <Table.Thead style={{ background: theme.other.surfaces.raised }}>
          <Table.Tr>
            <Table.Th w={34} />
            <Table.Th>{t('jobs.col_id')}</Table.Th>
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
                    <Mono title={job.id} c="">
                      {shortId(job.id)}
                    </Mono>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <JobStatusBadge status={job.status} />
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
                    <ProgressCell value={job.progress} status={job.status} />
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
                    <Table.Td colSpan={7} p={0} style={{ borderBottom: isOpen ? undefined : 'none' }}>
                      <Collapse in={isOpen}>
                        {isOpen && <AssessmentPanel jobId={job.id} estVram={job.est_vram_gb} />}
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
  );
}

/* --------------------------------------------------------- assessment view */

const VERDICT_META: Record<string, { color: string; icon: typeof IconCircleCheck }> = {
  eligible: { color: 'teal', icon: IconCircleCheck },
  eligible_after_fetch: { color: 'yellow', icon: IconDownload },
  ineligible: { color: 'red', icon: IconCircleX },
};

function AssessmentPanel({ jobId, estVram }: { jobId: string; estVram: number | null }) {
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
        {estVram !== null && (
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
