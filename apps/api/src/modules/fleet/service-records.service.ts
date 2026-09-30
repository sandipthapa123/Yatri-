import {
  FLEET_NOTIFICATION_TYPES,
  type AdminInspectionBody,
  type AdminMaintenanceCompleteBody,
  type AdminMaintenanceStartBody,
  type AdminServiceLogBody,
  type InspectionResult,
  type ServiceKind,
  type ServiceRecordInfo,
  type ServiceStatus,
} from '@yatri/types';

import { recordAudit } from '../../lib/audit';
import { query, withTransaction } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { notifyDriver } from './fleet-notify';
import { afterLifecycle, setLifecycle } from './vehicle-lifecycle';

/**
 * Inspection and maintenance records. A record belongs to a vehicle and to nothing else: no ride, payment
 * or refund can be reached from it, so recording work on a vehicle can never change financial or ride data.
 * What a record does to the vehicle goes through the vehicle's one lifecycle move (`setLifecycle`):
 * starting maintenance puts the vehicle in MAINTENANCE, completing it returns the vehicle to service, and a
 * failed inspection puts it in MAINTENANCE with the repair opened. A vehicle has at most one piece of
 * maintenance in progress (a unique index), so two administrators cannot open it twice.
 */
interface Row {
  id: string;
  vehicle_id: string;
  registration_number: string | null;
  kind: ServiceKind;
  status: ServiceStatus;
  performed_on: string | null;
  next_due_on: string | null;
  result: InspectionResult | null;
  notes: string | null;
  recorder: string | null;
  created_at: Date;
  completed_at: Date | null;
}
const SELECT = `SELECT r.id, r.vehicle_id, v.registration_number, r.kind, r.status,
    r.performed_on::text AS performed_on, r.next_due_on::text AS next_due_on, r.result, r.notes,
    u.full_name AS recorder, r.created_at, r.completed_at
  FROM vehicle_service_records r JOIN vehicles v ON v.id = r.vehicle_id
  LEFT JOIN users u ON u.id = r.recorded_by`;
const toInfo = (r: Row): ServiceRecordInfo => ({
  id: r.id,
  vehicleId: r.vehicle_id,
  vehicleRegistration: r.registration_number,
  kind: r.kind,
  status: r.status,
  performedOn: r.performed_on,
  nextDueOn: r.next_due_on,
  result: r.result,
  notes: r.notes,
  recordedByName: r.recorder,
  createdAt: r.created_at.toISOString(),
  completedAt: r.completed_at?.toISOString() ?? null,
});

export async function listServiceRecords(vehicleId: string): Promise<ServiceRecordInfo[]> {
  const r = await query<Row>(`${SELECT} WHERE r.vehicle_id = $1 ORDER BY r.created_at DESC, r.id`, [
    vehicleId,
  ]);
  return r.rows.map(toInfo);
}

/** Every record, newest first, for the maintenance list (optionally only the ones still in progress). */
export async function listAllServiceRecords(opts: {
  status?: ServiceStatus;
  page: number;
  pageSize: number;
}) {
  const where = 'WHERE ($1::text IS NULL OR r.status = $1)';
  const [rows, count] = await Promise.all([
    query<Row>(
      `${SELECT} ${where} ORDER BY (r.status = 'IN_PROGRESS') DESC, r.created_at DESC, r.id LIMIT $2 OFFSET $3`,
      [opts.status ?? null, opts.pageSize, (opts.page - 1) * opts.pageSize],
    ),
    query<{ n: string }>(`SELECT count(*)::text AS n FROM vehicle_service_records r ${where}`, [
      opts.status ?? null,
    ]),
  ]);
  return { total: Number(count.rows[0]?.n ?? 0), items: rows.rows.map(toInfo) };
}

async function oneRecord(id: string): Promise<ServiceRecordInfo> {
  const r = await query<Row>(`${SELECT} WHERE r.id = $1`, [id]);
  if (!r.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Record not found.');
  return toInfo(r.rows[0]);
}

const audit = (
  adminId: string,
  action: string,
  recordId: string,
  detail: Record<string, unknown>,
) =>
  recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action,
    subjectType: 'vehicle_service',
    subjectIds: [recordId],
    detail,
  });

/** Take a vehicle in for maintenance: the vehicle goes to MAINTENANCE and a record is opened. */
export async function startMaintenance(
  vehicleId: string,
  body: AdminMaintenanceStartBody,
  adminId: string,
): Promise<ServiceRecordInfo> {
  const out = await withTransaction(async (client) => {
    const moved = await setLifecycle(client, vehicleId, 'MAINTENANCE');
    try {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO vehicle_service_records (vehicle_id, kind, status, notes, recorded_by)
         VALUES ($1, 'MAINTENANCE', 'IN_PROGRESS', $2, $3) RETURNING id`,
        [vehicleId, body.notes ?? null, adminId],
      );
      return { id: (ins.rows[0] as { id: string }).id, moved };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new HttpError(
          409,
          'MAINTENANCE_OPEN',
          'This vehicle already has maintenance in progress.',
        );
      }
      throw err;
    }
  });
  await audit(adminId, 'MAINTENANCE_STARTED', out.id, { vehicleId });
  await afterLifecycle(vehicleId, out.moved, 'MAINTENANCE', adminId, 'Maintenance started');
  return oneRecord(out.id);
}

/** Finish maintenance: record the service date and the next one, and return the vehicle to service. */
export async function completeMaintenance(
  recordId: string,
  body: AdminMaintenanceCompleteBody,
  adminId: string,
): Promise<ServiceRecordInfo> {
  const out = await withTransaction(async (client) => {
    const cur = await client.query<{
      vehicle_id: string;
      status: ServiceStatus;
      kind: ServiceKind;
    }>('SELECT vehicle_id, status, kind FROM vehicle_service_records WHERE id = $1 FOR UPDATE', [
      recordId,
    ]);
    const rec = cur.rows[0];
    if (!rec) throw new HttpError(404, 'NOT_FOUND', 'Record not found.');
    if (rec.status !== 'IN_PROGRESS') {
      throw new HttpError(409, 'ALREADY_COMPLETED', 'This maintenance was already completed.');
    }
    if (body.nextDueOn && body.nextDueOn <= body.performedOn) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'The next service must be after this one.');
    }
    await client.query(
      `UPDATE vehicle_service_records SET status = 'COMPLETED', performed_on = $2, next_due_on = $3,
         notes = COALESCE($4, notes), completed_at = now() WHERE id = $1`,
      [recordId, body.performedOn, body.nextDueOn ?? null, body.notes ?? null],
    );
    // Back to service only if the vehicle is still in maintenance (an administrator may have moved it since).
    const state = await client.query<{ lifecycle_status: string }>(
      'SELECT lifecycle_status FROM vehicles WHERE id = $1 FOR UPDATE',
      [rec.vehicle_id],
    );
    const moved =
      state.rows[0]?.lifecycle_status === 'MAINTENANCE'
        ? await setLifecycle(client, rec.vehicle_id, body.returnTo)
        : null;
    return { vehicleId: rec.vehicle_id, moved };
  });
  await audit(adminId, 'MAINTENANCE_COMPLETED', recordId, {
    vehicleId: out.vehicleId,
    returnTo: out.moved ? body.returnTo : null,
  });
  if (out.moved) {
    await afterLifecycle(out.vehicleId, out.moved, body.returnTo, adminId, 'Maintenance completed');
  }
  return oneRecord(recordId);
}

/** A service done without taking the vehicle off the road: a completed record with the next date. */
export async function logService(
  vehicleId: string,
  body: AdminServiceLogBody,
  adminId: string,
): Promise<ServiceRecordInfo> {
  if (body.nextDueOn && body.nextDueOn <= body.performedOn) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'The next service must be after this one.');
  }
  const r = await query<{ id: string }>(
    `INSERT INTO vehicle_service_records (vehicle_id, kind, status, performed_on, next_due_on, notes, recorded_by, completed_at)
     SELECT id, 'MAINTENANCE', 'COMPLETED', $2, $3, $4, $5, now() FROM vehicles WHERE id = $1 RETURNING id`,
    [vehicleId, body.performedOn, body.nextDueOn ?? null, body.notes ?? null, adminId],
  );
  if (!r.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Vehicle not found.');
  await audit(adminId, 'SERVICE_LOGGED', r.rows[0].id, { vehicleId });
  return oneRecord(r.rows[0].id);
}

/**
 * An inspection. A pass is recorded with the next due date. A failure puts the vehicle in maintenance and
 * opens the repair, because a vehicle that failed cannot be offered for rides.
 */
export async function recordInspection(
  vehicleId: string,
  body: AdminInspectionBody,
  adminId: string,
): Promise<ServiceRecordInfo> {
  if (body.nextDueOn && body.nextDueOn <= body.performedOn) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'The next inspection must be after this one.');
  }
  const out = await withTransaction(async (client) => {
    const exists = await client.query('SELECT 1 FROM vehicles WHERE id = $1 FOR UPDATE', [
      vehicleId,
    ]);
    if (!exists.rowCount) throw new HttpError(404, 'NOT_FOUND', 'Vehicle not found.');
    const ins = await client.query<{ id: string }>(
      `INSERT INTO vehicle_service_records (vehicle_id, kind, status, performed_on, next_due_on, result, notes, recorded_by, completed_at)
       VALUES ($1, 'INSPECTION', 'COMPLETED', $2, $3, $4, $5, $6, now()) RETURNING id`,
      [
        vehicleId,
        body.performedOn,
        body.nextDueOn ?? null,
        body.result,
        body.notes ?? null,
        adminId,
      ],
    );
    let moved = null;
    let repairOpened = false;
    if (body.result === 'FAILED') {
      const state = await client.query<{ lifecycle_status: string }>(
        'SELECT lifecycle_status FROM vehicles WHERE id = $1',
        [vehicleId],
      );
      const now = state.rows[0]?.lifecycle_status;
      if (now === 'ACTIVE' || now === 'INACTIVE' || now === 'SUSPENDED') {
        moved = await setLifecycle(client, vehicleId, 'MAINTENANCE');
      }
      const open = await client.query(
        `INSERT INTO vehicle_service_records (vehicle_id, kind, status, notes, recorded_by)
         VALUES ($1, 'MAINTENANCE', 'IN_PROGRESS', $2, $3) ON CONFLICT DO NOTHING RETURNING id`,
        [vehicleId, 'Repair after a failed inspection.', adminId],
      );
      repairOpened = (open.rowCount ?? 0) > 0;
    }
    return { id: (ins.rows[0] as { id: string }).id, moved, repairOpened };
  });
  await audit(adminId, 'INSPECTION_RECORDED', out.id, {
    vehicleId,
    result: body.result,
    repairOpened: out.repairOpened,
  });
  if (out.moved)
    await afterLifecycle(vehicleId, out.moved, 'MAINTENANCE', adminId, 'Failed inspection');
  else if (body.result === 'FAILED') {
    const who = await query<{ driver_user_id: string | null; registration_number: string }>(
      'SELECT driver_user_id, registration_number FROM vehicles WHERE id = $1',
      [vehicleId],
    );
    const v = who.rows[0];
    if (v?.driver_user_id) {
      await notifyDriver(
        v.driver_user_id,
        FLEET_NOTIFICATION_TYPES.VEHICLE_MAINTENANCE,
        `Vehicle ${v.registration_number} failed its inspection.`,
        { vehicleId },
      );
    }
  }
  return oneRecord(out.id);
}
