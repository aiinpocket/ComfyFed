import {
  ActionIcon,
  AppShell,
  Badge,
  Box,
  Burger,
  Group,
  NavLink,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
  useMantineTheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconChartBar,
  IconLayoutDashboard,
  IconLogout,
  IconServer2,
  IconSettings,
  IconStack2,
  IconUsers,
  IconWorldBolt,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { NavLink as RouterNavLink, useLocation, useNavigate } from 'react-router-dom';

import { api, type Role } from '../api';
import { persistLang, type Lang } from '../i18n';
import { Logo } from './Logo';

const APP_VERSION = '0.1.0';

const NAV_ITEMS = [
  { to: '/dashboard', labelKey: 'nav.dashboard', icon: IconLayoutDashboard, adminOnly: false },
  { to: '/jobs', labelKey: 'nav.jobs', icon: IconStack2, adminOnly: false },
  { to: '/workers', labelKey: 'nav.workers', icon: IconServer2, adminOnly: false },
  { to: '/users', labelKey: 'nav.users', icon: IconUsers, adminOnly: true },
  { to: '/reports', labelKey: 'nav.reports', icon: IconChartBar, adminOnly: false },
  { to: '/settings', labelKey: 'nav.settings', icon: IconSettings, adminOnly: false },
] as const;

interface AppLayoutProps {
  platformUrl: string;
  role: Role;
  onLoggedOut: () => void;
  children: React.ReactNode;
}

export function AppLayout({ platformUrl, role, onLoggedOut, children }: AppLayoutProps) {
  const { t, i18n } = useTranslation();
  const theme = useMantineTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpened, { toggle: toggleMobile, close: closeMobile }] = useDisclosure(false);
  const navItems = NAV_ITEMS.filter((item) => !item.adminOnly || role === 'admin');

  const handleLogout = async () => {
    await api.logout().catch(() => undefined);
    onLoggedOut();
    navigate('/login', { replace: true });
  };

  const activeSection = navItems.find((item) => location.pathname.startsWith(item.to));

  return (
    <AppShell
      header={{ height: 58 }}
      navbar={{ width: 232, breakpoint: 'sm', collapsed: { mobile: !mobileOpened } }}
      padding={0}
      styles={{
        header: {
          background: theme.other.surfaces.chrome,
          borderColor: theme.other.surfaces.border,
        },
        navbar: {
          background: theme.other.surfaces.chrome,
          borderColor: theme.other.surfaces.border,
        },
        main: { background: theme.other.surfaces.base },
      }}
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={mobileOpened} onClick={toggleMobile} hiddenFrom="sm" size="sm" />
            <Text fw={600} fz="md" visibleFrom="sm">
              {activeSection ? t(activeSection.labelKey) : t('app.name')}
            </Text>
          </Group>

          <Group gap="sm" wrap="nowrap">
            {platformUrl && (
              <Tooltip label={t('topbar.platform_url')}>
                <Badge
                  variant="default"
                  size="lg"
                  radius="sm"
                  leftSection={<IconWorldBolt size={13} />}
                  styles={{
                    root: {
                      background: theme.other.surfaces.raised,
                      borderColor: theme.other.surfaces.border,
                      textTransform: 'none',
                      fontWeight: 400,
                      maxWidth: 260,
                    },
                    label: { fontFamily: theme.fontFamilyMonospace, fontSize: 11 },
                  }}
                  visibleFrom="md"
                >
                  {platformUrl}
                </Badge>
              </Tooltip>
            )}

            <SegmentedControl
              size="xs"
              radius="md"
              value={i18n.language === 'zh-TW' ? 'zh-TW' : 'en'}
              onChange={(value) => persistLang(value as Lang)}
              data={[
                { value: 'zh-TW', label: '繁中' },
                { value: 'en', label: 'EN' },
              ]}
              styles={{ root: { background: theme.other.surfaces.raised } }}
            />

            <Tooltip label={t('topbar.logout')}>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="lg"
                onClick={handleLogout}
                aria-label={t('topbar.logout')}
              >
                <IconLogout size={18} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        <AppShell.Section>
          <UnstyledButton
            component={RouterNavLink}
            to="/dashboard"
            onClick={closeMobile}
            style={{ display: 'block', padding: '6px 8px 14px' }}
          >
            <Group gap="xs" wrap="nowrap" align="center">
              <Logo size={26} />
              <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
                <Text fw={700} fz="sm" lh={1.15} style={{ letterSpacing: '-0.01em' }}>
                  {t('app.name')}
                </Text>
                <Text fz={10} c="dimmed" lh={1.3} truncate>
                  {t('app.tagline')}
                </Text>
              </Stack>
              <Badge
                size="xs"
                variant="light"
                color="federation"
                radius="sm"
                style={{ flexShrink: 0 }}
              >
                v{APP_VERSION}
              </Badge>
            </Group>
          </UnstyledButton>
        </AppShell.Section>

        <AppShell.Section grow component={ScrollArea}>
          <Stack gap={2}>
            {navItems.map(({ to, labelKey, icon: Icon }) => {
              const active = location.pathname.startsWith(to);
              return (
                <NavLink
                  key={to}
                  component={RouterNavLink}
                  to={to}
                  onClick={closeMobile}
                  active={active}
                  label={t(labelKey)}
                  leftSection={<Icon size={18} stroke={1.7} />}
                  variant="filled"
                  styles={{
                    root: {
                      borderRadius: theme.radius.md,
                      fontWeight: active ? 600 : 500,
                    },
                  }}
                />
              );
            })}
          </Stack>
        </AppShell.Section>

        <AppShell.Section>
          <Box
            px="xs"
            pt="sm"
            style={{ borderTop: `1px solid ${theme.other.surfaces.border}` }}
          >
            <Text fz={10} c="dimmed" lh={1.5}>
              {t('app.footer')}
            </Text>
          </Box>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        <Box p={{ base: 'md', sm: 'lg' }} maw={1400} mx="auto">
          {children}
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}
