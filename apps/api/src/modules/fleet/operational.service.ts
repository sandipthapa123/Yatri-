import {
  FLEET_NOTIFICATION_TYPES,
  OPERATIONAL_LABELS,
  OPERATIONAL_TRANSITIONS,
  canOperationalTransition,
  describeOperationalStatus,
  type FleetDriverDetail,
  type FleetDriverRow,
  type OperationalStatus,
} from '@yatri/types';

import { recordAudit, auditTrail } from '../../lib/audit';
import { query, withTransaction } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { likeContains } from '../admin/admin-range';
import { evaluateDriverEligibility } from '../availability/eligibility';
import { ACTIVE_SQL } from '../trips/trips.repository';
import { DRIVER_RIDEABLE_SQL, VEHICLE_RIDEABLE_SQL } from './eligibility';
import { enforceEligibility } from './enforcement';
import { expiryItems } from './expiry.service';
import { notifyDriver } from './fleet-notify';
import { listFleetVehicles } from './vehicles.service';

/**
 * A driver's OPERATIONAL status: active, restricted (a lower daily ride cap) or suspended by operations. It is
 * its own model, apart from the account, the verification, the availability state and the ride, each of which
 * keeps its one owner; the detail view shows them side by side and changes none of them. A change is checked
 * against the table in @yatri/types, applied under the driver's row lock, recorded, told to the driver in the
 * shared words, and an online driver who can no longer take rides is taken offline.
 */
interface Row {
  id: string;
  full_name: string | null;
  phone_number: string | null;
  account_status: string;
  verification_status: string;
  operational_status: OperationalStatus;
  availability: string | null;
  fleet_id: string | null;
  fleet_name: string | null;
  vehicle_count: number;
  eligible: boolean;
}
const toRow = (r: Row): FleetDriverRow => ({
  id: r.id,
  name: r.full_name,
  phone: r.phone_number,
  accountStatus: r.account_status,
  verificationStatus: r.verification_status,
  operationalStatus: r.operational_status,
  availability: r.availability ?? 'OFFLINE',
  fleetId: r.fleet_id,
  fleetName: r.fleet_name,
  vehicleCount: r.vehicle_count,
  eligible: r.eligible,
});
const SELECT = `SELECT u.id, u.full_name, u.phone_number, u.status::text AS account_status,
    dp.status::text AS verification_status, dp.operational_status, av.state AS availability,
    dp.fleet_id, fl.name AS fleet_name,
    (SELECT count(*)::int FROM vehicles x WHERE x.driver_user_id = u.id AND x.lifecycle_status <> 'RETIRED') AS vehicle_count,
    (u.status = 'ACTIVE' AND dp.status = 'VERIFIED' AND ${DRIVER_RIDEABLE_SQL}
      AND EXISTS (SELECT 1 FROM vehicles v WHERE v.driver_user_id = u.id AND ${VEHICLE_RIDEABLE_SQL})) AS eligible
  FROM driver_profiles dp JOIN users u ON u.id = dp.user_id
  LEFT JOIN driver_availability av ON av.driver_id = u.id
  LEFT JOIN fleets fl ON fl.id = dp.fleet_id`;

export interface DriverFilters {
  fleetId?: string;
  operational?: OperationalStatus;
  search?: string;
  page: number;
  pageSize: number;
}

export async function listFleetDrivers(f: DriverFilters) {
  const where = `WHERE ($1::uuid IS NULL OR dp.fleet_id = $1) AND ($2::text IS NULL OR dp.operational_status = $2)
    AND ($3::text IS NULL OR u.full_name ILIKE $3 ESCAPE '!' OR u.phone_number ILIKE $3 ESCAPE '!')`;
  const params = [
    f.fleetId ?? null,
    f.operational ?? null,
    f.search ? likeContains(f.search) : null,
  ];
  const [rows, count] = await Promise.all([
    query<Row>(`${SELECT} ${where} ORDER BY u.full_name NULLS LAST, u.id LIMIT $4 OFFSET $5`, [
      ...params,
      f.pageSize,
      (f.page - 1) * f.pageSize,
    ]),
    query<{ n: string }>(
      `SELECT count(*)::text AS n FROM driver_profiles dp JOIN users u ON u.id = dp.user_id ${where}`,
      params,
    ),
  ]);
  return { total: Number(count.rows[0]?.n ?? 0), items: rows.rows.map(toRow) };
}

export async function fleetDriverDetail(id: string): Promise<FleetDriverDetail> {
  const r = await query<
    Row & { operational_reason: string | null; operational_until: Date | null }
  >(
    `${SELECT.replace('dp.operational_status,', 'dp.operational_status, dp.operational_reason, dp.operational_until,')} WHERE u.id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Driver not found.');
  const [eligibility, vehicles, expiry, audit, ride] = await Promise.all([
    evaluateDriverEligibility(id),
    listFleetVehicles({ driverId: id, page: 1, pageSize: 50 }),
    expiryItems({ driverId: id, includeValid: true }),
    auditTrail('driver_operations', id),
    query<{ status: string }>(
      `SELECT status FROM trips WHERE driver_id = $1 AND status IN ${ACTIVE_SQL} LIMIT 1`,
      [id],
    ),
  ]);
  return {
    ...toRow(row),
    operationalReason: row.operational_reason,
    operationalUntil: row.operational_until?.toISOString() ?? null,
    allowedNext: [...OPERATIONAL_TRANSITIONS[row.operational_status]],
    axes: {
      account: row.account_status,
      verification: row.verification_status,
      operational: row.operational_status,
      availability: row.availability ?? 'OFFLINE',
      ride: ride.rows[0]?.status ?? 'NONE',
    },
    eligibility: { eligible: eligibility.eligible, reasons: eligibility.reasons },
    vehicles: vehicles.items,
    expiry,
    audit,
  };
}

/** Move a driver's operational status. `adminId` is null when the system lifts a restriction that ran out. */
export async function setOperationalStatus(
  driverId: string,
  to: OperationalStatus,
  reason: string,
  until: string | null,
  adminId: string | null,
): Promise<FleetDriverDetail> {
  if (until && new Date(until).getTime() <= Date.now()) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'The end date must be in the future.');
  }
  const moved = await withTransaction(async (client) => {
    const cur = await client.query<{ operational_status: OperationalStatus }>(
      'SELECT operational_status FROM driver_profiles WHERE user_id = $1 FOR UPDATE',
      [driverId],
    );
    const from = cur.rows[0]?.operational_status;
    if (!from) throw new HttpError(404, 'NOT_FOUND', 'Driver not found.');
    if (!canOperationalTransition(from, to)) {
      const next = OPERATIONAL_TRANSITIONS[from].map((s) => OPERATIONAL_LABELS[s]);
      throw new HttpError(
        409,
        'INVALID_OPERATIONAL_TRANSITION',
        `A driver who is ${OPERATIONAL_LABELS[from].toLowerCase()} can only become: ${next.join(', ')}.`,
      );
    }
    await client.query(
      `UPDATE driver_profiles SET operational_status = $2, operational_reason = $3,
         operational_until = $4, operational_changed_at = now() WHERE user_id = $1`,
      [driverId, to, to === 'ACTIVE' ? null : reason, to === 'ACTIVE' ? null : (until ?? null)],
    );
    return from;
  });
  await recordAudit({
    actorId: adminId,
    actorRole: adminId ? 'ADMIN' : 'SYSTEM',
    action: 'DRIVER_OPERATIONAL_STATUS_CHANGED',
    subjectType: 'driver_operations',
    subjectIds: [driverId],
    detail: { from: moved, to, reason, ...(until ? { until } : {}) },
  });
  await notifyDriver(
    driverId,
    to === 'SUSPENDED'
      ? FLEET_NOTIFICATION_TYPES.DRIVER_SUSPENDED
      : to === 'RESTRICTED'
        ? FLEET_NOTIFICATION_TYPES.DRIVER_RESTRICTED
        : FLEET_NOTIFICATION_TYPES.DRIVER_REINSTATED,
    describeOperationalStatus(moved, to, reason, until),
    { from: moved, to },
  );
  if (to === 'SUSPENDED') await enforceEligibility(driverId);
  return fleetDriverDetail(driverId);
}

/** Put a driver back to ACTIVE when a timed restriction or suspension has run out. Returns how many were lifted. */
export async function liftExpiredRestrictions(): Promise<number> {
  const due = await query<{ user_id: string }>(
    `SELECT user_id FROM driver_profiles
     WHERE operational_status <> 'ACTIVE' AND operational_until IS NOT NULL AND operational_until <= now()`,
  );
  let n = 0;
  for (const d of due.rows) {
    try {
      await setOperationalStatus(d.user_id, 'ACTIVE', 'The time limit ended', null, null);
      n++;
    } catch {
      /* someone changed it first: nothing to lift */
    }
  }
  return n;
}
