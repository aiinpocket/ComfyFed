import {
  Alert,
  Box,
  Button,
  Card,
  Group,
  Stack,
  Table,
  Text,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { IconAlertTriangle, IconChartBar, IconRefresh } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, type Contribution } from '../api';
import { EmptyState, Mono, SectionHeader, TableSkeleton } from '../components/Primitives';
import { formatGpuSeconds, shortId } from '../lib/format';

/** Reports are on-demand rather than polled — the data moves slowly. */
export function Reports() {
  const { t } = useTranslation();
  const theme = useMantineTheme();

  const [range, setRange] = useState<[Date | null, Date | null]>([
    dayjs().subtract(29, 'day').startOf('day').toDate(),
    dayjs().endOf('day').toDate(),
  ]);
  const [rows, setRows] = useState<Contribution[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const [from, to] = range;
    setLoading(true);
    setFailed(false);
    try {
      const result = await api.contributions(
        from ? dayjs(from).startOf('day').format('YYYY-MM-DDTHH:mm:ss') : undefined,
        to ? dayjs(to).endOf('day').format('YYYY-MM-DDTHH:mm:ss') : undefined,
      );
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
      <SectionHeader
        title={t('reports.title')}
        description={t('reports.subtitle')}
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
