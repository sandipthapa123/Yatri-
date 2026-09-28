/**
 * Expo inlines any `EXPO_PUBLIC_*` env var into the bundle at build time —
 * no extra config needed. Falls back to the standard iOS-simulator/local
 * dev address; Android emulator needs 10.0.2.2 and a physical device needs
 * your machine's LAN IP, set via EXPO_PUBLIC_API_URL in that case.
 */
export const API_BASE_URL: string =
  process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
