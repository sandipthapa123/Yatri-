import { randomInt } from 'node:crypto';
import request from 'supertest';

import { createApp } from '../app';
import { hashSecret, PASSWORD_HASH_ROUNDS } from '../lib/password';
import { createAdmin } from '../modules/users/users.repository';
import type { UserRole } from '../modules/users/users.types';

export const app = createApp();
export const api = request(app);

/** A fresh, valid E.164 test phone number, unique per call. */
export function uniquePhone(): string {
  const digits = Array.from({ length: 9 }, () => randomInt(0, 10)).join('');
  return `+977${digits}`;
}

export interface OnboardedUser {
  phoneNumber: string;
  role: UserRole;
  user: Record<string, unknown>;
  accessToken: string;
  refreshToken: string;
  isNewUser: boolean;
}

/** Drives the real request-otp -> verify-otp flow (using OTP_DEV_MODE) and returns the session. */
export async function onboardUser(
  role: Extract<UserRole, 'PASSENGER' | 'DRIVER'>,
): Promise<OnboardedUser> {
  const phoneNumber = uniquePhone();

  const requestRes = await api.post('/api/v1/auth/request-otp').send({ phoneNumber, role });
  if (requestRes.status !== 200) {
    throw new Error(`request-otp failed: ${JSON.stringify(requestRes.body)}`);
  }
  const devOtp: string = requestRes.body.data.devOtp;

  const verifyRes = await api
    .post('/api/v1/auth/verify-otp')
    .send({ phoneNumber, role, code: devOtp });
  if (verifyRes.status !== 200) {
    throw new Error(`verify-otp failed: ${JSON.stringify(verifyRes.body)}`);
  }

  const { user, accessToken, refreshToken, isNewUser } = verifyRes.body.data;
  return { phoneNumber, role, user, accessToken, refreshToken, isNewUser };
}

export async function createTestAdmin(email: string, password: string) {
  const passwordHash = await hashSecret(password, PASSWORD_HASH_ROUNDS);
  return createAdmin(email, passwordHash, 'Test Admin');
}
