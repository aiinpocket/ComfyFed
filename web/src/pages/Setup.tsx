import {
  Alert,
  Box,
  Button,
  Card,
  Center,
  Group,
  PasswordInput,
  SegmentedControl,
  Stack,
  Text,
  useMantineTheme,
} from '@mantine/core';
import { IconAlertTriangle, IconKey, IconLock } from '@tabler/icons-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, api } from '../api';
import { Logo } from '../components/Logo';
import { persistLang, type Lang } from '../i18n';

interface SetupProps {
  /** Called once POST /api/setup succeeds. The route does not log the
   * caller in (see api.ts's `setup` docstring), so the parent flows back
   * into the normal login screen. */
  onSetupComplete: () => void;
}

const MIN_PASSWORD_LENGTH = 8;

export function Setup({ onSetupComplete }: SetupProps) {
  const { t, i18n } = useTranslation();
  const theme = useMantineTheme();
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = confirmPassword.length > 0 && confirmPassword !== password;
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const canSubmit =
    Boolean(token) && password.length >= MIN_PASSWORD_LENGTH && password === confirmPassword && !busy;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setErrorCode(null);
    try {
      await api.setup(token, password);
      onSetupComplete();
    } catch (error) {
      setErrorCode(error instanceof ApiError ? error.code : 'network');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box
      mih="100vh"
      style={{
        background: `radial-gradient(1100px 520px at 50% -10%, rgba(96,88,217,0.20), transparent 62%), ${theme.other.surfaces.base}`,
      }}
    >
      <Center mih="100vh" px="md">
        <Stack gap="lg" w="100%" maw={392}>
          <Stack align="center" gap={6}>
            <Logo size={44} />
            <Text fz={26} fw={700} style={{ letterSpacing: '-0.02em' }}>
              {t('app.name')}
            </Text>
            <Text size="sm" c="dimmed" ta="center">
              {t('setup.subtitle')}
            </Text>
          </Stack>

          <Card
            padding="lg"
            style={{
              background: theme.other.surfaces.card,
              borderColor: theme.other.surfaces.border,
              boxShadow: '0 18px 50px -22px rgba(0,0,0,0.85)',
            }}
          >
            <form onSubmit={submit}>
              <Stack gap="md">
                <PasswordInput
                  label={t('setup.token')}
                  placeholder={t('setup.token_placeholder')}
                  leftSection={<IconKey size={16} />}
                  value={token}
                  onChange={(event) => setToken(event.currentTarget.value)}
                  autoFocus
                  size="md"
                  data-autofocus
                />

                <PasswordInput
                  label={t('setup.password')}
                  placeholder={t('setup.password_placeholder')}
                  leftSection={<IconLock size={16} />}
                  value={password}
                  onChange={(event) => setPassword(event.currentTarget.value)}
                  error={tooShort ? t('setup.password_too_short') : undefined}
                  size="md"
                />

                <PasswordInput
                  label={t('setup.confirm_password')}
                  placeholder={t('setup.confirm_password_placeholder')}
                  leftSection={<IconLock size={16} />}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.currentTarget.value)}
                  error={mismatch ? t('setup.password_mismatch') : undefined}
                  size="md"
                />

                <Text size="xs" c="dimmed">
                  {t('setup.password_rule')}
                </Text>

                {errorCode && (
                  <Alert
                    color="red"
                    variant="light"
                    radius="md"
                    icon={<IconAlertTriangle size={16} />}
                    p="sm"
                  >
                    <Text size="sm">
                      {t(`errors.${errorCode}`, { defaultValue: t('errors.unknown') })}
                    </Text>
                  </Alert>
                )}

                <Button type="submit" size="md" loading={busy} disabled={!canSubmit} fullWidth>
                  {t('setup.submit')}
                </Button>
              </Stack>
            </form>
          </Card>

          <Group justify="center">
            <SegmentedControl
              size="xs"
              radius="md"
              value={i18n.language === 'zh-TW' ? 'zh-TW' : 'en'}
              onChange={(value) => persistLang(value as Lang)}
              data={[
                { value: 'zh-TW', label: '繁體中文' },
                { value: 'en', label: 'English' },
              ]}
            />
          </Group>

          <Text size="xs" c="dimmed" ta="center">
            {t('setup.hint')}
          </Text>
        </Stack>
      </Center>
    </Box>
  );
}
