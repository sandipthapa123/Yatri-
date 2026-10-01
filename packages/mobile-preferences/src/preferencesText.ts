import {
  LARGER_TOUCH_SCALE,
  PREFERENCE_GROUPS,
  PREFERENCE_GROUP_LABELS,
  TEXT_SCALE,
  preferencesFor,
  type PreferenceDef,
  type PreferenceGroup,
  type PreferenceRole,
  type PreferencesResponse,
  type TextSize,
} from '@yatri/types';

/**
 * Turning the server's preferences into what the apps use, with no framework in it so it can be tested.
 * The definitions, allowed values and defaults are PREFERENCE_DEFS (@yatri/types); this only maps them to the
 * numbers and flags the shared components read, and words the screen shows.
 */
export interface UiPreferencesInput {
  scheme: 'light' | 'dark' | null;
  fontScale: number;
  touchScale: number;
  reducedMotion: boolean;
  speakUpdates: boolean;
  confirmBeforeSos: boolean;
  hapticFeedback: boolean;
  simplifiedNavigation: boolean;
}

/**
 * `systemReducedMotion` is what the phone says; the person's own choice wins when they made one.
 * Until preferences have loaded (`null`) the defaults apply.
 */
export function toUiPreferences(
  r: Pick<PreferencesResponse, 'values'> | null,
  systemReducedMotion: boolean,
): UiPreferencesInput {
  const v = r?.values ?? {};
  const theme = v.theme;
  const size = (v.textSize as TextSize | undefined) ?? 'STANDARD';
  const motion = v.reducedMotion;
  return {
    scheme: theme === 'LIGHT' ? 'light' : theme === 'DARK' ? 'dark' : null,
    fontScale: TEXT_SCALE[size] ?? 1,
    touchScale: v.largerTouchTargets === true ? LARGER_TOUCH_SCALE : 1,
    reducedMotion: motion === 'ON' ? true : motion === 'OFF' ? false : systemReducedMotion,
    speakUpdates: v.speakUpdates !== false,
    confirmBeforeSos: v.confirmBeforeSos !== false,
    hapticFeedback: v.hapticFeedback !== false,
    simplifiedNavigation: v.simplifiedNavigation === true,
  };
}

/** The groups a role sees, in order, each with its definitions (empty groups left out). */
export function settingsSections(
  role: PreferenceRole,
): Array<{ group: PreferenceGroup; label: string; defs: PreferenceDef[] }> {
  const mine = preferencesFor(role);
  return PREFERENCE_GROUPS.map((group) => ({
    group,
    label: PREFERENCE_GROUP_LABELS[group],
    defs: mine.filter((d) => d.group === group),
  })).filter((s) => s.defs.length > 0);
}

/** The words for a value, for a row that says what is chosen now ("Dark", "On", "Not set"). */
export function valueWords(def: PreferenceDef, value: string | boolean | null): string {
  if (def.kind === 'boolean') return value === true ? 'On' : 'Off';
  if (value === null || value === '') return 'No preference';
  const option = def.options?.find((o) => o.value === value);
  return option ? (option.label.split(',')[0] ?? option.label) : String(value);
}

/** What was saved, in a sentence for the screen reader. */
export function savedNews(def: PreferenceDef, value: string | boolean | null): string {
  return `${def.label}: ${valueWords(def, value)}. Saved.`;
}

/** The sentence after a conflict: another device changed the settings first. */
export const CONFLICT_NEWS =
  'Your settings were changed on another device. They were reloaded: please choose again.';
