import bcrypt from 'bcryptjs';

// OTPs are short-lived and attempt-limited, so a lower cost is fine and
// keeps verification latency low. Admin passwords are long-lived secrets
// an attacker might try to crack offline from a leaked hash, so they get a
// higher cost.
export const OTP_HASH_ROUNDS = 10;
export const PASSWORD_HASH_ROUNDS = 12;

export function hashSecret(value: string, rounds: number): Promise<string> {
  return bcrypt.hash(value, rounds);
}

export function verifySecret(value: string, hash: string): Promise<boolean> {
  return bcrypt.compare(value, hash);
}
