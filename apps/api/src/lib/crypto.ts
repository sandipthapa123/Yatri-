import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt } from 'node:crypto';
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

/**
 * Reversible encryption for the few things Yatri must be able to read back (a payout account number) and must not keep in
 * the clear. AES-256-GCM with a random nonce; the key is derived from a secret the caller passes (never a literal) and a
 * purpose label, so one leaked secret does not decrypt data from another purpose. Output: "v1.<nonce>.<tag>.<data>", base64url.
 */
export function encryptField(plain: string, secret: string, purpose: string): string {
  const key = createHmac('sha256', secret).update(`yatri:field:${purpose}:v1`).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

/** The inverse. Throws if the value was changed, or the secret or purpose is not the one it was encrypted with. */
export function decryptField(sealed: string, secret: string, purpose: string): string {
  const [version, nonce, tag, data] = sealed.split('.');
  if (version !== 'v1' || !nonce || !tag || !data) throw new Error('Unreadable encrypted value');
  const key = createHmac('sha256', secret).update(`yatri:field:${purpose}:v1`).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
