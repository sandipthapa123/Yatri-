import {
  ASSIGNED_TRIP_STATUSES,
  CHAT_MAX_LENGTH,
  TRIP_EVENT_META,
  type ChatHistory,
  type ChatMessage,
  type ChatTimelineItem,
  describeNewMessage,
} from '@yatri/types';

import { env } from '../../config/env';
import { pool } from '../../config/database';
import { query } from '../../lib/db';
import { checkWindowLimit } from '../../lib/rate-limit';
import { HttpError } from '../../middleware/errorHandler';
import { notifyThrottled } from '../../lib/notifications';
import { participantRole, requireParticipant } from '../trips/access';
import { publishToUser } from '../realtime/bus';
import { listTripEvents } from '../trips/trip-events.service';
import { getTrip, type TripRow } from '../trips/trips.repository';

/**
 * Trip chat. It belongs to the trip: only its passenger and driver, only once a driver is
 * assigned, writable while the trip is live and for CHAT_OPEN_AFTER_TRIP_MINUTES after it ends,
 * read-only afterwards. Ordering is the per-trip `seq`. System messages ("Driver has arrived")
 * are NOT stored here — they are the trip's own events, merged into the timeline on read, so
 * they can never disagree with what actually happened.
 */

interface Row {
  id: string;
  trip_id: string;
  seq: number;
  sender_id: string;
  body: string;
  client_message_id: string;
  created_at: Date;
  delivered_at: Date | null;
  read_at: Date | null;
}
const COLS =
  'id, trip_id, seq, sender_id, body, client_message_id, created_at, delivered_at, read_at';

function toMessage(trip: TripRow, r: Row): ChatMessage {
  return {
    id: r.id,
    tripId: r.trip_id,
    seq: r.seq,
    senderRole: r.sender_id === trip.passenger_id ? 'PASSENGER' : 'DRIVER',
    body: r.body,
    clientMessageId: r.client_message_id,
    createdAt: r.created_at.toISOString(),
    deliveredAt: r.delivered_at?.toISOString() ?? null,
    readAt: r.read_at?.toISOString() ?? null,
  };
}

/** Can messages be written right now, and if not, why (in words a person can read)? */
/** Control characters (except tab/newline) are never a message. Checked by code point, not regex. */
function hasControlCharacters(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) return true;
  }
  return false;
}

export function chatWindow(
  trip: TripRow,
  nowMs = Date.now(),
): { canSend: boolean; closedReason: string | null } {
  if (!trip.driver_id && !trip.ended_at && trip.status === 'SEARCHING') {
    return { canSend: false, closedReason: 'Chat opens when a driver accepts your ride.' };
  }
  if (ASSIGNED_TRIP_STATUSES.includes(trip.status)) return { canSend: true, closedReason: null };
  if (!trip.driver_id || !trip.matched_at) {
    return {
      canSend: false,
      closedReason: 'There was no driver on this ride, so there is no chat.',
    };
  }
  const endedAt = trip.ended_at?.getTime() ?? 0;
  const open = env.CHAT_OPEN_AFTER_TRIP_MINUTES * 60_000;
  if (endedAt && nowMs - endedAt <= open) return { canSend: true, closedReason: null };
  return {
    canSend: false,
    closedReason: 'This ride has ended, so the chat is now read-only.',
  };
}

const chatTrip = requireParticipant;

export async function sendMessage(
  tripId: string,
  senderId: string,
  clientMessageId: string,
  rawBody: string,
): Promise<ChatMessage> {
  const { trip } = await chatTrip(tripId, senderId);
  const win = chatWindow(trip);
  if (!win.canSend) throw new HttpError(409, 'CHAT_CLOSED', win.closedReason ?? 'Chat is closed.');

  const body = rawBody.trim();
  if (body.length < 1 || body.length > CHAT_MAX_LENGTH || hasControlCharacters(body)) {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      `Messages must be 1 to ${CHAT_MAX_LENGTH} characters.`,
    );
  }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientMessageId)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid message id.');
  }
  const limit = await checkWindowLimit(`chat:${senderId}`, env.CHAT_RATE_LIMIT_PER_MINUTE, 60);
  if (limit.limited) {
    throw new HttpError(
      429,
      'RATE_LIMITED',
      'You are sending messages too quickly. Please wait a moment.',
    );
  }

  // A retry of the same message returns the original: no duplicate, no new seq.
  const existing = await query<Row>(
    `SELECT ${COLS} FROM trip_messages WHERE trip_id = $1 AND sender_id = $2 AND client_message_id = $3`,
    [tripId, senderId, clientMessageId],
  );
  if (existing.rows[0]) return toMessage(trip, existing.rows[0]);

  const client = await pool.connect();
  let row: Row;
  try {
    await client.query('BEGIN');
    const s = await client.query<{ chat_seq: number }>(
      'UPDATE trips SET chat_seq = chat_seq + 1 WHERE id = $1 RETURNING chat_seq',
      [tripId],
    );
    const ins = await client.query<Row>(
      // created_at is taken NOW, under the row lock that also handed out the sequence number, so time
      // and sequence can never disagree (the column default is the transaction's START time, and two
      // simultaneous sends start their transactions in an order unrelated to who got the lock first).
      `INSERT INTO trip_messages (trip_id, seq, sender_id, body, client_message_id, created_at)
       VALUES ($1, $2, $3, $4, $5, clock_timestamp()) RETURNING ${COLS}`,
      [tripId, s.rows[0]?.chat_seq, senderId, body, clientMessageId],
    );
    await client.query('COMMIT');
    row = ins.rows[0] as Row;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((err as { code?: string }).code === '23505') {
      // Two identical retries raced: return whichever won.
      const again = await query<Row>(
        `SELECT ${COLS} FROM trip_messages WHERE trip_id = $1 AND sender_id = $2 AND client_message_id = $3`,
        [tripId, senderId, clientMessageId],
      );
      if (again.rows[0]) return toMessage(trip, again.rows[0]);
    }
    throw err;
  } finally {
    client.release();
  }

  const message = toMessage(trip, row);
  // Both participants (the sender's other devices too) receive it over the one realtime path.
  const recipients = [trip.passenger_id, trip.driver_id].filter((x): x is string => !!x);
  await Promise.all(recipients.map((u) => publishToUser(u, { type: 'chat_message', message })));
  // A nudge for the OTHER person, for when the app is closed: worded from the shared text (never the
  // message itself), and at most one a minute per conversation so a burst is one notification.
  const recipientId = senderId === trip.passenger_id ? trip.driver_id : trip.passenger_id;
  if (recipientId) {
    await notifyThrottled(`chat:${trip.id}:${recipientId}`, 60, {
      userId: recipientId,
      type: 'CHAT_MESSAGE',
      title: 'Yatri',
      body: describeNewMessage(recipientId === trip.passenger_id ? 'PASSENGER' : 'DRIVER'),
      metadata: { tripId: trip.id },
    }).catch(() => undefined);
  }
  return message;
}

/** Called when a message reaches the recipient's connection. Idempotent; only the first call notifies. */
export async function markDelivered(tripId: string, recipientId: string, upToSeq: number) {
  const trip = await getTrip(tripId);
  if (!trip || !participantRole(trip, recipientId)) return;
  const r = await query<{ max: number | null }>(
    `WITH u AS (
       UPDATE trip_messages SET delivered_at = now()
       WHERE trip_id = $1 AND sender_id <> $2 AND seq <= $3 AND delivered_at IS NULL
       RETURNING seq)
     SELECT max(seq) AS max FROM u`,
    [tripId, recipientId, upToSeq],
  );
  const max = r.rows[0]?.max;
  if (max === null || max === undefined) return;
  const senderId = trip.passenger_id === recipientId ? trip.driver_id : trip.passenger_id;
  if (senderId) {
    await publishToUser(senderId, {
      type: 'chat_receipt',
      tripId,
      kind: 'delivered',
      upToSeq: max,
      at: new Date().toISOString(),
    });
  }
}

export async function markRead(tripId: string, readerId: string, upToSeq: number) {
  const { trip } = await chatTrip(tripId, readerId);
  const r = await query<{ max: number | null }>(
    `WITH u AS (
       UPDATE trip_messages SET read_at = now(), delivered_at = COALESCE(delivered_at, now())
       WHERE trip_id = $1 AND sender_id <> $2 AND seq <= $3 AND read_at IS NULL
       RETURNING seq)
     SELECT max(seq) AS max FROM u`,
    [tripId, readerId, upToSeq],
  );
  const max = r.rows[0]?.max;
  if (max === null || max === undefined) return { upToSeq: 0 };
  const senderId = trip.passenger_id === readerId ? trip.driver_id : trip.passenger_id;
  if (senderId) {
    await publishToUser(senderId, {
      type: 'chat_receipt',
      tripId,
      kind: 'read',
      upToSeq: max,
      at: new Date().toISOString(),
    });
  }
  return { upToSeq: max };
}

/**
 * Retention: delete the chat text of rides that ended more than CHAT_RETENTION_DAYS ago, unless a
 * dispute on the ride is still open (the conversation is evidence). Trip events, calls metadata,
 * payments and ratings are not chat and are kept. Returns how many messages were deleted.
 */
export async function purgeExpiredChats(): Promise<number> {
  if (env.CHAT_RETENTION_DAYS <= 0) return 0;
  const r = await query(
    `DELETE FROM trip_messages m USING trips t
     WHERE m.trip_id = t.id
       AND t.ended_at IS NOT NULL
       AND t.ended_at < now() - ($1::int * interval '1 day')
       AND NOT EXISTS (SELECT 1 FROM trip_disputes d WHERE d.trip_id = t.id AND d.status = 'OPEN')`,
    [env.CHAT_RETENTION_DAYS],
  );
  return r.rowCount ?? 0;
}

/** The whole conversation for an admin holding TRIP_CHAT_VIEW (the caller audits the read). */
export async function getChatForAdmin(tripId: string): Promise<ChatHistory> {
  const trip = await getTrip(tripId);
  if (!trip) throw new HttpError(404, 'NOT_FOUND', 'Trip not found.');
  return buildHistory(trip, null);
}

export async function getHistory(tripId: string, userId: string): Promise<ChatHistory> {
  const { trip } = await chatTrip(tripId, userId);
  return buildHistory(trip, userId);
}

/** A timeline item's place in its own sequence: the tie-break when two items carry the same instant. */
const seqOf = (i: ChatTimelineItem) => (i.kind === 'message' ? i.message.seq : i.event.seq);

async function buildHistory(trip: TripRow, userId: string | null): Promise<ChatHistory> {
  const tripId = trip.id;
  const [msgs, events, unread] = await Promise.all([
    query<Row>(`SELECT ${COLS} FROM trip_messages WHERE trip_id = $1 ORDER BY seq ASC LIMIT 500`, [
      tripId,
    ]),
    listTripEvents(tripId, { limit: 500 }),
    userId === null
      ? Promise.resolve({ rows: [{ n: '0' }] })
      : query<{ n: string }>(
          'SELECT count(*)::text AS n FROM trip_messages WHERE trip_id = $1 AND sender_id <> $2 AND read_at IS NULL',
          [tripId, userId],
        ),
  ]);
  const items: ChatTimelineItem[] = [
    ...msgs.rows.map((r) => {
      const message = toMessage(trip, r);
      return { kind: 'message' as const, at: message.createdAt, message };
    }),
    ...events
      .filter((e) => TRIP_EVENT_META[e.type].chatVisible)
      .map((event) => ({ kind: 'system' as const, at: event.createdAt, event })),
  ].sort((a, b) => a.at.localeCompare(b.at) || seqOf(a) - seqOf(b));
  const win = chatWindow(trip);
  return { items, unreadCount: Number(unread.rows[0]?.n ?? 0), ...win };
}
