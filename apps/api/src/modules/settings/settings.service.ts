import {
  PLATFORM_SETTINGS,
  checkSettingValue,
  describeSettingValue,
  settingDef,
  type PlatformSettingInfo,
  type PublicPlatformConfig,
  type SettingKey,
  type SettingValue,
} from '@yatri/types';

import { env } from '../../config/env';
import { recordAudit } from '../../lib/audit';
import { query, withTransaction } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { log } from '../../lib/logger';

/**
 * THE platform settings store. `getSetting` is what every rule reads (fares, cancellation, waiting,
 * availability, notification thresholds); nothing else holds a copy. The value is the admin's
 * override if there is one, otherwise the deployment default from the environment.
 *
 * Reads are synchronous (rules run in timers and hot paths) against a per-process cache that is
 * refreshed at most every SETTINGS_CACHE_SECONDS, and immediately after this process writes. Two
 * admins editing one setting cannot overwrite each other: an edit quotes the version it was based
 * on and a stale one is refused.
 */
interface Stored {
  value: SettingValue | null;
  version: number;
  updatedAt: Date | null;
  updatedBy: string | null;
}

let cache = new Map<string, Stored>();
let loadedAt = 0;
let inflight: Promise<void> | null = null;

/** The deployment default of a setting (its key is the environment variable's name). */
export function settingDefault(key: SettingKey): SettingValue {
  return env[key as keyof typeof env] as SettingValue;
}

export function getSetting(key: SettingKey): SettingValue {
  const stored = cache.get(key);
  return stored && stored.value !== null ? stored.value : settingDefault(key);
}
export const settingNumber = (key: SettingKey) => getSetting(key) as number;
export const settingBool = (key: SettingKey) => getSetting(key) as boolean;
export const settingList = (key: SettingKey) => getSetting(key) as number[];
export const settingText = (key: SettingKey) => getSetting(key) as string;

interface Row {
  key: string;
  value: SettingValue | null;
  version: number;
  updated_at: Date;
  updated_by: string | null;
}

/** Re-read every stored setting. A database failure keeps the last good copy. */
export function refreshSettings(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await query<Row>(
        'SELECT key, value, version, updated_at, updated_by FROM platform_settings',
      );
      cache = new Map(
        r.rows.map((row) => [
          row.key,
          {
            value: row.value,
            version: row.version,
            updatedAt: row.updated_at,
            updatedBy: row.updated_by,
          },
        ]),
      );
      loadedAt = Date.now();
    } catch (err) {
      log.error('Could not refresh platform settings; using the last known values', err);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Make sure the copy this process holds is recent enough. Called before requests are handled. */
export async function ensureSettingsFresh(): Promise<void> {
  if (Date.now() - loadedAt >= env.SETTINGS_CACHE_SECONDS * 1000) await refreshSettings();
}

/** Every setting with its value, its default and who last changed it (always read fresh). */
export async function listSettings(): Promise<PlatformSettingInfo[]> {
  const r = await query<Row & { name: string | null }>(
    `SELECT s.key, s.value, s.version, s.updated_at, s.updated_by, u.full_name AS name
       FROM platform_settings s LEFT JOIN users u ON u.id = s.updated_by`,
  );
  const byKey = new Map(r.rows.map((row) => [row.key, row]));
  return PLATFORM_SETTINGS.map((def) => {
    const row = byKey.get(def.key);
    const overridden = !!row && row.value !== null;
    return {
      key: def.key,
      group: def.group,
      label: def.label,
      help: def.help,
      kind: def.kind,
      unit: 'unit' in def ? def.unit : null,
      value: overridden ? (row.value as SettingValue) : settingDefault(def.key),
      defaultValue: settingDefault(def.key),
      overridden,
      version: row?.version ?? 0,
      updatedAt: row ? row.updated_at.toISOString() : null,
      updatedByName: row?.name ?? null,
    };
  });
}

/**
 * Change one setting (or, with `value: null`, go back to the default). The row is locked while the
 * version is compared, so of two simultaneous edits exactly one applies and the other is told to
 * look again. The change, who made it and why go to the one audit log.
 */
export async function updateSetting(
  key: string,
  input: { value: unknown; expectedVersion: number; reason: string },
  actorId: string,
): Promise<PlatformSettingInfo> {
  const def = settingDef(key);
  if (!def) throw new HttpError(404, 'NOT_FOUND', 'Unknown setting.');
  let next: SettingValue | null = null;
  if (input.value !== null) {
    const check = checkSettingValue(def, input.value);
    if (!check.ok) throw new HttpError(400, 'INVALID_SETTING', check.message);
    next = check.value;
  }

  let before!: SettingValue;
  await withTransaction(async (client) => {
    const cur = await client.query<{ value: SettingValue | null; version: number }>(
      'SELECT value, version FROM platform_settings WHERE key = $1 FOR UPDATE',
      [key],
    );
    const row = cur.rows[0];
    const currentVersion = row?.version ?? 0;
    if (currentVersion !== input.expectedVersion) {
      throw new HttpError(
        409,
        'SETTING_CHANGED',
        'Someone else changed this setting while you were editing. Reload to see the new value.',
      ).withDetails({ currentVersion });
    }
    before = row && row.value !== null ? row.value : settingDefault(def.key as SettingKey);
    await client.query(
      `INSERT INTO platform_settings (key, value, version, updated_by, updated_at)
       VALUES ($1, $2::jsonb, 1, $3, now())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, version = platform_settings.version + 1,
             updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(next), actorId],
    );
  });

  const after = next ?? settingDefault(def.key as SettingKey);
  await recordAudit({
    actorId,
    actorRole: 'ADMIN',
    action: next === null ? 'SETTING_RESET' : 'SETTING_CHANGED',
    subjectType: 'setting',
    subjectIds: null,
    detail: {
      key,
      from: describeSettingValue(def, before),
      to: describeSettingValue(def, after),
      reason: input.reason,
    },
  });
  await refreshSettings();
  const updated = (await listSettings()).find((s) => s.key === key);
  if (!updated) throw new HttpError(500, 'INTERNAL', 'Setting vanished.');
  return updated;
}

/** What the apps may know, from the same store. */
/** The platform-wide part; the route adds the cities (which come from the cities module). */
export function publicPlatformConfig(): Omit<PublicPlatformConfig, 'cities'> {
  const requestsEnabled = settingBool('SERVICE_REQUESTS_ENABLED');
  return {
    requestsEnabled,
    pausedMessage: requestsEnabled ? null : settingText('SERVICE_PAUSED_MESSAGE'),
    defaultLanguage: settingText('DEFAULT_LANGUAGE'),
    fare: {
      baseNpr: settingNumber('FARE_BASE_NPR'),
      perKmNpr: settingNumber('FARE_PER_KM_NPR'),
      perMinuteNpr: settingNumber('FARE_PER_MINUTE_NPR'),
      minimumNpr: settingNumber('FARE_MINIMUM_NPR'),
    },
    cancellation: {
      freeSeconds: settingNumber('CANCEL_FREE_SECONDS'),
      feeNpr: settingNumber('CANCEL_FEE_NPR'),
    },
    waiting: {
      freeSeconds: settingNumber('WAITING_FREE_SECONDS'),
      perMinuteNpr: settingNumber('WAITING_PER_MINUTE_NPR'),
      noShowAfterSeconds: settingNumber('NO_SHOW_AFTER_SECONDS'),
    },
  };
}
