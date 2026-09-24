import { createTheme, MantineColorsTuple, rem } from '@mantine/core';

/**
 * ComfyFed console theme.
 *
 * Dark-first. One signature accent — electric violet-blue "federation" —
 * carries primary actions and active navigation; status semantics are fixed
 * elsewhere in the app (online = teal, busy = amber, offline = gray,
 * failed = red) so the accent never competes with a status signal.
 */

const federation: MantineColorsTuple = [
  '#f0efff',
  '#dedcfb',
  '#bab7f0',
  '#948fe6',
  '#746ede',
  '#6058d9',
  '#564dd8',
  '#463fc0',
  '#3d37ac',
  '#332e98',
];

/** Neutral ramp used for surfaces: layered near-blacks with a cool cast. */
const slate: MantineColorsTuple = [
  '#f4f5f8',
  '#e7e8ee',
  '#cbccd8',
  '#adafc1',
  '#9497ad',
  '#8489a1',
  '#7b809b',
  '#696d88',
  '#5d617b',
  '#4e536d',
];

export const surfaces = {
  /** App background — the deepest layer. */
  base: '#0b0d13',
  /** Sidebar / topbar chrome. */
  chrome: '#0f1117',
  /** Cards and panels. */
  card: '#151822',
  /** Raised elements inside cards (code blocks, table headers). */
  raised: '#1b1f2b',
  border: '#242938',
  borderStrong: '#323950',
};

export const statusColor = {
  online: 'teal',
  busy: 'yellow',
  offline: 'gray',
  disabled: 'gray',
  paused: 'slate',
  queued: 'slate',
  assigned: 'indigo',
  running: 'federation',
  done: 'teal',
  failed: 'red',
} as const;

export const theme = createTheme({
  primaryColor: 'federation',
  primaryShade: { light: 6, dark: 5 },
  colors: { federation, slate },
  defaultRadius: 'md',
  fontFamily: 'Inter, "Noto Sans TC", system-ui, -apple-system, sans-serif',
  fontFamilyMonospace: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
  headings: {
    fontFamily: 'Inter, "Noto Sans TC", system-ui, sans-serif',
    fontWeight: '600',
    sizes: {
      h1: { fontSize: rem(28), lineHeight: '1.25' },
      h2: { fontSize: rem(22), lineHeight: '1.3' },
      h3: { fontSize: rem(17), lineHeight: '1.35' },
      h4: { fontSize: rem(15), lineHeight: '1.4' },
    },
  },
  radius: {
    xs: rem(4),
    sm: rem(6),
    md: rem(10),
    lg: rem(14),
    xl: rem(20),
  },
  spacing: {
    xs: rem(8),
    sm: rem(12),
    md: rem(16),
    lg: rem(24),
    xl: rem(36),
  },
  other: { surfaces },
  components: {
    Card: {
      defaultProps: {
        withBorder: true,
        padding: 'lg',
        radius: 'md',
      },
    },
    Paper: {
      defaultProps: { radius: 'md' },
    },
    Badge: {
      defaultProps: { radius: 'sm', variant: 'light' },
    },
    Button: {
      defaultProps: { radius: 'md' },
    },
    Modal: {
      defaultProps: { radius: 'lg', centered: true, overlayProps: { blur: 3, opacity: 0.6 } },
    },
    Tooltip: {
      defaultProps: { withArrow: true, openDelay: 250 },
    },
  },
});
