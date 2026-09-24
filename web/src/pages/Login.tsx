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
  TextInput,
  useMantineTheme,
} from '@mantine/core';
import { IconAlertTriangle, IconLock, IconUser } from '@tabler/icons-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, api } from '../api';
import { Logo } from '../components/Logo';
import { persistLang, type Lang } from '../i18n';

interface LoginProps {
  onAuthenticated: () => void;
}

export function Login({ onAuthenticated }: LoginProps) {
  const { t, i18n } = useTranslation();
  const theme = useMantineTheme();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!username || !password || busy) return;
    setBusy(true);
    setErrorCode(null);
    try {
      await api.login(username, password);
      setPassword('');
      onAuthenticated();
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
              {t('login.subtitle')}
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
                <TextInput
                  label={t('login.username')}
                  placeholder={t('login.username_placeholder')}
                  leftSection={<IconUser size={16} />}
                  value={username}
                  onChange={(event) => setUsername(event.currentTarget.value)}
                  autoFocus
                  autoComplete="username"
                  size="md"
                  data-autofocus
                />

                <PasswordInput
                  label={t('login.password')}
                  placeholder={t('login.password_placeholder')}
                  leftSection={<IconLock size={16} />}
                  value={password}
                  onChange={(event) => setPassword(event.currentTarget.value)}
                  autoComplete="current-password"
                  size="md"
                />

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

                <Button
                  type="submit"
                  size="md"
                  loading={busy}
                  disabled={!username || !password}
                  fullWidth
                >
                  {t('login.submit')}
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
            {t('login.hint')}
          </Text>
        </Stack>
      </Center>
    </Box>
  );
}
