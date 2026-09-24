import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  Modal,
  NumberInput,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAdjustments,
  IconAlertTriangle,
  IconCheck,
  IconCopy,
  IconKey,
  IconPlus,
  IconUserOff,
  IconUsers,
  IconUserCheck,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, api, type AppUser, type Role, type UserPatch } from '../api';
import { EmptyState, Mono, SectionHeader, TableSkeleton } from '../components/Primitives';
import { formatAbsolute, formatBytes } from '../lib/format';
import { usePolling } from '../lib/usePolling';

const POLL_MS = 15000;

function errorMessage(caught: unknown, t: (key: string, opts?: Record<string, unknown>) => string): string {
  return caught instanceof ApiError
    ? t(`errors.${caught.code}`, { defaultValue: caught.message })
    : t('errors.network');
}

export function Users() {
  const { t } = useTranslation();
  const theme = useMantineTheme();

  const loader = useCallback(() => api.listUsers(), []);
  const { data, loading, error, refresh } = usePolling(loader, POLL_MS);
  const users = data ?? [];

  const [createOpen, setCreateOpen] = useState(false);
  const [oneTimePassword, setOneTimePassword] = useState<{ username: string; password: string } | null>(null);

  const [resetTarget, setResetTarget] = useState<AppUser | null>(null);
  const [resetting, setResetting] = useState(false);

  const [toggleTarget, setToggleTarget] = useState<AppUser | null>(null);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const [roleTarget, setRoleTarget] = useState<AppUser | null>(null);
  const [changingRole, setChangingRole] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);

  // 2026-09-20 per-user limits + NSFW. The platform defaults are shown as
  // the hint under each blank field, so the admin knows what "blank" means.
  const [editTarget, setEditTarget] = useState<AppUser | null>(null);
  const [platformDefaults, setPlatformDefaults] = useState<{ maxFileMb: number; quotaGb: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        setPlatformDefaults({ maxFileMb: settings.upload_max_file_mb, quotaGb: settings.upload_user_quota_gb });
      })
      .catch(() => {
        /* hints just stay blank */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const doResetPassword = async () => {
    if (!resetTarget) return;
    setResetting(true);
    try {
      const { password } = await api.resetUserPassword(resetTarget.id);
      setOneTimePassword({ username: resetTarget.username, password });
      setResetTarget(null);
      await refresh();
    } catch (caught) {
      notifications.show({
        color: 'red',
        icon: <IconX size={16} />,
        title: t('users.reset_failed'),
        message: errorMessage(caught, t),
      });
    } finally {
      setResetting(false);
    }
  };

  const doToggleDisabled = async () => {
    if (!toggleTarget) return;
    setToggling(true);
    setToggleError(null);
    const nextDisabled = !toggleTarget.disabled;
    try {
      await api.patchUser(toggleTarget.id, { disabled: nextDisabled });
      notifications.show({
        color: 'teal',
        icon: <IconCheck size={16} />,
        title: nextDisabled ? t('users.disabled_title') : t('users.enabled_title'),
        message: nextDisabled
          ? t('users.disabled_message', { name: toggleTarget.username })
          : t('users.enabled_message', { name: toggleTarget.username }),
      });
      setToggleTarget(null);
      await refresh();
    } catch (caught) {
      // Shown inline in the confirm dialog (not just a toast) -- this is
      // where `last_admin` (400, guarding the only active admin) surfaces.
      setToggleError(errorMessage(caught, t));
    } finally {
      setToggling(false);
    }
  };

  const doChangeRole = async () => {
    if (!roleTarget) return;
    setChangingRole(true);
    setRoleError(null);
    const nextRole: Role = roleTarget.role === 'admin' ? 'user' : 'admin';
    try {
      await api.patchUser(roleTarget.id, { role: nextRole });
      notifications.show({
        color: 'teal',
        icon: <IconCheck size={16} />,
        title: t('users.role_changed_title'),
        message: t('users.role_changed_message', { name: roleTarget.username, role: t(`users.role_${nextRole}`) }),
      });
      setRoleTarget(null);
      await refresh();
    } catch (caught) {
      // Shown inline in the confirm dialog -- `last_admin` also guards demotion.
      setRoleError(errorMessage(caught, t));
    } finally {
      setChangingRole(false);
    }
  };

  return (
    <Stack gap="lg">
      <SectionHeader
        title={t('users.title')}
        description={t('users.subtitle')}
        action={
          <Button leftSection={<IconPlus size={16} />} onClick={() => setCreateOpen(true)}>
            {t('users.add')}
          </Button>
        }
      />

      {error && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
          {t('users.load_error')}
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
        ) : users.length === 0 ? (
          <EmptyState
            icon={<IconUsers size={26} />}
            title={t('users.empty')}
            description={t('users.empty_hint')}
            action={
              <Button variant="light" leftSection={<IconPlus size={16} />} onClick={() => setCreateOpen(true)}>
                {t('users.add')}
              </Button>
            }
          />
        ) : (
          <Table.ScrollContainer minWidth={880}>
            <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
              <Table.Thead style={{ background: theme.other.surfaces.raised }}>
                <Table.Tr>
                  <Table.Th>{t('users.col_username')}</Table.Th>
                  <Table.Th>{t('users.col_role')}</Table.Th>
                  <Table.Th>{t('users.col_status')}</Table.Th>
                  <Table.Th>{t('users.col_created')}</Table.Th>
                  <Table.Th>{t('users.col_jobs')}</Table.Th>
                  <Table.Th>{t('users.col_used')}</Table.Th>
                  <Table.Th>{t('users.col_limits')}</Table.Th>
                  <Table.Th w={400} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {users.map((user) => (
                  <Table.Tr key={user.id} opacity={user.disabled ? 0.55 : 1}>
                    <Table.Td>
                      <Stack gap={1}>
                        <Text size="sm" fw={500}>
                          {user.username}
                        </Text>
                        <Mono size="xs" title={user.id}>
                          {user.id}
                        </Mono>
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      <Badge color={user.role === 'admin' ? 'federation' : 'gray'} variant="light" size="sm" tt="none" fw={500}>
                        {t(`users.role_${user.role}`)}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Badge color={user.disabled ? 'gray' : 'teal'} variant="light" size="sm" tt="none" fw={500}>
                        {user.disabled ? t('users.status_disabled') : t('users.status_enabled')}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {formatAbsolute(user.created_at)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {user.jobs}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c={user.used_bytes == null ? 'dimmed' : undefined} style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {user.used_bytes == null ? '—' : formatBytes(user.used_bytes)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        <Text size="sm" c={user.max_file_mb == null && user.quota_gb == null ? 'dimmed' : undefined} style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {user.max_file_mb == null && user.quota_gb == null
                            ? t('users.limits_default')
                            : `${user.max_file_mb ?? platformDefaults?.maxFileMb ?? '—'} MB / ${user.quota_gb ?? platformDefaults?.quotaGb ?? '—'} GB`}
                        </Text>
                        {user.nsfw_allowed === false && (
                          <Badge color="red" variant="light" size="sm" tt="none" fw={500}>
                            {t('users.nsfw_off')}
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" justify="flex-end" wrap="nowrap">
                        <Button
                          size="compact-sm"
                          variant="subtle"
                          leftSection={<IconAdjustments size={14} />}
                          onClick={() => setEditTarget(user)}
                        >
                          {t('users.edit_limits')}
                        </Button>
                        <Button
                          size="compact-sm"
                          variant="subtle"
                          leftSection={<IconKey size={14} />}
                          onClick={() => setResetTarget(user)}
                        >
                          {t('users.reset_password')}
                        </Button>
                        <Button
                          size="compact-sm"
                          variant="subtle"
                          onClick={() => {
                            setRoleError(null);
                            setRoleTarget(user);
                          }}
                        >
                          {user.role === 'admin' ? t('users.make_user') : t('users.make_admin')}
                        </Button>
                        <Button
                          size="compact-sm"
                          variant="subtle"
                          color={user.disabled ? 'teal' : 'red'}
                          leftSection={
                            user.disabled ? <IconUserCheck size={14} /> : <IconUserOff size={14} />
                          }
                          onClick={() => {
                            setToggleError(null);
                            setToggleTarget(user);
                          }}
                        >
                          {user.disabled ? t('users.enable') : t('users.disable')}
                        </Button>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>

      <CreateUserModal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={refresh}
        onShowOneTimePassword={(username, password) => setOneTimePassword({ username, password })}
      />

      <EditLimitsModal
        target={editTarget}
        platformDefaults={platformDefaults}
        onClose={() => setEditTarget(null)}
        onSaved={refresh}
      />

      {/* Reset-password confirm */}
      <Modal
        opened={resetTarget !== null}
        onClose={() => setResetTarget(null)}
        title={t('users.reset_confirm_title')}
        size="sm"
      >
        <Stack gap="md">
          <Text size="sm">{t('users.reset_confirm_body', { name: resetTarget?.username ?? '' })}</Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setResetTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={doResetPassword} loading={resetting}>
              {t('users.reset_password')}
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Disable/enable confirm */}
      <Modal
        opened={toggleTarget !== null}
        onClose={() => setToggleTarget(null)}
        title={toggleTarget?.disabled ? t('users.enable_confirm_title') : t('users.disable_confirm_title')}
        size="sm"
      >
        <Stack gap="md">
          <Text size="sm">
            {toggleTarget?.disabled
              ? t('users.enable_confirm_body', { name: toggleTarget?.username ?? '' })
              : t('users.disable_confirm_body', { name: toggleTarget?.username ?? '' })}
          </Text>
          {toggleError && (
            <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
              {toggleError}
            </Alert>
          )}
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setToggleTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button color={toggleTarget?.disabled ? 'teal' : 'red'} onClick={doToggleDisabled} loading={toggling}>
              {toggleTarget?.disabled ? t('users.enable') : t('users.disable')}
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Role-change confirm */}
      <Modal
        opened={roleTarget !== null}
        onClose={() => setRoleTarget(null)}
        title={t('users.role_confirm_title')}
        size="sm"
      >
        <Stack gap="md">
          <Text size="sm">
            {t('users.role_confirm_body', {
              name: roleTarget?.username ?? '',
              role: t(`users.role_${roleTarget?.role === 'admin' ? 'user' : 'admin'}`),
            })}
          </Text>
          {roleError && (
            <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
              {roleError}
            </Alert>
          )}
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setRoleTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={doChangeRole} loading={changingRole}>
              {t('common.save')}
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* One-time password result (create + reset both funnel here) */}
      <Modal
        opened={oneTimePassword !== null}
        onClose={() => setOneTimePassword(null)}
        title={t('users.password_modal_title')}
        size="sm"
        closeOnClickOutside={false}
        closeOnEscape={false}
      >
        {oneTimePassword && (
          <Stack gap="md">
            <Alert color="yellow" variant="light" p="sm" icon={<IconAlertTriangle size={16} />}>
              <Text size="sm">{t('users.password_warning')}</Text>
            </Alert>
            <Text size="sm" c="dimmed">
              {t('users.password_body', { name: oneTimePassword.username })}
            </Text>
            <Box
              style={{
                borderRadius: theme.radius.md,
                border: `1px solid ${theme.other.surfaces.border}`,
              }}
            >
              <Code block style={{ background: theme.other.surfaces.raised, fontSize: 14 }}>
                {oneTimePassword.password}
              </Code>
            </Box>
            <Group justify="space-between" gap="sm">
              <Button variant="default" onClick={() => setOneTimePassword(null)}>
                {t('common.done')}
              </Button>
              <CopyButton value={oneTimePassword.password} timeout={1800}>
                {({ copied, copy }) => (
                  <Tooltip label={copied ? t('common.copied') : t('common.copy')}>
                    <Button
                      variant="light"
                      color={copied ? 'teal' : 'federation'}
                      leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                      onClick={copy}
                    >
                      {copied ? t('common.copied') : t('common.copy')}
                    </Button>
                  </Tooltip>
                )}
              </CopyButton>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}

/* ------------------------------------------------------------ create modal */

interface CreateUserModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: () => void;
  onShowOneTimePassword: (username: string, password: string) => void;
}

function CreateUserModal({ opened, onClose, onCreated, onShowOneTimePassword }: CreateUserModalProps) {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const reset = () => {
    setUsername('');
    setRole('user');
    setPassword('');
    setBusy(false);
    setFieldError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const create = async () => {
    if (!username.trim() || busy) return;
    setBusy(true);
    setFieldError(null);
    try {
      const created = await api.createUser(username.trim(), role, password.trim() || undefined);
      onCreated();
      onShowOneTimePassword(created.username, created.password);
      close();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldError(t(`errors.${caught.code}`, { defaultValue: caught.message }));
      } else {
        notifications.show({
          color: 'red',
          icon: <IconX size={16} />,
          title: t('users.create_failed'),
          message: t('errors.network'),
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={close} title={t('users.add_title')} size="md">
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t('users.add_body')}
        </Text>
        <TextInput
          label={t('users.username_label')}
          placeholder={t('users.username_placeholder')}
          value={username}
          onChange={(event) => setUsername(event.currentTarget.value)}
          error={fieldError}
          data-autofocus
        />
        <Select
          label={t('users.role_label')}
          value={role}
          onChange={(value) => setRole(value === 'admin' ? 'admin' : 'user')}
          data={[
            { value: 'user', label: t('users.role_user') },
            { value: 'admin', label: t('users.role_admin') },
          ]}
          allowDeselect={false}
        />
        <PasswordInput
          label={t('users.password_label')}
          placeholder={t('users.password_placeholder')}
          description={t('users.password_hint')}
          value={password}
          onChange={(event) => setPassword(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void create();
          }}
        />
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button onClick={create} loading={busy} disabled={!username.trim()}>
            {t('users.create')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/* ------------------------------------------------------------ limits modal */

interface EditLimitsModalProps {
  target: AppUser | null;
  platformDefaults: { maxFileMb: number; quotaGb: number } | null;
  onClose: () => void;
  onSaved: () => void;
}

/** Per-user upload limits and the NSFW permission (2026-09-20). A blank
 * quota field means "platform default" and is sent as `null`, which clears
 * any previous override; the NSFW switch is on for everyone unless the admin
 * turns it off here. */
function EditLimitsModal({ target, platformDefaults, onClose, onSaved }: EditLimitsModalProps) {
  const { t } = useTranslation();
  const [maxFileMb, setMaxFileMb] = useState<string | number>('');
  const [quotaGb, setQuotaGb] = useState<string | number>('');
  const [nsfwAllowed, setNsfwAllowed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the draft whenever a different row is opened.
  useEffect(() => {
    if (!target) return;
    setMaxFileMb(target.max_file_mb ?? '');
    setQuotaGb(target.quota_gb ?? '');
    setNsfwAllowed(target.nsfw_allowed !== false);
    setError(null);
    setBusy(false);
  }, [target]);

  const save = async () => {
    if (!target || busy) return;
    const mb = maxFileMb === '' ? null : Number(maxFileMb);
    const gb = quotaGb === '' ? null : Number(quotaGb);
    if ((mb !== null && !Number.isFinite(mb)) || (gb !== null && !Number.isFinite(gb))) return;
    const update: UserPatch = { max_file_mb: mb, quota_gb: gb, nsfw_allowed: nsfwAllowed ? null : false };
    setBusy(true);
    setError(null);
    try {
      await api.patchUser(target.id, update);
      notifications.show({
        color: 'teal',
        icon: <IconCheck size={16} />,
        title: t('users.edit_saved_title'),
        message: t('users.edit_saved_message', { name: target.username }),
      });
      onSaved();
      onClose();
    } catch (caught) {
      setError(errorMessage(caught, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={target !== null} onClose={onClose} title={t('users.edit_title', { name: target?.username ?? '' })} size="md">
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t('users.edit_body')}
        </Text>
        <NumberInput
          label={t('users.edit_max_file_mb')}
          description={platformDefaults ? t('users.edit_max_file_mb_hint', { value: platformDefaults.maxFileMb }) : undefined}
          placeholder={t('users.limits_default')}
          value={maxFileMb}
          onChange={setMaxFileMb}
          min={1}
          max={1024}
          step={1}
          allowDecimal={false}
          allowNegative={false}
        />
        <NumberInput
          label={t('users.edit_quota_gb')}
          description={platformDefaults ? t('users.edit_quota_gb_hint', { value: platformDefaults.quotaGb }) : undefined}
          placeholder={t('users.limits_default')}
          value={quotaGb}
          onChange={setQuotaGb}
          min={0.1}
          max={1024}
          step={0.5}
          decimalScale={2}
          allowNegative={false}
        />
        <Switch
          label={t('users.edit_nsfw')}
          description={t('users.edit_nsfw_hint')}
          checked={nsfwAllowed}
          onChange={(event) => setNsfwAllowed(event.currentTarget.checked)}
        />
        {error && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
            {error}
          </Alert>
        )}
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={save} loading={busy}>
            {t('common.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
