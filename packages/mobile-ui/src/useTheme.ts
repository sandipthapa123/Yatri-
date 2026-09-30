import { useColorScheme } from 'react-native';
import { colors, darkColors, radii, spacing, typography, MIN_TOUCH_TARGET } from '@yatri/shared';

/**
 * Resolves brand tokens against the device's light/dark preference. Screens
 * should read colors through this hook rather than importing the palette
 * directly, so theme switching stays centralized.
 */
export function useTheme() {
  const scheme = useColorScheme();
  const palette = scheme === 'dark' ? darkColors : colors;

  return {
    colors: palette,
    spacing,
    radii,
    typography,
    minTouchTarget: MIN_TOUCH_TARGET,
    isDark: scheme === 'dark',
  };
}

export type Theme = ReturnType<typeof useTheme>;
