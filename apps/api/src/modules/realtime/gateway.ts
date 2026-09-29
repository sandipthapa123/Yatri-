import type { Server as HttpServer } from 'node:http';
import type { ServerRealtimeMessage, TripStatus } from '@yatri/types';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';

import { resolveAccessToken } from '../../middleware/authenticate';
import type { AuthContext } from '../../types/express';
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
import { getTrip } from '../trips/trips.repository';
import { metaFromRow } from '../trips/trips.service';
import {
  getStatus as getAvailabilityStatus,
  goOffline,
  goOnline,
  ingestLocation,
  sweepDrivers,
} from '../availability/availability.service';
import {
  driverLocationSampleShape,
  driverLocationSampleSchema,
} from '../availability/availability.validators';
import { touchSeen } from '../availability/presence.state';
import { HttpError } from '../../middleware/errorHandler';
import { availabilityConfig } from '../availability/availability.service';
import { onDriverChange, onTripChange, startBus, stopBus, type TripChange } from './bus';

export const REALTIME_PATH = '/ws/v1/realtime';

const AUTH_TIMEOUT_MS = 5_000;
const TOKEN_GRACE_MS = 30_000;
const SESSION_RECHECK_MS = 60_000;
const HEARTBEAT_MS = 25_000;
const SWEEP_MS = 5_000;
const DRIVER_SWEEP_MS = 15_000;
const MAX_MESSAGES_PER_SECOND = 8;
const MAX_VIOLATIONS = 25;
const MAX_BUFFERED_BYTES = 256 * 1024;

const uuid = z.string().uuid();
const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(10).max(4096) }),
  z.object({ type: z.literal('subscribe'), tripId: uuid }),
  z.object({ type: z.literal('unsubscribe'), tripId: uuid }),
  z.object({
    type: z.enum(['driver_location', 'passenger_location']),
    tripId: uuid,
    latitude: latitudeSchema,
    longitude: longitudeSchema,
    accuracyMeters: z.number().finite().min(0).max(100_000).nullable().optional(),
    deviceTimeMs: z.number().finite(),
  }),
  z.object({ type: z.literal('stop_sharing'), tripId: uuid }),
  // Driver presence. Strict: a stray driverId (or any unknown key) is a protocol error, not ignored.
  // (0,0 "no fix" readings are rejected downstream by evaluateFix.)
  z.object({ type: z.literal('location'), ...driverLocationSampleShape }).strict(),
  z
    .object({
      type: z.literal('availability'),
      action: z.enum(['online', 'offline']),
      location: driverLocationSampleSchema.optional(),
    })
    .strict(),
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
  const wss = new WebSocketServer({ server, path: REALTIME_PATH, maxPayload: 4 * 1024 });
  const conns = new Set<Conn>();
  const byTrip = new Map<string, Set<Conn>>();
  const lastFreshness = new Map<string, string>();
  // One live presence connection per driver. A newer login supersedes the older one, so two
  // devices can never both believe they are "the" online device.
  const driverConns = new Map<string, Conn>();

  const currentIntervalMs = () => availabilityConfig().intervals.idle;

  async function pushAvailability(conn: Conn) {
    if (!conn.auth) return;
    send(conn, { type: 'availability', status: await getAvailabilityStatus(conn.auth.userId) });
  }

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
    conns.delete(conn);
  };

  const viewerOf = (meta: TripMeta, userId: string) =>
    meta.passengerId === userId ? ('PASSENGER' as const) : ('DRIVER' as const);

  async function loadTripMeta(tripId: string): Promise<TripMeta | null> {
    const cached = await loadMeta(tripId);
    if (cached) return cached;
    const row = await getTrip(tripId);
    return row ? metaFromRow(row) : null;
  }

  async function pushSnapshot(conn: Conn, meta: TripMeta) {
    if (!conn.auth) return;
    send(conn, {
      type: 'snapshot',
      snapshot: await buildSnapshot(meta, viewerOf(meta, conn.auth.userId)),
    });
  }

  async function handle(conn: Conn, raw: string) {
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
      if (conn.auth && conn.auth.userId !== r.auth.userId)
        return conn.ws.close(4403, 'user_changed');
      const firstAuth = !conn.auth;
      conn.auth = r.auth;
      conn.token = msg.token;
      conn.expiresAtMs = r.expiresAtMs;
      send(conn, { type: 'authed', userId: r.auth.userId, role: r.auth.role });
      if (firstAuth && r.auth.role === 'DRIVER') {
        const previous = driverConns.get(r.auth.userId);
        driverConns.set(r.auth.userId, conn);
        if (previous && previous !== conn) {
          send(previous, { type: 'connection', status: 'superseded', updateIntervalMs: 0 });
          previous.ws.close(4409, 'superseded');
        }
        await touchSeen(r.auth.userId, Date.now());
        send(conn, {
          type: 'connection',
          status: 'connected',
          updateIntervalMs: currentIntervalMs(),
        });
        await pushAvailability(conn);
      }
      return;
    }

    if (!conn.auth) {
      send(conn, { type: 'error', code: 'UNAUTHENTICATED', message: 'Authenticate first.' });
      return conn.ws.close(4401, 'unauthenticated');
    }
    const userId = conn.auth.userId;

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

    if (msg.type === 'subscribe') {
      const meta = await loadTripMeta(msg.tripId);
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
      const meta = await loadTripMeta(msg.tripId);
      if (meta?.passengerId === userId) await passengerStopsSharing(msg.tripId);
      return;
    }

    // driver_location | passenger_location
    const result = await applyLocationUpdate({
      tripId: msg.tripId,
      userId,
      party: msg.type === 'driver_location' ? 'driver' : 'passenger',
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
    ws.on('message', (data) => {
      const now = Date.now();
      if (now - conn.window.startMs >= 1000) conn.window = { startMs: now, count: 0 };
      if (++conn.window.count > MAX_MESSAGES_PER_SECOND) {
        if (++conn.violations > MAX_VIOLATIONS) ws.close(4429, 'rate_limited');
        return; // drop the excess
      }
      handle(conn, data.toString()).catch((err) => {
        console.error('Realtime handler error', err);
        send(conn, { type: 'error', code: 'INTERNAL_ERROR', message: 'Something went wrong.' });
      });
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      // A dropped socket does NOT flip the driver offline: staleness handling does that on the
      // configured timeout, so a brief network blip does not cost the driver their shift.
      if (conn.auth && driverConns.get(conn.auth.userId) === conn)
        driverConns.delete(conn.auth.userId);
      drop(conn);
    });
    ws.on('error', () => ws.terminate());
  });

  const offChange = onTripChange((change: TripChange) => {
    const set = byTrip.get(change.tripId);
    if (!set || set.size === 0) return;
    void (async () => {
      const meta = await loadTripMeta(change.tripId);
      if (!meta) return;
      for (const conn of [...set]) {
        if (!conn.auth) continue;
        if (change.event) {
          send(conn, {
            type: 'event',
            tripId: change.tripId,
            eventId: change.eventId,
            event: change.event,
            important: change.important ?? false,
          });
        }
        await pushSnapshot(conn, meta);
        if (!isActive(meta.status as TripStatus)) unsubscribe(conn, change.tripId);
      }
    })().catch((err) => console.error('Realtime fan-out error', err));
  });

  // Timers: heartbeat, token/session expiry, driver-feed staleness.
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
        const meta = await loadTripMeta(tripId);
        if (!meta || !isActive(meta.status)) return;
        const f = await driverFreshness(tripId);
        const prev = lastFreshness.get(tripId);
        lastFreshness.set(tripId, f);
        if (prev !== undefined && prev !== f && f !== 'none') await announceStaleness(tripId, f);
      })().catch((err) => console.error('Staleness sweep error', err));
    }
  }, SWEEP_MS);

  const offDriver = onDriverChange((driverId) => {
    const conn = driverConns.get(driverId);
    if (conn) void pushAvailability(conn).catch((err) => console.error('driver push failed', err));
  });
  const driverSweeper = setInterval(() => {
    sweepDrivers().catch((err) => console.error('Driver sweep error', err));
  }, DRIVER_SWEEP_MS);

  await startBus();

  return {
    connectionCount: () => conns.size,
    async close() {
      clearInterval(heartbeat);
      clearInterval(sessionCheck);
      clearInterval(sweeper);
      clearInterval(driverSweeper);
      offChange();
      offDriver();
      for (const conn of conns) conn.ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await stopBus();
    },
  };
}
