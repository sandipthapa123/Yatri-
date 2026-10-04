import { authApi } from '@yatri/mobile-auth';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { Platform } from 'react-native';

/**
 * Push notifications, from the phone's side: ask once for permission, get the phone's push address and tell the server, so the
 * notifications the server already records (a driver is coming, a payout was sent) reach a phone that is not open. Nothing about
 * a notification's content is decided here, the phone's address goes only to Yatri's own server, and on sign-out the address is
 * removed from the account, so a phone that has been signed out stops receiving that person's notifications.
 *
 * Declining is respected: no nagging, and everything still reaches the person inside the app (the notification list is the record).
 * The system's permission prompt is the phone's own, and works with a screen reader.
 */
export type PushOutcome = 'registered' | 'denied' | 'unavailable';
export type PermissionState = 'granted' | 'denied' | 'undetermined';

/** What registration needs from the phone and the server, so the decision logic is tested without either. */
export interface PushDeps {
  platform: string;
  getPermission(): Promise<PermissionState>;
  requestPermission(): Promise<PermissionState>;
  /** The phone's push address, or null when this device cannot have one (a simulator, a build without push set up). */
  getToken(): Promise<string | null>;
  send(token: string, platform: 'ios' | 'android'): Promise<void>;
}

export async function registerPush(d: PushDeps): Promise<PushOutcome> {
  if (d.platform !== 'ios' && d.platform !== 'android') return 'unavailable';
  let permission = await d.getPermission();
  if (permission === 'undetermined') permission = await d.requestPermission();
  if (permission !== 'granted') return 'denied';
  let token: string | null;
  try {
    token = await d.getToken();
  } catch {
    return 'unavailable';
  }
  if (!token) return 'unavailable';
  try {
    await d.send(token, d.platform);
  } catch {
    return 'unavailable'; // not lost: tried again the next time the app opens
  }
  return 'registered';
}

// ---------------------------------------------------------------- the real phone

const toState = (s: string): PermissionState =>
  s === 'granted' ? 'granted' : s === 'denied' ? 'denied' : 'undetermined';

async function currentToken(): Promise<string | null> {
  const projectId =
    (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ??
    Constants.easConfig?.projectId;
  if (!projectId) return null; // push needs the app's EAS project id; without it this build simply has no push address
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Yatri',
      importance: Notifications.AndroidImportance.MAX,
    });
  }
  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}

function phoneDeps(getAccessToken: () => Promise<string>): PushDeps {
  return {
    platform: Platform.OS,
    getPermission: async () => toState((await Notifications.getPermissionsAsync()).status),
    requestPermission: async () => toState((await Notifications.requestPermissionsAsync()).status),
    getToken: currentToken,
    send: async (token, platform) => {
      await authApi.request('/users/me/push-token', {
        method: 'POST',
        accessToken: await getAccessToken(),
        body: { token, platform },
      });
    },
  };
}

let displayConfigured = false;
/** While the app is open, a notification is shown as a banner (and spoken by the screen reader) like any other. */
function configureDisplay(): void {
  if (displayConfigured) return;
  displayConfigured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

/** Register this phone once the person is signed in. Safe to run again (the server keeps one row per address). */
export function usePushRegistration(auth: {
  status: string;
  getAccessToken: () => Promise<string>;
}): void {
  const { status, getAccessToken } = auth;
  useEffect(() => {
    if (status !== 'authenticated') return;
    configureDisplay();
    void registerPush(phoneDeps(getAccessToken)).catch(() => undefined);
  }, [status, getAccessToken]);
}

/**
 * Take this phone's address off the account (called just before sign-out, while the person can still be identified). Best effort:
 * the server also drops an account's push addresses whenever its sessions are revoked.
 */
export async function unregisterPush(accessToken: string): Promise<void> {
  try {
    const token = await currentToken();
    if (!token) return;
    await authApi.request('/users/me/push-token', {
      method: 'DELETE',
      accessToken,
      body: { token },
    });
  } catch {
    /* nothing to undo */
  }
}
