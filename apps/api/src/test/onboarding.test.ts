import { describe, expect, it } from 'vitest';

import {
  api,
  bringDriverToSubmittable,
  completeDriverOnboardingInfo,
  createTestVehicle,
  onboardUser,
  uploadDocument,
  FIXTURES,
} from './helpers';

describe('Driver onboarding', () => {
  it('creates a driver profile at NOT_STARTED with every step incomplete', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    const res = await api
      .get('/api/v1/drivers/me/onboarding')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('NOT_STARTED');
    expect(res.body.data.steps).toEqual({
      personalInfo: false,
      driverInfo: false,
      vehicle: false,
      documents: false,
      submitted: false,
    });
    expect(res.body.data.details).toEqual({
      fullLegalName: null,
      dateOfBirth: null,
      licenseNumber: null,
      licenseExpiryDate: null,
      addressLine1: null,
      addressLine2: null,
      city: null,
      emergencyContactName: null,
      emergencyContactPhone: null,
    });
  });

  it('updates the driver profile and moves to IN_PROGRESS', async () => {
    const { accessToken } = await onboardUser('DRIVER');

    const patchRes = await completeDriverOnboardingInfo(accessToken);
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.status).toBe('IN_PROGRESS');
    expect(patchRes.body.data.steps.personalInfo).toBe(true);
    expect(patchRes.body.data.steps.driverInfo).toBe(true);
  });

  it('saves incomplete onboarding without losing previously saved fields', async () => {
    const { accessToken } = await onboardUser('DRIVER');

    await api
      .patch('/api/v1/drivers/me/onboarding')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fullLegalName: 'Partial Driver', city: 'Pokhara' });

    // A second, unrelated save must not clobber the first save's fields.
    const secondRes = await api
      .patch('/api/v1/drivers/me/onboarding')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ addressLine1: '456 Side Street' });

    expect(secondRes.status).toBe(200);
    // personalInfo needs fullLegalName + dateOfBirth + addressLine1 + city —
    // dateOfBirth is still missing, so the step isn't complete yet, but the
    // earlier fields must still be there once it is.
    await api
      .patch('/api/v1/drivers/me/onboarding')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ dateOfBirth: '1990-05-05' });

    const finalRes = await api
      .get('/api/v1/drivers/me/onboarding')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(finalRes.body.data.steps.personalInfo).toBe(true);
  });

  it('resumes onboarding: progress reflects what was already saved after "leaving and coming back"', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    await completeDriverOnboardingInfo(accessToken);
    await createTestVehicle(accessToken);

    // Simulate resuming later with a fresh GET — no data is re-entered.
    const resumed = await api
      .get('/api/v1/drivers/me/onboarding')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(resumed.status).toBe(200);
    expect(resumed.body.data.steps.personalInfo).toBe(true);
    expect(resumed.body.data.steps.driverInfo).toBe(true);
    expect(resumed.body.data.steps.vehicle).toBe(true);
    expect(resumed.body.data.steps.documents).toBe(false);
    expect(resumed.body.data.status).toBe('IN_PROGRESS');
    // The wizard must be able to prefill from a resumed GET without asking
    // the driver to re-enter anything already saved.
    expect(resumed.body.data.details.fullLegalName).toEqual(expect.any(String));
    expect(resumed.body.data.details.licenseNumber).toEqual(expect.any(String));
  });

  it('rejects submission while onboarding is incomplete', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    await completeDriverOnboardingInfo(accessToken);

    const res = await api
      .post('/api/v1/drivers/me/submit-verification')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ONBOARDING_INCOMPLETE');
    expect(Array.isArray(res.body.error.details.missingRequirements)).toBe(true);
    expect(res.body.error.details.missingRequirements.length).toBeGreaterThan(0);
  });

  it('submits the application once every step is complete', async () => {
    const driver = await bringDriverToSubmittable();

    const res = await api
      .post('/api/v1/drivers/me/submit-verification')
      .set('Authorization', `Bearer ${driver.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('SUBMITTED');
    expect(res.body.data.steps.submitted).toBe(true);

    const statusRes = await api
      .get('/api/v1/drivers/me/verification-status')
      .set('Authorization', `Bearer ${driver.accessToken}`);
    expect(statusRes.body.data.status).toBe('SUBMITTED');
  });

  it('rejects an unknown document type code', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    const res = await uploadDocument(accessToken, 'NOT_A_REAL_TYPE', FIXTURES.jpeg, 'x.jpg');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
