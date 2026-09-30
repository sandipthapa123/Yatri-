import {
  ASSIGNED_TRIP_STATUSES,
  describeIncomingCall,
  type CallEndReason,
  type CallInfo,
  type CallKind,
  type CallSignal,
  type CallState,
  type IceServersResponse,
  type TripRole,
} from '@yatri/types';

import { env } from '../../config/env';
import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { notify } from '../../lib/notifications';
import { publishToUser } from '../realtime/bus';
import { requireParticipant } from '../trips/access';
import { activeCallProvider } from './call-provider';
import { recordTripEvent } from '../trips/trip-events.service';
import { getTrip, type TripRow } from '../trips/trips.repository';

/**
 * Calls. The server owns the call STATE MACHINE and authorisation; the media itself is
 * peer-to-peer WebRTC (via STUN/TURN) and never touches this server. Neither party ever
 * sees the other's phone number — a call is addressed by trip role only. Signalling
 * (offer/answer/ICE) is relayed opaquely over the one realtime socket.
 *
 *   RINGING ─► CONNECTING ─► CONNECTED ─► ENDED(reason)
 *      └──────────────────────────────────► ENDED (declined / missed / cancelled)
 */
const TRANSITIONS: Record<CallState, readonly CallState[]> = {
  RINGING: ['CONNECTING', 'ENDED'],
  CONNECTING: ['CONNECTED', 'ENDED'],
  CONNECTED: ['ENDED'],
  ENDED: [],
};
export const canCallTransition = (from: CallState, to: CallState) => TRANSITIONS[from].includes(to);
const statesLeadingTo = (to: CallState): CallState[] =>
  (Object.keys(TRANSITIONS) as CallState[]).filter((f) => canCallTransition(f, to));

interface Row {
  id: string;
  trip_id: string;
  caller_id: string;
  callee_id: string;
  kind: CallKind;
  state: CallState;
  end_reason: CallEndReason | null;
  created_at: Date;
  answered_at: Date | null;
  connected_at: Date | null;
  ended_at: Date | null;
}
const COLS =
  'id, trip_id, caller_id, callee_id, kind, state, end_reason, created_at, answered_at, connected_at, ended_at';

function toInfo(r: Row, trip: TripRow): CallInfo {
  const callerRole: TripRole = r.caller_id === trip.passenger_id ? 'PASSENGER' : 'DRIVER';
  return {
    id: r.id,
    tripId: r.trip_id,
    kind: r.kind,
    state: r.state,
    callerRole,
    createdAt: r.created_at.toISOString(),
    answeredAt: r.answered_at?.toISOString() ?? null,
    connectedAt: r.connected_at?.toISOString() ?? null,
    endedAt: r.ended_at?.toISOString() ?? null,
    endReason: r.end_reason,
  };
}

async function loadCall(callId: string, userId: string): Promise<{ row: Row; trip: TripRow }> {
  const r = await query<Row>(`SELECT ${COLS} FROM trip_calls WHERE id = $1`, [callId]);
  const row = r.rows[0];
  const trip = row ? await getTrip(row.trip_id) : null;
  // Only the two people on the call can even learn it exists.
  if (!row || !trip || (row.caller_id !== userId && row.callee_id !== userId)) {
    throw new HttpError(404, 'NOT_FOUND', 'Call not found.');
  }
  return { row, trip };
}

async function publishState(row: Row, trip: TripRow) {
  const call = toInfo(row, trip);
  await Promise.all(
    [row.caller_id, row.callee_id].map((u) => publishToUser(u, { type: 'call_state', call })),
  );
  return call;
}

async function cas(
  callId: string,
  to: CallState,
  extra: { reason?: CallEndReason },
): Promise<Row | null> {
  const r = await query<Row>(
    `UPDATE trip_calls SET state = $2,
       answered_at = CASE WHEN $2 = 'CONNECTING' THEN now() ELSE answered_at END,
       connected_at = CASE WHEN $2 = 'CONNECTED' THEN now() ELSE connected_at END,
       ended_at = CASE WHEN $2 = 'ENDED' THEN now() ELSE ended_at END,
       end_reason = CASE WHEN $2 = 'ENDED' THEN $3 ELSE end_reason END
     WHERE id = $1 AND state = ANY($4::text[]) RETURNING ${COLS}`,
    [callId, to, extra.reason ?? null, statesLeadingTo(to)],
  );
  return r.rows[0] ?? null;
}

export async function startCall(
  tripId: string,
  callerId: string,
  kind: CallKind,
): Promise<CallInfo> {
  const { trip } = await requireParticipant(tripId, callerId);
  if (!ASSIGNED_TRIP_STATUSES.includes(trip.status) || !trip.driver_id) {
    throw new HttpError(
      409,
      'CALL_NOT_AVAILABLE',
      'You can call once a driver is assigned, until the ride ends.',
    );
  }
  const calleeId = trip.passenger_id === callerId ? trip.driver_id : trip.passenger_id;
  try {
    const r = await query<Row>(
      `INSERT INTO trip_calls (trip_id, caller_id, callee_id, kind) VALUES ($1, $2, $3, $4) RETURNING ${COLS}`,
      [tripId, callerId, calleeId, kind],
    );
    const call = await publishState(r.rows[0] as Row, trip);
    // A durable notification for the person being called (the socket reaches only an open app).
    const calleeRole = calleeId === trip.passenger_id ? 'PASSENGER' : 'DRIVER';
    await notify({
      userId: calleeId,
      type: 'CALL_INCOMING',
      title: 'Yatri',
      body: describeIncomingCall(calleeRole, kind),
      metadata: { tripId, callId: call.id },
    }).catch(() => undefined);
    return call;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new HttpError(409, 'CALL_IN_PROGRESS', 'There is already a call on this ride.');
    }
    throw err;
  }
}

export async function answerCall(callId: string, userId: string): Promise<CallInfo> {
  const { row, trip } = await loadCall(callId, userId);
  if (row.callee_id !== userId)
    throw new HttpError(403, 'FORBIDDEN', 'Only the person being called can answer.');
  const next = await cas(callId, 'CONNECTING', {});
  if (!next) throw new HttpError(409, 'CALL_NOT_RINGING', 'This call is no longer ringing.');
  return publishState(next, trip);
}

export async function declineCall(callId: string, userId: string): Promise<CallInfo> {
  const { row, trip } = await loadCall(callId, userId);
  if (row.callee_id !== userId)
    throw new HttpError(403, 'FORBIDDEN', 'Only the person being called can decline.');
  const next = await cas(callId, 'ENDED', { reason: 'DECLINED' });
  if (!next) throw new HttpError(409, 'CALL_NOT_RINGING', 'This call is no longer ringing.');
  return publishState(next, trip);
}

/** Hang up. Idempotent: ending an already-ended call just returns it. */
export async function endCall(callId: string, userId: string): Promise<CallInfo> {
  const { row, trip } = await loadCall(callId, userId);
  if (row.state === 'ENDED') return toInfo(row, trip);
  // Before it was answered, the caller hanging up is a cancelled (missed) call; afterwards, a normal end.
  const reason: CallEndReason =
    row.state === 'RINGING' ? (row.caller_id === userId ? 'CANCELLED' : 'DECLINED') : 'COMPLETED';
  const next = await cas(callId, 'ENDED', { reason });
  if (!next) return toInfo((await loadCall(callId, userId)).row, trip); // lost a race: already ended
  if (row.state === 'RINGING' && reason === 'CANCELLED') {
    await recordTripEvent({ tripId: trip.id, type: 'CALL_MISSED', actorId: row.caller_id });
  }
  return publishState(next, trip);
}

export async function callConnected(callId: string, userId: string): Promise<CallInfo> {
  const { row, trip } = await loadCall(callId, userId);
  if (row.state === 'CONNECTED') return toInfo(row, trip);
  const next = await cas(callId, 'CONNECTED', {});
  if (!next) throw new HttpError(409, 'CALL_NOT_CONNECTING', 'This call is not connecting.');
  return publishState(next, trip);
}

/** Relay a WebRTC signalling payload to the other party. The server never inspects the SDP. */
export async function relaySignal(
  callId: string,
  fromUserId: string,
  signal: CallSignal,
): Promise<void> {
  const { row } = await loadCall(callId, fromUserId);
  if (row.state === 'ENDED') throw new HttpError(409, 'CALL_ENDED', 'This call has ended.');
  // The caller may send its offer while still ringing; everything else needs the call answered.
  if (row.state === 'RINGING' && row.caller_id !== fromUserId) {
    throw new HttpError(409, 'CALL_NOT_ANSWERED', 'Answer the call first.');
  }
  const to = row.caller_id === fromUserId ? row.callee_id : row.caller_id;
  await publishToUser(to, { type: 'call_signal', callId, signal });
}

export async function activeCallFor(tripId: string, userId: string): Promise<CallInfo | null> {
  const { trip } = await requireParticipant(tripId, userId);
  const r = await query<Row>(
    `SELECT ${COLS} FROM trip_calls WHERE trip_id = $1 AND state <> 'ENDED'`,
    [tripId],
  );
  return r.rows[0] ? toInfo(r.rows[0], trip) : null;
}

/** When the trip stops being callable (ends, or the driver drops out), any live call ends with it. */
export async function endLiveCallForTrip(tripId: string): Promise<void> {
  const trip = await getTrip(tripId);
  if (!trip) return;
  const r = await query<Row>(
    `UPDATE trip_calls SET state = 'ENDED', ended_at = now(), end_reason = 'TRIP_ENDED'
     WHERE trip_id = $1 AND state <> 'ENDED' RETURNING ${COLS}`,
    [tripId],
  );
  for (const row of r.rows) await publishState(row, trip);
}

/** Rings that nobody answered become missed calls. */
export async function sweepCalls(): Promise<number> {
  const r = await query<Row>(
    `UPDATE trip_calls SET state = 'ENDED', ended_at = now(), end_reason = 'MISSED'
     WHERE state = 'RINGING' AND created_at < now() - ($1::int * interval '1 second')
     RETURNING ${COLS}`,
    [env.CALL_RING_TIMEOUT_SECONDS],
  );
  for (const row of r.rows) {
    const trip = await getTrip(row.trip_id);
    if (!trip) continue;
    await recordTripEvent({ tripId: trip.id, type: 'CALL_MISSED', actorId: row.caller_id });
    await publishState(row, trip);
  }
  return r.rows.length;
}

/** STUN plus, when configured, short-lived TURN credentials (coturn shared-secret scheme). */
/** Call metadata for a trip (admin view). Never media, never phone numbers. */
export async function listCallsForTrip(tripId: string): Promise<CallInfo[]> {
  const trip = await getTrip(tripId);
  if (!trip) return [];
  const r = await query<Row>(
    `SELECT ${COLS} FROM trip_calls WHERE trip_id = $1 ORDER BY created_at ASC`,
    [tripId],
  );
  return r.rows.map((row) => toInfo(row, trip));
}

export async function iceServersFor(tripId: string, userId: string): Promise<IceServersResponse> {
  const { trip } = await requireParticipant(tripId, userId);
  if (!ASSIGNED_TRIP_STATUSES.includes(trip.status)) {
    throw new HttpError(
      409,
      'CALL_NOT_AVAILABLE',
      'Calls are only available during an active ride.',
    );
  }
  return activeCallProvider().connectionInfo(userId);
}
