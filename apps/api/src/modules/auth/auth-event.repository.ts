import { query } from '../../lib/db';
import { log } from '../../lib/logger';

export type AuthEventType =
  | 'OTP_REQUESTED'
  | 'OTP_REQUEST_BLOCKED'
  | 'OTP_VERIFIED'
  | 'OTP_VERIFY_FAILED'
  | 'OTP_LOCKED'
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILED'
  | 'LOGOUT'
  | 'TOKEN_REFRESHED'
  | 'TOKEN_REFRESH_FAILED'
  | 'SESSION_REVOKED'
  | 'ACCESS_BLOCKED_SUSPENDED'
  | 'ACCESS_BLOCKED_DEACTIVATED';

export interface RecordAuthEventInput {
  eventType: AuthEventType;
  userId?: string | null;
  phoneNumber?: string | null;
  email?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Fire-and-forget audit logging: a failure here must never fail the request
 * it's describing, so callers don't await-and-throw on it — errors are
 * caught and logged instead.
 */
export async function recordAuthEvent(input: RecordAuthEventInput): Promise<void> {
  try {
    await query(
      `INSERT INTO auth_events (user_id, event_type, phone_number, email, ip_address, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.userId ?? null,
        input.eventType,
        input.phoneNumber ?? null,
        input.email ?? null,
        input.ipAddress ?? null,
        input.userAgent ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  } catch (err) {
    log.error('Failed to record auth event', input.eventType, err);
  }
}
