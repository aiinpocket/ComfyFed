import {
  ActionIcon,
  Button,
  Card,
  CopyButton,
  Group,
  Modal,
  NumberInput,
  PasswordInput,
  Progress,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconCheck,
  IconCopy,
  IconDeviceFloppy,
  IconKey,
  IconDatabase,
  IconPhoto,
  IconRefresh,
  IconTrash,
  IconWorldBolt,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, api, type ObjectInfoMode, type Role, type StagingFile } from '../api';
import { Mono, SectionHeader } from '../components/Primitives';
import { persistLang, type Lang } from '../i18n';
import { formatBytes } from '../lib/format';

interface SettingsProps {
  platformUrl: string;
  /** `user` sees only change-password + language: `GET /api/settings` (the
   * platform URL / object_info_mode section) is admin-only and 403s for
   * anyone else, so that section -- and the fetch that feeds it -- is
   * skipped entirely rather than shown broken. */
  role: Role;
}

export function Settings({ platformUrl, role }: SettingsProps) {
  const { t, i18n } = useTranslation();
  const theme = useMantineTheme();
  const isAdmin = role === 'admin';

  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);

  // Server-side settings, seeded from what the app already loaded.
  const [savedUrl, setSavedUrl] = useState(platformUrl);
  const [urlDraft, setUrlDraft] = useState(platformUrl);
  const [savingUrl, setSavingUrl] = useState(false);
  const [savingLang, setSavingLang] = useState(false);

  // Task 7's object_info merge mode, GET /api/settings so a console that
  // opens straight to this page (not seeded by a prior POST) still shows it.
  const [objectInfoMode, setObjectInfoMode] = useState<ObjectInfoMode | null>(null);
  const [savingObjectInfoMode, setSavingObjectInfoMode] = useState(false);

  // Admin-configurable upload limits. Same GET /api/settings read as
  // `object_info_mode` above -- kept as strings while editing so a
  // half-typed "1." does not snap back under the admin's cursor.
  const [maxFileMb, setMaxFileMb] = useState<string | number>('');
  const [quotaGb, setQuotaGb] = useState<string | number>('');
  const [savingUploadLimits, setSavingUploadLimits] = useState(false);

  useEffect(() => {
    setSavedUrl(platformUrl);
    setUrlDraft(platformUrl);
  }, [platformUrl]);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        setObjectInfoMode(settings.object_info_mode as ObjectInfoMode);
        setMaxFileMb(settings.upload_max_file_mb);
        setQuotaGb(settings.upload_user_quota_gb);
      })
      .catch(() => {
        /* left null; the segmented control below just won't render yet */
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  // The caller's OWN staged uploads (`GET /api/staging`). Any role sees this
  // card -- it is personal storage, and there is deliberately no admin
  // cross-user view of anyone's uploads on either stack.
  const [uploads, setUploads] = useState<StagingFile[]>([]);
  const [uploadsTotal, setUploadsTotal] = useState(0);
  // Usage vs quota. `total_bytes` is staging alone; the quota counts the
  // caller's saved panel files too, so the bar shows their sum.
  const [uploadsUserdata, setUploadsUserdata] = useState(0);
  const [uploadsQuota, setUploadsQuota] = useState(0);
  const [uploadsLoaded, setUploadsLoaded] = useState(false);
  const [uploadsBusy, setUploadsBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<StagingFile | null>(null);
  const [deleting, setDeleting] = useState(false);

  const urlValid = urlDraft.startsWith('http://') || urlDraft.startsWith('https://');
  const urlDirty = urlDraft !== savedUrl;

  const notifyFailure = (title: string, caught: unknown) =>
    notifications.show({
      color: 'red',
      icon: <IconX size={16} />,
      title,
      message:
        caught instanceof ApiError
          ? t(`errors.${caught.code}`, { defaultValue: caught.message })
          : t('errors.network'),
    });

  const loadUploads = useCallback(
    async (notifyOnFailure = true) => {
      setUploadsBusy(true);
      try {
        const listing = await api.listStaging();
        setUploads(listing.files);
        setUploadsTotal(listing.total_bytes);
        setUploadsUserdata(listing.userdata_bytes ?? 0);
        setUploadsQuota(listing.quota_bytes ?? 0);
        setUploadsLoaded(true);
      } catch (caught) {
        if (notifyOnFailure) notifyFailure(t('settings.uploads_load_failed'), caught);
      } finally {
        setUploadsBusy(false);
      }
    },
    // `notifyFailure` closes over `t` only; re-creating this on a language
    // switch is harmless and keeps the effect below honest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  useEffect(() => {
    void loadUploads(false);
  }, [loadUploads]);

  const confirmDeleteUpload = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteStagingFile(deleteTarget.name);
      notifications.show({
        color: 'teal',
        icon: <IconCheck size={16} />,
        title: t('settings.uploads_deleted'),
        message: deleteTarget.name,
      });
      setDeleteTarget(null);
      await loadUploads();
    } catch (caught) {
      notifyFailure(t('settings.uploads_delete_failed'), caught);
    } finally {
      setDeleting(false);
    }
  };

  const savePlatformUrl = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!urlDirty || !urlValid || savingUrl) return;
    setSavingUrl(true);
    try {
      const result = await api.updateSettings({ platform_url: urlDraft.trim() });
      setSavedUrl(result.platform_url);
      setUrlDraft(result.platform_url);
      notifications.show({
        color: 'teal',
        icon: <IconCheck size={16} />,
        title: t('settings.platform_saved'),
        message: t('settings.platform_saved_hint'),
      });
    } catch (caught) {
      notifyFailure(t('settings.platform_save_failed'), caught);
    } finally {
      setSavingUrl(false);
    }
  };

  // The picker sets this browser's language AND the server-side default that
  // new sessions and the installer's bilingual output fall back to.
  const changeLanguage = async (value: string) => {
    const lang = value as Lang;
    persistLang(lang);
    setSavingLang(true);
    try {
      await api.updateSettings({ lang });
    } catch (caught) {
      notifyFailure(t('settings.language_save_failed'), caught);
    } finally {
      setSavingLang(false);
    }
  };

  const saveUploadLimits = async (event: React.FormEvent) => {
    event.preventDefault();
    if (savingUploadLimits) return;
    const mb = Number(maxFileMb);
    const gb = Number(quotaGb);
    if (!Number.isFinite(mb) || !Number.isFinite(gb)) return;
    setSavingUploadLimits(true);
    try {
      const result = await api.updateSettings({
        upload_max_file_mb: mb,
        upload_user_quota_gb: gb,
      });
      setMaxFileMb(result.upload_max_file_mb);
      setQuotaGb(result.upload_user_quota_gb);
      notifications.show({
        color: 'teal',
        icon: <IconCheck size={16} />,
        title: t('settings.upload_limits_saved'),
        message: t('settings.upload_limits_saved_hint'),
      });
      // The uploads card below quotes the quota -- refresh it so the bar and
      // the new ceiling agree immediately.
      await loadUploads(false);
    } catch (caught) {
      notifyFailure(t('settings.upload_limits_save_failed'), caught);
    } finally {
      setSavingUploadLimits(false);
    }
  };

  const changeObjectInfoMode = async (value: string) => {
    const mode = value as ObjectInfoMode;
    const previous = objectInfoMode;
    setObjectInfoMode(mode);
    setSavingObjectInfoMode(true);
    try {
      await api.updateSettings({ object_info_mode: mode });
    } catch (caught) {
      setObjectInfoMode(previous);
      notifyFailure(t('settings.object_info_save_failed'), caught);
    } finally {
      setSavingObjectInfoMode(false);
    }
  };

  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;
  const tooShort = newPassword.length > 0 && newPassword.length < 8;
  const canSubmit =
    Boolean(oldPassword) && newPassword.length >= 8 && newPassword === confirmPassword && !busy;

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      await api.changePassword(oldPassword, newPassword);
      notifications.show({
        color: 'teal',
        icon: <IconCheck size={16} />,
        title: t('settings.password_changed'),
        message: t('settings.password_changed_hint'),
      });
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (caught) {
      notifications.show({
        color: 'red',
        icon: <IconX size={16} />,
        title: t('settings.password_failed'),
        message:
          caught instanceof ApiError
            ? t(`errors.${caught.code}`, { defaultValue: caught.message })
            : t('errors.network'),
      });
    } finally {
      setBusy(false);
    }
  };

  const cardStyle = {
    background: theme.other.surfaces.card,
    borderColor: theme.other.surfaces.border,
  };

  return (
    <Stack gap="lg">
      <SectionHeader title={t('settings.title')} description={t('settings.subtitle')} />

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        <Card style={cardStyle}>
          <form onSubmit={changePassword}>
            <Stack gap="md">
              <Group gap="xs">
                <IconKey size={17} />
                <Text fw={600}>{t('settings.password_heading')}</Text>
              </Group>
              <Text size="sm" c="dimmed">
                {t('settings.password_hint')}
              </Text>

              <PasswordInput
                label={t('settings.old_password')}
                value={oldPassword}
                onChange={(event) => setOldPassword(event.currentTarget.value)}
                autoComplete="current-password"
              />
              <PasswordInput
                label={t('settings.new_password')}
                description={t('settings.password_rule')}
                value={newPassword}
                onChange={(event) => setNewPassword(event.currentTarget.value)}
                error={tooShort ? t('settings.password_too_short') : undefined}
                autoComplete="new-password"
              />
              <PasswordInput
                label={t('settings.confirm_password')}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.currentTarget.value)}
                error={mismatch ? t('settings.password_mismatch') : undefined}
                autoComplete="new-password"
              />

              <Group justify="flex-end">
                <Button type="submit" disabled={!canSubmit} loading={busy}>
                  {t('settings.change_password')}
                </Button>
              </Group>
            </Stack>
          </form>
        </Card>

        <Stack gap="md">
          {isAdmin && (
          <Card style={cardStyle}>
            <Stack gap="sm">
              <Group gap="xs">
                <IconWorldBolt size={17} />
                <Text fw={600}>{t('settings.platform_heading')}</Text>
              </Group>
              <Text size="sm" c="dimmed">
                {t('settings.platform_hint')}
              </Text>
              <Group
                justify="space-between"
                gap="sm"
                p="sm"
                wrap="nowrap"
                style={{
                  background: theme.other.surfaces.raised,
                  border: `1px solid ${theme.other.surfaces.border}`,
                  borderRadius: theme.radius.md,
                }}
              >
                <Mono c="" size="sm">
                  {savedUrl || t('settings.platform_unset')}
                </Mono>
                {savedUrl && (
                  <CopyButton value={savedUrl} timeout={1500}>
                    {({ copied, copy }) => (
                      <Tooltip label={copied ? t('common.copied') : t('common.copy')}>
                        <Button
                          size="compact-sm"
                          variant="subtle"
                          color={copied ? 'teal' : 'gray'}
                          onClick={copy}
                          leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                        >
                          {copied ? t('common.copied') : t('common.copy')}
                        </Button>
                      </Tooltip>
                    )}
                  </CopyButton>
                )}
              </Group>

              <form onSubmit={savePlatformUrl}>
                <Stack gap="xs">
                  <TextInput
                    label={t('settings.platform_edit_label')}
                    placeholder="https://your-domain.example"
                    value={urlDraft}
                    onChange={(event) => setUrlDraft(event.currentTarget.value)}
                    error={urlDraft && !urlValid ? t('settings.platform_invalid') : undefined}
                  />
                  <Group justify="space-between" align="center" wrap="wrap" gap="xs">
                    <Text size="xs" c="dimmed" style={{ flex: 1, minWidth: 180 }}>
                      {t('settings.platform_change_hint')}
                    </Text>
                    <Button
                      type="submit"
                      size="compact-sm"
                      leftSection={<IconDeviceFloppy size={15} />}
                      disabled={!urlDirty || !urlValid}
                      loading={savingUrl}
                    >
                      {t('common.save')}
                    </Button>
                  </Group>
                </Stack>
              </form>
            </Stack>
          </Card>
          )}

          {isAdmin && (
          <Card style={cardStyle}>
            <form onSubmit={saveUploadLimits}>
              <Stack gap="sm">
                <Group gap="xs">
                  <IconDatabase size={17} />
                  <Text fw={600}>{t('settings.upload_limits_heading')}</Text>
                </Group>
                <Text size="sm" c="dimmed">
                  {t('settings.upload_limits_hint')}
                </Text>
                <NumberInput
                  label={t('settings.upload_max_file_mb')}
                  description={t('settings.upload_max_file_mb_hint')}
                  value={maxFileMb}
                  onChange={setMaxFileMb}
                  min={1}
                  max={1024}
                  step={1}
                  allowDecimal={false}
                  allowNegative={false}
                />
                <NumberInput
                  label={t('settings.upload_user_quota_gb')}
                  description={t('settings.upload_user_quota_gb_hint')}
                  value={quotaGb}
                  onChange={setQuotaGb}
                  min={0.1}
                  max={1024}
                  step={0.5}
                  decimalScale={2}
                  allowNegative={false}
                />
                <Group justify="flex-end">
                  <Button
                    type="submit"
                    size="compact-sm"
                    leftSection={<IconDeviceFloppy size={15} />}
                    loading={savingUploadLimits}
                  >
                    {t('common.save')}
                  </Button>
                </Group>
              </Stack>
            </form>
          </Card>
          )}

          <Card style={cardStyle}>
            <Stack gap="sm">
              <Text fw={600}>{t('settings.language_heading')}</Text>
              <Text size="sm" c="dimmed">
                {t('settings.language_hint')}
              </Text>
              <SegmentedControl
                value={i18n.language === 'zh-TW' ? 'zh-TW' : 'en'}
                disabled={savingLang}
                onChange={(value) => void changeLanguage(value)}
                data={[
                  { value: 'zh-TW', label: '繁體中文' },
                  { value: 'en', label: 'English' },
                ]}
                styles={{ root: { background: theme.other.surfaces.raised } }}
              />
            </Stack>
          </Card>

          <Card style={cardStyle}>
            <Stack gap="sm">
              <Group justify="space-between" wrap="nowrap">
                <Group gap="xs">
                  <IconPhoto size={17} />
                  <Text fw={600}>{t('settings.uploads_heading')}</Text>
                </Group>
                <Button
                  size="compact-sm"
                  variant="subtle"
                  color="gray"
                  leftSection={<IconRefresh size={14} />}
                  loading={uploadsBusy}
                  onClick={() => void loadUploads()}
                >
                  {t('settings.uploads_refresh')}
                </Button>
              </Group>
              <Text size="sm" c="dimmed">
                {t('settings.uploads_hint')}
              </Text>

              {uploadsQuota > 0 && (
                <Stack gap={4}>
                  <Group justify="space-between" gap="xs">
                    <Text size="xs" c="dimmed">
                      {t('settings.uploads_quota', {
                        used: formatBytes(uploadsTotal + uploadsUserdata),
                        quota: formatBytes(uploadsQuota),
                      })}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {Math.min(
                        100,
                        Math.round(((uploadsTotal + uploadsUserdata) / uploadsQuota) * 100),
                      )}
                      %
                    </Text>
                  </Group>
                  <Progress
                    aria-label={t('settings.uploads_quota_bar')}
                    value={Math.min(100, ((uploadsTotal + uploadsUserdata) / uploadsQuota) * 100)}
                    color={
                      (uploadsTotal + uploadsUserdata) / uploadsQuota >= 0.9 ? 'red' : undefined
                    }
                  />
                </Stack>
              )}

              {uploadsLoaded && uploads.length === 0 && (
                <Text size="sm" c="dimmed">
                  {t('settings.uploads_empty')}
                </Text>
              )}

              {uploads.length > 0 && (
                <Stack gap="xs">
                  {uploads.map((file) => (
                    <Group
                      key={file.name}
                      justify="space-between"
                      gap="sm"
                      wrap="nowrap"
                      p="xs"
                      style={{
                        background: theme.other.surfaces.raised,
                        border: `1px solid ${theme.other.surfaces.border}`,
                        borderRadius: theme.radius.md,
                      }}
                    >
                      <Stack gap={2} style={{ minWidth: 0 }}>
                        <Mono c="" size="sm">
                          {file.name}
                        </Mono>
                        <Text size="xs" c="dimmed">
                          {formatBytes(file.size)} ·{' '}
                          {new Date(file.modified * 1000).toLocaleString()}
                        </Text>
                      </Stack>
                      <Tooltip label={t('settings.uploads_delete')}>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label={`${t('settings.uploads_delete')} ${file.name}`}
                          onClick={() => setDeleteTarget(file)}
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  ))}
                  <Text size="xs" c="dimmed">
                    {t('settings.uploads_total', {
                      count: uploads.length,
                      size: formatBytes(uploadsTotal),
                    })}
                  </Text>
                </Stack>
              )}
            </Stack>
          </Card>

          {objectInfoMode && (
            <Card style={cardStyle}>
              <Stack gap="sm">
                <Text fw={600}>{t('settings.object_info_heading')}</Text>
                <Text size="sm" c="dimmed">
                  {t('settings.object_info_hint')}
                </Text>
                <SegmentedControl
                  value={objectInfoMode}
                  disabled={savingObjectInfoMode}
                  onChange={(value) => void changeObjectInfoMode(value)}
                  data={[
                    { value: 'union', label: t('settings.object_info_union') },
                    { value: 'intersection', label: t('settings.object_info_intersection') },
                  ]}
                  styles={{ root: { background: theme.other.surfaces.raised } }}
                />
              </Stack>
            </Card>
          )}
        </Stack>
      </SimpleGrid>

      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={t('settings.uploads_delete')}
      >
        <Stack gap="md">
          <Text size="sm">
            {t('settings.uploads_confirm', { name: deleteTarget?.name ?? '' })}
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setDeleteTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button color="red" loading={deleting} onClick={() => void confirmDeleteUpload()}>
              {t('settings.uploads_delete')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
