import {
  CITY_CODE_PATTERN,
  CITY_NAME_MAX,
  CITY_PAYMENT_METHODS,
  CITY_STATUSES,
  CITY_STATUS_TRANSITIONS,
  COVERAGE_ZONE_KINDS,
  PROVINCE_CODES,
  checkSettingValue,
  cityOverridableDefs,
  isCityOverridable,
  settingDef,
  type AdminCityBody,
  type AdminCityCategoriesBody,
  type AdminCityDocumentsBody,
  type AdminCityHoursBody,
  type AdminCityPaymentsBody,
  type AdminCitySettingsBody,
  type AdminCityStatusBody,
  type AdminCityZonesBody,
  type AdminCityRow,
  type CityAnalytics,
  type CityDetail,
  type CityStatus,
  type ResolvedRange,
} from '@yatri/types';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import { auditTrail, recordAudit } from '../../lib/audit';
import { query, withTransaction, isUniqueViolation } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { allZones, dropZoneCache } from '../operations/zones.service';
import { settingNumber } from '../settings/settings.service';
import {
  allCityData,
  cityAtPoint,
  dropCityCache,
  getCityData,
  paymentMethodsFor,
  toCityInfo,
} from './cities.service';

/**
 * Administering cities. Every edit, of the city or of anything under it, is one transaction that locks the city row,
 * refuses an edit based on an out-of-date version (so two administrators cannot overwrite each other unseen), applies
 * the change, raises the version and writes the audit entry with the stated reason. What a city may do and the words
 * for it are in @yatri/types; the boundary is the existing zones, assigned to the city here.
 */
const reason = z.string().trim().min(3).max(300);
const version = z.number().int().min(1);

const timeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Use a time zone name such as Asia/Kathmandu.');

export const cityBodySchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(CITY_CODE_PATTERN, 'Use capital letters, digits and underscores (2 to 30).'),
    name: z.string().trim().min(2).max(CITY_NAME_MAX),
    provinceCode: z.enum(PROVINCE_CODES as [string, ...string[]]),
    centerLatitude: z.number().min(-90).max(90),
    centerLongitude: z.number().min(-180).max(180),
    timeZone,
    expectedVersion: version.optional(),
    reason,
  })
  .strict();
export const cityStatusSchema = z
  .object({ to: z.enum(CITY_STATUSES), expectedVersion: version, reason })
  .strict();
const minute = z.number().int().min(0).max(1440).nullable();
export const cityHoursSchema = z
  .object({
    windows: z
      .array(
        z
          .object({
            daysOfWeek: z.array(z.number().int().min(1).max(7)).max(7).nullable(),
            startMinute: minute,
            endMinute: minute,
          })
          .strict()
          .refine(
            (w) => w.startMinute === null || w.endMinute === null || w.startMinute !== w.endMinute,
            'The start and end time cannot be the same.',
          ),
      )
      .max(14),
    expectedVersion: version,
    reason,
  })
  .strict();
export const cityCategoriesSchema = z
  .object({
    categories: z.record(z.string().uuid(), z.boolean()),
    expectedVersion: version,
    reason,
  })
  .strict();
export const cityPaymentsSchema = z
  .object({ methods: z.record(z.string(), z.boolean()), expectedVersion: version, reason })
  .strict();
export const citySettingsSchema = z
  .object({
    settings: z.record(z.string(), z.number().nullable()),
    expectedVersion: version,
    reason,
  })
  .strict();
export const cityDocumentsSchema = z
  .object({ documentTypeIds: z.array(z.string().uuid()).max(30), expectedVersion: version, reason })
  .strict();
export const cityZonesSchema = z
  .object({ zones: z.record(z.string().uuid(), z.boolean()), expectedVersion: version, reason })
  .strict();

const notFound = () => new HttpError(404, 'NOT_FOUND', 'City not found.');

/** Lock the city, check the version, run the change, raise the version, audit it. */
async function editCity<T>(
  cityId: string,
  expectedVersion: number,
  adminId: string,
  action: string,
  why: string,
  work: (c: PoolClient) => Promise<{ detail: Record<string, unknown>; result: T }>,
): Promise<T> {
  const out = await withTransaction(async (c) => {
    const cur = await c.query<{ version: number }>(
      'SELECT version FROM cities WHERE id = $1 FOR UPDATE',
      [cityId],
    );
    if (!cur.rows[0]) throw notFound();
    if (cur.rows[0].version !== expectedVersion) {
      throw new HttpError(
        409,
        'VERSION_CONFLICT',
        'This city was changed by someone else while you were editing. Reload it and make your change again.',
      );
    }
    const done = await work(c);
    await c.query('UPDATE cities SET version = version + 1, updated_at = now() WHERE id = $1', [
      cityId,
    ]);
    return done;
  });
  dropCityCache();
  dropZoneCache();
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action,
    subjectType: 'city',
    subjectIds: [cityId],
    detail: { ...out.detail, reason: why },
  });
  return out.result;
}

// ---------------------------------------------------------------- create and edit the profile

export async function createCity(body: AdminCityBody, adminId: string): Promise<CityDetail> {
  try {
    const r = await query<{ id: string }>(
      `INSERT INTO cities (code, name, province_code, time_zone, center_latitude, center_longitude)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        body.code,
        body.name,
        body.provinceCode,
        body.timeZone,
        body.centerLatitude,
        body.centerLongitude,
      ],
    );
    const id = r.rows[0]?.id as string;
    dropCityCache();
    await recordAudit({
      actorId: adminId,
      actorRole: 'ADMIN',
      action: 'CITY_CREATED',
      subjectType: 'city',
      subjectIds: [id],
      detail: { code: body.code, name: body.name, reason: body.reason },
    });
    return cityDetail(id);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HttpError(409, 'CITY_CODE_TAKEN', 'A city with that code already exists.');
    }
    throw err;
  }
}

export async function updateCity(
  id: string,
  body: AdminCityBody,
  adminId: string,
): Promise<CityDetail> {
  if (body.expectedVersion === undefined)
    throw new HttpError(400, 'VALIDATION_ERROR', 'Say which version you are editing.');
  try {
    await editCity(id, body.expectedVersion, adminId, 'CITY_UPDATED', body.reason, async (c) => {
      await c.query(
        `UPDATE cities SET code = $2, name = $3, province_code = $4, time_zone = $5, center_latitude = $6, center_longitude = $7
         WHERE id = $1`,
        [
          id,
          body.code,
          body.name,
          body.provinceCode,
          body.timeZone,
          body.centerLatitude,
          body.centerLongitude,
        ],
      );
      return { detail: { code: body.code, name: body.name }, result: undefined };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HttpError(409, 'CITY_CODE_TAKEN', 'A city with that code already exists.');
    }
    throw err;
  }
  return cityDetail(id);
}

export async function setCityStatus(
  id: string,
  body: AdminCityStatusBody,
  adminId: string,
): Promise<CityDetail> {
  await editCity(
    id,
    body.expectedVersion,
    adminId,
    'CITY_STATUS_CHANGED',
    body.reason,
    async (c) => {
      const cur = (
        await c.query<{ status: CityStatus }>('SELECT status FROM cities WHERE id = $1', [id])
      ).rows[0];
      if (!cur) throw notFound();
      if (!CITY_STATUS_TRANSITIONS[cur.status].includes(body.to)) {
        throw new HttpError(
          409,
          'ILLEGAL_MOVE',
          `A city that is ${cur.status.toLowerCase().replace('_', ' ')} cannot move to ${body.to.toLowerCase().replace('_', ' ')}.`,
        );
      }
      if (body.to === 'ACTIVE') {
        // A city with no boundary has nowhere to take rides: opening it would be a mistake.
        const zones = await c.query(
          `SELECT 1 FROM service_zones WHERE city_id = $1 AND is_active AND kind = ANY($2::text[]) LIMIT 1`,
          [id, [...COVERAGE_ZONE_KINDS]],
        );
        if (!zones.rowCount) {
          throw new HttpError(
            409,
            'NO_SERVICE_AREA',
            'Give the city at least one active service area before opening it.',
          );
        }
      }
      await c.query('UPDATE cities SET status = $2 WHERE id = $1', [id, body.to]);
      return { detail: { from: cur.status, to: body.to }, result: undefined };
    },
  );
  return cityDetail(id);
}

export async function setCityHours(
  id: string,
  body: AdminCityHoursBody,
  adminId: string,
): Promise<CityDetail> {
  await editCity(
    id,
    body.expectedVersion,
    adminId,
    'CITY_HOURS_CHANGED',
    body.reason,
    async (c) => {
      await c.query('DELETE FROM city_hours WHERE city_id = $1', [id]);
      for (const w of body.windows) {
        await c.query(
          'INSERT INTO city_hours (city_id, days_of_week, start_minute, end_minute) VALUES ($1, $2, $3, $4)',
          [
            id,
            w.daysOfWeek && w.daysOfWeek.length > 0 ? w.daysOfWeek : null,
            w.startMinute,
            w.endMinute,
          ],
        );
      }
      return { detail: { windows: body.windows.length }, result: undefined };
    },
  );
  return cityDetail(id);
}

export async function setCityCategories(
  id: string,
  body: AdminCityCategoriesBody,
  adminId: string,
): Promise<CityDetail> {
  await editCity(
    id,
    body.expectedVersion,
    adminId,
    'CITY_CATEGORIES_CHANGED',
    body.reason,
    async (c) => {
      const ids = Object.keys(body.categories);
      const known = await c.query<{ id: string }>(
        'SELECT id FROM vehicle_categories WHERE id = ANY($1::uuid[])',
        [ids],
      );
      if (known.rowCount !== ids.length)
        throw new HttpError(400, 'UNKNOWN_CATEGORY', 'One of the vehicle types does not exist.');
      const all = await c.query<{ id: string }>(
        'SELECT id FROM vehicle_categories WHERE is_active',
      );
      const disabledAfter = new Set(
        (
          await c.query<{ category_id: string }>(
            'SELECT category_id FROM city_categories WHERE city_id = $1 AND NOT enabled',
            [id],
          )
        ).rows.map((x) => x.category_id),
      );
      for (const [cat, on] of Object.entries(body.categories)) {
        if (on) disabledAfter.delete(cat);
        else disabledAfter.add(cat);
      }
      if (all.rows.every((x) => disabledAfter.has(x.id))) {
        throw new HttpError(400, 'NO_CATEGORY', 'A city must offer at least one vehicle type.');
      }
      for (const [cat, on] of Object.entries(body.categories)) {
        if (on)
          await c.query('DELETE FROM city_categories WHERE city_id = $1 AND category_id = $2', [
            id,
            cat,
          ]);
        else {
          await c.query(
            `INSERT INTO city_categories (city_id, category_id, enabled) VALUES ($1, $2, false)
           ON CONFLICT (city_id, category_id) DO UPDATE SET enabled = false`,
            [id, cat],
          );
        }
      }
      return { detail: { changed: body.categories }, result: undefined };
    },
  );
  return cityDetail(id);
}

export async function setCityPayments(
  id: string,
  body: AdminCityPaymentsBody,
  adminId: string,
): Promise<CityDetail> {
  await editCity(
    id,
    body.expectedVersion,
    adminId,
    'CITY_PAYMENTS_CHANGED',
    body.reason,
    async (c) => {
      for (const m of Object.keys(body.methods)) {
        if (!(CITY_PAYMENT_METHODS as readonly string[]).includes(m)) {
          throw new HttpError(
            400,
            'UNKNOWN_PAYMENT_METHOD',
            `${m} is not a payment method a city can switch.`,
          );
        }
      }
      const off = new Set(
        (
          await c.query<{ method: string }>(
            'SELECT method FROM city_payment_methods WHERE city_id = $1 AND NOT enabled',
            [id],
          )
        ).rows.map((x) => x.method),
      );
      for (const [m, on] of Object.entries(body.methods)) {
        if (on) off.delete(m);
        else off.add(m);
      }
      if (CITY_PAYMENT_METHODS.every((m) => off.has(m))) {
        throw new HttpError(400, 'NO_PAYMENT_METHOD', 'A city must offer at least one way to pay.');
      }
      for (const [m, on] of Object.entries(body.methods)) {
        if (on)
          await c.query('DELETE FROM city_payment_methods WHERE city_id = $1 AND method = $2', [
            id,
            m,
          ]);
        else {
          await c.query(
            `INSERT INTO city_payment_methods (city_id, method, enabled) VALUES ($1, $2, false)
           ON CONFLICT (city_id, method) DO UPDATE SET enabled = false`,
            [id, m],
          );
        }
      }
      return { detail: { changed: body.methods }, result: undefined };
    },
  );
  return cityDetail(id);
}

/** The city's fare, cancellation and waiting values. Each is checked by the platform setting's own definition. */
export async function setCitySettings(
  id: string,
  body: AdminCitySettingsBody,
  adminId: string,
): Promise<CityDetail> {
  const clean: Record<string, number | null> = {};
  for (const [key, raw] of Object.entries(body.settings)) {
    if (!isCityOverridable(key))
      throw new HttpError(400, 'UNKNOWN_SETTING', `${key} cannot be set for a city.`);
    if (raw === null) {
      clean[key] = null;
      continue;
    }
    const def = settingDef(key);
    const checked = def ? checkSettingValue(def, raw) : null;
    if (!checked || !checked.ok) {
      throw new HttpError(
        400,
        'INVALID_SETTING',
        checked && !checked.ok ? checked.message : 'Not a valid value.',
      ).withDetails({ key });
    }
    clean[key] = checked.value as number;
  }
  await editCity(
    id,
    body.expectedVersion,
    adminId,
    'CITY_SETTINGS_CHANGED',
    body.reason,
    async (c) => {
      for (const [key, v] of Object.entries(clean)) {
        if (v === null)
          await c.query('DELETE FROM city_settings WHERE city_id = $1 AND key = $2', [id, key]);
        else {
          await c.query(
            `INSERT INTO city_settings (city_id, key, value) VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (city_id, key) DO UPDATE SET value = $3::jsonb`,
            [id, key, JSON.stringify(v)],
          );
        }
      }
      return { detail: { settings: clean }, result: undefined };
    },
  );
  return cityDetail(id);
}

export async function setCityDocuments(
  id: string,
  body: AdminCityDocumentsBody,
  adminId: string,
): Promise<CityDetail> {
  await editCity(
    id,
    body.expectedVersion,
    adminId,
    'CITY_DOCUMENTS_CHANGED',
    body.reason,
    async (c) => {
      const ids = [...new Set(body.documentTypeIds)];
      const known = await c.query(
        'SELECT 1 FROM document_types WHERE id = ANY($1::uuid[]) AND is_active',
        [ids],
      );
      if (known.rowCount !== ids.length)
        throw new HttpError(
          400,
          'UNKNOWN_DOCUMENT_TYPE',
          'One of the document types does not exist.',
        );
      await c.query('DELETE FROM city_requirements WHERE city_id = $1', [id]);
      for (const d of ids) {
        await c.query('INSERT INTO city_requirements (city_id, document_type_id) VALUES ($1, $2)', [
          id,
          d,
        ]);
      }
      return { detail: { documents: ids.length }, result: undefined };
    },
  );
  return cityDetail(id);
}

/** Assign service zones to the city (its boundary), or take them out. Only zones that say where Yatri operates count. */
export async function setCityZones(
  id: string,
  body: AdminCityZonesBody,
  adminId: string,
): Promise<CityDetail> {
  await editCity(
    id,
    body.expectedVersion,
    adminId,
    'CITY_ZONES_CHANGED',
    body.reason,
    async (c) => {
      const ids = Object.keys(body.zones);
      const rows = await c.query<{ id: string; kind: string; city_id: string | null }>(
        'SELECT id, kind, city_id FROM service_zones WHERE id = ANY($1::uuid[]) FOR UPDATE',
        [ids],
      );
      if (rows.rowCount !== ids.length)
        throw new HttpError(400, 'UNKNOWN_ZONE', 'One of the zones does not exist.');
      for (const z of rows.rows) {
        if (!COVERAGE_ZONE_KINDS.includes(z.kind as never)) {
          throw new HttpError(
            400,
            'NOT_A_BOUNDARY',
            'Only service areas and city boundaries can be part of a city. Other zones (airports, venues) keep working inside it.',
          );
        }
      }
      for (const [zone, member] of Object.entries(body.zones)) {
        if (member)
          await c.query('UPDATE service_zones SET city_id = $2, updated_at = now() WHERE id = $1', [
            zone,
            id,
          ]);
        else
          await c.query(
            'UPDATE service_zones SET city_id = NULL, updated_at = now() WHERE id = $1 AND city_id = $2',
            [zone, id],
          );
      }
      // An open city must keep a boundary.
      const status = (
        await c.query<{ status: CityStatus }>('SELECT status FROM cities WHERE id = $1', [id])
      ).rows[0]?.status;
      if (status === 'ACTIVE') {
        const left = await c.query(
          `SELECT 1 FROM service_zones WHERE city_id = $1 AND is_active AND kind = ANY($2::text[]) LIMIT 1`,
          [id, [...COVERAGE_ZONE_KINDS]],
        );
        if (!left.rowCount)
          throw new HttpError(
            409,
            'NO_SERVICE_AREA',
            'An open city needs at least one active service area. Pause the city first.',
          );
      }
      return { detail: { zones: body.zones }, result: undefined };
    },
  );
  return cityDetail(id);
}

// ---------------------------------------------------------------- reading

/** How many online drivers are in each city right now (their last location, through the same geofence). */
async function onlineDriversByCity(): Promise<Map<string, number>> {
  const r = await query<{ latitude: string; longitude: string }>(
    `SELECT l.latitude, l.longitude FROM driver_availability a
     JOIN driver_last_locations l ON l.driver_id = a.driver_id WHERE a.state = 'ONLINE'`,
  );
  const counts = new Map<string, number>();
  for (const row of r.rows) {
    const { city } = await cityAtPoint({
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
    });
    if (city) counts.set(city.info.id, (counts.get(city.info.id) ?? 0) + 1);
  }
  return counts;
}

export async function listCities(): Promise<AdminCityRow[]> {
  const [data, rides, zones, online] = await Promise.all([
    allCityData(),
    query<{ city_id: string; n: number }>(
      `SELECT city_id, count(*)::int AS n FROM trips WHERE city_id IS NOT NULL AND requested_at >= date_trunc('month', now()) GROUP BY city_id`,
    ),
    query<{ city_id: string; n: number }>(
      'SELECT city_id, count(*)::int AS n FROM service_zones WHERE city_id IS NOT NULL GROUP BY city_id',
    ),
    onlineDriversByCity(),
  ]);
  return [...data.values()].map((c) => {
    const info = toCityInfo(c);
    return {
      id: info.id,
      code: info.code,
      name: info.name,
      provinceName: info.provinceName,
      status: info.status,
      openNow: info.openNow,
      zones: zones.rows.find((z) => z.city_id === info.id)?.n ?? 0,
      ridesThisMonth: rides.rows.find((r) => r.city_id === info.id)?.n ?? 0,
      driversOnlineNow: online.get(info.id) ?? 0,
    };
  });
}

export async function cityDetail(id: string): Promise<CityDetail> {
  const city = await getCityData(id);
  if (!city) throw notFound();
  const [cats, docs, allDocs, zones, audit] = await Promise.all([
    query<{ id: string; code: string; label: string }>(
      'SELECT id, code, label FROM vehicle_categories WHERE is_active ORDER BY sort_order, code',
    ),
    query<{ document_type_id: string }>(
      'SELECT document_type_id FROM city_requirements WHERE city_id = $1',
      [id],
    ),
    query<{
      id: string;
      code: string;
      label: string;
      owner_type: 'DRIVER' | 'VEHICLE';
      is_required: boolean;
    }>(
      'SELECT id, code, label, owner_type, is_required FROM document_types WHERE is_active ORDER BY owner_type, sort_order, label',
    ),
    allZones(),
    auditTrail('city', id),
  ]);
  const names = new Map([...(await allCityData()).values()].map((c) => [c.info.id, c.info.name]));
  const chosen = new Set(docs.rows.map((d) => d.document_type_id));
  const platform = (key: string) => settingNumber(key as never);
  const info = toCityInfo(city);
  return {
    ...info,
    categories: cats.rows.map((c) => ({
      categoryId: c.id,
      code: c.code,
      label: c.label,
      enabled: !city.disabledCategoryIds.has(c.id),
    })),
    paymentMethods: CITY_PAYMENT_METHODS.map((m) => ({
      method: m,
      enabled: paymentMethodsFor(city).includes(m),
    })),
    settings: cityOverridableDefs().map((d) => ({
      key: d.key,
      label: d.label,
      unit: 'unit' in d ? (d.unit as string) : null,
      platformValue: platform(d.key),
      cityValue: city.settings.get(d.key) ?? null,
    })),
    documents: allDocs.rows.map((d) => ({
      documentTypeId: d.id,
      code: d.code,
      label: d.label,
      ownerType: d.owner_type,
      required: chosen.has(d.id),
    })),
    zones: zones
      .filter((z) => (COVERAGE_ZONE_KINDS as readonly string[]).includes(z.kind))
      .map((z) => ({
        id: z.id,
        code: z.code,
        name: z.name,
        kind: z.kind,
        isActive: z.isActive,
        inThisCity: z.cityId === id,
        otherCityName: z.cityId && z.cityId !== id ? (names.get(z.cityId) ?? 'another city') : null,
      })),
    audit,
    allowedNext: [...CITY_STATUS_TRANSITIONS[info.status]],
  };
}

/** How the city is doing over a range (rides are counted on the day they were requested, like every report). */
export async function cityAnalytics(id: string, range: ResolvedRange): Promise<CityAnalytics> {
  if (!(await getCityData(id))) throw notFound();
  const params = [id, range.from, range.to];
  const base = `FROM trips t LEFT JOIN vehicle_categories vc ON vc.id = t.vehicle_category_id
    WHERE t.city_id = $1 AND t.requested_at >= $2 AND t.requested_at < $3`;
  const [totals, byCat, byDay, online] = await Promise.all([
    query<{
      rides: number;
      completed: number;
      cancelled: number;
      no_drivers: number;
      gross: number;
    }>(
      `SELECT count(*)::int AS rides, count(*) FILTER (WHERE t.status = 'COMPLETED')::int AS completed,
              count(*) FILTER (WHERE t.status = 'CANCELLED')::int AS cancelled,
              count(*) FILTER (WHERE t.status = 'NO_DRIVERS')::int AS no_drivers,
              COALESCE(sum(t.fare_final_npr) FILTER (WHERE t.status = 'COMPLETED'), 0)::int AS gross ${base}`,
      params,
    ),
    query<{ code: string | null; label: string | null; rides: number; gross: number }>(
      `SELECT vc.code, vc.label, count(*)::int AS rides,
              COALESCE(sum(t.fare_final_npr) FILTER (WHERE t.status = 'COMPLETED'), 0)::int AS gross
       ${base} GROUP BY vc.code, vc.label ORDER BY rides DESC, vc.code`,
      params,
    ),
    query<{ day: string; rides: number }>(
      `SELECT to_char(t.requested_at, 'YYYY-MM-DD') AS day, count(*)::int AS rides ${base} GROUP BY 1 ORDER BY 1`,
      params,
    ),
    onlineDriversByCity(),
  ]);
  const t = totals.rows[0];
  const finished = (t?.completed ?? 0) + (t?.cancelled ?? 0);
  return {
    range,
    rides: t?.rides ?? 0,
    completed: t?.completed ?? 0,
    cancelled: t?.cancelled ?? 0,
    noDrivers: t?.no_drivers ?? 0,
    completionRatePercent:
      finished === 0 ? null : Math.round(((t?.completed ?? 0) / finished) * 100),
    grossFaresNpr: t?.gross ?? 0,
    driversOnlineNow: online.get(id) ?? 0,
    byCategory: byCat.rows.map((c) => ({
      code: c.code,
      label: c.label,
      rides: c.rides,
      grossNpr: c.gross,
    })),
    byDay: byDay.rows,
  };
}
