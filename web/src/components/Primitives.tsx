import {
  Box,
  Card,
  Center,
  Group,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import type { CSSProperties, ReactNode } from 'react';

/** Monospace inline text for ids, hashes and filenames. */
export function Mono({
  children,
  title,
  c = 'dimmed',
  size = 'sm',
  style,
}: {
  children: ReactNode;
  title?: string;
  c?: string;
  size?: string;
  style?: CSSProperties;
}) {
  return (
    <Text
      component="span"
      ff="monospace"
      size={size}
      c={c}
      title={title}
      style={{ letterSpacing: '-0.01em', ...style }}
    >
      {children}
    </Text>
  );
}

/** Small labelled metric used inside worker cards. */
export function Metric({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  const content = (
    <Stack gap={2}>
      <Text size="10px" tt="uppercase" fw={600} c="dimmed" style={{ letterSpacing: '0.08em' }}>
        {label}
      </Text>
      <Text size="sm" fw={500} lineClamp={1}>
        {value}
      </Text>
    </Stack>
  );
  return hint ? <Tooltip label={hint}>{content}</Tooltip> : content;
}

interface StatCardProps {
  label: string;
  value: ReactNode;
  icon: ReactNode;
  color: string;
  loading?: boolean;
}

/** Dashboard headline number. */
export function StatCard({ label, value, icon, color, loading }: StatCardProps) {
  const theme = useMantineTheme();
  return (
    <Card
      padding="md"
      style={{
        background: theme.other.surfaces.card,
        borderColor: theme.other.surfaces.border,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <Box
        style={{
          position: 'absolute',
          insetBlock: 0,
          insetInlineStart: 0,
          width: 3,
          background: `var(--mantine-color-${color}-5)`,
        }}
      />
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Stack gap={4}>
          <Text size="xs" c="dimmed" fw={500}>
            {label}
          </Text>
          {loading ? (
            <Skeleton height={30} width={48} radius="sm" />
          ) : (
            <Text fz={30} fw={600} lh={1.1} style={{ fontVariantNumeric: 'tabular-nums' }}>
              {value}
            </Text>
          )}
        </Stack>
        <ThemeIcon variant="light" color={color} size={34} radius="md">
          {icon}
        </ThemeIcon>
      </Group>
    </Card>
  );
}

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}

/** Shown wherever a collection is legitimately empty (not loading, not failed). */
export function EmptyState({ icon, title, description, action, compact }: EmptyStateProps) {
  return (
    <Center py={compact ? 'lg' : 'xl'} px="md">
      <Stack align="center" gap="xs" maw={380}>
        <ThemeIcon variant="light" color="gray" size={compact ? 40 : 52} radius="xl">
          {icon}
        </ThemeIcon>
        <Text fw={600} size={compact ? 'sm' : 'md'} ta="center">
          {title}
        </Text>
        {description && (
          <Text size="sm" c="dimmed" ta="center" lh={1.5}>
            {description}
          </Text>
        )}
        {action && <Box mt="xs">{action}</Box>}
      </Stack>
    </Center>
  );
}

/** Loading placeholder shaped like a worker card. */
export function CardSkeleton({ height = 180 }: { height?: number }) {
  const theme = useMantineTheme();
  return (
    <Card
      padding="lg"
      style={{ background: theme.other.surfaces.card, borderColor: theme.other.surfaces.border }}
    >
      <Stack gap="sm" h={height} justify="flex-start">
        <Group justify="space-between">
          <Skeleton height={16} width="45%" radius="sm" />
          <Skeleton height={18} width={64} radius="sm" />
        </Group>
        <Skeleton height={10} width="70%" radius="sm" />
        <Group gap="lg" mt="xs">
          <Skeleton height={30} width={72} radius="sm" />
          <Skeleton height={30} width={72} radius="sm" />
          <Skeleton height={30} width={72} radius="sm" />
        </Group>
        <Skeleton height={8} radius="xl" mt="auto" />
      </Stack>
    </Card>
  );
}

/** Loading placeholder shaped like a table. */
export function TableSkeleton({ rows = 4, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <Stack gap="xs" p="md">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <Group key={rowIndex} gap="md" wrap="nowrap">
          {Array.from({ length: cols }).map((__, colIndex) => (
            <Skeleton
              key={colIndex}
              height={12}
              radius="sm"
              style={{ flex: colIndex === 0 ? 2 : 1 }}
            />
          ))}
        </Group>
      ))}
    </Stack>
  );
}

/** Section heading with optional right-aligned actions. */
export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm">
      <Stack gap={2}>
        <Text fz={20} fw={600}>
          {title}
        </Text>
        {description && (
          <Text size="sm" c="dimmed">
            {description}
          </Text>
        )}
      </Stack>
      {action}
    </Group>
  );
}
