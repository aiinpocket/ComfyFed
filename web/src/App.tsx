import { Center, Loader, Stack, Text } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';

import { api, onUnauthorized, setCsrf } from './api';
import { AppLayout } from './components/AppLayout';
import { Logo } from './components/Logo';
import { Dashboard } from './pages/Dashboard';
import { JobDetail } from './pages/JobDetail';
import { Jobs } from './pages/Jobs';
import { Login } from './pages/Login';
import { Reports } from './pages/Reports';
import { Settings } from './pages/Settings';
import { Workers } from './pages/Workers';

type AuthState = 'checking' | 'authenticated' | 'anonymous';

export function App() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [auth, setAuth] = useState<AuthState>('checking');
  const [platformUrl, setPlatformUrl] = useState('');

  const refreshSession = useCallback(async () => {
    try {
      const me = await api.me();
      setPlatformUrl(me.platform_url ?? '');
      setAuth(me.authenticated ? 'authenticated' : 'anonymous');
    } catch {
      setAuth('anonymous');
    }
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  // Any 401 from anywhere in the app drops us back to the login screen.
  useEffect(() => {
    onUnauthorized(() => {
      setCsrf(null);
      setAuth('anonymous');
      navigate('/login', { replace: true });
    });
    return () => onUnauthorized(null);
  }, [navigate]);

  const handleAuthenticated = useCallback(async () => {
    await refreshSession();
    navigate('/dashboard', { replace: true });
  }, [navigate, refreshSession]);

  if (auth === 'checking') {
    return (
      <Center mih="100vh">
        <Stack align="center" gap="sm">
          <Logo size={38} />
          <Loader size="sm" color="federation" />
          <Text size="sm" c="dimmed">
            {t('common.loading')}
          </Text>
        </Stack>
      </Center>
    );
  }

  if (auth === 'anonymous') {
    return (
      <Routes>
        <Route path="/login" element={<Login onAuthenticated={handleAuthenticated} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <AppLayout platformUrl={platformUrl} onLoggedOut={() => setAuth('anonymous')}>
      <Routes>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/jobs/:id" element={<JobDetail />} />
        <Route path="/workers" element={<Workers />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings platformUrl={platformUrl} />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </AppLayout>
  );
}
