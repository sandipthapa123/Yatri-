import type { ServerRealtimeMessage } from '@yatri/types';
import Redis from 'ioredis';

import { env } from '../../config/env';
import { getRedisClient } from '../../config/redis';
import { log } from '../../lib/logger';

/**
 * Cross-process fan-out. There are exactly TWO primitives, so chat, calls, offers, events,
 * availability and snapshots all travel one coherent path:
 *
 *  1. `publishTripChange`  – "trip X changed": every instance rebuilds role-specific snapshots
 *     for the sockets subscribed to X. Carries NO location data, so the privacy rules live in
 *     one place (tracking.service).
 *  2. `publishToUser`      – "deliver this protocol message to user U's connections". Used for
 *     everything addressed to a person: trip events, chat, receipts, call state/signalling,
 *     ride offers, availability status.
 */
const TRIP_CHANNEL = 'yatri:trip-changes';
const USER_CHANNEL = 'yatri:user-messages';

export interface TripChange {
  tripId: string;
  /** Snapshot version, monotonic per trip. */
  version: number;
}

export interface UserMessage {
  userId: string;
  message: ServerRealtimeMessage;
}

type TripHandler = (change: TripChange) => void;
type UserHandler = (m: UserMessage) => void;
const tripHandlers = new Set<TripHandler>();
const userHandlers = new Set<UserHandler>();
let subscriber: Redis | null = null;

export async function publishTripChange(change: TripChange): Promise<void> {
  await getRedisClient().publish(TRIP_CHANNEL, JSON.stringify(change));
}

export async function publishToUser(userId: string, message: ServerRealtimeMessage): Promise<void> {
  await getRedisClient().publish(USER_CHANNEL, JSON.stringify({ userId, message }));
}

export function onTripChange(handler: TripHandler): () => void {
  tripHandlers.add(handler);
  return () => tripHandlers.delete(handler);
}

export function onUserMessage(handler: UserHandler): () => void {
  userHandlers.add(handler);
  return () => userHandlers.delete(handler);
}

export async function startBus(): Promise<void> {
  if (subscriber) return;
  subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  subscriber.on('error', (err) => log.error('Realtime bus error', err));
  subscriber.on('message', (channel, raw) => {
    try {
      if (channel === USER_CHANNEL) {
        const m = JSON.parse(raw) as UserMessage;
        for (const h of userHandlers) h(m);
      } else {
        const change = JSON.parse(raw) as TripChange;
        for (const h of tripHandlers) h(change);
      }
    } catch {
      /* ignore malformed */
    }
  });
  // ioredis resubscribes automatically after a reconnect.
  await subscriber.subscribe(TRIP_CHANNEL, USER_CHANNEL);
}

export async function stopBus(): Promise<void> {
  const s = subscriber;
  subscriber = null;
  if (s) {
    s.removeAllListeners('message');
    await s.quit().catch(() => undefined);
  }
}
