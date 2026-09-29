import type { DriverAvailabilityState } from '@yatri/types';

import { getRedisClient } from '../../config/redis';
import type { StoredFix } from '../tracking/tracking.rules';

/**
 * Ephemeral realtime driver state, in Redis. Postgres stays the source of truth
 * for availability STATE; Redis holds only what is short-lived and hot: the latest
 * fix, last-seen, a mirror of the state (so a location update does not cost a DB
 * read), and small throttles. Everything here expires on its own.
 */
const TTL_SECONDS = 24 * 60 * 60;

export interface LiveFix {
  fix: StoredFix;
  headingDegrees: number | null;
  speedMps: number | null;
}

const key = {
  fix: (id: string) => `drv:${id}:fix`,
  state: (id: string) => `drv:${id}:state`,
  seen: (id: string) => `drv:${id}:seen`,
  persisted: (id: string) => `drv:${id}:persisted`,
  notified: (id: string) => `drv:${id}:notified`,
  flag: (id: string, kind: string) => `drv:${id}:flag:${kind}`,
};

const redis = () => getRedisClient();

export async function getLiveFix(driverId: string): Promise<LiveFix | null> {
  const raw = await redis().get(key.fix(driverId));
  return raw ? (JSON.parse(raw) as LiveFix) : null;
}
export async function setLiveFix(driverId: string, live: LiveFix): Promise<void> {
  await redis().set(key.fix(driverId), JSON.stringify(live), 'EX', TTL_SECONDS);
}
export async function clearLiveFix(driverId: string): Promise<void> {
  await redis().del(key.fix(driverId), key.persisted(driverId), key.notified(driverId));
}

export async function getStateMirror(driverId: string): Promise<DriverAvailabilityState | null> {
  return (await redis().get(key.state(driverId))) as DriverAvailabilityState | null;
}
export async function setStateMirror(driverId: string, state: DriverAvailabilityState) {
  await redis().set(key.state(driverId), state, 'EX', TTL_SECONDS);
}

export async function touchSeen(driverId: string, nowMs: number): Promise<void> {
  await redis().set(key.seen(driverId), String(nowMs), 'EX', TTL_SECONDS);
}
export async function getSeen(driverId: string): Promise<number | null> {
  const v = await redis().get(key.seen(driverId));
  return v ? Number(v) : null;
}

/** True when a Postgres write is due (at most one per `everySeconds`); claims the slot atomically. */
export async function claimPersistSlot(driverId: string, everySeconds: number): Promise<boolean> {
  if (everySeconds <= 0) return true;
  const ok = await redis().set(key.persisted(driverId), '1', 'EX', everySeconds, 'NX');
  return ok === 'OK';
}

/** True the first time in a minute a given kind of flag is raised for a driver (keeps the flag table small). */
export async function claimFlagSlot(driverId: string, kind: string): Promise<boolean> {
  return (await redis().set(key.flag(driverId, kind), '1', 'EX', 60, 'NX')) === 'OK';
}

export async function getNotifiedFreshness(driverId: string): Promise<string | null> {
  return redis().get(key.notified(driverId));
}
export async function setNotifiedFreshness(driverId: string, freshness: string) {
  await redis().set(key.notified(driverId), freshness, 'EX', TTL_SECONDS);
}

// ---- the driver's active trip (so the presence connection can feed exactly that trip) ----
const tripKey = (id: string) => `drv:${id}:trip`;

/** '' means "checked, no active trip" (so we don't hit the DB on every fix). */
export async function setDriverTrip(driverId: string, tripId: string | null): Promise<void> {
  await redis().set(tripKey(driverId), tripId ?? '', 'EX', TTL_SECONDS);
}
export async function getDriverTrip(driverId: string): Promise<string | null | undefined> {
  const v = await redis().get(tripKey(driverId));
  return v === null ? undefined : v === '' ? null : v;
}
