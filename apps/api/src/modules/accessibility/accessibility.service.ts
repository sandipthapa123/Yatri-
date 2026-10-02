import {
  ACCESSIBILITY_NOTE_MAX,
  ACCESSIBLE_VEHICLE_ATTRIBUTE,
  ACCESSIBILITY_NOTIFICATION_TYPES,
  COMMUNICATION_ALLOWED_TO_CALL,
  VEHICLE_ATTRIBUTE_CODE_PATTERN,
  hasAccessibilityContent,
  initialCapabilityStatus,
  requiredVehicleAttributes,
  type AccessibilityProfile,
  type AccessibilityProfileBody,
  type AccessibilityStats,
  type AdminAttributeBody,
  type AdminCapabilityReview,
  type AdminTripAccessibility,
  type CommunicationPreference,
  type PassengerNeedCode,
  type PickupInstructionCode,
  type ResolvedRange,
  type TripAccessibility,
  type TripAccessibilityRequest,
  type TripAccessibilityUpdateBody,
  type VehicleAttributeInfo,
  type VehicleCapabilitiesResponse,
  type VehicleCapability,
  type VehicleCapabilityStatus,
  COMMUNICATION_PREFERENCES,
  PASSENGER_NEED_CODES,
  PICKUP_INSTRUCTION_CODES,
  TERMINAL_TRIP_STATUSES,
} from '@yatri/types';

import { recordAudit } from '../../lib/audit';
import { query, withTransaction } from '../../lib/db';
import { notify } from '../../lib/notifications';
import { HttpError } from '../../middleware/errorHandler';
import { bumpTripVersion } from '../tracking/tracking.service';
import { recordTripEvent } from '../trips/trip-events.service';
import { getTrip } from '../trips/trips.repository';

/**
 * Inclusive and accessible rides: the ONE place accessibility data is read and written. The catalogue of vehicle
 * features, what a passenger said they need (only what they stated), what a ride carries, what a vehicle declares and
 * who approved it, and the staff views of all of it. Matching reads `attributesSatisfiedSql`; calls read
 * `driverMayCall`; nothing else re-derives any of it.
 */

const notFound = (what: string) => new HttpError(404, 'NOT_FOUND', `${what} was not found.`);

// ---------------------------------------------------------------- the catalogue of vehicle features

interface AttributeRow {
  code: string;
  label: string;
  help: string;
  requires_approval: boolean;
  active: boolean;
  core: boolean;
  version: number;
}
const toAttribute = (r: AttributeRow): VehicleAttributeInfo => ({
  code: r.code,
  label: r.label,
  help: r.help,
  requiresApproval: r.requires_approval,
  active: r.active,
  core: r.core,
  version: r.version,
});

export async function listAttributes(activeOnly = false): Promise<VehicleAttributeInfo[]> {
  const r = await query<AttributeRow>(
    `SELECT code, label, help, requires_approval, active, core, version FROM accessibility_attributes
     ${activeOnly ? 'WHERE active' : ''} ORDER BY core DESC, label`,
  );
  return r.rows.map(toAttribute);
}

/** code -> label, for the sentences about a ride's vehicle needs. */
export async function attributeLabels(): Promise<Record<string, string>> {
  return Object.fromEntries((await listAttributes()).map((a) => [a.code, a.label]));
}

/** Create or edit a feature. Core features keep their code and cannot be switched off (the passenger needs map to them). */
export async function saveAttribute(
  body: AdminAttributeBody,
  adminId: string,
): Promise<VehicleAttributeInfo> {
  return withTransaction(async (c) => {
    let row: AttributeRow;
    let before: AttributeRow | null = null;
    if (body.code) {
      const cur = await c.query<AttributeRow>(
        'SELECT code, label, help, requires_approval, active, core, version FROM accessibility_attributes WHERE code = $1 FOR UPDATE',
        [body.code],
      );
      before = cur.rows[0] ?? null;
    }
    if (!before) {
      if (body.code && !VEHICLE_ATTRIBUTE_CODE_PATTERN.test(body.code)) {
        throw new HttpError(
          400,
          'VALIDATION_ERROR',
          'The code must be capital letters, digits and underscores.',
        );
      }
      const code = body.code ?? codeFromLabel(body.label);
      if (!VEHICLE_ATTRIBUTE_CODE_PATTERN.test(code)) {
        throw new HttpError(
          400,
          'VALIDATION_ERROR',
          'Give the feature a name with at least three letters.',
        );
      }
      try {
        const ins = await c.query<AttributeRow>(
          `INSERT INTO accessibility_attributes (code, label, help, requires_approval, active)
           VALUES ($1, $2, $3, $4, $5) RETURNING code, label, help, requires_approval, active, core, version`,
          [code, body.label, body.help, body.requiresApproval, body.active],
        );
        row = ins.rows[0] as AttributeRow;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw new HttpError(409, 'ATTRIBUTE_EXISTS', 'A feature with that name already exists.');
        }
        throw err;
      }
    } else {
      if (body.version !== undefined && body.version !== before.version) {
        throw new HttpError(
          409,
          'VERSION_CONFLICT',
          'Someone else changed this feature. Reload and try again.',
        );
      }
      if (before.core && !body.active) {
        throw new HttpError(
          409,
          'CORE_ATTRIBUTE',
          'This feature is needed to match passengers and cannot be switched off.',
        );
      }
      const upd = await c.query<AttributeRow>(
        `UPDATE accessibility_attributes SET label = $2, help = $3, requires_approval = $4, active = $5,
           version = version + 1, updated_at = now()
         WHERE code = $1 RETURNING code, label, help, requires_approval, active, core, version`,
        [before.code, body.label, body.help, body.requiresApproval, body.active],
      );
      row = upd.rows[0] as AttributeRow;
      // The rule changed under existing claims: starting to require approval puts them back in the queue;
      // no longer requiring it counts the waiting ones.
      if (!before.requires_approval && body.requiresApproval) {
        await c.query(
          `UPDATE vehicle_accessibility SET status = 'PENDING', decided_by = NULL, decided_at = NULL, decision_reason = NULL
           WHERE attribute_code = $1 AND status = 'APPROVED'`,
          [row.code],
        );
      } else if (before.requires_approval && !body.requiresApproval) {
        await c.query(
          `UPDATE vehicle_accessibility SET status = 'APPROVED', decided_by = $2, decided_at = now(),
             decision_reason = 'Approval is no longer required for this feature.'
           WHERE attribute_code = $1 AND status = 'PENDING'`,
          [row.code, adminId],
        );
      }
    }
    await recordAudit({
      actorId: adminId,
      actorRole: 'ADMIN',
      action: before ? 'ACCESSIBILITY_ATTRIBUTE_CHANGED' : 'ACCESSIBILITY_ATTRIBUTE_ADDED',
      subjectType: 'accessibility_attribute',
      subjectIds: null,
      detail: {
        code: row.code,
        requiresApproval: row.requires_approval,
        active: row.active,
        reason: body.reason,
      },
    });
    return toAttribute(row);
  });
}

const codeFromLabel = (label: string) =>
  label
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);

// ---------------------------------------------------------------- the passenger's saved profile

interface ProfileRow {
  companion: boolean;
  needs: string[];
  communication: CommunicationPreference;
  pickup_instructions: string[];
  pickup_note: string | null;
  other_note: string | null;
  version: number;
  updated_at: Date;
}

const EMPTY_PROFILE: AccessibilityProfile = {
  companion: false,
  needs: [],
  communication: 'ANY',
  pickupInstructions: [],
  pickupNote: null,
  otherNote: null,
  version: 0,
  updatedAt: null,
};

const inList = <T extends string>(list: readonly T[], v: string): v is T =>
  (list as readonly string[]).includes(v);
const clean = (s: string | null | undefined) => {
  const t = (s ?? '').trim();
  return t === '' ? null : t.slice(0, ACCESSIBILITY_NOTE_MAX);
};
const unique = <T>(xs: readonly T[]) => [...new Set(xs)];

/** Check a set of choices against the one definition. Anything unknown is refused, never dropped silently. */
export function checkAccessibility(input: {
  companion?: boolean;
  needs?: readonly string[];
  communication?: string;
  pickupInstructions?: readonly string[];
  pickupNote?: string | null;
  otherNote?: string | null;
}): Omit<TripAccessibility, 'requiredVehicleAttributes'> {
  const needs = unique(input.needs ?? []);
  for (const n of needs) {
    if (!inList(PASSENGER_NEED_CODES, n)) {
      throw new HttpError(400, 'VALIDATION_ERROR', `"${n}" is not one of the accessibility needs.`);
    }
  }
  const communication = input.communication ?? 'ANY';
  if (!inList(COMMUNICATION_PREFERENCES, communication)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'That is not one of the ways to be reached.');
  }
  const pickupInstructions = unique(input.pickupInstructions ?? []);
  for (const p of pickupInstructions) {
    if (!inList(PICKUP_INSTRUCTION_CODES, p)) {
      throw new HttpError(400, 'VALIDATION_ERROR', `"${p}" is not one of the pickup instructions.`);
    }
  }
  return {
    needs: needs as PassengerNeedCode[],
    companion: input.companion === true,
    communication,
    pickupInstructions: pickupInstructions as PickupInstructionCode[],
    pickupNote: clean(input.pickupNote),
    otherNote: clean(input.otherNote),
  };
}

export async function getProfile(userId: string): Promise<AccessibilityProfile> {
  const r = await query<ProfileRow>(
    `SELECT needs, companion, communication, pickup_instructions, pickup_note, other_note, version, updated_at
     FROM passenger_accessibility WHERE user_id = $1`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) return { ...EMPTY_PROFILE };
  return {
    needs: row.needs as PassengerNeedCode[],
    companion: row.companion,
    communication: row.communication,
    pickupInstructions: row.pickup_instructions as PickupInstructionCode[],
    pickupNote: row.pickup_note,
    otherNote: row.other_note,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Save the profile. A save names the version it was based on, so two devices cannot overwrite each other. */
export async function saveProfile(
  userId: string,
  body: AccessibilityProfileBody,
): Promise<AccessibilityProfile> {
  const v = checkAccessibility(body);
  await withTransaction(async (c) => {
    // Lock the person, not the profile row: on a first save there is no profile row yet, and two devices saving for the
    // first time would both see "no profile" and the later one would silently overwrite the earlier.
    await c.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const cur = await c.query<{ version: number }>(
      'SELECT version FROM passenger_accessibility WHERE user_id = $1 FOR UPDATE',
      [userId],
    );
    const have = cur.rows[0]?.version ?? 0;
    if ((body.version ?? 0) !== have) {
      throw new HttpError(
        409,
        'VERSION_CONFLICT',
        'Your accessibility settings changed on another device. Reload and try again.',
      );
    }
    await c.query(
      `INSERT INTO passenger_accessibility (user_id, needs, communication, pickup_instructions, pickup_note, other_note, companion)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE SET needs = $2, communication = $3, pickup_instructions = $4,
         pickup_note = $5, other_note = $6, companion = $7, version = passenger_accessibility.version + 1, updated_at = now()`,
      [
        userId,
        v.needs,
        v.communication,
        v.pickupInstructions,
        v.pickupNote,
        v.otherNote,
        v.companion,
      ],
    );
  });
  return getProfile(userId);
}

// ---------------------------------------------------------------- what a ride carries

/**
 * The accessibility of a ride being requested: the passenger's saved profile, overridden by anything the request
 * carries. Also checks the service can honour the needs (the vehicle features they map to exist and are switched on).
 */
export async function resolveForRequest(
  passengerId: string,
  requested: TripAccessibilityRequest | undefined,
): Promise<TripAccessibility> {
  const profile = await getProfile(passengerId);
  const merged = checkAccessibility({
    companion: requested?.companion ?? profile.companion,
    needs: requested?.needs ?? profile.needs,
    communication: requested?.communication ?? profile.communication,
    pickupInstructions: requested?.pickupInstructions ?? profile.pickupInstructions,
    pickupNote: requested && 'pickupNote' in requested ? requested.pickupNote : profile.pickupNote,
    otherNote: requested && 'otherNote' in requested ? requested.otherNote : profile.otherNote,
  });
  const required = requiredVehicleAttributes(merged.needs);
  if (required.length > 0) {
    const have = await query<{ code: string }>(
      'SELECT code FROM accessibility_attributes WHERE active AND code = ANY($1::text[])',
      [required],
    );
    if (have.rowCount !== required.length) {
      throw new HttpError(
        409,
        'ACCESSIBILITY_UNAVAILABLE',
        'Rides with that accessibility need are not available right now.',
      );
    }
  }
  return { ...merged, requiredVehicleAttributes: required };
}

export async function saveForTrip(tripId: string, a: TripAccessibility): Promise<void> {
  if (!hasAccessibilityContent(a)) return; // an ordinary ride stores nothing
  await query(
    `INSERT INTO trip_accessibility (trip_id, needs, communication, pickup_instructions, pickup_note, other_note, required_attributes, companion)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (trip_id) DO NOTHING`,
    [
      tripId,
      a.needs,
      a.communication,
      a.pickupInstructions,
      a.pickupNote,
      a.otherNote,
      a.requiredVehicleAttributes,
      a.companion,
    ],
  );
}

interface TripAccRow {
  companion: boolean;
  needs: string[];
  communication: CommunicationPreference;
  pickup_instructions: string[];
  pickup_note: string | null;
  other_note: string | null;
  required_attributes: string[];
}
const toTripAcc = (r: TripAccRow): TripAccessibility => ({
  companion: r.companion,
  needs: r.needs as PassengerNeedCode[],
  communication: r.communication,
  pickupInstructions: r.pickup_instructions as PickupInstructionCode[],
  pickupNote: r.pickup_note,
  otherNote: r.other_note,
  requiredVehicleAttributes: r.required_attributes,
});

export async function getForTrip(tripId: string): Promise<TripAccessibility | null> {
  const r = await query<TripAccRow>(
    `SELECT needs, companion, communication, pickup_instructions, pickup_note, other_note, required_attributes
     FROM trip_accessibility WHERE trip_id = $1`,
    [tripId],
  );
  return r.rows[0] ? toTripAcc(r.rows[0]) : null;
}

/** The vehicle features a ride requires (for matching and for the offer text). Never anything about the person. */
export async function requiredAttributesOfTrip(tripId: string): Promise<string[]> {
  const r = await query<{ required_attributes: string[] }>(
    'SELECT required_attributes FROM trip_accessibility WHERE trip_id = $1',
    [tripId],
  );
  return r.rows[0]?.required_attributes ?? [];
}

/**
 * What the viewer may see of a ride's accessibility. The passenger sees their own; the assigned driver sees it while
 * the ride is live (and not once it has ended); nobody else sees anything.
 */
export async function visibleToViewer(
  trip: { id: string; passenger_id: string; driver_id: string | null; status: string },
  viewerId: string,
): Promise<TripAccessibility | null> {
  const isPassenger = trip.passenger_id === viewerId;
  const isLiveDriver =
    trip.driver_id === viewerId &&
    !(TERMINAL_TRIP_STATUSES as readonly string[]).includes(trip.status);
  if (!isPassenger && !isLiveDriver) return null;
  return getForTrip(trip.id);
}

/** Whether the driver of this ride may start a call to the passenger (the passenger's way of being reached). */
export async function driverMayCall(tripId: string): Promise<boolean> {
  const a = await getForTrip(tripId);
  return !a || COMMUNICATION_ALLOWED_TO_CALL[a.communication];
}

const CHANGEABLE = ['SEARCHING', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'];

/**
 * The passenger changes how to reach them and where to meet while the ride is waiting for the pickup. The driver is
 * told with an event (polite announcement) that carries no words of the instructions; they read them in the ride.
 */
export async function updatePickup(
  tripId: string,
  passengerId: string,
  body: TripAccessibilityUpdateBody,
): Promise<TripAccessibility> {
  const trip = await getTrip(tripId);
  if (!trip || trip.passenger_id !== passengerId) throw notFound('The ride');
  const v = checkAccessibility({
    communication: body.communication,
    pickupInstructions: body.pickupInstructions,
    pickupNote: body.pickupNote,
  });
  const updated = await withTransaction(async (c) => {
    const locked = await c.query<{ status: string }>(
      'SELECT status FROM trips WHERE id = $1 FOR UPDATE',
      [tripId],
    );
    if (!CHANGEABLE.includes(locked.rows[0]?.status ?? '')) {
      throw new HttpError(
        409,
        'ACCESSIBILITY_LOCKED',
        'Pickup instructions can only be changed until the ride has started.',
      );
    }
    await c.query(
      `INSERT INTO trip_accessibility (trip_id, communication, pickup_instructions, pickup_note)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (trip_id) DO UPDATE SET communication = $2, pickup_instructions = $3, pickup_note = $4, updated_at = now()`,
      [tripId, v.communication, v.pickupInstructions, v.pickupNote],
    );
    return true;
  });
  if (updated) {
    await bumpTripVersion(tripId);
    if (trip.driver_id) {
      await recordTripEvent({ tripId, type: 'ACCESSIBILITY_UPDATED', actorId: passengerId });
    }
  }
  return (await getForTrip(tripId)) as TripAccessibility;
}

// ---------------------------------------------------------------- what a vehicle offers

/**
 * For a query that aliases `vehicles` as `v`: true when the vehicle holds EVERY feature in the parameter (an array of
 * codes) as APPROVED. The one condition the matching engine uses; an empty array is satisfied by any vehicle.
 */
export const attributesSatisfiedSql = (param: string) =>
  `(cardinality(${param}::text[]) = 0 OR (
      SELECT count(*) FROM vehicle_accessibility va
      WHERE va.vehicle_id = v.id AND va.status = 'APPROVED' AND va.attribute_code = ANY(${param}::text[])
    ) = cardinality(${param}::text[]))`;

async function ownVehicle(vehicleId: string, driverId: string): Promise<void> {
  const r = await query('SELECT 1 FROM vehicles WHERE id = $1 AND driver_user_id = $2', [
    vehicleId,
    driverId,
  ]);
  if (!r.rowCount) throw notFound('The vehicle');
}

export async function capabilitiesOf(
  vehicleId: string,
  driverId: string,
): Promise<VehicleCapabilitiesResponse> {
  await ownVehicle(vehicleId, driverId);
  return { vehicleId, capabilities: await capabilityList(vehicleId) };
}

async function capabilityList(vehicleId: string): Promise<VehicleCapability[]> {
  const r = await query<
    AttributeRow & { status: VehicleCapabilityStatus | null; decision_reason: string | null }
  >(
    `SELECT a.code, a.label, a.help, a.requires_approval, a.active, a.core, a.version, va.status, va.decision_reason
     FROM accessibility_attributes a
     LEFT JOIN vehicle_accessibility va ON va.attribute_code = a.code AND va.vehicle_id = $1
     WHERE a.active OR va.status IS NOT NULL
     ORDER BY a.core DESC, a.label`,
    [vehicleId],
  );
  return r.rows.map((x) => ({
    code: x.code,
    label: x.label,
    help: x.help,
    requiresApproval: x.requires_approval,
    status: x.status,
    decisionReason: x.decision_reason,
  }));
}

/**
 * The driver says which features their vehicle has. Features that need checking wait for an administrator (the driver can
 * never mark one approved); the others count at once. A feature left out is removed. An approved claim stays as it is.
 */
export async function declareCapabilities(
  vehicleId: string,
  driverId: string,
  declared: readonly string[],
): Promise<VehicleCapabilitiesResponse> {
  await ownVehicle(vehicleId, driverId);
  const wanted = unique(declared);
  await withTransaction(async (c) => {
    const catalogue = await c.query<AttributeRow>(
      'SELECT code, label, help, requires_approval, active, core, version FROM accessibility_attributes WHERE active',
    );
    const byCode = new Map(catalogue.rows.map((a) => [a.code, a]));
    for (const code of wanted) {
      if (!byCode.has(code)) {
        throw new HttpError(
          400,
          'VALIDATION_ERROR',
          `"${code}" is not a feature a vehicle can declare.`,
        );
      }
    }
    await c.query(
      `DELETE FROM vehicle_accessibility WHERE vehicle_id = $1 AND NOT (attribute_code = ANY($2::text[]))`,
      [vehicleId, wanted],
    );
    for (const code of wanted) {
      const attr = byCode.get(code) as AttributeRow;
      const status = initialCapabilityStatus(attr.requires_approval);
      // A new claim starts as `status`; a claim already APPROVED is left alone; a REJECTED one is resubmitted.
      await c.query(
        `INSERT INTO vehicle_accessibility (vehicle_id, attribute_code, status, declared_by,
                                            decided_by, decided_at, decision_reason)
         VALUES ($1, $2, $3, $4, NULL, CASE WHEN $3 = 'APPROVED' THEN now() END,
                 CASE WHEN $3 = 'APPROVED' THEN 'Declared by the driver; no approval needed for this feature.' END)
         ON CONFLICT (vehicle_id, attribute_code) DO UPDATE SET
           status = CASE WHEN vehicle_accessibility.status = 'REJECTED' THEN EXCLUDED.status
                         ELSE vehicle_accessibility.status END,
           declared_at = CASE WHEN vehicle_accessibility.status = 'REJECTED' THEN now()
                              ELSE vehicle_accessibility.declared_at END,
           decided_by = CASE WHEN vehicle_accessibility.status = 'REJECTED' THEN NULL
                             ELSE vehicle_accessibility.decided_by END,
           decision_reason = CASE WHEN vehicle_accessibility.status = 'REJECTED' THEN EXCLUDED.decision_reason
                                  ELSE vehicle_accessibility.decision_reason END`,
        [vehicleId, code, status, driverId],
      );
    }
  });
  return { vehicleId, capabilities: await capabilityList(vehicleId) };
}

// ---------------------------------------------------------------- administration

export async function pendingReviews(): Promise<AdminCapabilityReview[]> {
  const r = await query<{
    vehicle_id: string;
    attribute_code: string;
    label: string;
    driver_name: string | null;
    vehicle: string;
    declared_at: Date;
  }>(
    `SELECT va.vehicle_id, va.attribute_code, a.label, u.full_name AS driver_name,
            concat_ws(' ', v.color, v.make, v.model, '(' || v.registration_number || ')') AS vehicle, va.declared_at
     FROM vehicle_accessibility va
     JOIN accessibility_attributes a ON a.code = va.attribute_code
     JOIN vehicles v ON v.id = va.vehicle_id
     LEFT JOIN users u ON u.id = v.driver_user_id
     WHERE va.status = 'PENDING' ORDER BY va.declared_at LIMIT 200`,
  );
  return r.rows.map((x) => ({
    vehicleId: x.vehicle_id,
    attributeCode: x.attribute_code,
    attributeLabel: x.label,
    driverName: x.driver_name,
    vehicle: x.vehicle,
    declaredAt: x.declared_at.toISOString(),
  }));
}

/** Approve or reject one claim. The administrator's reason is kept, the driver is told, and it is audited. */
export async function decideCapability(
  vehicleId: string,
  code: string,
  decision: 'APPROVED' | 'REJECTED',
  reason: string,
  adminId: string,
): Promise<void> {
  const owner = await withTransaction(async (c) => {
    const r = await c.query<{ status: string; driver: string | null; label: string }>(
      `SELECT va.status, v.driver_user_id AS driver, a.label
       FROM vehicle_accessibility va JOIN vehicles v ON v.id = va.vehicle_id
       JOIN accessibility_attributes a ON a.code = va.attribute_code
       WHERE va.vehicle_id = $1 AND va.attribute_code = $2 FOR UPDATE OF va`,
      [vehicleId, code],
    );
    const row = r.rows[0];
    if (!row) throw notFound('That claim');
    await c.query(
      `UPDATE vehicle_accessibility SET status = $3, decided_by = $4, decided_at = now(), decision_reason = $5
       WHERE vehicle_id = $1 AND attribute_code = $2`,
      [vehicleId, code, decision, adminId, reason],
    );
    await recordAudit({
      actorId: adminId,
      actorRole: 'ADMIN',
      action:
        decision === 'APPROVED' ? 'VEHICLE_CAPABILITY_APPROVED' : 'VEHICLE_CAPABILITY_REJECTED',
      subjectType: 'vehicle',
      subjectIds: [vehicleId],
      detail: { code, from: row.status, reason },
    });
    return { driver: row.driver, label: row.label };
  });
  if (owner.driver) {
    await notify({
      userId: owner.driver,
      type:
        decision === 'APPROVED'
          ? ACCESSIBILITY_NOTIFICATION_TYPES.CAPABILITY_APPROVED
          : ACCESSIBILITY_NOTIFICATION_TYPES.CAPABILITY_REJECTED,
      title: decision === 'APPROVED' ? 'Vehicle feature approved' : 'Vehicle feature not approved',
      body:
        decision === 'APPROVED'
          ? `${owner.label} is now approved for your vehicle, so you can be offered rides that need it.`
          : `${owner.label} was not approved for your vehicle. ${reason}`,
      metadata: { vehicleId, code },
    });
  }
}

/** Counts only. Nobody's needs are listed here. */
export async function accessibilityStats(range: ResolvedRange): Promise<AccessibilityStats> {
  const params = [range.from, range.to];
  const [rides, vehicles, online, pending, byAttr] = await Promise.all([
    query<{ with_needs: number; vehicle: number; matched: number; unmatched: number }>(
      `SELECT count(*)::int AS with_needs,
              count(*) FILTER (WHERE cardinality(ta.required_attributes) > 0)::int AS vehicle,
              count(*) FILTER (WHERE cardinality(ta.required_attributes) > 0 AND t.driver_id IS NOT NULL)::int AS matched,
              count(*) FILTER (WHERE cardinality(ta.required_attributes) > 0 AND t.status = 'NO_DRIVERS')::int AS unmatched
       FROM trip_accessibility ta JOIN trips t ON t.id = ta.trip_id
       WHERE t.requested_at >= $1 AND t.requested_at < $2`,
      params,
    ),
    query<{ n: number }>(
      `SELECT count(DISTINCT va.vehicle_id)::int AS n FROM vehicle_accessibility va
       WHERE va.status = 'APPROVED' AND va.attribute_code = $1`,
      [ACCESSIBLE_VEHICLE_ATTRIBUTE],
    ),
    query<{ n: number }>(
      `SELECT count(DISTINCT v.id)::int AS n FROM vehicle_accessibility va
       JOIN vehicles v ON v.id = va.vehicle_id AND v.verification_status = 'APPROVED'
       JOIN driver_availability da ON da.driver_id = v.driver_user_id AND da.state = 'ONLINE'
       WHERE va.status = 'APPROVED' AND va.attribute_code = $1`,
      [ACCESSIBLE_VEHICLE_ATTRIBUTE],
    ),
    query<{ n: number }>(
      `SELECT count(*)::int AS n FROM vehicle_accessibility WHERE status = 'PENDING'`,
    ),
    query<{ code: string; label: string; approved: number; online: number }>(
      `SELECT a.code, a.label,
              count(DISTINCT va.vehicle_id) FILTER (WHERE va.status = 'APPROVED')::int AS approved,
              count(DISTINCT v.id) FILTER (WHERE va.status = 'APPROVED' AND da.state = 'ONLINE'
                                            AND v.verification_status = 'APPROVED')::int AS online
       FROM accessibility_attributes a
       LEFT JOIN vehicle_accessibility va ON va.attribute_code = a.code
       LEFT JOIN vehicles v ON v.id = va.vehicle_id
       LEFT JOIN driver_availability da ON da.driver_id = v.driver_user_id
       WHERE a.active GROUP BY a.code, a.label, a.core ORDER BY a.core DESC, a.label`,
    ),
  ]);
  const r = rides.rows[0];
  return {
    rangeLabel: range.label,
    ridesRequestedWithNeeds: r?.with_needs ?? 0,
    ridesNeedingAccessibleVehicle: r?.vehicle ?? 0,
    ridesNeedingAccessibleVehicleMatched: r?.matched ?? 0,
    ridesNeedingAccessibleVehicleUnmatched: r?.unmatched ?? 0,
    accessibleVehiclesApproved: vehicles.rows[0]?.n ?? 0,
    accessibleVehiclesOnlineNow: online.rows[0]?.n ?? 0,
    pendingReviews: pending.rows[0]?.n ?? 0,
    byAttribute: byAttr.rows.map((x) => ({
      code: x.code,
      label: x.label,
      approvedVehicles: x.approved,
      onlineNow: x.online,
    })),
  };
}

/** Staff handling a ride may read its protected details; the route audits every read. */
export async function adminTripAccessibility(tripId: string): Promise<AdminTripAccessibility> {
  const trip = await getTrip(tripId);
  if (!trip) throw notFound('The ride');
  return { tripId, accessibility: await getForTrip(tripId) };
}

/** The retention rule for ACCESSIBILITY_RIDE_DETAILS (called by compliance/retention.service). */
export async function purgeOldRideAccessibility(days: number): Promise<number> {
  const r = await query(
    `DELETE FROM trip_accessibility ta USING trips t
     WHERE t.id = ta.trip_id AND t.ended_at IS NOT NULL
       AND t.ended_at < now() - ($1::int * interval '1 day')`,
    [days],
  );
  return r.rowCount ?? 0;
}
