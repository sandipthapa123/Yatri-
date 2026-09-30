// Set by React Native (true in development, false in a release build). Undefined under plain Node
// (unit tests), where the development rules apply.
declare const __DEV__: boolean | undefined;

const DEV_DEFAULT = 'http://localhost:4000/api/v1';

/**
 * Decide which API address the app talks to. In development anything goes (the simulator's localhost, a
 * LAN address). A RELEASE build must be given an https address of a real server at build time: without
 * this rule a forgotten setting would ship an app that sends people's sign-in tokens, locations and
 * rides, in the clear, to "localhost". It fails loudly at start instead.
 */
export function resolveApiBaseUrl(value: string | undefined, isDev: boolean): string {
  const configured = value?.trim();
  if (!configured) {
    if (isDev) return DEV_DEFAULT;
    throw new Error(
      'EXPO_PUBLIC_API_URL is not set. A release build must be built with the address of the Yatri API.',
    );
  }
  if (isDev) return configured;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('EXPO_PUBLIC_API_URL is not a valid address.');
  }
  const host = url.hostname.toLowerCase();
  const local =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.startsWith('127.') ||
    host === '10.0.2.2' ||
    host === '0.0.0.0';
  if (url.protocol !== 'https:' || local) {
    throw new Error(
      'EXPO_PUBLIC_API_URL must be an https address of a real server in a release build.',
    );
  }
  return configured;
}

/**
 * Expo inlines any `EXPO_PUBLIC_*` env var into the bundle at build time. In development it falls back
 * to the iOS-simulator/local address; the Android emulator needs 10.0.2.2 and a physical device your
 * machine's LAN IP, set via EXPO_PUBLIC_API_URL. A release build refuses anything but https.
 */
export const API_BASE_URL: string = resolveApiBaseUrl(
  process.env.EXPO_PUBLIC_API_URL,
  typeof __DEV__ === 'undefined' ? true : __DEV__,
);

/**
 * The server returns picture links as paths on its own host ("/api/v1/storage/..."). An Image needs an
 * absolute URL, so every place that shows one goes through this — the one place that knows the origin.
 */
export function resolveMediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!url.startsWith('/')) return url;
  return `${API_BASE_URL.replace(/\/api\/v\d+\/?$/, '')}${url}`;
}
