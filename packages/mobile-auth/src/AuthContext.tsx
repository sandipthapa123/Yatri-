import type { AppUser } from '@yatri/shared';
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

import * as api from './apiClient';
import { ApiError, type PickedFile } from './apiClient';
import { shouldEndSession } from './sessionPolicy';
import {
  clearTokens,
  loadProfile,
  loadTokens,
  saveProfile,
  saveTokens,
  type StoredTokens,
} from './tokenStorage';
import type { RequestOtpResponse, UserRole, VerifyOtpResponse } from './types';

export type AuthStatus = 'loading' | 'unauthenticated' | 'authenticated';

export interface AuthContextValue {
  status: AuthStatus;
  user: AppUser | null;
  /** True once verify-otp resolves for a brand-new account (drives "profile setup" screens). */
  isNewUser: boolean;
  driverStatus: string | undefined;
  requestOtp: (phoneNumber: string) => Promise<RequestOtpResponse>;
  verifyOtp: (phoneNumber: string, code: string) => Promise<VerifyOtpResponse>;
  logout: () => Promise<void>;
  updateProfile: (update: {
    fullName?: string;
    profilePictureUrl?: string | null;
  }) => Promise<void>;
  uploadProfilePicture: (file: PickedFile) => Promise<void>;
  /** Sets the account to DEACTIVATED and signs the device out. Irreversible from the app. */
  deactivateAccount: () => Promise<void>;
  /** Returns a currently-valid access token, transparently refreshing if needed. */
  getAccessToken: () => Promise<string>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Refresh a little before actual expiry so an in-flight request never races
// a token that's about to die.
const REFRESH_SKEW_MS = 30_000;

export function AuthProvider({ role, children }: { role: UserRole; children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AppUser | null>(null);
  const [isNewUser, setIsNewUser] = useState(false);
  const [driverStatus, setDriverStatus] = useState<string | undefined>(undefined);

  const tokensRef = useRef<StoredTokens | null>(null);
  const accessTokenExpiresAtRef = useRef<number>(0);

  const applySession = useCallback(
    async (
      session: VerifyOtpResponse | (StoredTokens & { accessTokenExpiresInSeconds: number }),
    ) => {
      const stored: StoredTokens = {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        refreshTokenExpiresAt: session.refreshTokenExpiresAt,
      };
      tokensRef.current = stored;
      accessTokenExpiresAtRef.current = Date.now() + session.accessTokenExpiresInSeconds * 1000;
      await saveTokens(stored);
    },
    [],
  );

  const signOut = useCallback(async () => {
    tokensRef.current = null;
    accessTokenExpiresAtRef.current = 0;
    await clearTokens();
    setUser(null);
    setDriverStatus(undefined);
    setStatus('unauthenticated');
  }, []);

  const getAccessToken = useCallback(async (): Promise<string> => {
    const tokens = tokensRef.current;
    if (!tokens) throw new ApiError(401, 'UNAUTHENTICATED', 'Not signed in.');

    if (Date.now() < accessTokenExpiresAtRef.current - REFRESH_SKEW_MS) {
      return tokens.accessToken;
    }

    try {
      const refreshed = await api.refreshTokens(tokens.refreshToken);
      await applySession(refreshed);
      return refreshed.accessToken;
    } catch (err) {
      // Only the server rejecting the refresh token ends the session; being offline must not sign anyone out.
      if (shouldEndSession(err)) await signOut();
      throw err;
    }
  }, [applySession, signOut]);

  // On mount: try to resume a session from secure storage.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await loadTokens();
      if (!stored) {
        if (!cancelled) setStatus('unauthenticated');
        return;
      }
      tokensRef.current = stored;
      // We don't know the access token's real expiry after a cold start;
      // treat it as due for a refresh so getAccessToken always validates it.
      accessTokenExpiresAtRef.current = 0;
      try {
        const token = await getAccessToken();
        const profile = await api.getMe(token);
        if (cancelled) return;
        if (cancelled) return;
        const before = await loadProfile<{ driverStatus?: string }>();
        void saveProfile({ user: profile, driverStatus: before?.driverStatus });
        setUser(profile);
        setStatus('authenticated');
      } catch (err) {
        if (cancelled) return;
        if (shouldEndSession(err)) {
          await signOut();
          return;
        }
        // No connection (or the server is down) at start-up: open with the last known profile, so a ride in
        // progress can still be shown and recovered; the connectivity banner says the data may be out of date.
        const cached = await loadProfile<{ user: AppUser; driverStatus?: string }>();
        if (cached?.user) {
          setUser(cached.user);
          setDriverStatus(cached.driverStatus);
          setStatus('authenticated');
        } else {
          setStatus('unauthenticated'); // tokens are kept: signing in again is the only way forward until we are online
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestOtp = useCallback(
    (phoneNumber: string) => api.requestOtp(phoneNumber, role),
    [role],
  );

  const verifyOtp = useCallback(
    async (phoneNumber: string, code: string) => {
      const session = await api.verifyOtp(phoneNumber, role, code);
      await applySession(session);
      setUser(session.user);
      setIsNewUser(session.isNewUser);
      setDriverStatus(session.driverStatus);
      void saveProfile({ user: session.user, driverStatus: session.driverStatus });
      setStatus('authenticated');
      return session;
    },
    [applySession, role],
  );

  const logout = useCallback(async () => {
    try {
      const token = await getAccessToken();
      await api.logout(token);
    } catch {
      // Best-effort: still clear local state even if the network call fails.
    }
    await signOut();
  }, [getAccessToken, signOut]);

  const updateProfile = useCallback(
    async (update: { fullName?: string; profilePictureUrl?: string | null }) => {
      const token = await getAccessToken();
      const updated =
        role === 'DRIVER'
          ? await api.updateDriverMe(token, update)
          : await api.updateMe(token, update);
      setUser(updated);
      if ('driverStatus' in updated) setDriverStatus(updated.driverStatus as string);
    },
    [getAccessToken, role],
  );

  const uploadProfilePicture = useCallback(
    async (file: PickedFile) => {
      const token = await getAccessToken();
      const updated = await api.uploadProfilePicture(token, file);
      setUser(updated);
    },
    [getAccessToken],
  );

  const deactivateAccount = useCallback(async () => {
    const token = await getAccessToken();
    await api.deactivateAccount(token);
    await signOut();
  }, [getAccessToken, signOut]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      isNewUser,
      driverStatus,
      requestOtp,
      verifyOtp,
      logout,
      updateProfile,
      uploadProfilePicture,
      deactivateAccount,
      getAccessToken,
    }),
    [
      status,
      user,
      isNewUser,
      driverStatus,
      requestOtp,
      verifyOtp,
      logout,
      updateProfile,
      uploadProfilePicture,
      deactivateAccount,
      getAccessToken,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
