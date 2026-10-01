import { createContext, useContext } from 'react';

/**
 * How the person asked the apps to look and behave (from the ONE preferences model on the server; see
 * @yatri/types preferences.ts). The provider that loads them lives in @yatri/mobile-preferences; the shared
 * components only READ this, so a screen never needs to know where the settings came from. The defaults are
 * what an app shows before preferences have loaded or when they cannot be reached.
 */
export interface UiPreferences {
  /** null: follow the phone. */
  scheme: 'light' | 'dark' | null;
  /** Multiplies the sizes of text in shared components. */
  fontScale: number;
  /** Multiplies the smallest size of anything tappable. */
  touchScale: number;
  reducedMotion: boolean;
  /** Whether the app speaks ride updates itself on iPhone. */
  speakUpdates: boolean;
  confirmBeforeSos: boolean;
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  scheme: null,
  fontScale: 1,
  touchScale: 1,
  reducedMotion: false,
  speakUpdates: true,
  confirmBeforeSos: true,
};

export const UiPreferencesContext = createContext<UiPreferences>(DEFAULT_UI_PREFERENCES);
export const useUiPreferences = (): UiPreferences => useContext(UiPreferencesContext);
