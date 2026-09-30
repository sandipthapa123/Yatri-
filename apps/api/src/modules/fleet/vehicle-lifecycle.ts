import {
  FLEET_NOTIFICATION_TYPES,
  VEHICLE_LIFECYCLE_LABELS,
  VEHICLE_LIFECYCLE_TRANSITIONS,
  canVehicleTransition,
  describeVehicleLifecycle,
  type VehicleLifecycle,
} from '@yatri/types';
import type { PoolClient } from 'pg';

import { recordAudit } from '../../lib/audit';
import { HttpError } from '../../middleware/errorHandler';
import { enforceEligibility } from './enforcement';
import { notifyDriver } from './fleet-notify';

/**
 * The ONE place a vehicle changes lifecycle state: the move is checked against the table in @yatri/types
 * and applied under the vehicle's row lock (`setLifecycle`), then recorded, told to the driver in the shared
 * words, and followed by making sure an online driver who can no longer use any vehicle is taken offline
 * (`afterLifecycle`). The admin action and the maintenance workflow both use it.
 */
const invalidMove = (from: VehicleLifecycle) => {
  const next = VEHICLE_LIFECYCLE_TRANSITIONS[from].map((s) => VEHICLE_LIFECYCLE_LABELS[s]);
  return new HttpError(
    409,
    'INVALID_VEHICLE_TRANSITION',
    next.length === 0
      ? `This vehicle is ${VEHICLE_LIFECYCLE_LABELS[from].toLowerCase()} and cannot change.`
      : `A vehicle that is ${VEHICLE_LIFECYCLE_LABELS[from].toLowerCase()} can only become: ${next.join(', ')}.`,
  );
};

/**
 * Move a vehicle along its lifecycle under a row lock. Both the admin action and the maintenance workflow
 * call this, so there is one place where a vehicle changes state. Must be called with the vehicle's lock
 * held by the caller's transaction, or without a transaction (it then takes its own).
 */
export async function setLifecycle(
  client: PoolClient,
  vehicleId: string,
  to: VehicleLifecycle,
): Promise<{ from: VehicleLifecycle; registration: string; driverId: string | null }> {
  const cur = await client.query<{
    lifecycle_status: VehicleLifecycle;
    registration_number: string;
    driver_user_id: string | null;
  }>(
    'SELECT lifecycle_status, registration_number, driver_user_id FROM vehicles WHERE id = $1 FOR UPDATE',
    [vehicleId],
  );
  const v = cur.rows[0];
  if (!v) throw new HttpError(404, 'NOT_FOUND', 'Vehicle not found.');
  if (!canVehicleTransition(v.lifecycle_status, to)) throw invalidMove(v.lifecycle_status);
  await client.query(
    'UPDATE vehicles SET lifecycle_status = $2, updated_at = now() WHERE id = $1',
    [vehicleId, to],
  );
  return {
    from: v.lifecycle_status,
    registration: v.registration_number,
    driverId: v.driver_user_id,
  };
}

/** After a lifecycle change: the record, the driver told in the shared words, and "online" kept honest. */
export async function afterLifecycle(
  vehicleId: string,
  moved: { from: VehicleLifecycle; registration: string; driverId: string | null },
  to: VehicleLifecycle,
  actorId: string | null,
  reason: string | null,
) {
  await recordAudit({
    actorId,
    actorRole: actorId ? 'ADMIN' : 'SYSTEM',
    action: 'VEHICLE_LIFECYCLE_CHANGED',
    subjectType: 'vehicle',
    subjectIds: [vehicleId],
    detail: { from: moved.from, to, ...(reason ? { reason } : {}) },
  });
  if (moved.driverId) {
    await notifyDriver(
      moved.driverId,
      to === 'MAINTENANCE'
        ? FLEET_NOTIFICATION_TYPES.VEHICLE_MAINTENANCE
        : FLEET_NOTIFICATION_TYPES.VEHICLE_STATUS,
      describeVehicleLifecycle(moved.registration, to),
      { vehicleId },
    );
    await enforceEligibility(moved.driverId);
  }
}
