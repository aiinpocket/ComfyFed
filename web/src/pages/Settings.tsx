import {
  Button,
  Card,
  CopyButton,
  Group,
  PasswordInput,
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
  IconWorldBolt,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, api } from '../api';
import { Mono, SectionHeader } from '../components/Primitives';
import { persistLang, type Lang } from '../i18n';

interface SettingsProps {
  platformUrl: string;
}

export function Settings({ platformUrl }: SettingsProps) {
  const { t, i18n } = useTranslation();
  const theme = useMantineTheme();

  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);

  // Server-side settings, seeded from what the app already loaded.
  const [savedUrl, setSavedUrl] = useState(platformUrl);
  const [urlDraft, setUrlDraft] = useState(platformUrl);
  const [savingUrl, setSavingUrl] = useState(false);
  const [savingLang, setSavingLang] = useState(false);

  useEffect(() => {
    setSavedUrl(platformUrl);
    setUrlDraft(platformUrl);
  }, [platformUrl]);

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
        </Stack>
      </SimpleGrid>
    </Stack>
  );
}
