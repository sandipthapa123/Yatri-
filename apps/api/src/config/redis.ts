import Redis from 'ioredis';

import { env } from './env';

let client: Redis | null = null;

/**
 * Redis-ready, not Redis-required: no realtime feature exists yet, so
 * nothing should hold an open connection at boot. Call this to get a lazily
 * connecting client the first time a future feature (presence, pub/sub,
 * driver-location fanout) actually needs one.
 */
export function getRedisClient(): Redis {
  if (!client) {
    client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });
    client.on('error', (err) => {
      console.error('Redis client error', err);
    });
  }
  return client;
}
