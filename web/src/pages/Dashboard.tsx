import {
  Alert,
  Badge,
  Box,
  Card,
  Group,
  Progress,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconBolt,
  IconCircleCheck,
  IconClockHour4,
  IconCpu,
  IconDeviceDesktopOff,
  IconInbox,
  IconPlayerPlay,
} from '@tabler/icons-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { api, type Job, type Worker } from '../api';
import {
  CardSkeleton,
  EmptyState,
  Metric,
  Mono,
  SectionHeader,
  StatCard,
} from '../components/Primitives';
import { WorkerStatusBadge } from '../components/StatusBadge';
import { JobStatusBadge } from '../components/StatusBadge';
import { formatGb, formatRelative, shortId } from '../lib/format';
import { usePolling } from '../lib/usePolling';

const POLL_MS = 5000;
const ACTIVE_STATUSES = ['queued', 'assigned', 'running'];

const BACKEND_COLORS: Record<string, string> = {
  cuda: 'teal',
  rocm: 'orange',
  mps: 'grape',
  cpu: 'gray',
};

export function Dashboard() {
  const { t } = useTranslation();
  const theme = useMantineTheme();

  const loadAll = useCallback(
    async () => ({
      workers: await api.listWorkers(),
      jobs: await api.listJobs(ACTIVE_STATUSES),
    }),
    [],
  );

  const { data, loading, error } = usePolling(loadAll, POLL_MS);

  const workers = data?.workers ?? [];
  const jobs = data?.jobs ?? [];

  const active = workers.filter((w) => !w.disabled);
  const onlineCount = active.filter((w) => w.status === 'online').length;
  const busyCount = active.filter((w) => w.status === 'busy').length;
  const queuedCount = jobs.filter((j) => j.status === 'queued').length;
  const runningCount = jobs.filter((j) => j.status === 'running' || j.status === 'assigned').length;

  const jobByWorker = new Map<string, Job>();
  for (const job of jobs) {
    if (job.worker_id && (job.status === 'running' || job.status === 'assigned')) {
      jobByWorker.set(job.worker_id, job);
    }
  }
  const workerName = new Map(workers.map((w) => [w.id, w.name] as const));

  return (
    <Stack gap="lg">
      <SectionHeader title={t('dashboard.title')} description={t('dashboard.subtitle')} />

      {error && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
          {t('dashboard.load_error')}
        </Alert>
      )}

      <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
        <StatCard
          label={t('dashboard.stat_online')}
          value={onlineCount}
          icon={<IconCircleCheck size={19} />}
          color="teal"
          loading={loading}
        />
        <StatCard
          label={t('dashboard.stat_busy')}
          value={busyCount}
          icon={<IconBolt size={19} />}
          color="yellow"
          loading={loading}
        />
        <StatCard
          label={t('dashboard.stat_queued')}
          value={queuedCount}
          icon={<IconClockHour4 size={19} />}
          color="gray"
          loading={loading}
        />
        <StatCard
          label={t('dashboard.stat_running')}
          value={runningCount}
          icon={<IconPlayerPlay size={19} />}
          color="federation"
          loading={loading}
        />
      </SimpleGrid>

      <Stack gap="sm">
        <Text fw={600} fz="md">
          {t('dashboard.workers_heading')}
        </Text>

        {loading ? (
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
          </SimpleGrid>
        ) : workers.length === 0 ? (
          <Card style={{ background: theme.other.surfaces.card, borderColor: theme.other.surfaces.border }}>
            <EmptyState
              icon={<IconDeviceDesktopOff size={26} />}
              title={t('dashboard.no_workers')}
              description={t('dashboard.no_workers_hint')}
            />
          </Card>
        ) : (
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
            {workers.map((worker) => (
              <WorkerCard key={worker.id} worker={worker} job={jobByWorker.get(worker.id) ?? null} />
            ))}
          </SimpleGrid>
        )}
      </Stack>

      <Stack gap="sm">
        <Text fw={600} fz="md">
          {t('dashboard.queue_heading')}
        </Text>
        <Card
          padding={0}
          style={{ background: theme.other.surfaces.card, borderColor: theme.other.surfaces.border, overflow: 'hidden' }}
        >
          {jobs.length === 0 ? (
            <EmptyState
              compact
              icon={<IconInbox size={22} />}
              title={t('dashboard.queue_empty')}
              description={t('dashboard.queue_empty_hint')}
            />
          ) : (
            <Table.ScrollContainer minWidth={620}>
              <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                <Table.Thead style={{ background: theme.other.surfaces.raised }}>
                  <Table.Tr>
                    <Table.Th>{t('jobs.col_id')}</Table.Th>
                    <Table.Th>{t('jobs.col_status')}</Table.Th>
                    <Table.Th>{t('jobs.col_progress')}</Table.Th>
                    <Table.Th>{t('jobs.col_worker')}</Table.Th>
                    <Table.Th>{t('jobs.col_created')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {jobs.map((job) => (
                    <Table.Tr key={job.id}>
                      <Table.Td>
                        <Mono title={job.id} c="">
                          {shortId(job.id)}
                        </Mono>
                      </Table.Td>
                      <Table.Td>
                        <JobStatusBadge status={job.status} />
                      </Table.Td>
                      <Table.Td style={{ minWidth: 140 }}>
                        <ProgressCell value={job.progress} status={job.status} />
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c={job.worker_id ? undefined : 'dimmed'}>
                          {job.worker_id ? (workerName.get(job.worker_id) ?? shortId(job.worker_id)) : '—'}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {formatRelative(job.created_at, t)}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Card>
      </Stack>
    </Stack>
  );
}

export function ProgressCell({ value, status }: { value: number; status: string }) {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const color = status === 'failed' ? 'red' : status === 'done' ? 'teal' : 'federation';
  return (
    <Group gap="xs" wrap="nowrap">
      <Progress
        value={status === 'done' ? 100 : percent}
        color={color}
        size="sm"
        radius="xl"
        style={{ flex: 1, minWidth: 60 }}
        animated={status === 'running'}
      />
      <Text size="xs" c="dimmed" w={34} ta="right" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {status === 'done' ? 100 : percent}%
      </Text>
    </Group>
  );
}

function WorkerCard({ worker, job }: { worker: Worker; job: Job | null }) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const hardware = worker.hardware ?? {};
  const dynamic = worker.dynamic ?? {};
  const backend = (worker.backend || '').toLowerCase();
  const accent =
    worker.disabled ? 'gray' : worker.status === 'online' ? 'teal' : worker.status === 'busy' ? 'yellow' : 'gray';

  return (
    <Card
      padding="md"
      style={{
        background: theme.other.surfaces.card,
        borderColor: theme.other.surfaces.border,
        opacity: worker.disabled ? 0.6 : 1,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <Box
        style={{
          position: 'absolute',
          insetInline: 0,
          top: 0,
          height: 2,
          background: `linear-gradient(90deg, var(--mantine-color-${accent}-5), transparent 75%)`,
        }}
      />
      <Stack gap="sm" h="100%">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Text fw={600} lineClamp={1}>
              {worker.name}
            </Text>
            <Mono size="xs" title={worker.id}>
              {shortId(worker.id)}
            </Mono>
          </Stack>
          <WorkerStatusBadge status={worker.status} disabled={worker.disabled} />
        </Group>

        <Group gap="xs" wrap="wrap">
          {backend && (
            <Badge size="sm" color={BACKEND_COLORS[backend] ?? 'gray'} variant="light" tt="uppercase" fw={600}>
              {backend}
            </Badge>
          )}
          {hardware.gpu_name && (
            <Tooltip label={hardware.gpu_name}>
              <Badge size="sm" variant="default" tt="none" fw={400} maw={190} style={{ overflow: 'hidden' }}>
                {hardware.gpu_name}
              </Badge>
            </Tooltip>
          )}
          {worker.model_count > 0 && (
            <Badge size="sm" variant="default" tt="none" fw={400}>
              {t('dashboard.model_count', { count: worker.model_count })}
            </Badge>
          )}
        </Group>

        <SimpleGrid cols={3} spacing="xs">
          <Metric label={t('dashboard.metric_vram')} value={formatGb(hardware.vram_gb)} />
          <Metric label={t('dashboard.metric_ram')} value={formatGb(hardware.ram_gb)} />
          <Metric
            label={t('dashboard.metric_disk')}
            value={formatGb(dynamic.free_disk_gb)}
            hint={t('dashboard.metric_disk_hint')}
          />
        </SimpleGrid>

        <Box mt="auto">
          {job ? (
            <Stack gap={5}>
              <Group justify="space-between" gap="xs" wrap="nowrap">
                <Text size="xs" c="dimmed" truncate>
                  {t('dashboard.current_job')} <Mono size="xs">{shortId(job.id)}</Mono>
                </Text>
              </Group>
              <ProgressCell value={job.progress} status={job.status} />
            </Stack>
          ) : (
            <Text size="xs" c="dimmed">
              {t('dashboard.idle')}
            </Text>
          )}
        </Box>

        <Group
          gap={6}
          pt="xs"
          style={{ borderTop: `1px solid ${theme.other.surfaces.border}` }}
        >
          <IconCpu size={13} style={{ opacity: 0.5 }} />
          <Text size="xs" c="dimmed">
            {t('dashboard.last_seen', { value: formatRelative(worker.last_seen, t) })}
          </Text>
        </Group>
      </Stack>
    </Card>
  );
}
