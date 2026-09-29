import type { TripEventName } from '@yatri/types';
import Redis from 'ioredis';

import { env } from '../../config/env';
import { getRedisClient } from '../../config/redis';

/**
 * Cross-process fan-out. Every API instance publishes "trip X changed" and
 * every instance forwards it to the sockets it holds. The message carries
 * NO location data: each instance rebuilds role-specific snapshots from
 * Redis, so the privacy rules live in one place (tracking.service).
 */
const CHANNEL = 'yatri:trip-changes';

export interface TripChange {
  tripId: string;
  eventId: number;
  event?: TripEventName;
  important?: boolean;
}

type Handler = (change: TripChange) => void;
const handlers = new Set<Handler>();
let subscriber: Redis | null = null;

export async function publishTripChange(change: TripChange): Promise<void> {
  await getRedisClient().publish(CHANNEL, JSON.stringify(change));
}

export function onTripChange(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export async function startBus(): Promise<void> {
  if (subscriber) return;
  subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  subscriber.on('error', (err) => console.error('Realtime bus error', err));
  subscriber.on('message', (_channel, raw) => {
    try {
      const change = JSON.parse(raw) as TripChange;
      for (const h of handlers) h(change);
    } catch {
      /* ignore malformed */
    }
  });
  // ioredis resubscribes automatically after a reconnect.
  await subscriber.subscribe(CHANNEL);
}

export async function stopBus(): Promise<void> {
  const s = subscriber;
  subscriber = null;
  if (s) {
    s.removeAllListeners('message');
    await s.quit().catch(() => undefined);
  }
}
