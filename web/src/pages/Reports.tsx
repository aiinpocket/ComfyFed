import {
  Alert,
  Box,
  Button,
  Card,
  Group,
  NumberInput,
  Stack,
  Table,
  Tabs,
  Text,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import {
  IconAlertTriangle,
  IconCalculator,
  IconChartBar,
  IconRefresh,
  IconUsers,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, type Contribution, type PayoutResult, type Role, type UsageRow } from '../api';
import { EmptyState, Mono, SectionHeader, StatCard, TableSkeleton } from '../components/Primitives';
import { formatGpuSeconds, shortId } from '../lib/format';

const DEFAULT_RANGE: () => [Date, Date] = () => [
  dayjs().subtract(29, 'day').startOf('day').toDate(),
  dayjs().endOf('day').toDate(),
];

/** `YYYY-MM-DDTHH:mm:ss` bounds for a date-range picker's value, or
 * `undefined` on either end left blank -- shared by every report tab. */
function rangeParams(range: [Date | null, Date | null]): { from?: string; to?: string } {
  const [from, to] = range;
  return {
    from: from ? dayjs(from).startOf('day').format('YYYY-MM-DDTHH:mm:ss') : undefined,
    to: to ? dayjs(to).endOf('day').format('YYYY-MM-DDTHH:mm:ss') : undefined,
  };
}

/** Reports are on-demand rather than polled — the data moves slowly. */
export function Reports({ role }: { role: Role }) {
  const { t } = useTranslation();

  if (role !== 'admin') {
    return <MyUsagePanel />;
  }

  return (
    <Stack gap="lg">
      <SectionHeader title={t('reports.page_title')} description={t('reports.page_subtitle')} />

      <Tabs defaultValue="contributions">
        <Tabs.List>
          <Tabs.Tab value="contributions" leftSection={<IconChartBar size={15} />}>
            {t('reports.tab_contributions')}
          </Tabs.Tab>
          <Tabs.Tab value="usage" leftSection={<IconUsers size={15} />}>
            {t('reports.tab_usage')}
          </Tabs.Tab>
          <Tabs.Tab value="payout" leftSection={<IconCalculator size={15} />}>
            {t('reports.tab_payout')}
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="contributions" pt="lg">
          <ContributionsPanel />
        </Tabs.Panel>
        <Tabs.Panel value="usage" pt="lg">
          <UsagePanel />
        </Tabs.Panel>
        <Tabs.Panel value="payout" pt="lg">
          <PayoutPanel />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

/* ----------------------------------------------------- worker contributions */

/** Worker 貢獻 tab: the pre-Task-8 Reports page, unchanged. */
function ContributionsPanel() {
  const { t } = useTranslation();
  const theme = useMantineTheme();

  const [range, setRange] = useState<[Date | null, Date | null]>(DEFAULT_RANGE());
  const [rows, setRows] = useState<Contribution[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const { from, to } = rangeParams(range);
      const result = await api.contributions(from, to);
      setRows([...result].sort((a, b) => b.gpu_seconds - a.gpu_seconds));
    } catch {
      setFailed(true);
      setRows(null);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalSeconds = (rows ?? []).reduce((sum, row) => sum + row.gpu_seconds, 0);
  const totalJobs = (rows ?? []).reduce((sum, row) => sum + row.jobs, 0);
  const maxSeconds = Math.max(1, ...(rows ?? []).map((row) => row.gpu_seconds));

  return (
    <Stack gap="lg">
      <Group gap="sm" wrap="wrap" justify="flex-end">
        <DatePickerInput
          type="range"
          value={range}
          onChange={(value) => setRange(value as [Date | null, Date | null])}
          placeholder={t('reports.pick_range')}
          valueFormat="YYYY-MM-DD"
          w={250}
          allowSingleDateInRange
        />
        <Button variant="light" leftSection={<IconRefresh size={16} />} onClick={load} loading={loading}>
          {t('reports.refresh')}
        </Button>
      </Group>

      {failed && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
          {t('reports.load_error')}
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
          <TableSkeleton rows={4} cols={4} />
        ) : !rows || rows.length === 0 ? (
          <EmptyState
            icon={<IconChartBar size={26} />}
            title={t('reports.empty')}
            description={t('reports.empty_hint')}
          />
        ) : (
          <>
            <Group
              justify="space-between"
              px="md"
              py="sm"
              style={{ borderBottom: `1px solid ${theme.other.surfaces.border}` }}
            >
              <Text size="sm" c="dimmed">
                {t('reports.summary', { workers: rows.length, jobs: totalJobs })}
              </Text>
              <Text size="sm" fw={600}>
                {t('reports.total_gpu', { value: formatGpuSeconds(totalSeconds) })}
              </Text>
            </Group>
            <Table.ScrollContainer minWidth={640}>
              <Table verticalSpacing="sm" horizontalSpacing="md">
                <Table.Thead style={{ background: theme.other.surfaces.raised }}>
                  <Table.Tr>
                    <Table.Th>{t('reports.col_worker')}</Table.Th>
                    <Table.Th w={90}>{t('reports.col_jobs')}</Table.Th>
                    <Table.Th w={130}>{t('reports.col_gpu_time')}</Table.Th>
                    <Table.Th>{t('reports.col_share')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((row) => {
                    const share = totalSeconds > 0 ? (row.gpu_seconds / totalSeconds) * 100 : 0;
                    const barWidth = (row.gpu_seconds / maxSeconds) * 100;
                    return (
                      <Table.Tr key={row.worker_id}>
                        <Table.Td>
                          <Stack gap={1}>
                            <Text size="sm" fw={500}>
                              {row.name || t('reports.unknown_worker')}
                            </Text>
                            <Mono size="xs" title={row.worker_id}>
                              {shortId(row.worker_id)}
                            </Mono>
                          </Stack>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {row.jobs}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {formatGpuSeconds(row.gpu_seconds)}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Tooltip label={`${share.toFixed(1)}%`}>
                            <Group gap="xs" wrap="nowrap">
                              <Box
                                style={{
                                  flex: 1,
                                  height: 8,
                                  borderRadius: 999,
                                  background: theme.other.surfaces.raised,
                                  overflow: 'hidden',
                                  minWidth: 80,
                                }}
                              >
                                <Box
                                  style={{
                                    width: `${barWidth}%`,
                                    height: '100%',
                                    borderRadius: 999,
                                    background:
                                      'linear-gradient(90deg, var(--mantine-color-federation-6), var(--mantine-color-teal-5))',
                                  }}
                                />
                              </Box>
                              <Text
                                size="xs"
                                c="dimmed"
                                w={44}
                                ta="right"
                                style={{ fontVariantNumeric: 'tabular-nums' }}
                              >
                                {share.toFixed(1)}%
                              </Text>
                            </Group>
                          </Tooltip>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </>
        )}
      </Card>
    </Stack>
  );
}

/* ------------------------------------------------------------- user usage */

/** 使用者用量 tab (admin): per-user aggregate from `GET /api/reports/usage`. */
function UsagePanel() {
  const { t } = useTranslation();
  const theme = useMantineTheme();

  const [range, setRange] = useState<[Date | null, Date | null]>(DEFAULT_RANGE());
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const { from, to } = rangeParams(range);
      const result = await api.reportUsage(from, to);
      setRows(result);
    } catch {
      setFailed(true);
      setRows(null);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Stack gap="lg">
      <Group gap="sm" wrap="wrap" justify="flex-end">
        <DatePickerInput
          type="range"
          value={range}
          onChange={(value) => setRange(value as [Date | null, Date | null])}
          placeholder={t('reports.pick_range')}
          valueFormat="YYYY-MM-DD"
          w={250}
          allowSingleDateInRange
        />
        <Button variant="light" leftSection={<IconRefresh size={16} />} onClick={load} loading={loading}>
          {t('reports.refresh')}
        </Button>
      </Group>

      {failed && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
          {t('reports.usage_load_error')}
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
          <TableSkeleton rows={4} cols={4} />
        ) : !rows || rows.length === 0 ? (
          <EmptyState
            icon={<IconUsers size={26} />}
            title={t('reports.usage_empty')}
            description={t('reports.usage_empty_hint')}
          />
        ) : (
          <Table.ScrollContainer minWidth={560}>
            <Table verticalSpacing="sm" horizontalSpacing="md">
              <Table.Thead style={{ background: theme.other.surfaces.raised }}>
                <Table.Tr>
                  <Table.Th>{t('reports.usage_col_username')}</Table.Th>
                  <Table.Th w={100}>{t('reports.usage_col_jobs')}</Table.Th>
                  <Table.Th w={140}>{t('reports.usage_col_gpu')}</Table.Th>
                  <Table.Th w={140}>{t('reports.usage_col_unbilled')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((row) => (
                  <Table.Tr key={row.user_id ?? '__legacy__'}>
                    <Table.Td>
                      <Text size="sm" fw={500} c={row.username ? undefined : 'dimmed'}>
                        {row.username ?? t('reports.usage_legacy')}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {row.jobs}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {formatGpuSeconds(row.gpu_seconds)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {formatGpuSeconds(row.unbilled_gpu_seconds)}
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
  );
}

/* ----------------------------------------------------------- payout tab */

/** 分潤試算 tab (admin): pool + date range → `GET /api/reports/payout`, run
 * on demand (never auto-loaded — a pool of 0 isn't a meaningful default). */
function PayoutPanel() {
  const { t } = useTranslation();
  const theme = useMantineTheme();

  const [range, setRange] = useState<[Date | null, Date | null]>(DEFAULT_RANGE());
  const [pool, setPool] = useState<number | ''>('');
  const [result, setResult] = useState<PayoutResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [ran, setRan] = useState(false);

  const calculate = async () => {
    setLoading(true);
    setFailed(false);
    try {
      const { from, to } = rangeParams(range);
      const poolValue = pool === '' ? 0 : Number(pool);
      const outcome = await api.reportPayout(poolValue, from, to);
      setResult(outcome);
    } catch {
      setFailed(true);
      setResult(null);
    } finally {
      setLoading(false);
      setRan(true);
    }
  };

  return (
    <Stack gap="lg">
      <Group gap="sm" wrap="wrap" align="flex-end">
        <NumberInput
          label={t('reports.payout_pool_label')}
          value={pool}
          onChange={(value) => setPool(value === '' ? '' : Number(value))}
          min={0}
          step={1}
          decimalScale={2}
          w={200}
        />
        <DatePickerInput
          type="range"
          value={range}
          onChange={(value) => setRange(value as [Date | null, Date | null])}
          placeholder={t('reports.pick_range')}
          valueFormat="YYYY-MM-DD"
          w={250}
          allowSingleDateInRange
        />
        <Button
          leftSection={<IconCalculator size={16} />}
          onClick={() => void calculate()}
          loading={loading}
        >
          {t('reports.payout_calculate')}
        </Button>
      </Group>

      {failed && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
          {t('reports.payout_load_error')}
        </Alert>
      )}

      {ran && !failed && (
        <Card
          padding={0}
          style={{
            background: theme.other.surfaces.card,
            borderColor: theme.other.surfaces.border,
            overflow: 'hidden',
          }}
        >
          {!result || result.workers.length === 0 ? (
            <EmptyState
              icon={<IconCalculator size={26} />}
              title={t('reports.payout_empty')}
              description={t('reports.empty_hint')}
            />
          ) : (
            <>
              <Group
                justify="space-between"
                px="md"
                py="sm"
                style={{ borderBottom: `1px solid ${theme.other.surfaces.border}` }}
              >
                <Text size="sm" fw={600}>
                  {t('reports.payout_total', { value: formatGpuSeconds(result.total_gpu_seconds) })}
                </Text>
              </Group>
              <Table.ScrollContainer minWidth={560}>
                <Table verticalSpacing="sm" horizontalSpacing="md">
                  <Table.Thead style={{ background: theme.other.surfaces.raised }}>
                    <Table.Tr>
                      <Table.Th>{t('reports.col_worker')}</Table.Th>
                      <Table.Th w={140}>{t('reports.col_gpu_time')}</Table.Th>
                      <Table.Th w={100}>{t('reports.payout_col_ratio')}</Table.Th>
                      <Table.Th w={140}>{t('reports.payout_col_amount')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {result.workers.map((worker) => (
                      <Table.Tr key={worker.worker_id}>
                        <Table.Td>
                          <Stack gap={1}>
                            <Text size="sm" fw={500}>
                              {worker.name || t('reports.unknown_worker')}
                            </Text>
                            <Mono size="xs" title={worker.worker_id}>
                              {shortId(worker.worker_id)}
                            </Mono>
                          </Stack>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {formatGpuSeconds(worker.gpu_seconds)}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {(worker.ratio * 100).toFixed(2)}%
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" fw={500} style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {worker.amount.toFixed(2)}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </>
          )}
        </Card>
      )}
    </Stack>
  );
}

/* ----------------------------------------------------------- plain user */

/** Whole page for a plain user: no tabs, just their own usage, from
 * `GET /api/reports/my-usage`. */
function MyUsagePanel() {
  const { t } = useTranslation();

  const [range, setRange] = useState<[Date | null, Date | null]>(DEFAULT_RANGE());
  const [row, setRow] = useState<UsageRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const { from, to } = rangeParams(range);
      const result = await api.reportMyUsage(from, to);
      setRow(result);
    } catch {
      setFailed(true);
      setRow(null);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Stack gap="lg">
      <SectionHeader
        title={t('reports.my_usage_title')}
        description={t('reports.my_usage_subtitle')}
        action={
          <Group gap="sm" wrap="wrap">
            <DatePickerInput
              type="range"
              value={range}
              onChange={(value) => setRange(value as [Date | null, Date | null])}
              placeholder={t('reports.pick_range')}
              valueFormat="YYYY-MM-DD"
              w={250}
              allowSingleDateInRange
            />
            <Button
              variant="light"
              leftSection={<IconRefresh size={16} />}
              onClick={load}
              loading={loading}
            >
              {t('reports.refresh')}
            </Button>
          </Group>
        }
      />

      {failed && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
          {t('reports.my_usage_load_error')}
        </Alert>
      )}

      <Group gap="md" wrap="wrap" grow>
        <StatCard
          label={t('reports.my_usage_jobs')}
          value={row ? row.jobs : 0}
          icon={<IconChartBar size={18} />}
          color="federation"
          loading={loading}
        />
        <StatCard
          label={t('reports.my_usage_gpu')}
          value={row ? formatGpuSeconds(row.gpu_seconds) : '—'}
          icon={<IconCalculator size={18} />}
          color="teal"
          loading={loading}
        />
        <StatCard
          label={t('reports.my_usage_unbilled')}
          value={row ? formatGpuSeconds(row.unbilled_gpu_seconds) : '—'}
          icon={<IconUsers size={18} />}
          color="gray"
          loading={loading}
        />
      </Group>
    </Stack>
  );
}
