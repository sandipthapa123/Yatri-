import { describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import {
  api,
  approveEverythingAsAdmin,
  bringDriverToSubmittable,
  loginTestAdmin,
  uploadDocument,
  FIXTURES,
} from './helpers';

async function submit(accessToken: string) {
  return api
    .post('/api/v1/drivers/me/submit-verification')
    .set('Authorization', `Bearer ${accessToken}`);
}

describe('Driver verification workflow', () => {
  it('admin can approve an individual document', async () => {
    const driver = await bringDriverToSubmittable();
    const admin = await loginTestAdmin(
      `v-doc-approve-${Date.now()}@yatri.local`,
      'a-strong-test-password-1',
    );

    const documentId = driver.documentIds.DRIVING_LICENSE!;
    const res = await api
      .post(`/api/v1/admin/documents/${documentId}/approve`)
      .set('Authorization', `Bearer ${admin}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('APPROVED');
  });

  it('admin rejecting a document requires a reason', async () => {
    const driver = await bringDriverToSubmittable();
    const admin = await loginTestAdmin(
      `v-doc-reject-${Date.now()}@yatri.local`,
      'a-strong-test-password-1',
    );

    const documentId = driver.documentIds.IDENTITY_DOCUMENT!;
    const noReason = await api
      .post(`/api/v1/admin/documents/${documentId}/reject`)
      .set('Authorization', `Bearer ${admin}`)
      .send({});
    expect(noReason.status).toBe(400);

    const withReason = await api
      .post(`/api/v1/admin/documents/${documentId}/reject`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ reason: 'Photo is blurry and unreadable' });
    expect(withReason.status).toBe(200);
    expect(withReason.body.data.status).toBe('REJECTED');
    expect(withReason.body.data.rejectionReason).toBe('Photo is blurry and unreadable');
  });

  it('an ineligible driver cannot be approved even after submitting', async () => {
    const driver = await bringDriverToSubmittable();
    const admin = await loginTestAdmin(
      `v-ineligible-${Date.now()}@yatri.local`,
      'a-strong-test-password-1',
    );
    await submit(driver.accessToken);

    // Documents were uploaded but never approved — still PENDING.
    const res = await api
      .post(`/api/v1/admin/drivers/${driver.user.id}/verify`)
      .set('Authorization', `Bearer ${admin}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_ELIGIBLE');
    expect(res.body.error.details.missingRequirements.length).toBeGreaterThan(0);
  });

  it('approves a fully eligible driver end to end', async () => {
    const driver = await bringDriverToSubmittable();
    const admin = await loginTestAdmin(
      `v-approve-${Date.now()}@yatri.local`,
      'a-strong-test-password-1',
    );

    await submit(driver.accessToken);
    await approveEverythingAsAdmin(admin, driver);

    const verifyRes = await api
      .post(`/api/v1/admin/drivers/${driver.user.id}/verify`)
      .set('Authorization', `Bearer ${admin}`);
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.data.status).toBe('VERIFIED');

    const statusRes = await api
      .get('/api/v1/drivers/me/verification-status')
      .set('Authorization', `Bearer ${driver.accessToken}`);
    expect(statusRes.body.data.status).toBe('VERIFIED');
  });

  it('rejects a driver application with a visible reason, then allows resubmission', async () => {
    const driver = await bringDriverToSubmittable();
    const admin = await loginTestAdmin(
      `v-reject-resubmit-${Date.now()}@yatri.local`,
      'a-strong-test-password-1',
    );
    await submit(driver.accessToken);

    const rejectRes = await api
      .post(`/api/v1/admin/drivers/${driver.user.id}/reject`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ reason: 'Licence document does not match name on file' });
    expect(rejectRes.status).toBe(200);

    const statusRes = await api
      .get('/api/v1/drivers/me/verification-status')
      .set('Authorization', `Bearer ${driver.accessToken}`);
    expect(statusRes.body.data.status).toBe('REJECTED');
    expect(statusRes.body.data.rejectionReason).toBe(
      'Licence document does not match name on file',
    );

    // Driver corrects the flagged document and resubmits.
    await uploadDocument(driver.accessToken, 'DRIVING_LICENSE', FIXTURES.png, 'corrected.png');
    const resubmitRes = await submit(driver.accessToken);
    expect(resubmitRes.status).toBe(200);
    expect(resubmitRes.body.data.status).toBe('SUBMITTED');
  });

  it('rejecting or approving requires the driver to actually be under review', async () => {
    const driver = await bringDriverToSubmittable();
    const admin = await loginTestAdmin(
      `v-invalid-transition-${Date.now()}@yatri.local`,
      'a-strong-test-password-1',
    );

    // Never submitted — still IN_PROGRESS.
    const res = await api
      .post(`/api/v1/admin/drivers/${driver.user.id}/reject`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ reason: 'test reason' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('a suspended driver cannot become verified', async () => {
    const driver = await bringDriverToSubmittable();
    const admin = await loginTestAdmin(
      `v-suspend-${Date.now()}@yatri.local`,
      'a-strong-test-password-1',
    );

    await submit(driver.accessToken);
    await approveEverythingAsAdmin(admin, driver);
    await api
      .post(`/api/v1/admin/drivers/${driver.user.id}/verify`)
      .set('Authorization', `Bearer ${admin}`);

    const suspendRes = await api
      .post(`/api/v1/admin/drivers/${driver.user.id}/suspend`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ reason: 'Multiple passenger complaints' });
    expect(suspendRes.status).toBe(200);
    expect(suspendRes.body.data.status).toBe('SUSPENDED');

    // Even though every requirement is still APPROVED, a suspended driver
    // is not a valid state-transition source for "verify".
    const reverifyRes = await api
      .post(`/api/v1/admin/drivers/${driver.user.id}/verify`)
      .set('Authorization', `Bearer ${admin}`);
    expect(reverifyRes.status).toBe(409);

    const statusRes = await api
      .get('/api/v1/drivers/me/verification-status')
      .set('Authorization', `Bearer ${driver.accessToken}`);
    expect(statusRes.body.data.status).toBe('SUSPENDED');
  });

  it('only a verified driver can be suspended', async () => {
    const driver = await bringDriverToSubmittable();
    const admin = await loginTestAdmin(
      `v-suspend-unverified-${Date.now()}@yatri.local`,
      'a-strong-test-password-1',
    );
    await submit(driver.accessToken);

    const res = await api
      .post(`/api/v1/admin/drivers/${driver.user.id}/suspend`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ reason: 'test reason' });
    expect(res.status).toBe(409);
  });

  it('records verification history for every action', async () => {
    const driver = await bringDriverToSubmittable();
    const admin = await loginTestAdmin(
      `v-history-${Date.now()}@yatri.local`,
      'a-strong-test-password-1',
    );

    await submit(driver.accessToken);
    await approveEverythingAsAdmin(admin, driver);
    await api
      .post(`/api/v1/admin/drivers/${driver.user.id}/verify`)
      .set('Authorization', `Bearer ${admin}`);

    const historyRes = await api
      .get(`/api/v1/admin/drivers/${driver.user.id}/verification-history`)
      .set('Authorization', `Bearer ${admin}`);

    expect(historyRes.status).toBe(200);
    const actions = historyRes.body.data.map((e: { action: string }) => e.action);
    expect(actions).toContain('SUBMITTED');
    expect(actions).toContain('DRIVER_APPROVED');
    expect(actions).toContain('DOCUMENT_APPROVED');
    expect(actions).toContain('VEHICLE_APPROVED');

    // This test never opened GET /admin/drivers/:id, so the driver never
    // auto-transitioned SUBMITTED -> UNDER_REVIEW before being approved
    // (see the dedicated test for that transition below).
    const approvedEvent = historyRes.body.data.find(
      (e: { action: string }) => e.action === 'DRIVER_APPROVED',
    );
    expect(approvedEvent.previousStatus).toBe('SUBMITTED');
    expect(approvedEvent.newStatus).toBe('VERIFIED');
  });

  it('opening a submitted application transitions it to UNDER_REVIEW', async () => {
    const driver = await bringDriverToSubmittable();
    const admin = await loginTestAdmin(
      `v-under-review-${Date.now()}@yatri.local`,
      'a-strong-test-password-1',
    );
    await submit(driver.accessToken);

    const before = await pool.query<{ status: string }>(
      `SELECT status FROM driver_profiles WHERE user_id = $1`,
      [driver.user.id],
    );
    expect(before.rows[0]?.status).toBe('SUBMITTED');

    await api
      .get(`/api/v1/admin/drivers/${driver.user.id}`)
      .set('Authorization', `Bearer ${admin}`);

    const after = await pool.query<{ status: string }>(
      `SELECT status FROM driver_profiles WHERE user_id = $1`,
      [driver.user.id],
    );
    expect(after.rows[0]?.status).toBe('UNDER_REVIEW');
  });
});
