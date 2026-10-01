import { ApiError, useAuth } from '@yatri/mobile-auth';
import { UiPreferencesContext } from '@yatri/mobile-ui';
import type { PreferencesResponse, PreferenceValue } from '@yatri/types';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AccessibilityInfo, AppState } from 'react-native';

import { preferencesApi } from './preferencesApi';
import { CONFLICT_NEWS, toUiPreferences } from './preferencesText';

/**
 * Loads the person's preferences from the server (the one source) and shares them with the whole app: the shared
 * components read them through the UI-preferences context, and the settings screen reads and changes them here.
 * The server is asked again when the app comes back to the foreground, so a change made on another device shows
 * up here without signing in again. A save quotes the version it was based on; if another device saved first the
 * server says so, the new settings replace the old ones on screen, and the person chooses again.
 *
 * If the server cannot be reached the last known settings stay in force (and the defaults before that), and the
 * screen says so: preferences never get in the way of riding.
 */
export interface PreferencesContextValue {
  /** What is in force, or null before the first load. */
  data: PreferencesResponse | null;
  loading: boolean;
  /** A problem loading, in words; null when fine. */
  loadError: string | null;
  /** Save one change (null puts it back to the default). Resolves to a sentence to announce, or throws one. */
  save: (key: string, value: PreferenceValue) => Promise<void>;
  reload: () => Promise<void>;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function usePreferences(): PreferencesContextValue {
  const v = useContext(PreferencesContext);
  if (!v) throw new Error('usePreferences must be used inside PreferencesProvider');
  return v;
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const { status, getAccessToken } = useAuth();
  const [data, setData] = useState<PreferencesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [systemMotion, setSystemMotion] = useState(false);
  const alive = useRef(true);
  const dataRef = useRef<PreferencesResponse | null>(null);
  dataRef.current = data;

  const reload = useCallback(async () => {
    if (status !== 'authenticated') return;
    setLoading(true);
    try {
      const next = await preferencesApi.get(await getAccessToken());
      if (!alive.current) return;
      setData(next);
      setLoadError(null);
    } catch (e) {
      if (alive.current) {
        setLoadError(
          e instanceof ApiError
            ? e.message
            : 'Your settings could not be loaded. The last ones are being used.',
        );
      }
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [status, getAccessToken]);

  // Load on sign-in, forget on sign-out, and look again whenever the app returns to the foreground.
  useEffect(() => {
    alive.current = true;
    if (status === 'authenticated') void reload();
    else setData(null);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void reload();
    });
    return () => {
      alive.current = false;
      sub.remove();
    };
  }, [status, reload]);

  // The phone's own reduce-motion setting, used when the person has not chosen.
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => live && setSystemMotion(v));
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setSystemMotion);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);

  const save = useCallback(
    async (key: string, value: PreferenceValue) => {
      const token = await getAccessToken();
      try {
        const next = await preferencesApi.update(token, {
          changes: { [key]: value },
          expectedVersion: dataRef.current?.version ?? 0,
        });
        setData(next);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
          const current = (e.details as { current?: PreferencesResponse } | undefined)?.current;
          if (current) setData(current);
          else await reload();
          throw new Error(CONFLICT_NEWS);
        }
        throw e instanceof ApiError
          ? new Error(e.message)
          : new Error('That did not save. Please try again.');
      }
    },
    [getAccessToken, reload],
  );

  const ui = useMemo(() => toUiPreferences(data, systemMotion), [data, systemMotion]);
  const value = useMemo(
    () => ({ data, loading, loadError, save, reload }),
    [data, loading, loadError, save, reload],
  );
  return (
    <PreferencesContext.Provider value={value}>
      <UiPreferencesContext.Provider value={ui}>{children}</UiPreferencesContext.Provider>
    </PreferencesContext.Provider>
  );
}
