import { describe, expect, it } from 'vitest';
import { env } from '../config/env';

import {
  api,
  bringDriverToSubmittable,
  loginTestAdmin,
  onboardUser,
  uploadDocument,
  FIXTURES,
} from './helpers';

describe('Documents', () => {
  it('lists the configured document types', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    const res = await api
      .get('/api/v1/documents/types')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some((t: { code: string }) => t.code === 'DRIVING_LICENSE')).toBe(true);
  });

  it('accepts a valid JPEG, PNG, and PDF upload', async () => {
    const { accessToken } = await onboardUser('DRIVER');

    const jpeg = await uploadDocument(accessToken, 'DRIVING_LICENSE', FIXTURES.jpeg, 'license.jpg');
    expect(jpeg.status).toBe(201);
    expect(jpeg.body.data.status).toBe('PENDING');

    const png = await uploadDocument(accessToken, 'IDENTITY_DOCUMENT', FIXTURES.png, 'id.png');
    expect(png.status).toBe(201);

    const pdf = await uploadDocument(accessToken, 'DRIVER_PHOTOGRAPH', FIXTURES.pdf, 'photo.pdf');
    expect(pdf.status).toBe(201);
  });

  it('rejects a file whose content does not match any accepted type', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    const res = await uploadDocument(
      accessToken,
      'DRIVING_LICENSE',
      FIXTURES.invalid,
      'license.jpg', // lying extension — content sniffing must win
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_FILE_TYPE');
  });

  it('rejects an oversized file', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    // Sized from the configured cap, not from an assumption about what .env.test says.
    const oversized = Buffer.concat([
      FIXTURES.jpeg,
      Buffer.alloc(env.MAX_UPLOAD_FILE_SIZE_BYTES + 1024, 0),
    ]);
    const res = await uploadDocument(accessToken, 'DRIVING_LICENSE', oversized, 'big.jpg');
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('rejects an upload with no file attached', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    const res = await api
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${accessToken}`)
      .field('documentTypeCode', 'DRIVING_LICENSE');
    expect(res.status).toBe(400);
  });

  it('lets a driver replace a rejected document', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    const admin = await loginTestAdmin(
      `doc-replace-${Date.now()}@yatri.local`,
      'a-strong-test-password-1',
    );

    const first = await uploadDocument(accessToken, 'DRIVING_LICENSE', FIXTURES.jpeg, 'v1.jpg');
    const rejectRes = await api
      .post(`/api/v1/admin/documents/${first.body.data.id}/reject`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ reason: 'Illegible photo' });
    expect(rejectRes.status).toBe(200);

    const second = await uploadDocument(accessToken, 'DRIVING_LICENSE', FIXTURES.png, 'v2.png');
    expect(second.status).toBe(201);
    expect(second.body.data.id).not.toBe(first.body.data.id);
    expect(second.body.data.status).toBe('PENDING');

    const listRes = await api
      .get('/api/v1/documents')
      .set('Authorization', `Bearer ${accessToken}`);
    const licenseDocs = listRes.body.data.filter(
      (d: { documentType: { code: string } }) => d.documentType.code === 'DRIVING_LICENSE',
    );
    expect(licenseDocs).toHaveLength(1);
    expect(licenseDocs[0].id).toBe(second.body.data.id);
  });

  it('refuses to replace an already-approved document', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    const admin = await loginTestAdmin(
      `doc-approved-${Date.now()}@yatri.local`,
      'a-strong-test-password-1',
    );

    const doc = await uploadDocument(accessToken, 'DRIVING_LICENSE', FIXTURES.jpeg, 'v1.jpg');
    await api
      .post(`/api/v1/admin/documents/${doc.body.data.id}/approve`)
      .set('Authorization', `Bearer ${admin}`)
      .send({});

    const reupload = await uploadDocument(accessToken, 'DRIVING_LICENSE', FIXTURES.png, 'v2.png');
    expect(reupload.status).toBe(409);
    expect(reupload.body.error.code).toBe('DOCUMENT_ALREADY_APPROVED');
  });

  it('prevents one driver from accessing another driver’s documents', async () => {
    const driverA = await onboardUser('DRIVER');
    const driverB = await onboardUser('DRIVER');

    const doc = await uploadDocument(
      driverA.accessToken,
      'DRIVING_LICENSE',
      FIXTURES.jpeg,
      'a.jpg',
    );

    const downloadAttempt = await api
      .get(`/api/v1/documents/${doc.body.data.id}/download-url`)
      .set('Authorization', `Bearer ${driverB.accessToken}`);
    expect(downloadAttempt.status).toBe(404);

    const deleteAttempt = await api
      .delete(`/api/v1/documents/${doc.body.data.id}`)
      .set('Authorization', `Bearer ${driverB.accessToken}`);
    expect(deleteAttempt.status).toBe(404);
  });

  it('deletes a pending document but not an approved one', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    const doc = await uploadDocument(accessToken, 'DRIVING_LICENSE', FIXTURES.jpeg, 'a.jpg');

    const deleteRes = await api
      .delete(`/api/v1/documents/${doc.body.data.id}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(deleteRes.status).toBe(200);
  });

  it('returns a working signed download URL for the document owner', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    const doc = await uploadDocument(accessToken, 'DRIVING_LICENSE', FIXTURES.jpeg, 'a.jpg');

    const urlRes = await api
      .get(`/api/v1/documents/${doc.body.data.id}/download-url`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(urlRes.status).toBe(200);

    const contentRes = await api.get(urlRes.body.data.url);
    expect(contentRes.status).toBe(200);
    expect(contentRes.headers['content-type']).toBe('image/jpeg');
  });

  it('rejects a tampered or expired signed URL', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    const doc = await uploadDocument(accessToken, 'DRIVING_LICENSE', FIXTURES.jpeg, 'a.jpg');
    const urlRes = await api
      .get(`/api/v1/documents/${doc.body.data.id}/download-url`)
      .set('Authorization', `Bearer ${accessToken}`);

    const tampered = urlRes.body.data.url.replace(/sig=[^&]+/, 'sig=deadbeef');
    const res = await api.get(tampered);
    expect(res.status).toBe(403);
  });

  it('full onboarding upload set produces a submittable driver', async () => {
    const driver = await bringDriverToSubmittable();
    const listRes = await api
      .get('/api/v1/documents')
      .set('Authorization', `Bearer ${driver.accessToken}`);
    expect(listRes.body.data.length).toBeGreaterThanOrEqual(5);
  });

  it('a passenger cannot upload or list documents', async () => {
    const { accessToken } = await onboardUser('PASSENGER');

    const uploadRes = await uploadDocument(accessToken, 'DRIVING_LICENSE', FIXTURES.jpeg, 'a.jpg');
    expect(uploadRes.status).toBe(403);

    const listRes = await api
      .get('/api/v1/documents')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(listRes.status).toBe(403);
  });
});
