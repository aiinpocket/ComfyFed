import { Center, Loader, Stack, Text } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';

import { api, onUnauthorized, setCsrf, type Role } from './api';
import { AppLayout } from './components/AppLayout';
import { Logo } from './components/Logo';
import { Dashboard } from './pages/Dashboard';
import { JobDetail } from './pages/JobDetail';
import { Jobs } from './pages/Jobs';
import { Login } from './pages/Login';
import { Reports } from './pages/Reports';
import { Settings } from './pages/Settings';
import { Setup } from './pages/Setup';
import { Users } from './pages/Users';
import { Workers } from './pages/Workers';

type AuthState = 'checking' | 'authenticated' | 'anonymous' | 'setup_needed';

/** The signed-in user, as far as the console's UI needs to know: enough to
 * gate nav items and routes. `role` defaults to the least-privileged 'user'
 * when the server ever omits it, rather than accidentally granting admin. */
export interface CurrentUser {
  username: string;
  role: Role;
}

export function App() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [auth, setAuth] = useState<AuthState>('checking');
  const [platformUrl, setPlatformUrl] = useState('');
  const [user, setUser] = useState<CurrentUser | null>(null);

  const refreshSession = useCallback(async () => {
    try {
      const me = await api.me();
      setPlatformUrl(me.platform_url ?? '');
      if (me.authenticated) {
        setUser({ username: me.username ?? '', role: me.role === 'admin' ? 'admin' : 'user' });
        setAuth('authenticated');
      } else {
        setUser(null);
        setAuth('anonymous');
      }
    } catch {
      setUser(null);
      setAuth('anonymous');
    }
  }, []);

  // Cloud-only first-run gate (see api.ts's `setupStatus` docstring): the
  // Python server has no `/api/setup/*` routes at all, so any failure here
  // (network error, 404) is silently treated as "setup not needed" and we
  // fall straight through to the normal session check.
  const bootstrap = useCallback(async () => {
    try {
      const status = await api.setupStatus();
      if (status.needed) {
        setAuth('setup_needed');
        return;
      }
    } catch {
      /* Python server, or a transient network error -- proceed as normal. */
    }
    await refreshSession();
  }, [refreshSession]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const handleSetupComplete = useCallback(() => {
    // POST /api/setup does not log the caller in -- flow into the normal
    // login form (see Setup.tsx's `onSetupComplete` docstring).
    setAuth('anonymous');
  }, []);

  // Any 401 from anywhere in the app drops us back to the login screen.
  useEffect(() => {
    onUnauthorized(() => {
      setCsrf(null);
      setUser(null);
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

  if (auth === 'setup_needed') {
    return <Setup onSetupComplete={handleSetupComplete} />;
  }

  if (auth === 'anonymous') {
    return (
      <Routes>
        <Route path="/login" element={<Login onAuthenticated={handleAuthenticated} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  const role: Role = user?.role ?? 'user';
  const isAdmin = role === 'admin';

  return (
    <AppLayout
      platformUrl={platformUrl}
      role={role}
      onLoggedOut={() => {
        setUser(null);
        setAuth('anonymous');
      }}
    >
      <Routes>
        <Route path="/dashboard" element={<Dashboard role={role} />} />
        <Route path="/jobs" element={<Jobs role={role} />} />
        <Route path="/jobs/:id" element={<JobDetail role={role} />} />
        {/* Workers is open to every role: `GET /api/workers` is a read-only
            fleet listing any logged-in user may load (workers are shared
            infrastructure). The page itself hides the admin-only mutation
            controls (add/disable/delete) for non-admins via its `role` prop,
            and those endpoints stay admin-gated server-side regardless. */}
        <Route path="/workers" element={<Workers role={role} />} />
        {/* Users stays admin-only: guarded at the route level, not just hidden
            from nav -- a non-admin deep-linking here bounces to the dashboard
            instead of rendering a page whose `/api/users` calls would 403. */}
        <Route
          path="/users"
          element={isAdmin ? <Users /> : <Navigate to="/dashboard" replace />}
        />
        <Route path="/reports" element={<Reports role={role} />} />
        <Route path="/settings" element={<Settings platformUrl={platformUrl} role={role} />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </AppLayout>
  );
}
