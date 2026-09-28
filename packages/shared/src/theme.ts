/**
 * Yatri brand tokens, shared by every app.
 *
 * Colors are chosen and paired to meet WCAG 2.1 AA contrast (>= 4.5:1 for
 * body text, >= 3:1 for large text/UI components) against the surface they
 * are documented to sit on. Keep that invariant when changing a value.
 */

export const colors = {
  // Brand — inspired by Nepal's flag (crimson field, blue trim).
  primary: '#C81E3A', // on white: ~5.9:1
  primaryDark: '#9E1730', // pressed/active state, on white: ~8.3:1
  secondary: '#1D4ED8', // on white: ~6.3:1

  // Neutrals
  background: '#FFFFFF',
  surface: '#F7F7F8',
  border: '#E2E2E5',

  // Text — on `background`/`surface`
  textPrimary: '#14141A', // ~17.9:1
  textSecondary: '#53535E', // ~7.1:1
  textInverse: '#FFFFFF', // on `primary`: ~5.9:1

  // Semantic
  success: '#0F7A3D', // on white: ~5.1:1
  error: '#B3261E', // on white: ~6.4:1
  warning: '#8A5A00', // on white: ~5.6:1 (avoid pure yellow/black for AA text)
} as const;

export const darkColors = {
  primary: '#FF6B85',
  primaryDark: '#FF95A8',
  secondary: '#7FA6FF',
  background: '#121214',
  surface: '#1C1C1F',
  border: '#2E2E33',
  textPrimary: '#F5F5F7',
  textSecondary: '#B8B8C0',
  textInverse: '#14141A',
  success: '#5FD98A',
  error: '#FF8A80',
  warning: '#F4C15C',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radii = {
  sm: 6,
  md: 12,
  lg: 20,
  pill: 999,
} as const;

export const typography = {
  fontFamily: {
    regular: 'System',
    medium: 'System',
    bold: 'System',
  },
  size: {
    xs: 12,
    sm: 14,
    md: 16,
    lg: 20,
    xl: 24,
    xxl: 32,
  },
  lineHeight: {
    xs: 16,
    sm: 20,
    md: 24,
    lg: 28,
    xl: 32,
    xxl: 40,
  },
} as const;

/** Minimum hit-target size (iOS HIG / WCAG 2.5.5) for any tappable control. */
export const MIN_TOUCH_TARGET = 44;

export type ThemeColors = typeof colors;
