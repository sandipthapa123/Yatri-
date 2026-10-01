import { useColorScheme } from 'react-native';
import { colors, darkColors, radii, spacing, typography, MIN_TOUCH_TARGET } from '@yatri/shared';

import { useUiPreferences } from './uiPreferences';

/**
 * Resolves brand tokens against the person's theme choice (or the device's light/dark setting when they have
 * not chosen), and scales the smallest touch target by their larger-buttons preference. Screens should read
 * colors and sizes through this hook rather than importing the palette directly, so theme switching stays
 * centralized.
 */
export function useTheme() {
  const system = useColorScheme();
  const prefs = useUiPreferences();
  const scheme = prefs.scheme ?? system;
  const palette = scheme === 'dark' ? darkColors : colors;

  return {
    colors: palette,
    spacing,
    radii,
    typography,
    minTouchTarget: Math.round(MIN_TOUCH_TARGET * prefs.touchScale),
    fontScale: prefs.fontScale,
    reducedMotion: prefs.reducedMotion,
    isDark: scheme === 'dark',
  };
}

export type Theme = ReturnType<typeof useTheme>;
