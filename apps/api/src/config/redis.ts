import Redis from 'ioredis';

import { env } from './env';
import { log } from '../lib/logger';

let client: Redis | null = null;

/**
 * The shared Redis client (live positions, presence, rate limits, the realtime bus). It connects
 * lazily. A command that gets no answer within REDIS_COMMAND_TIMEOUT_MS fails instead of hanging the
 * request behind it, and reconnection backs off (capped at 2 s) rather than hammering a Redis that
 * is restarting; anything queued meanwhile is answered or failed, never lost silently.
 */
export function getRedisClient(): Redis {
  if (!client) {
    client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS,
      retryStrategy: (attempt) => Math.min(attempt * 100, 2000),
    });
    client.on('error', (err) => {
      log.error('Redis client error', err);
    });
  }
  return client;
}

/** Close the shared client (graceful shutdown, and the end of a test run). */
export async function closeRedis(): Promise<void> {
  if (!client) return;
  const c = client;
  client = null;
  await c.quit().catch(() => c.disconnect());
}
