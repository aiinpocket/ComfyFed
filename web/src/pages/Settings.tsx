import {
  Badge,
  Button,
  Card,
  CopyButton,
  Group,
  NumberInput,
  PasswordInput,
  Progress,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
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
  IconEyeOff,
  IconKey,
  IconDatabase,
  IconPhoto,
  IconRefresh,
  IconWorldBolt,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, api, type ObjectInfoMode, type Role } from '../api';
import { Mono, SectionHeader } from '../components/Primitives';
import { persistLang, type Lang } from '../i18n';
import { formatBytes } from '../lib/format';
import { ApiTokensCard } from './ApiTokensCard';

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

  // Phase 3.3 §3.7: same GET /api/settings read as `object_info_mode` above.
  const [splitBatches, setSplitBatches] = useState(true);
  const [savingSplitBatches, setSavingSplitBatches] = useState(false);

  // Phase 3.4 §2: `X-Forwarded-For` trust. `null` = this platform does not
  // expose the setting at all (the cloud stack reads Cloudflare's own
  // `CF-Connecting-IP`), in which case the switch is not rendered.
  const [trustProxy, setTrustProxy] = useState<boolean | null>(null);
  const [savingTrustProxy, setSavingTrustProxy] = useState(false);

  // Admin-configurable upload limits. Same GET /api/settings read as
  // `object_info_mode` above -- kept as strings while editing so a
  // half-typed "1." does not snap back under the admin's cursor.
  const [maxFileMb, setMaxFileMb] = useState<string | number>('');
  const [quotaGb, setQuotaGb] = useState<string | number>('');
  const [savingUploadLimits, setSavingUploadLimits] = useState(false);

  // 2026-09-20 NSFW review: the key itself is never sent back, only whether
  // one is stored. The input is a fresh draft each time; saving it empty
  // removes the stored key.
  const [nsfwKeySet, setNsfwKeySet] = useState(false);
  const [nsfwKeyDraft, setNsfwKeyDraft] = useState('');
  const [savingNsfwKey, setSavingNsfwKey] = useState(false);

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
        setSplitBatches(settings.split_batches);
        setTrustProxy(typeof settings.trust_proxy === 'boolean' ? settings.trust_proxy : null);
        setNsfwKeySet(settings.nsfw_check_api_key_set === true);
      })
      .catch(() => {
        /* left null; the segmented control below just won't render yet */
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  // Storage usage (`GET /api/staging`). 2026-09-20 檔案頁 §4 moved the file
  // LIST and its delete flow to `/files`; what stays here is the quota bar,
  // which needs the same listing's byte totals. Any role sees it -- storage
  // is personal, and there is no admin cross-user view on either stack.
  const [uploadsTotal, setUploadsTotal] = useState(0);
  // Usage vs quota. `total_bytes` is staging alone; the quota counts the
  // caller's saved panel files too, so the bar shows their sum.
  const [uploadsUserdata, setUploadsUserdata] = useState(0);
  // 2026-09-24: job inputs/outputs count too.
  const [uploadsJobs, setUploadsJobs] = useState(0);
  const [uploadsQuota, setUploadsQuota] = useState(0);
  const [uploadsBusy, setUploadsBusy] = useState(false);

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
        setUploadsTotal(listing.total_bytes);
        setUploadsUserdata(listing.userdata_bytes ?? 0);
        setUploadsJobs(listing.jobs_bytes ?? 0);
        setUploadsQuota(listing.quota_bytes ?? 0);
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
    // An empty NumberInput reads as '' and Number('') === 0 -- a finite
    // value the server rightly 400s. Block the not-actually-filled form
    // client-side instead of round-tripping for an error (review finding).
    if (maxFileMb === '' || quotaGb === '' || !Number.isFinite(mb) || !Number.isFinite(gb) || mb <= 0 || gb <= 0) return;
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

  const saveNsfwKey = async (event: React.FormEvent) => {
    event.preventDefault();
    if (savingNsfwKey) return;
    const key = nsfwKeyDraft.trim();
    setSavingNsfwKey(true);
    try {
      const result = await api.updateSettings({ nsfw_check_api_key: key });
      setNsfwKeySet(result.nsfw_check_api_key_set === true);
      setNsfwKeyDraft('');
      notifications.show({
        color: 'teal',
        icon: <IconCheck size={16} />,
        title: t('settings.nsfw_saved'),
        message: t('settings.nsfw_saved_hint'),
      });
    } catch (caught) {
      notifyFailure(t('settings.nsfw_save_failed'), caught);
    } finally {
      setSavingNsfwKey(false);
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

  const changeSplitBatches = async (value: boolean) => {
    const previous = splitBatches;
    setSplitBatches(value);
    setSavingSplitBatches(true);
    try {
      await api.updateSettings({ split_batches: value });
    } catch (caught) {
      setSplitBatches(previous);
      notifyFailure(t('settings.split_batches_save_failed'), caught);
    } finally {
      setSavingSplitBatches(false);
    }
  };

  const changeTrustProxy = async (value: boolean) => {
    const previous = trustProxy;
    setTrustProxy(value);
    setSavingTrustProxy(true);
    try {
      await api.updateSettings({ trust_proxy: value });
    } catch (caught) {
      setTrustProxy(previous);
      notifyFailure(t('settings.trust_proxy_save_failed'), caught);
    } finally {
      setSavingTrustProxy(false);
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
        <Stack gap="md">
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

        {/* API token / AI access (design §4.4) -- every role, not just admins:
            a plain user drives their own jobs through the MCP server too. */}
        <ApiTokensCard platformUrl={platformUrl} />
        </Stack>

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

          {isAdmin && (
          <Card style={cardStyle}>
            <form onSubmit={saveNsfwKey}>
              <Stack gap="sm">
                <Group justify="space-between" wrap="nowrap">
                  <Group gap="xs">
                    <IconEyeOff size={17} />
                    <Text fw={600}>{t('settings.nsfw_heading')}</Text>
                  </Group>
                  <Badge color={nsfwKeySet ? 'teal' : 'gray'} variant="light" size="sm" tt="none" fw={500}>
                    {nsfwKeySet ? t('settings.nsfw_status_set') : t('settings.nsfw_status_unset')}
                  </Badge>
                </Group>
                <Text size="sm" c="dimmed">
                  {t('settings.nsfw_hint')}
                </Text>
                <PasswordInput
                  label={t('settings.nsfw_api_key')}
                  description={nsfwKeySet ? t('settings.nsfw_api_key_set_hint') : t('settings.nsfw_api_key_unset_hint')}
                  placeholder="sk-ant-..."
                  value={nsfwKeyDraft}
                  onChange={(event) => setNsfwKeyDraft(event.currentTarget.value)}
                  autoComplete="off"
                />
                <Group justify="flex-end">
                  <Button
                    type="submit"
                    size="compact-sm"
                    leftSection={<IconDeviceFloppy size={15} />}
                    loading={savingNsfwKey}
                    disabled={!nsfwKeySet && nsfwKeyDraft.trim() === ''}
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
                {t('settings.uploads_quota_hint')}
              </Text>

              {uploadsQuota > 0 && (
                <Stack gap={4}>
                  <Group justify="space-between" gap="xs">
                    <Text size="xs" c="dimmed">
                      {t('settings.uploads_quota', {
                        used: formatBytes(uploadsTotal + uploadsUserdata + uploadsJobs),
                        quota: formatBytes(uploadsQuota),
                      })}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {Math.min(
                        100,
                        Math.round(((uploadsTotal + uploadsUserdata + uploadsJobs) / uploadsQuota) * 100),
                      )}
                      %
                    </Text>
                  </Group>
                  <Progress
                    aria-label={t('settings.uploads_quota_bar')}
                    value={Math.min(100, ((uploadsTotal + uploadsUserdata + uploadsJobs) / uploadsQuota) * 100)}
                    color={
                      (uploadsTotal + uploadsUserdata + uploadsJobs) / uploadsQuota >= 0.9 ? 'red' : undefined
                    }
                  />
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
                <Switch
                  label={t('settings.split_batches')}
                  description={t('settings.split_batches_hint')}
                  checked={splitBatches}
                  disabled={savingSplitBatches}
                  onChange={(event) => void changeSplitBatches(event.currentTarget.checked)}
                />
                {trustProxy !== null && (
                  <Switch
                    label={t('settings.trust_proxy')}
                    description={t('settings.trust_proxy_hint')}
                    checked={trustProxy}
                    disabled={savingTrustProxy}
                    onChange={(event) => void changeTrustProxy(event.currentTarget.checked)}
                  />
                )}
              </Stack>
            </Card>
          )}
        </Stack>
      </SimpleGrid>

    </Stack>
  );
}
