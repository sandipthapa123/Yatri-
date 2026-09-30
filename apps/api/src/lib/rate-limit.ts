import { getRedisClient } from '../config/redis';

export interface WindowCounterResult {
  count: number;
  limited: boolean;
  retryAfterSeconds: number;
}

/**
 * Count one hit and (re)arm the window in ONE atomic Redis step. Doing INCR and EXPIRE as two calls
 * leaves a gap: if the process dies between them the counter has no expiry and the key blocks that
 * caller forever. This script also repairs a counter that somehow has no expiry.
 */
const HIT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

/**
 * Fixed-window counter (e.g. "max 5 OTP requests per 15 minutes for this phone number"). Backed by
 * Redis so it is correct across several API processes, unlike an in-memory counter.
 */
export async function checkWindowLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<WindowCounterResult> {
  const [count, ttl] = (await getRedisClient().eval(HIT, 1, key, windowSeconds)) as [
    number,
    number,
  ];
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
