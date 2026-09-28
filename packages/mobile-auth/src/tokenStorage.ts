import * as SecureStore from 'expo-secure-store';

const KEYS = {
  accessToken: 'yatri_access_token',
  refreshToken: 'yatri_refresh_token',
  refreshTokenExpiresAt: 'yatri_refresh_token_expires_at',
} as const;

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

/**
 * Wraps expo-secure-store (iOS Keychain / Android Keystore) so tokens never
 * touch AsyncStorage or any other plaintext storage on the device.
 */
export async function saveTokens(tokens: StoredTokens): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(KEYS.accessToken, tokens.accessToken),
    SecureStore.setItemAsync(KEYS.refreshToken, tokens.refreshToken),
    SecureStore.setItemAsync(KEYS.refreshTokenExpiresAt, tokens.refreshTokenExpiresAt),
  ]);
}

export async function loadTokens(): Promise<StoredTokens | null> {
  const [accessToken, refreshToken, refreshTokenExpiresAt] = await Promise.all([
    SecureStore.getItemAsync(KEYS.accessToken),
    SecureStore.getItemAsync(KEYS.refreshToken),
    SecureStore.getItemAsync(KEYS.refreshTokenExpiresAt),
  ]);
  if (!accessToken || !refreshToken || !refreshTokenExpiresAt) return null;
  return { accessToken, refreshToken, refreshTokenExpiresAt };
}

export async function clearTokens(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(KEYS.accessToken),
    SecureStore.deleteItemAsync(KEYS.refreshToken),
    SecureStore.deleteItemAsync(KEYS.refreshTokenExpiresAt),
  ]);
}
