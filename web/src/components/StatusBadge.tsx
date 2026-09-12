import { Badge, Box, Group, MantineColor } from '@mantine/core';
import { useTranslation } from 'react-i18next';

const WORKER_COLORS: Record<string, MantineColor> = {
  online: 'teal',
  busy: 'yellow',
  offline: 'gray',
};

const JOB_COLORS: Record<string, MantineColor> = {
  queued: 'gray',
  assigned: 'indigo',
  running: 'federation',
  done: 'teal',
  failed: 'red',
  canceled: 'gray',
};

interface DotProps {
  color: MantineColor;
  pulse?: boolean;
}

/** A small filled status dot; pulses while a worker is actively busy. */
export function StatusDot({ color, pulse = false }: DotProps) {
  return (
    <Box
      component="span"
      className={pulse ? 'cf-pulse' : undefined}
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: 999,
        flexShrink: 0,
        background: `var(--mantine-color-${color}-5)`,
        boxShadow: `0 0 0 3px var(--mantine-color-${color}-light)`,
      }}
    />
  );
}

export function WorkerStatusBadge({ status, disabled }: { status: string; disabled?: boolean }) {
  const { t } = useTranslation();
  const effective = disabled ? 'disabled' : status;
  const color = disabled ? 'gray' : (WORKER_COLORS[status] ?? 'gray');

  return (
    <Group gap={6} wrap="nowrap">
      <StatusDot color={color} pulse={!disabled && status === 'busy'} />
      <Badge color={color} variant="light" size="sm" tt="none" fw={500}>
        {t(`worker_status.${effective}`, { defaultValue: effective })}
      </Badge>
    </Group>
  );
}

export function JobStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const color = JOB_COLORS[status] ?? 'gray';
  return (
    <Badge color={color} variant="light" size="sm" tt="none" fw={500}>
      {t(`job_status.${status}`, { defaultValue: status })}
    </Badge>
  );
}
