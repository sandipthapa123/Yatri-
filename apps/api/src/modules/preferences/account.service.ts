import { isoOrNull } from '../../lib/dates';
import type { DeviceSession, RecentPlace, RecentPlacesResponse } from '@yatri/types';

import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { recordAuthEvent } from '../auth/auth-event.repository';
import { settingNumber } from '../settings/settings.service';
import { recentPlacesSettings } from './preferences.service';

/**
 * The parts of "my account" a person manages themselves: the devices they are signed in on, and their recent
 * destinations. Saved places and emergency contacts keep their own modules; this adds nothing to them.
 */

// ---------------------------------------------------------------- devices (sessions)

interface SessionRow {
  id: string;
  device_label: string | null;
  last_used_at: Date | null;
  created_at: Date;
}

/** Devices still signed in, most recently used first. The label is what the device called itself when it signed in; no network address is shown. */
export async function listDevices(
  userId: string,
  currentSessionId: string,
): Promise<DeviceSession[]> {
  const r = await query<SessionRow>(
    `SELECT id, device_label, last_used_at, created_at FROM auth_sessions
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
     ORDER BY COALESCE(last_used_at, created_at) DESC`,
    [userId],
  );
  return r.rows.map((s) => ({
    id: s.id,
    deviceLabel: s.device_label,
    lastUsedAt: isoOrNull(s.last_used_at),
    signedInAt: s.created_at.toISOString(),
    current: s.id === currentSessionId,
  }));
}

/** Sign one device out. Only the person's own sessions can be found; anything else is a plain 404. */
export async function signOutDevice(
  userId: string,
  sessionId: string,
  actorSessionId: string,
): Promise<void> {
  const r = await query(
    `UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [sessionId, userId],
  );
  if (!r.rowCount) throw new HttpError(404, 'NOT_FOUND', 'That device is not signed in.');
  await query('DELETE FROM push_tokens WHERE session_id = $1', [sessionId]);
  await recordAuthEvent({
    eventType: 'SESSION_REVOKED',
    userId,
    metadata: { sessionId, by: 'USER', self: sessionId === actorSessionId },
  });
}

/** Sign out every other device in one step (the one in your hand stays signed in). Returns how many. */
export async function signOutOtherDevices(
  userId: string,
  currentSessionId: string,
): Promise<number> {
  const r = await query(
    `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
    [userId, currentSessionId],
  );
  // Their phones stop getting notifications too (a token with no session is from before tokens were tied to one).
  await query('DELETE FROM push_tokens WHERE user_id = $1 AND session_id IS DISTINCT FROM $2', [
    userId,
    currentSessionId,
  ]);
  await recordAuthEvent({
    eventType: 'SESSION_REVOKED',
    userId,
    metadata: { by: 'USER', others: r.rowCount ?? 0 },
  });
  return r.rowCount ?? 0;
}

// ---------------------------------------------------------------- recent destinations

/**
 * Places the person recently went to, newest first, derived from their rides (nothing is stored twice).
 * Rides someone else booked for them are left out: the destination is not theirs to be reminded of. The person
 * can hide the list (a preference) or clear it (everything before now stops being offered).
 */
export async function recentPlaces(userId: string): Promise<RecentPlacesResponse> {
  const s = await recentPlacesSettings(userId);
  if (!s.show) return { items: [], hidden: true };
  const r = await query<{
    place_name: string | null;
    address: string;
    latitude: string;
    longitude: string;
    last_used: Date;
    rides: number;
  }>(
    `SELECT DISTINCT ON (round(l.latitude::numeric, 4), round(l.longitude::numeric, 4))
            l.place_name, l.address, l.latitude, l.longitude, t.requested_at AS last_used,
            count(*) OVER (PARTITION BY round(l.latitude::numeric, 4), round(l.longitude::numeric, 4))::int AS rides
     FROM trips t JOIN locations l ON l.id = t.destination_location_id
     WHERE t.passenger_id = $1 AND t.status NOT IN ('NO_DRIVERS')
       AND (t.booked_by IS NULL OR t.booked_by = t.passenger_id)
       AND ($2::timestamptz IS NULL OR t.requested_at > $2)
     ORDER BY round(l.latitude::numeric, 4), round(l.longitude::numeric, 4), t.requested_at DESC`,
    [userId, s.clearedAt],
  );
  const items: RecentPlace[] = r.rows
    .map((p) => ({
      name: p.place_name,
      address: p.address,
      latitude: Number(p.latitude),
      longitude: Number(p.longitude),
      lastUsedAt: p.last_used.toISOString(),
      rides: p.rides,
    }))
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
    .slice(0, settingNumber('RECENT_PLACES_LIMIT'));
  return { items, hidden: false };
}

/** Stop offering what was recent up to now. Rides and their history are untouched. */
export async function clearRecentPlaces(userId: string): Promise<void> {
  await query(
    `INSERT INTO user_preferences (user_id, recent_places_cleared_at) VALUES ($1, now())
     ON CONFLICT (user_id) DO UPDATE SET recent_places_cleared_at = now()`,
    [userId],
  );
}
