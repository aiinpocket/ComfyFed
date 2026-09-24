import { useCallback, useEffect, useRef, useState } from 'react';

export interface PollingState<T> {
  data: T | null;
  /** True only until the first successful (or failed) load — drives skeletons. */
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * Poll an async loader on an interval.
 *
 * Refreshes never flip `loading` back on, so the UI updates in place instead
 * of flashing skeletons every tick. Polling pauses while the tab is hidden.
 */
export function usePolling<T>(
  loader: () => Promise<T>,
  intervalMs: number,
  enabled = true,
): PollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const result = await loaderRef.current();
      if (!mountedRef.current) return;
      setData(result);
      setError(null);
    } catch (caught) {
      if (!mountedRef.current) return;
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs, refresh]);

  return { data, loading, error, refresh };
}
