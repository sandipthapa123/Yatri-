import { isoOrNull } from '../../lib/dates';
import {
  PLATFORM_DEFAULTED,
  checkPreferenceValue,
  notificationCategoryOf,
  notificationPrefKey,
  NOTIFICATION_CATEGORY_INFO,
  preferenceDef,
  preferencesFor,
  type PreferenceRole,
  type PreferenceValue,
  type PreferenceValues,
  type PreferencesResponse,
  type SettingKey,
  type UpdatePreferencesBody,
} from '@yatri/types';

import { query, withTransaction } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { getActiveCategoryByCode, listActiveCategories } from '../pricing/categories';
import { settingText } from '../settings/settings.service';

/**
 * Personal preferences, server side. ONE row per person holds only what they chose (`user_preferences.choices`);
 * the definitions, allowed values and defaults are PREFERENCE_DEFS in @yatri/types, and a default that an
 * administrator controls (the language) is read from platform settings, so changing it reaches everyone who has
 * not chosen. A save quotes the version it was based on and is applied under a row lock: of two devices saving
 * at once, one wins and the other is told to look again, so neither overwrites the other unseen.
 *
 * Preferences are the person's own. No administrator screen reads them.
 */
interface Row {
  choices: PreferenceValues;
  version: number;
  updated_at: Date;
}

function defaultsFor(role: PreferenceRole): PreferenceValues {
  const out: PreferenceValues = {};
  for (const d of preferencesFor(role)) {
    const platform = PLATFORM_DEFAULTED[d.key];
    out[d.key] = platform ? settingText(platform as SettingKey) : d.default;
  }
  return out;
}

async function vehicleOptionsFor(role: PreferenceRole) {
  if (!preferencesFor(role).some((d) => d.key === 'defaultVehicle')) return [];
  return (await listActiveCategories()).map((c) => ({ code: c.code, label: c.label }));
}

async function toResponse(
  row: Row | undefined,
  role: PreferenceRole,
): Promise<PreferencesResponse> {
  const defaults = defaultsFor(role);
  const allowed = new Set(Object.keys(defaults));
  const chosen = Object.fromEntries(
    Object.entries(row?.choices ?? {}).filter(([k]) => allowed.has(k)),
  );
  return {
    values: { ...defaults, ...chosen },
    overridden: Object.keys(chosen),
    defaults,
    vehicleOptions: await vehicleOptionsFor(role),
    version: row?.version ?? 0,
    updatedAt: isoOrNull(row?.updated_at),
  };
}

export async function getPreferences(
  userId: string,
  role: PreferenceRole,
): Promise<PreferencesResponse> {
  const r = await query<Row>(
    'SELECT choices, version, updated_at FROM user_preferences WHERE user_id = $1',
    [userId],
  );
  return await toResponse(r.rows[0], role);
}

export async function updatePreferences(
  userId: string,
  role: PreferenceRole,
  body: UpdatePreferencesBody,
): Promise<PreferencesResponse> {
  const entries = Object.entries(body.changes);
  if (entries.length === 0) throw new HttpError(400, 'NO_CHANGES', 'Nothing to change.');
  const allowed = new Set(preferencesFor(role).map((d) => d.key));
  const clean: Record<string, PreferenceValue> = {};
  for (const [key, raw] of entries) {
    const def = preferenceDef(key);
    if (!def || !allowed.has(key))
      throw new HttpError(400, 'UNKNOWN_PREFERENCE', `There is no setting called ${key}.`);
    const checked = checkPreferenceValue(def, raw);
    if (!checked.ok)
      throw new HttpError(400, 'INVALID_PREFERENCE', checked.message).withDetails({ key });
    if (key === 'defaultVehicle' && typeof checked.value === 'string') {
      // The server decides what is on offer: the code must be a vehicle type offered right now.
      if (!(await getActiveCategoryByCode(checked.value))) {
        throw new HttpError(
          400,
          'INVALID_PREFERENCE',
          'That vehicle type is not offered.',
        ).withDetails({ key });
      }
    }
    clean[key] = checked.value;
  }
  const row = await withTransaction(async (c) => {
    await c.query('INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [
      userId,
    ]);
    const cur = (
      await c.query<Row>(
        'SELECT choices, version, updated_at FROM user_preferences WHERE user_id = $1 FOR UPDATE',
        [userId],
      )
    ).rows[0] as Row;
    if (body.expectedVersion !== undefined && body.expectedVersion !== cur.version) {
      throw new HttpError(
        409,
        'VERSION_CONFLICT',
        'Your settings were changed on another device. They have been reloaded; please choose again.',
      ).withDetails({ current: await toResponse(cur, role) });
    }
    const next: PreferenceValues = { ...cur.choices };
    for (const [k, v] of Object.entries(clean)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    const upd = await c.query<Row>(
      `UPDATE user_preferences SET choices = $2::jsonb, version = version + 1, updated_at = now()
       WHERE user_id = $1 RETURNING choices, version, updated_at`,
      [userId, JSON.stringify(next)],
    );
    return upd.rows[0] as Row;
  });
  return await toResponse(row, role);
}

/** What one person chose, for the places that act on it (no role needed: unknown keys are ignored). */
async function choicesOf(userId: string): Promise<PreferenceValues> {
  const r = await query<{ choices: PreferenceValues }>(
    'SELECT choices FROM user_preferences WHERE user_id = $1',
    [userId],
  );
  return r.rows[0]?.choices ?? {};
}

/** One person's value for one setting: what they chose, else the setting's own default. */
export async function personalPreference(
  userId: string,
  key: string,
): Promise<PreferenceValue | null> {
  const chosen = (await choicesOf(userId))[key];
  return chosen === undefined ? (preferenceDef(key)?.default ?? null) : chosen;
}

/**
 * Whether a notification of this type should be pushed to this person. Mandatory categories always are; an
 * optional one is unless the person switched it off. The ONE place that reads notification preferences.
 */
export async function shouldDeliver(userId: string, type: string): Promise<boolean> {
  const category = notificationCategoryOf(type);
  if (NOTIFICATION_CATEGORY_INFO[category].mandatory) return true;
  const choices = await choicesOf(userId);
  const key = notificationPrefKey(category);
  const chosen = choices[key];
  // Not chosen: the definition's default decides (offers and news are off until the person turns them on).
  return chosen === undefined ? preferenceDef(key)?.default !== false : chosen !== false;
}

/** How the person's name is shown to a driver: the full name, or only the first. */
export async function nameForDriver(
  passengerId: string,
  fullName: string | null,
): Promise<string | null> {
  if (!fullName) return fullName;
  const choices = await choicesOf(passengerId);
  if (choices.nameShownToDrivers !== 'FIRST_NAME') return fullName;
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

/** The person's own place-suggestion settings (privacy): whether to show them, and when they last cleared them. */
export async function recentPlacesSettings(
  userId: string,
): Promise<{ show: boolean; clearedAt: Date | null }> {
  const r = await query<{ choices: PreferenceValues; recent_places_cleared_at: Date | null }>(
    'SELECT choices, recent_places_cleared_at FROM user_preferences WHERE user_id = $1',
    [userId],
  );
  const row = r.rows[0];
  return {
    show: row?.choices.showRecentPlaces !== false,
    clearedAt: row?.recent_places_cleared_at ?? null,
  };
}
