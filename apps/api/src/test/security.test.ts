import { describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import {
  api,
  bringDriverToSubmittable,
  loginTestAdmin,
  onboardUser,
  uploadDocument,
  FIXTURES,
} from './helpers';

describe('Security', () => {
  it('rejects an executable disguised with an image extension', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    // ELF magic bytes (Linux executable header) — not a valid image or PDF.
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
    const res = await uploadDocument(accessToken, 'DRIVING_LICENSE', elf, 'totally-a-photo.jpg');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_FILE_TYPE');
  });

  it('rejects an HTML/script payload disguised as a PDF', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const res = await uploadDocument(accessToken, 'DRIVING_LICENSE', html, 'license.pdf');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_FILE_TYPE');
  });

  it('never persists a rejected file’s bytes as a document record', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    await uploadDocument(accessToken, 'DRIVING_LICENSE', FIXTURES.invalid, 'fake.jpg');
    const listRes = await api
      .get('/api/v1/documents')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(listRes.body.data).toHaveLength(0);
  });

  it('refuses a null character anywhere in a request with 400, never a database error', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    const inBody = await api
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fullName: 'A\u0000B' });
    expect(inBody.status).toBe(400);
    expect(inBody.body.error.code).toBe('VALIDATION_ERROR');
    const inQuery = await api
      .get('/api/v1/trips/history?page=1%00')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(inQuery.status).toBe(400);
    // ordinary text with newlines and other scripts still goes through to the field's own rules
    const fine = await api
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fullName: 'सन्दीप थापा' });
    expect(fine.status).toBe(200);
  });

  it('returns 400 (not a raw database error) for a malformed id', async () => {
    const admin = await loginTestAdmin(
      `sec-badid-${Date.now()}@yatri.local`,
      'a-strong-test-password-1',
    );
    const res = await api
      .get('/api/v1/admin/drivers/not-a-uuid-at-all')
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 (not 500) for a well-formed but nonexistent id', async () => {
    const admin = await loginTestAdmin(
      `sec-noid-${Date.now()}@yatri.local`,
      'a-strong-test-password-1',
    );
    const res = await api
      .get('/api/v1/admin/drivers/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(404);
  });

  it('malformed vehicle/document ids are rejected before touching the database', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    const patchRes = await api
      .patch('/api/v1/vehicles/../../etc/passwd')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ color: 'Red' });
    expect([400, 404]).toContain(patchRes.status);

    const deleteRes = await api
      .delete('/api/v1/documents/<script>alert(1)</script>')
      .set('Authorization', `Bearer ${accessToken}`);
    // Either our own UUID validation catches it (400), or the malformed
    // path never matches the route at all (404) — either way it's rejected
    // before reaching the database, never a raw SQL error (500).
    expect([400, 404]).toContain(deleteRes.status);
  });

  it('an approved (then expired) document no longer counts toward eligibility', async () => {
    const driver = await bringDriverToSubmittable();
    const admin = await loginTestAdmin(
      `sec-expired-${Date.now()}@yatri.local`,
      'a-strong-test-password-1',
    );

    for (const id of Object.values(driver.documentIds)) {
      await api
        .post(`/api/v1/admin/documents/${id}/approve`)
        .set('Authorization', `Bearer ${admin}`)
        .send({});
    }
    await api
      .post(`/api/v1/admin/vehicles/${driver.vehicleId}/approve`)
      .set('Authorization', `Bearer ${admin}`)
      .send({});

    // Force one required document into the past without going through the
    // API (simulating time passing since approval).
    await pool.query(`UPDATE documents SET expiry_date = '2000-01-01' WHERE id = $1`, [
      driver.documentIds.DRIVING_LICENSE,
    ]);

    const listRes = await api
      .get('/api/v1/documents')
      .set('Authorization', `Bearer ${driver.accessToken}`);
    const license = listRes.body.data.find(
      (d: { documentType: { code: string } }) => d.documentType.code === 'DRIVING_LICENSE',
    );
    expect(license.status).toBe('EXPIRED');

    await api
      .post('/api/v1/drivers/me/submit-verification')
      .set('Authorization', `Bearer ${driver.accessToken}`);
    const verifyRes = await api
      .post(`/api/v1/admin/drivers/${driver.user.id}/verify`)
      .set('Authorization', `Bearer ${admin}`);
    expect(verifyRes.status).toBe(409);
    expect(
      verifyRes.body.error.details.missingRequirements.some((m: string) => /expired/i.test(m)),
    ).toBe(true);
  });

  it('rejects invalid onboarding input (future date of birth, expired licence, garbage phone)', async () => {
    const { accessToken } = await onboardUser('DRIVER');

    const futureDob = await api
      .patch('/api/v1/drivers/me/onboarding')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ dateOfBirth: '2099-01-01' });
    expect(futureDob.status).toBe(400);

    const expiredLicense = await api
      .patch('/api/v1/drivers/me/onboarding')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ licenseExpiryDate: '2000-01-01' });
    expect(expiredLicense.status).toBe(400);

    const badPhone = await api
      .patch('/api/v1/drivers/me/onboarding')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ emergencyContactPhone: 'not-a-phone' });
    expect(badPhone.status).toBe(400);
  });

  it('rejects an invalid vehicle registration number and non-existent category', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    const categoriesRes = await api
      .get('/api/v1/vehicles/categories')
      .set('Authorization', `Bearer ${accessToken}`);
    const categoryId = categoriesRes.body.data[0].id;

    const badReg = await api
      .post('/api/v1/vehicles')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        categoryId,
        make: 'Toyota',
        model: 'Corolla',
        year: 2020,
        color: 'White',
        registrationNumber: '###!!!',
      });
    expect(badReg.status).toBe(400);

    const badCategory = await api
      .post('/api/v1/vehicles')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        categoryId: '00000000-0000-0000-0000-000000000000',
        make: 'Toyota',
        model: 'Corolla',
        year: 2020,
        color: 'White',
        registrationNumber: 'BA-1-PA-1234',
      });
    expect(badCategory.status).toBe(400);
  });
});
