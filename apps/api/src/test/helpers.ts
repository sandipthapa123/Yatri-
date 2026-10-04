import { randomInt } from 'node:crypto';
import type { AdminPermission } from '@yatri/types';
import request, { type Response as SupertestResponse } from 'supertest';

import { pool } from '../config/database';
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

/**
 * What an admin could do before permissions were granular: run operations, review drivers, cancel
 * rides, decide disputes. Test admins get this by default; a test that is about a permission passes
 * exactly the set it wants (including none).
 */
export const BASELINE_ADMIN_PERMISSIONS: AdminPermission[] = [
  'OPERATIONS_VIEW',
  'DRIVERS_REVIEW',
  'RIDES_MANAGE',
  'DISPUTES_MANAGE',
];

export async function createTestAdmin(
  email: string,
  password: string,
  permissions: AdminPermission[] = BASELINE_ADMIN_PERMISSIONS,
) {
  const passwordHash = await hashSecret(password, PASSWORD_HASH_ROUNDS);
  const admin = await createAdmin(email, passwordHash, 'Test Admin');
  await pool.query('UPDATE users SET admin_permissions = $2::text[] WHERE id = $1', [
    admin.id,
    permissions,
  ]);
  return admin;
}

export async function loginTestAdmin(
  email: string,
  password: string,
  permissions?: AdminPermission[],
): Promise<string> {
  await createTestAdmin(email, password, permissions);
  const res = await api.post('/api/v1/auth/admin/login').send({ email, password });
  if (res.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(res.body)}`);
  return res.body.data.accessToken as string;
}

/** Minimal real file bytes for each accepted type, plus one that matches none of them. */
export const FIXTURES = {
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
  pdf: Buffer.from('%PDF-1.4\n%fake pdf content for tests\n'),
  invalid: Buffer.from('this is plain text pretending to be a document'),
};

export function uploadDocument(
  accessToken: string,
  documentTypeCode: string,
  file: Buffer,
  filename: string,
  opts: { vehicleId?: string; expiryDate?: string } = {},
) {
  let req = api
    .post('/api/v1/documents')
    .set('Authorization', `Bearer ${accessToken}`)
    .field('documentTypeCode', documentTypeCode);
  if (opts.vehicleId) req = req.field('vehicleId', opts.vehicleId);
  if (opts.expiryDate) req = req.field('expiryDate', opts.expiryDate);
  return req.attach('file', file, filename);
}

export function uniqueLicenseNumber(): string {
  return `LIC-${randomInt(0, 1_000_000)}`;
}

export function uniqueRegistrationNumber(): string {
  return `BA-${randomInt(1, 99)}-PA-${randomInt(1000, 9999)}`;
}

export async function completeDriverOnboardingInfo(
  accessToken: string,
): Promise<SupertestResponse> {
  return api
    .patch('/api/v1/drivers/me/onboarding')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      fullLegalName: 'Test Driver',
      dateOfBirth: '1995-01-01',
      licenseNumber: uniqueLicenseNumber(),
      licenseExpiryDate: '2099-01-01',
      addressLine1: '123 Main Street',
      city: 'Kathmandu',
    });
}

export async function createTestVehicle(accessToken: string, categoryCode = 'CAR') {
  const categoriesRes = await api
    .get('/api/v1/vehicles/categories')
    .set('Authorization', `Bearer ${accessToken}`);
  const category = (categoriesRes.body.data as Array<{ id: string; code: string }>).find(
    (c) => c.code === categoryCode,
  );
  if (!category) throw new Error(`No such vehicle category: ${categoryCode}`);

  const res = await api
    .post('/api/v1/vehicles')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      categoryId: category.id,
      make: 'Toyota',
      model: 'Corolla',
      year: 2020,
      color: 'White',
      registrationNumber: uniqueRegistrationNumber(),
      registrationExpiryDate: '2099-01-01',
      insuranceProvider: 'Test Insurance',
      insurancePolicyNumber: `POL-${randomInt(0, 1_000_000)}`,
      insuranceExpiryDate: '2099-01-01',
    });
  if (res.status !== 201) throw new Error(`create vehicle failed: ${JSON.stringify(res.body)}`);
  return res.body.data as { id: string; verificationStatus: string };
}

export interface SubmittableDriver extends OnboardedUser {
  vehicleId: string;
  documentIds: Record<string, string>;
}

/**
 * Drives a driver all the way to "every onboarding step complete, ready to
 * submit" via the real API: personal/driver info, one vehicle, and every
 * currently-required document (driver + vehicle), all with valid files and
 * far-future expiry dates.
 */
export async function bringDriverToSubmittable(): Promise<SubmittableDriver> {
  const onboarded = await onboardUser('DRIVER');
  const { accessToken } = onboarded;

  await completeDriverOnboardingInfo(accessToken);
  const vehicle = await createTestVehicle(accessToken);

  const documentIds: Record<string, string> = {};
  for (const code of ['DRIVING_LICENSE', 'IDENTITY_DOCUMENT', 'DRIVER_PHOTOGRAPH']) {
    const res = await uploadDocument(accessToken, code, FIXTURES.jpeg, 'doc.jpg', {
      expiryDate: '2099-01-01',
    });
    if (res.status !== 201) throw new Error(`upload ${code} failed: ${JSON.stringify(res.body)}`);
    documentIds[code] = res.body.data.id;
  }
  for (const code of ['VEHICLE_REGISTRATION', 'VEHICLE_INSURANCE']) {
    const res = await uploadDocument(accessToken, code, FIXTURES.pdf, 'doc.pdf', {
      vehicleId: vehicle.id,
      expiryDate: '2099-01-01',
    });
    if (res.status !== 201) throw new Error(`upload ${code} failed: ${JSON.stringify(res.body)}`);
    documentIds[code] = res.body.data.id;
  }

  return { ...onboarded, vehicleId: vehicle.id, documentIds };
}

/** Admin-approves a submittable driver's vehicle and every document — the strict path to VERIFIED-eligible. */
export async function approveEverythingAsAdmin(
  adminToken: string,
  driver: SubmittableDriver,
): Promise<void> {
  const approve = (path: string) =>
    api.post(path).set('Authorization', `Bearer ${adminToken}`).send({});

  const vehicleRes = await approve(`/api/v1/admin/vehicles/${driver.vehicleId}/approve`);
  if (vehicleRes.status !== 200) {
    throw new Error(`approve vehicle failed: ${JSON.stringify(vehicleRes.body)}`);
  }
  for (const documentId of Object.values(driver.documentIds)) {
    const res = await approve(`/api/v1/admin/documents/${documentId}/approve`);
    if (res.status !== 200) throw new Error(`approve document failed: ${JSON.stringify(res.body)}`);
  }
}

/** A driver who has passed the real, strict verification flow: documents approved, vehicle approved, admin-VERIFIED. */
export async function createVerifiedDriver(): Promise<{
  driver: SubmittableDriver;
  adminToken: string;
}> {
  const driver = await bringDriverToSubmittable();
  const submit = await api
    .post('/api/v1/drivers/me/submit-verification')
    .set('Authorization', `Bearer ${driver.accessToken}`);
  if (submit.status !== 200) throw new Error(`submit failed: ${JSON.stringify(submit.body)}`);
  const adminToken = await loginTestAdmin(
    `verified-${Date.now()}-${randomInt(0, 1e6)}@yatri.local`,
    'a-strong-test-password-1',
  );
  await approveEverythingAsAdmin(adminToken, driver);
  const verify = await api
    .post(`/api/v1/admin/drivers/${driver.user.id}/verify`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({});
  if (verify.status !== 200) throw new Error(`verify failed: ${JSON.stringify(verify.body)}`);
  return { driver, adminToken };
}

/**
 * Wait for something the system does just after it answers (a notification written after the realtime message that
 * announced it, for example): read it again until `done` says so, for up to `timeoutMs`. Returns the last value read, so
 * the test's own assertions explain any failure.
 */
export async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    value = await read();
  }
  return value;
}
