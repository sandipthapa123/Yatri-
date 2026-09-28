import { randomBytes, randomInt } from 'node:crypto';
import { createHash } from 'node:crypto';

/**
 * Generates a cryptographically secure numeric OTP of the given length,
 * e.g. length 6 -> a code in [100000, 999999]. Uses crypto.randomInt, not
 * Math.random, so the code isn't predictable from observing other output.
 */
export function generateNumericOtp(length: number): string {
  const min = 10 ** (length - 1);
  const max = 10 ** length - 1;
  return randomInt(min, max + 1)
    .toString()
    .padStart(length, '0');
}

/** High-entropy opaque token for refresh tokens (256 bits, URL-safe). */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * One-way, unsalted hash for storing high-entropy opaque tokens: the token
 * itself is already 256 bits of randomness, so this exists only so a DB
 * read (backup, leaked snapshot, insider) can't directly recover a usable
 * token — not to resist offline guessing, which is infeasible at this
 * entropy regardless of hash function. Never use this for OTPs or
 * passwords, which need a slow, salted hash (see lib/password.ts).
 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
