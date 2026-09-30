import {
  describeTripEvent,
  TRIP_EVENT_META,
  type TripEventPayload,
  type TripEventRecord,
  type TripEventType,
} from '@yatri/types';

import { pool } from '../../config/database';
import { getRedisClient } from '../../config/redis';
import { query } from '../../lib/db';
import { notify } from '../../lib/notifications';
import { publishToUser } from '../realtime/bus';

/**
 * THE way anything happens to a trip: one persisted, per-trip numbered event. It is created
 * exactly once, here, and every consumer — system chat messages, screen-reader announcements,
 * notifications, the admin timeline — is rendered from it (`describeTripEvent`). No app or
 * module words or triggers a trip event itself.
 *
 * `seq` is gap-free: it is taken under the trip row lock and rolled back if the event turns out
 * to be a duplicate (`dedupeKey`), so a client that sees seq 7 and 9 knows 8 is missing.
 */
const lastSeqKey = (tripId: string) => `trk:${tripId}:lastseq`;

export interface RecordEventInput {
  tripId: string;
  type: TripEventType;
  actorId?: string | null;
  payload?: TripEventPayload;
  /** Raise at most once per (trip, key) — waiting milestones, nearby thresholds. */
  dedupeKey?: string;
}

interface EventRow {
  seq: number;
  type: TripEventType;
  payload: TripEventPayload;
  created_at: Date;
}

const toRecord = (tripId: string, r: EventRow): TripEventRecord => ({
  tripId,
  seq: r.seq,
  type: r.type,
  payload: r.payload,
  createdAt: r.created_at.toISOString(),
});

export async function recordTripEvent(input: RecordEventInput): Promise<TripEventRecord | null> {
  const client = await pool.connect();
  let record: TripEventRecord | null = null;
  let passengerId = '';
  let driverId: string | null = null;
  try {
    await client.query('BEGIN');
    // The UPDATE takes the trip row lock: concurrent events for one trip serialize here.
    const t = await client.query<{
      event_seq: number;
      passenger_id: string;
      driver_id: string | null;
    }>(
      'UPDATE trips SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq, passenger_id, driver_id',
      [input.tripId],
    );
    const trip = t.rows[0];
    if (!trip) {
      await client.query('ROLLBACK');
      return null;
    }
    passengerId = trip.passenger_id;
    driverId = trip.driver_id;
    if (input.dedupeKey) {
      const dup = await client.query(
        'SELECT 1 FROM trip_events WHERE trip_id = $1 AND dedupe_key = $2',
        [input.tripId, input.dedupeKey],
      );
      if (dup.rowCount) {
        await client.query('ROLLBACK'); // the seq is not consumed
        return null;
      }
    }
    const ins = await client.query<EventRow>(
      // created_at is taken now, under the row lock that handed out the sequence number (the column
      // default is the transaction's start time, which can be earlier than a neighbour's with a lower seq).
      `INSERT INTO trip_events (trip_id, seq, type, actor_id, payload, dedupe_key, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, clock_timestamp())
       RETURNING seq, type, payload, created_at`,
      [
        input.tripId,
        trip.event_seq,
        input.type,
        input.actorId ?? null,
        JSON.stringify(input.payload ?? {}),
        input.dedupeKey ?? null,
      ],
    );
    await client.query('COMMIT');
    record = toRecord(input.tripId, ins.rows[0] as EventRow);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  await getRedisClient().set(lastSeqKey(input.tripId), String(record.seq), 'EX', 6 * 60 * 60);

  const meta = TRIP_EVENT_META[record.type];
  {
    const recipients = [passengerId, driverId].filter((x): x is string => !!x);
    await Promise.all(
      recipients.map((userId) =>
        publishToUser(userId, { type: 'trip_event', event: record, important: meta.important }),
      ),
    );
    if (meta.notify) {
      // A durable, provider-delivered notification for the moments people must not miss.
      await Promise.all(
        recipients.map((userId) =>
          notify({
            userId,
            type: `TRIP_${record.type}`,
            title: 'Yatri',
            body: describeTripEvent(record, userId === passengerId ? 'PASSENGER' : 'DRIVER'),
            metadata: { tripId: input.tripId, seq: record.seq },
          }).catch(() => undefined),
        ),
      );
    }
  }
  return record;
}

export async function getLastEventSeq(tripId: string): Promise<number> {
  const cached = await getRedisClient().get(lastSeqKey(tripId));
  if (cached !== null) return Number(cached);
  const r = await query<{ event_seq: number }>('SELECT event_seq FROM trips WHERE id = $1', [
    tripId,
  ]);
  return r.rows[0]?.event_seq ?? 0;
}

/** Events after `afterSeq` (a reconnecting client fills any gap with this). */
export async function listTripEvents(
  tripId: string,
  opts: { afterSeq?: number; limit?: number } = {},
): Promise<TripEventRecord[]> {
  const r = await query<EventRow>(
    `SELECT seq, type, payload, created_at FROM trip_events
     WHERE trip_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
    [tripId, opts.afterSeq ?? 0, Math.min(opts.limit ?? 200, 500)],
  );
  return r.rows.map((row) => toRecord(tripId, row));
}
