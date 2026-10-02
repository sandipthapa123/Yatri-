import {
  FLEET_NOTIFICATION_TYPES,
  VEHICLE_LIFECYCLE_LABELS,
  VEHICLE_LIFECYCLE_TRANSITIONS,
  type AdminFleetVehicleBody,
  type FleetVehicleDetail,
  type FleetVehicleRow,
  type ServiceRecordInfo,
  type VehicleLifecycle,
} from '@yatri/types';
import type { PoolClient } from 'pg';

import { recordAudit, auditTrail } from '../../lib/audit';
import { query, withTransaction } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { listRequiredDocumentTypes } from '../documents/document-types.repository';
import { documentSatisfies, isPastDate } from '../drivers/onboarding.service';
import type { DocumentRow } from '../documents/documents.types';
import { likeContains } from '../admin/admin-range';
import { ACTIVE_SQL } from '../trips/trips.repository';
import { createVehicle, registrationTaken } from '../vehicles/vehicles.repository';
import { VEHICLE_RIDEABLE_SQL, vehicleRideProblems } from './eligibility';
import { enforceEligibility } from './enforcement';
import { expiryItems } from './expiry.service';
import { notifyDriver } from './fleet-notify';
import { listServiceRecords } from './service-records.service';
import { afterLifecycle, setLifecycle } from './vehicle-lifecycle';

/**
 * Vehicles as fleet operations sees them: the lifecycle (one guarded move at a time), and who drives which
 * vehicle. `vehicles.driver_user_id` is the ONE record of the driver-to-vehicle relationship; assigning and
 * unassigning are the only writes to it from here, each checked by `assignmentProblems` and applied under a
 * row lock, so two administrators acting together cannot both win.
 */
interface Row {
  id: string;
  registration_number: string;
  make: string;
  model: string;
  color: string;
  category_label: string | null;
  lifecycle_status: VehicleLifecycle;
  verification_status: string;
  fleet_id: string | null;
  fleet_name: string | null;
  driver_user_id: string | null;
  driver_name: string | null;
  eligible: boolean;
}
const toRow = (r: Row): FleetVehicleRow => ({
  id: r.id,
  registrationNumber: r.registration_number,
  description: `${r.color} ${r.make} ${r.model}`,
  categoryLabel: r.category_label,
  lifecycle: r.lifecycle_status,
  verificationStatus: r.verification_status,
  fleetId: r.fleet_id,
  fleetName: r.fleet_name,
  driverId: r.driver_user_id,
  driverName: r.driver_name,
  eligible: r.eligible,
});
const SELECT = `SELECT v.id, v.registration_number, v.make, v.model, v.color, c.label AS category_label,
    v.lifecycle_status, v.verification_status::text AS verification_status, v.fleet_id, fl.name AS fleet_name,
    v.driver_user_id, u.full_name AS driver_name, (${VEHICLE_RIDEABLE_SQL}) AS eligible
  FROM vehicles v
  LEFT JOIN vehicle_categories c ON c.id = v.category_id
  LEFT JOIN fleets fl ON fl.id = v.fleet_id
  LEFT JOIN users u ON u.id = v.driver_user_id`;

export interface VehicleFilters {
  fleetId?: string;
  lifecycle?: VehicleLifecycle;
  assigned?: 'yes' | 'no';
  driverId?: string;
  search?: string;
  page: number;
  pageSize: number;
}

export async function listFleetVehicles(f: VehicleFilters) {
  const where = `WHERE ($1::uuid IS NULL OR v.fleet_id = $1) AND ($2::text IS NULL OR v.lifecycle_status = $2)
    AND ($3::text IS NULL OR ($3 = 'yes') = (v.driver_user_id IS NOT NULL))
    AND ($4::uuid IS NULL OR v.driver_user_id = $4)
    AND ($5::text IS NULL OR v.registration_number ILIKE $5 ESCAPE '!' OR v.make ILIKE $5 ESCAPE '!'
         OR v.model ILIKE $5 ESCAPE '!' OR u.full_name ILIKE $5 ESCAPE '!')`;
  const params = [
    f.fleetId ?? null,
    f.lifecycle ?? null,
    f.assigned ?? null,
    f.driverId ?? null,
    f.search ? likeContains(f.search) : null,
  ];
  const [rows, count] = await Promise.all([
    query<Row>(`${SELECT} ${where} ORDER BY v.registration_number, v.id LIMIT $6 OFFSET $7`, [
      ...params,
      f.pageSize,
      (f.page - 1) * f.pageSize,
    ]),
    query<{ n: string }>(
      `SELECT count(*)::text AS n FROM vehicles v LEFT JOIN users u ON u.id = v.driver_user_id ${where}`,
      params,
    ),
  ]);
  return { total: Number(count.rows[0]?.n ?? 0), items: rows.rows.map(toRow) };
}

export async function fleetVehicleDetail(id: string): Promise<FleetVehicleDetail> {
  const r = await query<Row>(`${SELECT} WHERE v.id = $1`, [id]);
  const row = r.rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Vehicle not found.');
  const [eligibility, expiry, service, audit] = await Promise.all([
    vehicleRideProblems(id),
    expiryItems({ vehicleId: id, includeValid: true }),
    listServiceRecords(id),
    auditTrail('vehicle', id),
  ]);
  return {
    ...toRow(row),
    allowedNext: [...VEHICLE_LIFECYCLE_TRANSITIONS[row.lifecycle_status]],
    eligibility,
    expiry,
    service: service as ServiceRecordInfo[],
    audit,
    assignable:
      row.driver_user_id === null &&
      ['ACTIVE', 'INACTIVE', 'MAINTENANCE'].includes(row.lifecycle_status),
  };
}

export async function changeVehicleLifecycle(
  vehicleId: string,
  to: VehicleLifecycle,
  reason: string,
  adminId: string,
): Promise<FleetVehicleDetail> {
  const moved = await withTransaction((client) => setLifecycle(client, vehicleId, to));
  await afterLifecycle(vehicleId, moved, to, adminId, reason);
  return fleetVehicleDetail(vehicleId);
}

// ---------------------------------------------------------------- assignment

/**
 * Everything that stops this vehicle going to this driver, in words. Validated: the vehicle's lifecycle and
 * review, its fleet, its dates and (once approved) its papers; the driver's account, verification,
 * operational status, licence and papers; and the conflicts (a vehicle already with another driver).
 * A vehicle not yet approved can be assigned: its papers are uploaded by its driver and reviewed after.
 */
export async function assignmentProblems(
  client: PoolClient,
  vehicleId: string,
  driverId: string,
): Promise<string[]> {
  const v = await client.query<{
    registration_number: string;
    category_id: string;
    lifecycle_status: VehicleLifecycle;
    verification_status: string;
    fleet_id: string | null;
    driver_user_id: string | null;
    registration_expiry_date: string | null;
    insurance_expiry_date: string | null;
  }>(
    `SELECT registration_number, category_id, lifecycle_status, verification_status::text AS verification_status,
            fleet_id, driver_user_id, registration_expiry_date::text AS registration_expiry_date,
            insurance_expiry_date::text AS insurance_expiry_date
     FROM vehicles WHERE id = $1`,
    [vehicleId],
  );
  const vehicle = v.rows[0];
  if (!vehicle) throw new HttpError(404, 'NOT_FOUND', 'Vehicle not found.');
  const d = await client.query<{
    account_status: string;
    verification_status: string;
    operational_status: string;
    fleet_id: string | null;
    license_expiry_date: string | null;
  }>(
    `SELECT u.status::text AS account_status, dp.status::text AS verification_status, dp.operational_status,
            dp.fleet_id, dd.license_expiry_date::text AS license_expiry_date
     FROM driver_profiles dp JOIN users u ON u.id = dp.user_id
     LEFT JOIN driver_details dd ON dd.user_id = dp.user_id
     WHERE dp.user_id = $1 AND u.role = 'DRIVER'`,
    [driverId],
  );
  const driver = d.rows[0];
  if (!driver) throw new HttpError(404, 'NOT_FOUND', 'Driver not found.');

  const reg = vehicle.registration_number;
  const problems: string[] = [];
  // conflicts first: they are the ones an administrator can act on
  if (vehicle.driver_user_id === driverId)
    problems.push(`Vehicle ${reg} is already assigned to this driver.`);
  else if (vehicle.driver_user_id) {
    problems.push(`Vehicle ${reg} is already assigned to another driver. Unassign it first.`);
  }
  if (!['ACTIVE', 'INACTIVE', 'MAINTENANCE'].includes(vehicle.lifecycle_status)) {
    problems.push(
      `Vehicle ${reg} is ${VEHICLE_LIFECYCLE_LABELS[vehicle.lifecycle_status].toLowerCase()} and cannot be assigned.`,
    );
  }
  if (vehicle.verification_status === 'REJECTED') {
    problems.push(`Vehicle ${reg} was rejected in review and cannot be assigned.`);
  }
  if (isPastDate(vehicle.registration_expiry_date))
    problems.push(`The registration of ${reg} has expired.`);
  if (isPastDate(vehicle.insurance_expiry_date))
    problems.push(`The insurance of ${reg} has expired.`);
  if (vehicle.fleet_id !== null && driver.fleet_id !== vehicle.fleet_id) {
    problems.push('The driver belongs to a different fleet (or to none) than this vehicle.');
  }
  if (vehicle.fleet_id === null) {
    problems.push(
      `Vehicle ${reg} does not belong to a fleet, so it stays with the driver who registered it.`,
    );
  }
  if (driver.account_status !== 'ACTIVE') problems.push("The driver's account is not active.");
  if (driver.verification_status !== 'VERIFIED') problems.push('The driver is not verified.');
  if (driver.operational_status === 'SUSPENDED')
    problems.push('The driver is suspended by operations.');
  if (isPastDate(driver.license_expiry_date)) problems.push("The driver's licence has expired.");
  const driverDocs = await client.query<DocumentRow>(
    `SELECT d.*, dt.code AS document_type_code, dt.label AS document_type_label
     FROM documents d JOIN document_types dt ON dt.id = d.document_type_id
     WHERE d.owner_type = 'DRIVER' AND d.driver_user_id = $1`,
    [driverId],
  );
  for (const t of await listRequiredDocumentTypes('DRIVER')) {
    if (!documentSatisfies(driverDocs.rows, t.id, null, true)) {
      problems.push(`The driver's ${t.label} is missing, rejected, or expired.`);
    }
  }
  if (vehicle.verification_status === 'APPROVED') {
    const vdocs = await client.query<DocumentRow>(
      `SELECT d.*, dt.code AS document_type_code, dt.label AS document_type_label
       FROM documents d JOIN document_types dt ON dt.id = d.document_type_id
       WHERE d.owner_type = 'VEHICLE' AND d.vehicle_id = $1`,
      [vehicleId],
    );
    for (const t of await listRequiredDocumentTypes('VEHICLE', vehicle.category_id)) {
      if (!documentSatisfies(vdocs.rows, t.id, vehicleId, true)) {
        problems.push(`${t.label} for ${reg} is missing, rejected, or expired.`);
      }
    }
  }
  return problems;
}

export async function assignVehicle(
  vehicleId: string,
  driverId: string,
  adminId: string,
): Promise<FleetVehicleDetail> {
  const reg = await withTransaction(async (client) => {
    // Lock the vehicle, then the driver, in that order, so simultaneous assignments line up.
    await client.query('SELECT 1 FROM vehicles WHERE id = $1 FOR UPDATE', [vehicleId]);
    await client.query('SELECT 1 FROM driver_profiles WHERE user_id = $1 FOR UPDATE', [driverId]);
    const problems = await assignmentProblems(client, vehicleId, driverId);
    if (problems.length > 0) {
      throw new HttpError(409, 'ASSIGNMENT_NOT_ALLOWED', problems[0] as string).withDetails({
        problems,
      });
    }
    const u = await client.query<{ registration_number: string }>(
      `UPDATE vehicles SET driver_user_id = $2, updated_at = now()
       WHERE id = $1 AND driver_user_id IS NULL RETURNING registration_number`,
      [vehicleId, driverId],
    );
    if (!u.rows[0]) {
      throw new HttpError(
        409,
        'ASSIGNMENT_NOT_ALLOWED',
        'This vehicle was just assigned to someone else.',
      );
    }
    return u.rows[0].registration_number;
  });
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'VEHICLE_ASSIGNED',
    subjectType: 'vehicle',
    subjectIds: [vehicleId],
    detail: { driverId },
  });
  await notifyDriver(
    driverId,
    FLEET_NOTIFICATION_TYPES.VEHICLE_ASSIGNED,
    `Vehicle ${reg} was assigned to you. Upload its documents if they are not on file, then go online when it is approved.`,
    { vehicleId },
  );
  return fleetVehicleDetail(vehicleId);
}

export async function unassignVehicle(
  vehicleId: string,
  reason: string,
  adminId: string,
): Promise<FleetVehicleDetail> {
  const done = await withTransaction(async (client) => {
    const cur = await client.query<{
      registration_number: string;
      driver_user_id: string | null;
      fleet_id: string | null;
    }>(
      'SELECT registration_number, driver_user_id, fleet_id FROM vehicles WHERE id = $1 FOR UPDATE',
      [vehicleId],
    );
    const v = cur.rows[0];
    if (!v) throw new HttpError(404, 'NOT_FOUND', 'Vehicle not found.');
    if (!v.driver_user_id) {
      throw new HttpError(409, 'NOT_ASSIGNED', `Vehicle ${v.registration_number} has no driver.`);
    }
    if (!v.fleet_id) {
      throw new HttpError(
        409,
        'NOT_A_FLEET_VEHICLE',
        'Only a fleet vehicle can be unassigned. Retire this vehicle instead.',
      );
    }
    const onRide = await client.query(
      `SELECT 1 FROM trips WHERE driver_id = $1 AND status IN ${ACTIVE_SQL} LIMIT 1`,
      [v.driver_user_id],
    );
    if (onRide.rowCount) {
      throw new HttpError(
        409,
        'DRIVER_ON_RIDE',
        'The driver is on a ride. Unassign after it ends.',
      );
    }
    await client.query(
      'UPDATE vehicles SET driver_user_id = NULL, updated_at = now() WHERE id = $1',
      [vehicleId],
    );
    return { registration: v.registration_number, driverId: v.driver_user_id };
  });
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'VEHICLE_UNASSIGNED',
    subjectType: 'vehicle',
    subjectIds: [vehicleId],
    detail: { driverId: done.driverId, reason },
  });
  await notifyDriver(
    done.driverId,
    FLEET_NOTIFICATION_TYPES.VEHICLE_UNASSIGNED,
    `Vehicle ${done.registration} is no longer assigned to you.`,
    { vehicleId },
  );
  await enforceEligibility(done.driverId);
  return fleetVehicleDetail(vehicleId);
}

/** A vehicle owned by a fleet, registered by an administrator and not yet with a driver. */
export async function createFleetVehicle(
  body: AdminFleetVehicleBody,
  adminId: string,
): Promise<FleetVehicleDetail> {
  if (!body.fleetId) throw new HttpError(400, 'VALIDATION_ERROR', 'A fleet vehicle needs a fleet.');
  const fleet = await query<{ status: string }>('SELECT status FROM fleets WHERE id = $1', [
    body.fleetId,
  ]);
  if (!fleet.rows[0]) throw new HttpError(400, 'VALIDATION_ERROR', 'Unknown fleet.');
  try {
    const row = await createVehicle(
      null,
      {
        categoryId: body.categoryId,
        make: body.make,
        model: body.model,
        year: body.year,
        color: body.color,
        registrationNumber: body.registrationNumber,
        registrationExpiryDate: body.registrationExpiryDate ?? undefined,
        insuranceExpiryDate: body.insuranceExpiryDate ?? undefined,
      },
      body.fleetId,
    );
    await recordAudit({
      actorId: adminId,
      actorRole: 'ADMIN',
      action: 'FLEET_VEHICLE_CREATED',
      subjectType: 'vehicle',
      subjectIds: [row.id],
      detail: { registrationNumber: row.registration_number, fleetId: body.fleetId },
    });
    return fleetVehicleDetail(row.id);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      throw registrationTaken();
    }
    if (code === '23503') throw new HttpError(400, 'VALIDATION_ERROR', 'Unknown vehicle category.');
    throw err;
  }
}
