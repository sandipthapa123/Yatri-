import type { Server as HttpServer } from 'node:http';
import type { ServerRealtimeMessage } from '@yatri/types';
import { CALL_KINDS, CHAT_MAX_LENGTH } from '@yatri/types';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';

import { HttpError } from '../../middleware/errorHandler';
import { resolveAccessToken } from '../../middleware/authenticate';
import type { AuthContext } from '../../types/express';
import {
  availabilityConfig,
  getStatus as getAvailabilityStatus,
  goOffline,
  goOnline,
  ingestLocation,
} from '../availability/availability.service';
import {
  driverLocationSampleSchema,
  driverLocationSampleShape,
} from '../availability/availability.validators';
import { touchSeen } from '../availability/presence.state';
import {
  answerCall,
  callConnected,
  declineCall,
  endCall,
  relaySignal,
  startCall,
} from '../calls/calls.service';
import { markDelivered, markRead, sendMessage } from '../chat/chat.service';
import { currentOfferFor } from '../dispatch/dispatch.service';
import { latitudeSchema, longitudeSchema } from '../location/coordinates';
import {
  announceStaleness,
  applyLocationUpdate,
  buildSnapshot,
  driverFreshness,
  isActive,
  loadMeta,
  passengerStopsSharing,
  type TripMeta,
} from '../tracking/tracking.service';
import { JOBS } from '../jobs/registry';
import { startJobScheduler } from '../jobs/jobs';
import { onTripChange, onUserMessage, startBus, stopBus, type TripChange } from './bus';
import { log } from '../../lib/logger';

export const REALTIME_PATH = '/ws/v1/realtime';

const AUTH_TIMEOUT_MS = 5_000;
const TOKEN_GRACE_MS = 30_000;
const SESSION_RECHECK_MS = 60_000;
const HEARTBEAT_MS = 25_000;
const SWEEP_MS = 5_000;
const MAX_MESSAGES_PER_SECOND = 8;
const MAX_VIOLATIONS = 25;
const MAX_BUFFERED_BYTES = 256 * 1024;
// WebRTC offers/answers carry an SDP (a few KB, more for video); every other message stays small.
const MAX_SIGNAL_BYTES = 32 * 1024;
const MAX_MESSAGE_BYTES = 4 * 1024;

const uuid = z.string().uuid();
const callSignal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('offer'), sdp: z.string().min(1).max(30_000) }).strict(),
  z.object({ kind: z.literal('answer'), sdp: z.string().min(1).max(30_000) }).strict(),
  z.object({ kind: z.literal('ice'), candidate: z.record(z.string(), z.unknown()) }).strict(),
]);

// The realtime protocol's client half (types in @yatri/types/realtime.ts). Strict where identity
// is at stake: a stray driverId/userId in a message is a protocol error, never honoured.
const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(10).max(4096) }),
  z.object({ type: z.literal('subscribe'), tripId: uuid }),
  z.object({ type: z.literal('unsubscribe'), tripId: uuid }),
  z.object({
    type: z.literal('passenger_location'),
    tripId: uuid,
    latitude: latitudeSchema,
    longitude: longitudeSchema,
    accuracyMeters: z.number().finite().min(0).max(100_000).nullable().optional(),
    deviceTimeMs: z.number().finite(),
  }),
  z.object({ type: z.literal('stop_sharing'), tripId: uuid }),
  z.object({ type: z.literal('location'), ...driverLocationSampleShape }).strict(),
  z
    .object({
      type: z.literal('availability'),
      action: z.enum(['online', 'offline']),
      location: driverLocationSampleSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('chat_send'),
      tripId: uuid,
      clientMessageId: z.string().min(8).max(64),
      body: z
        .string()
        .min(1)
        .max(CHAT_MAX_LENGTH * 2),
    })
    .strict(),
  z
    .object({ type: z.literal('chat_read'), tripId: uuid, upToSeq: z.number().int().min(1) })
    .strict(),
  z.object({ type: z.literal('call_start'), tripId: uuid, kind: z.enum(CALL_KINDS) }).strict(),
  z.object({ type: z.literal('call_answer'), callId: uuid }).strict(),
  z.object({ type: z.literal('call_decline'), callId: uuid }).strict(),
  z.object({ type: z.literal('call_end'), callId: uuid }).strict(),
  z.object({ type: z.literal('call_connected'), callId: uuid }).strict(),
  z.object({ type: z.literal('call_signal'), callId: uuid, signal: callSignal }).strict(),
  z.object({ type: z.literal('ping') }),
]);

interface Conn {
  ws: WebSocket;
  auth: AuthContext | null;
  token: string | null;
  expiresAtMs: number;
  subs: Set<string>;
  alive: boolean;
  window: { startMs: number; count: number };
  violations: number;
}

export interface RealtimeGateway {
  close(): Promise<void>;
  connectionCount(): number;
}

function send(conn: Conn, message: ServerRealtimeMessage) {
  if (conn.ws.readyState !== WebSocket.OPEN) return;
  // Slow consumer: skip rather than queue unboundedly; the next snapshot supersedes this one.
  if (message.type === 'snapshot' && conn.ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
  conn.ws.send(JSON.stringify(message));
}

export async function attachRealtimeGateway(server: HttpServer): Promise<RealtimeGateway> {
  const wss = new WebSocketServer({ server, path: REALTIME_PATH, maxPayload: MAX_SIGNAL_BYTES });
  const conns = new Set<Conn>();
  const byTrip = new Map<string, Set<Conn>>();
  const byUser = new Map<string, Set<Conn>>();
  const lastFreshness = new Map<string, string>();
  // One live presence connection per driver: a newer login supersedes the older one, so two
  // devices can never both believe they are "the" online device.
  const driverConns = new Map<string, Conn>();

  const subscribe = (conn: Conn, tripId: string) => {
    conn.subs.add(tripId);
    let set = byTrip.get(tripId);
    if (!set) byTrip.set(tripId, (set = new Set()));
    set.add(conn);
  };
  const unsubscribe = (conn: Conn, tripId: string) => {
    conn.subs.delete(tripId);
    const set = byTrip.get(tripId);
    set?.delete(conn);
    if (set && set.size === 0) {
      byTrip.delete(tripId);
      lastFreshness.delete(tripId);
    }
  };
  const drop = (conn: Conn) => {
    for (const t of [...conn.subs]) unsubscribe(conn, t);
    if (conn.auth) {
      const set = byUser.get(conn.auth.userId);
      set?.delete(conn);
      if (set && set.size === 0) byUser.delete(conn.auth.userId);
    }
    conns.delete(conn);
  };

  const viewerOf = (meta: TripMeta, userId: string) =>
    meta.passengerId === userId ? ('PASSENGER' as const) : ('DRIVER' as const);

  async function pushSnapshot(conn: Conn, meta: TripMeta) {
    if (!conn.auth) return;
    send(conn, {
      type: 'snapshot',
      snapshot: await buildSnapshot(meta, viewerOf(meta, conn.auth.userId)),
    });
  }

  async function onAuthenticated(conn: Conn, auth: AuthContext) {
    let set = byUser.get(auth.userId);
    if (!set) byUser.set(auth.userId, (set = new Set()));
    set.add(conn);
    if (auth.role !== 'DRIVER') return;

    const previous = driverConns.get(auth.userId);
    driverConns.set(auth.userId, conn);
    if (previous && previous !== conn) {
      send(previous, { type: 'connection', status: 'superseded', updateIntervalMs: 0 });
      previous.ws.close(4409, 'superseded');
    }
    await touchSeen(auth.userId, Date.now());
    send(conn, {
      type: 'connection',
      status: 'connected',
      updateIntervalMs: availabilityConfig().intervals.idle,
    });
    send(conn, { type: 'availability', status: await getAvailabilityStatus(auth.userId) });
    // A driver who reconnects mid-offer sees the offer again instead of silently losing it.
    const offer = await currentOfferFor(auth.userId);
    if (offer) send(conn, { type: 'trip_offer', offer });
  }

  async function handle(conn: Conn, raw: string, byteLength: number) {
    let parsed;
    try {
      parsed = clientMessage.safeParse(JSON.parse(raw));
    } catch {
      return send(conn, { type: 'error', code: 'BAD_MESSAGE', message: 'Malformed message.' });
    }
    if (!parsed.success) {
      return send(conn, { type: 'error', code: 'BAD_MESSAGE', message: 'Invalid message.' });
    }
    const msg = parsed.data;
    if (msg.type !== 'call_signal' && byteLength > MAX_MESSAGE_BYTES) {
      return send(conn, { type: 'error', code: 'BAD_MESSAGE', message: 'Message too large.' });
    }

    if (msg.type === 'ping') {
      // For a driver a ping is also a liveness heartbeat.
      if (conn.auth?.role === 'DRIVER') await touchSeen(conn.auth.userId, Date.now());
      return send(conn, { type: 'pong' });
    }

    if (msg.type === 'auth') {
      const r = await resolveAccessToken(msg.token);
      if (!r.ok) {
        send(conn, { type: 'error', code: 'UNAUTHENTICATED', message: 'Sign in again.' });
        return conn.ws.close(4401, 'unauthenticated');
      }
      // Token refresh on a live socket must stay the same user.
      if (conn.auth && conn.auth.userId !== r.auth.userId) {
        return conn.ws.close(4403, 'user_changed');
      }
      const firstAuth = !conn.auth;
      conn.auth = r.auth;
      conn.token = msg.token;
      conn.expiresAtMs = r.expiresAtMs;
      send(conn, { type: 'authed', userId: r.auth.userId, role: r.auth.role });
      if (firstAuth) await onAuthenticated(conn, r.auth);
      return;
    }

    if (!conn.auth) {
      send(conn, { type: 'error', code: 'UNAUTHENTICATED', message: 'Authenticate first.' });
      return conn.ws.close(4401, 'unauthenticated');
    }
    const userId = conn.auth.userId;

    // ---- driver presence
    if (msg.type === 'location' || msg.type === 'availability') {
      // The driver is whoever authenticated this socket; nothing in the message can change that.
      if (conn.auth.role !== 'DRIVER') {
        return send(conn, {
          type: 'availability_error',
          code: 'FORBIDDEN',
          message: 'Only drivers can do this.',
        });
      }
      if (driverConns.get(userId) !== conn) {
        return send(conn, {
          type: 'availability_error',
          code: 'SUPERSEDED',
          message: 'This device is no longer the active one.',
        });
      }
      if (msg.type === 'location') {
        const { type: _t, ...sample } = msg;
        void _t;
        const result = await ingestLocation(userId, sample);
        if (result.accepted) {
          return send(conn, {
            type: 'location_ack',
            receivedAt: result.receivedAt,
            freshness: result.freshness,
          });
        }
        if (result.reason === 'too_frequent') return;
        return send(conn, { type: 'rejected', tripId: '', reason: result.reason });
      }
      if (msg.action === 'online' && !msg.location) {
        return send(conn, { type: 'error', code: 'BAD_MESSAGE', message: 'Invalid message.' });
      }
      try {
        const status =
          msg.action === 'online' && msg.location
            ? await goOnline(userId, msg.location)
            : await goOffline(userId);
        return send(conn, { type: 'availability', status });
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        return send(conn, { type: 'availability_error', code: err.code, message: err.message });
      }
    }

    // ---- chat and calls: domain services own the rules; the socket only carries them
    if (
      msg.type === 'chat_send' ||
      msg.type === 'chat_read' ||
      msg.type === 'call_start' ||
      msg.type === 'call_answer' ||
      msg.type === 'call_decline' ||
      msg.type === 'call_end' ||
      msg.type === 'call_connected' ||
      msg.type === 'call_signal'
    ) {
      const scope = 'tripId' in msg ? msg.tripId : '';
      try {
        if (msg.type === 'chat_send') {
          await sendMessage(msg.tripId, userId, msg.clientMessageId, msg.body);
        } else if (msg.type === 'chat_read') await markRead(msg.tripId, userId, msg.upToSeq);
        else if (msg.type === 'call_start') await startCall(msg.tripId, userId, msg.kind);
        else if (msg.type === 'call_answer') await answerCall(msg.callId, userId);
        else if (msg.type === 'call_decline') await declineCall(msg.callId, userId);
        else if (msg.type === 'call_end') await endCall(msg.callId, userId);
        else if (msg.type === 'call_connected') await callConnected(msg.callId, userId);
        else await relaySignal(msg.callId, userId, msg.signal);
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        send(conn, { type: 'rejected', tripId: scope, reason: err.code });
      }
      return;
    }

    // ---- trip subscription and passenger location
    if (msg.type === 'subscribe') {
      const meta = await loadMeta(msg.tripId);
      // Same answer for "missing", "not yours" and "ended": no way to probe other people's trips.
      if (
        !meta ||
        !isActive(meta.status) ||
        (meta.passengerId !== userId && meta.driverId !== userId)
      ) {
        return send(conn, { type: 'error', code: 'NOT_FOUND', message: 'Trip not available.' });
      }
      subscribe(conn, msg.tripId);
      send(conn, { type: 'subscribed', tripId: msg.tripId });
      return pushSnapshot(conn, meta); // a reconnect gets full current state, not a replay
    }

    if (msg.type === 'unsubscribe') return unsubscribe(conn, msg.tripId);

    if (!conn.subs.has(msg.tripId)) {
      return send(conn, { type: 'rejected', tripId: msg.tripId, reason: 'not_subscribed' });
    }

    if (msg.type === 'stop_sharing') {
      const meta = await loadMeta(msg.tripId);
      if (meta?.passengerId === userId) await passengerStopsSharing(msg.tripId);
      return;
    }

    // passenger_location (the driver's position only ever arrives through presence)
    const result = await applyLocationUpdate({
      tripId: msg.tripId,
      userId,
      party: 'passenger',
      fix: {
        latitude: msg.latitude,
        longitude: msg.longitude,
        accuracyMeters: msg.accuracyMeters ?? null,
        deviceTimeMs: msg.deviceTimeMs,
      },
    });
    if (!result.accepted && result.reason !== 'too_frequent') {
      send(conn, { type: 'rejected', tripId: msg.tripId, reason: result.reason });
    }
  }

  wss.on('connection', (ws) => {
    const conn: Conn = {
      ws,
      auth: null,
      token: null,
      expiresAtMs: 0,
      subs: new Set(),
      alive: true,
      window: { startMs: Date.now(), count: 0 },
      violations: 0,
    };
    conns.add(conn);
    const authTimer = setTimeout(() => {
      if (!conn.auth) ws.close(4401, 'auth_timeout');
    }, AUTH_TIMEOUT_MS);

    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const now = Date.now();
      if (now - conn.window.startMs >= 1000) conn.window = { startMs: now, count: 0 };
      if (++conn.window.count > MAX_MESSAGES_PER_SECOND) {
        if (++conn.violations > MAX_VIOLATIONS) ws.close(4429, 'rate_limited');
        return; // drop the excess
      }
      const text = data.toString();
      handle(conn, text, Buffer.byteLength(text)).catch((err) => {
        log.error('Realtime handler error', err);
        send(conn, { type: 'error', code: 'INTERNAL_ERROR', message: 'Something went wrong.' });
      });
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      // A dropped socket does NOT flip the driver offline: staleness handling does that on the
      // configured timeout, so a brief network blip does not cost the driver their shift.
      if (conn.auth && driverConns.get(conn.auth.userId) === conn) {
        driverConns.delete(conn.auth.userId);
      }
      drop(conn);
    });
    ws.on('error', () => ws.terminate());
  });

  // Snapshots: rebuilt per viewer for the sockets subscribed to the trip.
  const offTrip = onTripChange((change: TripChange) => {
    const set = byTrip.get(change.tripId);
    if (!set || set.size === 0) return;
    void (async () => {
      const meta = await loadMeta(change.tripId);
      if (!meta) return;
      for (const conn of [...set]) {
        if (!conn.auth) continue;
        await pushSnapshot(conn, meta);
        if (!isActive(meta.status)) unsubscribe(conn, change.tripId);
      }
    })().catch((err) => log.error('Realtime fan-out error', err));
  });

  // Everything addressed to a person (events, chat, receipts, calls, offers, availability).
  const offUser = onUserMessage(({ userId, message }) => {
    const set = byUser.get(userId);
    if (!set) return;
    for (const conn of set) {
      send(conn, message);
      // A chat message that reached the OTHER party's device is "delivered".
      if (
        message.type === 'chat_message' &&
        conn.auth &&
        message.message.senderRole !== conn.auth.role
      ) {
        void markDelivered(message.message.tripId, userId, message.message.seq).catch(
          () => undefined,
        );
      }
    }
  });

  // Timers: heartbeat, token/session expiry, staleness, dispatch, waiting, calls.
  const heartbeat = setInterval(() => {
    for (const conn of conns) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }, HEARTBEAT_MS);

  const sessionCheck = setInterval(() => {
    const now = Date.now();
    for (const conn of conns) {
      if (!conn.auth || !conn.token) continue;
      if (now > conn.expiresAtMs + TOKEN_GRACE_MS) {
        conn.ws.close(4401, 'token_expired'); // the client re-sends `auth` with a fresh token before this
        continue;
      }
      void resolveAccessToken(conn.token)
        .then((r) => {
          if (!r.ok) conn.ws.close(4401, 'session_ended');
        })
        .catch(() => undefined);
    }
  }, SESSION_RECHECK_MS);

  const sweeper = setInterval(() => {
    for (const tripId of byTrip.keys()) {
      void (async () => {
        const meta = await loadMeta(tripId);
        if (!meta || !isActive(meta.status) || !meta.driverId) return;
        const f = await driverFreshness(tripId);
        const prev = lastFreshness.get(tripId);
        lastFreshness.set(tripId, f);
        if (prev !== undefined && prev !== f && f !== 'none') await announceStaleness(tripId, f);
      })().catch((err) => log.error('Staleness sweep error', err));
    }
  }, SWEEP_MS);

  // Every time-based job runs from the one registry, under the one runner (lock, history, timeout).
  const stopJobs = startJobScheduler(JOBS);

  await startBus();

  return {
    connectionCount: () => conns.size,
    async close() {
      clearInterval(heartbeat);
      clearInterval(sessionCheck);
      clearInterval(sweeper);
      stopJobs();
      offTrip();
      offUser();
      for (const conn of conns) conn.ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await stopBus();
    },
  };
}
