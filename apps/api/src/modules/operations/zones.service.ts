import {
  ZONE_KINDS,
  ZONE_NOTE_MAX,
  checkZoneAccess,
  zoneProblem,
  zonesAt,
  type AdminZoneBody,
  type LatLng,
  type PolygonPoints,
  type ZoneAccess,
  type ZoneDef,
  type ZoneKind,
  type ZonePurpose,
} from '@yatri/types';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';

/**
 * Service zones: where rides may start and end, and the named places (airport, venue, city) the pricing
 * rules, dispatch and incentives refer to. The rules are `checkZoneAccess` in @yatri/types over the
 * shared point-in-polygon; this module only stores zones and hands them to whoever asks. The list is
 * small, so it is read through a short cache that is dropped on every edit.
 */
interface Row {
  id: string;
  code: string;
  name: string;
  kind: ZoneKind;
  polygon: PolygonPoints;
  pickup_allowed: boolean;
  dropoff_allowed: boolean;
  note: string | null;
  priority: number;
  is_active: boolean;
  city_id: string | null;
}
const COLS =
  'id, code, name, kind, polygon, pickup_allowed, dropoff_allowed, note, priority, is_active, city_id';
const toZone = (r: Row): ZoneDef => ({
  id: r.id,
  code: r.code,
  name: r.name,
  kind: r.kind,
  polygon: r.polygon,
  pickupAllowed: r.pickup_allowed,
  dropoffAllowed: r.dropoff_allowed,
  note: r.note,
  priority: r.priority,
  isActive: r.is_active,
  cityId: r.city_id,
});

const CACHE_MS = 5_000;
let cache: { at: number; zones: ZoneDef[] } | null = null;
export const dropZoneCache = () => {
  cache = null;
};

/** Every zone (active or not), newest edits visible within a few seconds on any instance. */
export async function allZones(): Promise<ZoneDef[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.zones;
  const r = await query<Row>(`SELECT ${COLS} FROM service_zones ORDER BY priority DESC, code`);
  const zones = r.rows.map(toZone);
  cache = { at: Date.now(), zones };
  return zones;
}
export const activeZones = async () => (await allZones()).filter((z) => z.isActive);

/** Refuse a pickup or drop-off the zones do not allow (422, in the rule's own words). */
export async function assertZoneAccess(point: LatLng, purpose: ZonePurpose): Promise<ZoneDef[]> {
  const result: ZoneAccess = checkZoneAccess(await activeZones(), point, purpose);
  if (!result.ok) throw new HttpError(422, result.code, result.message);
  return result.zones;
}

/** The zone that names a pickup for pricing and incentives: the most specific non-coverage zone, else the coverage one. */
export function primaryZone(zones: readonly ZoneDef[]): ZoneDef | null {
  return zones.find((z) => z.kind !== 'SERVICE_AREA' && z.kind !== 'CITY') ?? zones[0] ?? null;
}
export async function zoneIdsAt(point: LatLng): Promise<string[]> {
  return zonesAt(await activeZones(), point).map((z) => z.id);
}

// ---------------------------------------------------------------- administration

export const zoneBodySchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Z0-9_]{2,40}$/, 'Use capital letters, digits and underscores (2 to 40).'),
    name: z.string().trim().min(2).max(80),
    kind: z.enum(ZONE_KINDS),
    polygon: z.array(z.tuple([z.number(), z.number()])),
    pickupAllowed: z.boolean(),
    dropoffAllowed: z.boolean(),
    note: z.string().trim().max(ZONE_NOTE_MAX).nullable(),
    priority: z.number().int().min(0).max(1000),
    isActive: z.boolean(),
    cityId: z.string().uuid().nullable().optional(),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();

function check(body: AdminZoneBody) {
  const problem = zoneProblem(body);
  if (problem)
    throw new HttpError(400, 'VALIDATION_ERROR', problem).withDetails({ polygon: [problem] });
}

export async function createZone(body: AdminZoneBody, adminId: string): Promise<ZoneDef> {
  check(body);
  try {
    const r = await query<Row>(
      `INSERT INTO service_zones (code, name, kind, polygon, pickup_allowed, dropoff_allowed, note, priority, is_active, city_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10) RETURNING ${COLS}`,
      [
        body.code,
        body.name,
        body.kind,
        JSON.stringify(body.polygon),
        body.pickupAllowed,
        body.dropoffAllowed,
        body.note,
        body.priority,
        body.isActive,
        body.cityId ?? null,
      ],
    );
    dropZoneCache();
    const zone = toZone(r.rows[0] as Row);
    await recordAudit({
      actorId: adminId,
      actorRole: 'ADMIN',
      action: 'ZONE_CREATED',
      subjectType: 'zone',
      subjectIds: [zone.id],
      detail: { code: zone.code, kind: zone.kind, reason: body.reason },
    });
    return zone;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new HttpError(409, 'ZONE_CODE_TAKEN', 'A zone with that code already exists.');
    }
    throw err;
  }
}

export async function updateZone(
  id: string,
  body: AdminZoneBody,
  adminId: string,
): Promise<ZoneDef> {
  check(body);
  try {
    const r = await query<Row>(
      `UPDATE service_zones SET code = $2, name = $3, kind = $4, polygon = $5::jsonb, pickup_allowed = $6,
         dropoff_allowed = $7, note = $8, priority = $9, is_active = $10, updated_at = now(),
         city_id = CASE WHEN $11::boolean THEN $12::uuid ELSE city_id END
       WHERE id = $1 RETURNING ${COLS}`,
      [
        id,
        body.code,
        body.name,
        body.kind,
        JSON.stringify(body.polygon),
        body.pickupAllowed,
        body.dropoffAllowed,
        body.note,
        body.priority,
        body.isActive,
        body.cityId !== undefined,
        body.cityId ?? null,
      ],
    );
    if (!r.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Zone not found.');
    dropZoneCache();
    await recordAudit({
      actorId: adminId,
      actorRole: 'ADMIN',
      action: 'ZONE_UPDATED',
      subjectType: 'zone',
      subjectIds: [id],
      detail: { code: body.code, active: body.isActive, reason: body.reason },
    });
    return toZone(r.rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new HttpError(409, 'ZONE_CODE_TAKEN', 'A zone with that code already exists.');
    }
    throw err;
  }
}
