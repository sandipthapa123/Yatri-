import { useCallback, useEffect, useState } from 'react';

export type BootstrapStatus = 'loading' | 'ready' | 'error';

interface BootstrapState {
  status: BootstrapStatus;
  error: Error | null;
  retry: () => void;
}

/**
 * Placeholder app bootstrap: in later phases this resolves the session,
 * feature flags, and any remote config the app needs before showing the
 * home screen. For now it is a single async tick so the loading and error
 * states have a real (retryable) state machine to drive them, instead of
 * being purely presentational.
 */
async function bootstrap(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 400));
}

export function useAppBootstrap(): BootstrapState {
  const [status, setStatus] = useState<BootstrapStatus>('loading');
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    bootstrap()
      .then(() => {
        if (!cancelled) setStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error('Failed to start Yatri.'));
        setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setStatus('loading');
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  return { status, error, retry };
}
