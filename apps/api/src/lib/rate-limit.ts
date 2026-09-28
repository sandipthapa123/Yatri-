import { getRedisClient } from '../config/redis';

export interface WindowCounterResult {
  count: number;
  limited: boolean;
  retryAfterSeconds: number;
}

/**
 * Fixed-window counter (e.g. "max 5 OTP requests per 15 minutes for this
 * phone number"). Backed by Redis so it works correctly across multiple API
 * processes, unlike an in-memory counter.
 */
export async function checkWindowLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<WindowCounterResult> {
  const redis = getRedisClient();
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }
  const ttl = await redis.ttl(key);
  return {
    count,
    limited: count > limit,
    retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
  };
}

/**
 * Simple "may I act again yet" cooldown (e.g. resend-OTP cooldown). Returns
 * how many seconds remain if the cooldown is still active, or null if the
 * caller is free to act (and the cooldown has been (re)armed).
 */
export async function checkAndArmCooldown(
  key: string,
  cooldownSeconds: number,
): Promise<number | null> {
  const redis = getRedisClient();
  // SET key value EX seconds NX — only succeeds if the key doesn't exist yet.
  const armed = await redis.set(key, '1', 'EX', cooldownSeconds, 'NX');
  if (armed === 'OK') return null;
  const ttl = await redis.ttl(key);
  return ttl > 0 ? ttl : cooldownSeconds;
}

export async function clearCooldown(key: string): Promise<void> {
  await getRedisClient().del(key);
}
