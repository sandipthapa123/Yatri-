import { query } from '../../lib/db';
import type { UserRole } from '../users/users.types';

export type OtpPurpose = 'LOGIN';

export interface OtpRequestRow {
  id: string;
  phone_number: string;
  role: UserRole;
  purpose: OtpPurpose;
  otp_hash: string;
  attempts: number;
  max_attempts: number;
  expires_at: Date;
  consumed_at: Date | null;
  invalidated_at: Date | null;
  created_at: Date;
}

/** Supersede any still-usable OTP for this phone/role/purpose before issuing a new one. */
export async function invalidateActiveOtps(
  phoneNumber: string,
  role: UserRole,
  purpose: OtpPurpose,
): Promise<void> {
  await query(
    `UPDATE otp_requests
     SET invalidated_at = now()
     WHERE phone_number = $1 AND role = $2 AND purpose = $3
       AND consumed_at IS NULL AND invalidated_at IS NULL`,
    [phoneNumber, role, purpose],
  );
}

export async function createOtpRequest(input: {
  phoneNumber: string;
  role: UserRole;
  purpose: OtpPurpose;
  otpHash: string;
  expiresAt: Date;
  maxAttempts: number;
  requesterIp: string | null;
  userAgent: string | null;
}): Promise<OtpRequestRow> {
  const result = await query<OtpRequestRow>(
    `INSERT INTO otp_requests
       (phone_number, role, purpose, otp_hash, expires_at, max_attempts, requester_ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, phone_number, role, purpose, otp_hash, attempts, max_attempts,
               expires_at, consumed_at, invalidated_at, created_at`,
    [
      input.phoneNumber,
      input.role,
      input.purpose,
      input.otpHash,
      input.expiresAt,
      input.maxAttempts,
      input.requesterIp,
      input.userAgent,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to create OTP request');
  return row;
}

/** The one OTP that could currently be verified for this phone/role/purpose, if any. */
export async function findActiveOtpRequest(
  phoneNumber: string,
  role: UserRole,
  purpose: OtpPurpose,
): Promise<OtpRequestRow | null> {
  const result = await query<OtpRequestRow>(
    `SELECT id, phone_number, role, purpose, otp_hash, attempts, max_attempts,
            expires_at, consumed_at, invalidated_at, created_at
     FROM otp_requests
     WHERE phone_number = $1 AND role = $2 AND purpose = $3
       AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC
     LIMIT 1`,
    [phoneNumber, role, purpose],
  );
  return result.rows[0] ?? null;
}

/** Returns the row's new attempt count. */
export async function incrementOtpAttempts(id: string): Promise<number> {
  const result = await query<{ attempts: number }>(
    `UPDATE otp_requests SET attempts = LEAST(attempts + 1, max_attempts) WHERE id = $1
     RETURNING attempts`,
    [id],
  );
  return result.rows[0]?.attempts ?? 0;
}

export async function markOtpConsumed(id: string): Promise<void> {
  await query(`UPDATE otp_requests SET consumed_at = now() WHERE id = $1`, [id]);
}
