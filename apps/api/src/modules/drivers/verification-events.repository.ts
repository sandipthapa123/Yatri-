import { query } from '../../lib/db';
import type { DriverStatus } from './drivers.types';

export type VerificationAction =
  | 'SUBMITTED'
  | 'DOCUMENT_APPROVED'
  | 'DOCUMENT_REJECTED'
  | 'VEHICLE_APPROVED'
  | 'VEHICLE_REJECTED'
  | 'DRIVER_APPROVED'
  | 'DRIVER_REJECTED'
  | 'DRIVER_SUSPENDED';

export interface VerificationEventRow {
  id: string;
  driver_user_id: string;
  actor_user_id: string | null;
  action: VerificationAction;
  previous_status: DriverStatus | null;
  new_status: DriverStatus | null;
  document_id: string | null;
  vehicle_id: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface RecordVerificationEventInput {
  driverUserId: string;
  actorUserId?: string | null;
  action: VerificationAction;
  previousStatus?: DriverStatus | null;
  newStatus?: DriverStatus | null;
  documentId?: string | null;
  vehicleId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordVerificationEvent(input: RecordVerificationEventInput): Promise<void> {
  await query(
    `INSERT INTO driver_verification_events
       (driver_user_id, actor_user_id, action, previous_status, new_status, document_id, vehicle_id, reason, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.driverUserId,
      input.actorUserId ?? null,
      input.action,
      input.previousStatus ?? null,
      input.newStatus ?? null,
      input.documentId ?? null,
      input.vehicleId ?? null,
      input.reason ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

export async function listVerificationEvents(
  driverUserId: string,
): Promise<VerificationEventRow[]> {
  const result = await query<VerificationEventRow>(
    `SELECT * FROM driver_verification_events WHERE driver_user_id = $1 ORDER BY created_at DESC`,
    [driverUserId],
  );
  return result.rows;
}
