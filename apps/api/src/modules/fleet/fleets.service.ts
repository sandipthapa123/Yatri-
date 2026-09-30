import {
  FLEET_STATUS_LABELS,
  type AdminFleetBody,
  type FleetDetail,
  type FleetInfo,
  type FleetStatus,
} from '@yatri/types';
import { z } from 'zod';

import { recordAudit, auditTrail } from '../../lib/audit';
import { query, withTransaction } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { enforceEligibility } from './enforcement';
import { listFleetDrivers } from './operational.service';
import { listFleetVehicles } from './vehicles.service';

/**
 * Fleets (operators). A fleet has contact details and a status; its vehicles and drivers are the records
 * that point at it (`vehicles.fleet_id`, `driver_profiles.fleet_id`), not a second list. While a fleet is not
 * ACTIVE its vehicles and drivers are not offered rides (the rule lives in fleet/eligibility), and online
 * drivers of a fleet that stops being active are taken offline.
 */
interface Row {
  id: string;
  name: string;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  status: FleetStatus;
  vehicle_count: number;
  driver_count: number;
  created_at: Date;
}
const toInfo = (r: Row): FleetInfo => ({
  id: r.id,
  name: r.name,
  contactName: r.contact_name,
  contactPhone: r.contact_phone,
  contactEmail: r.contact_email,
  status: r.status,
  vehicleCount: r.vehicle_count,
  driverCount: r.driver_count,
  createdAt: r.created_at.toISOString(),
});
const SELECT = `SELECT f.id, f.name, f.contact_name, f.contact_phone, f.contact_email, f.status, f.created_at,
    (SELECT count(*)::int FROM vehicles v WHERE v.fleet_id = f.id AND v.lifecycle_status <> 'RETIRED') AS vehicle_count,
    (SELECT count(*)::int FROM driver_profiles d WHERE d.fleet_id = f.id) AS driver_count
  FROM fleets f`;

export async function listFleets(): Promise<FleetInfo[]> {
  const r = await query<Row>(`${SELECT} ORDER BY f.name`);
  return r.rows.map(toInfo);
}

export async function fleetDetail(id: string): Promise<FleetDetail> {
  const r = await query<Row>(`${SELECT} WHERE f.id = $1`, [id]);
  if (!r.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Fleet not found.');
  const [vehicles, drivers, audit] = await Promise.all([
    listFleetVehicles({ fleetId: id, page: 1, pageSize: 200 }),
    listFleetDrivers({ fleetId: id, page: 1, pageSize: 200 }),
    auditTrail('fleet', id),
  ]);
  return { ...toInfo(r.rows[0]), vehicles: vehicles.items, drivers: drivers.items, audit };
}

export const fleetBodySchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    contactName: z.string().trim().max(100).nullable(),
    contactPhone: z
      .string()
      .trim()
      .regex(/^\+[1-9][0-9]{6,14}$/, 'Use an international phone number such as +9779812345678.')
      .nullable(),
    contactEmail: z.string().trim().toLowerCase().email().max(200).nullable(),
    status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();

export async function createFleet(body: AdminFleetBody, adminId: string): Promise<FleetDetail> {
  try {
    const r = await query<{ id: string }>(
      `INSERT INTO fleets (name, contact_name, contact_phone, contact_email, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [body.name, body.contactName, body.contactPhone, body.contactEmail, body.status],
    );
    const id = (r.rows[0] as { id: string }).id;
    await recordAudit({
      actorId: adminId,
      actorRole: 'ADMIN',
      action: 'FLEET_CREATED',
      subjectType: 'fleet',
      subjectIds: [id],
      detail: { name: body.name, reason: body.reason },
    });
    return fleetDetail(id);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new HttpError(409, 'FLEET_NAME_TAKEN', 'A fleet with that name already exists.');
    }
    throw err;
  }
}

export async function updateFleet(
  id: string,
  body: AdminFleetBody,
  adminId: string,
): Promise<FleetDetail> {
  const from = await withTransaction(async (client) => {
    const cur = await client.query<{ status: FleetStatus }>(
      'SELECT status FROM fleets WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!cur.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Fleet not found.');
    try {
      await client.query(
        `UPDATE fleets SET name = $2, contact_name = $3, contact_phone = $4, contact_email = $5,
           status = $6, updated_at = now() WHERE id = $1`,
        [id, body.name, body.contactName, body.contactPhone, body.contactEmail, body.status],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new HttpError(409, 'FLEET_NAME_TAKEN', 'A fleet with that name already exists.');
      }
      throw err;
    }
    return cur.rows[0].status;
  });
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: from === body.status ? 'FLEET_UPDATED' : 'FLEET_STATUS_CHANGED',
    subjectType: 'fleet',
    subjectIds: [id],
    detail: {
      from: FLEET_STATUS_LABELS[from],
      to: FLEET_STATUS_LABELS[body.status],
      reason: body.reason,
    },
  });
  if (body.status !== 'ACTIVE') {
    const drivers = await query<{ user_id: string }>(
      'SELECT user_id FROM driver_profiles WHERE fleet_id = $1',
      [id],
    );
    for (const d of drivers.rows) await enforceEligibility(d.user_id);
  }
  return fleetDetail(id);
}

/** Put a driver in a fleet, or take them out (null). A driver with a vehicle of another fleet cannot move. */
export async function setDriverFleet(
  driverId: string,
  fleetId: string | null,
  reason: string,
  adminId: string,
): Promise<void> {
  const from = await withTransaction(async (client) => {
    const cur = await client.query<{ fleet_id: string | null }>(
      'SELECT fleet_id FROM driver_profiles WHERE user_id = $1 FOR UPDATE',
      [driverId],
    );
    if (!cur.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Driver not found.');
    if (fleetId) {
      const f = await client.query('SELECT 1 FROM fleets WHERE id = $1', [fleetId]);
      if (!f.rowCount) throw new HttpError(400, 'VALIDATION_ERROR', 'Unknown fleet.');
    }
    const held = await client.query(
      `SELECT 1 FROM vehicles WHERE driver_user_id = $1 AND fleet_id IS NOT NULL
         AND fleet_id IS DISTINCT FROM $2::uuid AND lifecycle_status <> 'RETIRED' LIMIT 1`,
      [driverId, fleetId],
    );
    if (held.rowCount) {
      throw new HttpError(
        409,
        'DRIVER_HAS_FLEET_VEHICLE',
        'The driver drives a vehicle of another fleet. Unassign it first.',
      );
    }
    await client.query('UPDATE driver_profiles SET fleet_id = $2 WHERE user_id = $1', [
      driverId,
      fleetId,
    ]);
    return cur.rows[0].fleet_id;
  });
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'DRIVER_FLEET_CHANGED',
    subjectType: 'driver_operations',
    subjectIds: [driverId],
    detail: { from, to: fleetId, reason },
  });
  await enforceEligibility(driverId);
}
