import type { AdminCampaignBody, CampaignInfo } from '@yatri/types';
import { describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { voidStaleReservations } from '../modules/growth/engine';
import { api, loginTestAdmin, onboardUser } from './helpers';
import { PATAN, THAMEL, auth, forceDriverOnline } from './rides';

describe('a promotion held for a ride that did not happen', () => {
  it('is given back by the hourly job even if releasing it failed at the time', async () => {
    const admin = await loginTestAdmin(`recovery-${Date.now()}@example.com`, 'a-strong-test-password-1', ['GROWTH_MANAGE']);
    const rider = await onboardUser('PASSENGER');
    const body: AdminCampaignBody = {
      kind: 'PROMO', name: `Recovery ${Date.now()}`, description: 'x', code: null, startsAt: null, endsAt: null,
      eligibility: { userIds: [rider.user.id as string] }, offer: { type: 'PERCENT_OFF', percent: 10 }, referrerPoints: null,
      stackable: false, limits: { perUser: 1, total: null, validDaysAfterGrant: null }, message: null, reason: 'Testing',
    };
    const created = (await api.post('/api/v1/admin/growth/campaigns').set(auth(admin)).send(body)).body.data as CampaignInfo;
    expect((await api.post(`/api/v1/admin/growth/campaigns/${created.id}/status`).set(auth(admin)).send({ to: 'ACTIVE', version: created.version, reason: 'Go live' })).status).toBe(200);

    const driver = await onboardUser('DRIVER');
    await forceDriverOnline(driver.user.id as string);
    const req = await api.post('/api/v1/trips/request').set(auth(rider.accessToken)).send({ pickup: THAMEL, destination: PATAN, vehicleCategory: 'CAR' });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    const tripId = req.body.data.id as string;
    const held = await pool.query(`SELECT status FROM campaign_redemptions WHERE trip_id = $1`, [tripId]);
    expect(held.rows.map((r) => r.status)).toEqual(['RESERVED']);

    // the ride ends without a release (the release call failed): the rider's one use is still held
    await pool.query(`UPDATE trips SET status = 'CANCELLED', ended_at = now() WHERE id = $1`, [tripId]);
    expect(await voidStaleReservations()).toBeGreaterThanOrEqual(1);
    const after = await pool.query(`SELECT status FROM campaign_redemptions WHERE trip_id = $1`, [tripId]);
    expect(after.rows.map((r) => r.status)).toEqual(['VOID']);
    expect(await voidStaleReservations()).toBe(0); // nothing more to do the second time
  });
});
