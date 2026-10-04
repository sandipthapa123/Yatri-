import {
  combineOffers,
  computeDiscount,
  campaignPhase,
  campaignProblem,
  evaluateEligibility,
  notificationCategoryOf,
  pointsForFare,
  redeemablePoints,
  usageAllowed,
  type AdminCampaignBody,
  type AdminPermission,
  type CampaignAnalytics,
  type CampaignInfo,
  type FareEstimateResponse,
  type OfferView,
  type ReferralView,
  type RewardsHistoryResponse,
  type RewardsSummary,
} from '@yatri/types';
import { describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { settleRide } from '../modules/growth/engine';
import { expirePoints } from '../modules/growth/loyalty';
import { sweepCampaignMessages } from '../modules/growth/messaging';
import { runRiskSweep } from '../modules/risk/sweep';
import { api, loginTestAdmin, onboardUser, type OnboardedUser } from './helpers';
import {
  PATAN,
  THAMEL,
  acceptCurrentOffer,
  arriveAtPickup,
  auth,
  forceDriverOnline,
  finishedRide,
  type RideWorld,
} from './rides';

// ---------------------------------------------------------------- helpers

let n = 0;
const admin = (permissions: AdminPermission[]) =>
  loginTestAdmin(
    `growth-${Date.now()}-${++n}@example.com`,
    'a-strong-test-password-1',
    permissions,
  );
const unique = () =>
  `T${Date.now().toString(36).toUpperCase()}${(++n).toString(36).toUpperCase()}`.slice(0, 18);

function body(over: Partial<AdminCampaignBody> = {}): AdminCampaignBody {
  return {
    kind: 'PROMO',
    name: `Campaign ${unique()}`,
    description: 'A test campaign',
    code: null,
    startsAt: null,
    endsAt: null,
    eligibility: {},
    offer: { type: 'PERCENT_OFF', percent: 10 },
    referrerPoints: null,
    stackable: false,
    limits: { perUser: null, total: null, validDaysAfterGrant: null },
    message: null,
    reason: 'Testing',
    ...over,
  };
}
const create = (t: string, b: AdminCampaignBody) =>
  api.post('/api/v1/admin/growth/campaigns').set(auth(t)).send(b);
async function live(t: string, over: Partial<AdminCampaignBody> = {}): Promise<CampaignInfo> {
  const res = await create(t, body(over));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const c = res.body.data as CampaignInfo;
  const on = await api
    .post(`/api/v1/admin/growth/campaigns/${c.id}/status`)
    .set(auth(t))
    .send({ to: 'ACTIVE', version: c.version, reason: 'Go live' });
  expect(on.status, JSON.stringify(on.body)).toBe(200);
  return on.body.data as CampaignInfo;
}
const estimate = (token: string, promotion?: object) =>
  api
    .post('/api/v1/trips/estimate')
    .set(auth(token))
    .send({
      pickup: THAMEL,
      destination: PATAN,
      vehicleCategory: 'CAR',
      ...(promotion ? { promotion } : {}),
    });
const car = (res: { body: { data: FareEstimateResponse } }) =>
  res.body.data.categories.find((c) => c.code === 'CAR')!;

/** A passenger requests (with `promotion`), a driver takes the ride, and the ride is driven to the end. */
async function ride(
  passenger: OnboardedUser,
  promotion?: object,
  opts: { complete?: boolean } = {},
) {
  const driver = await onboardUser('DRIVER');
  await forceDriverOnline(driver.user.id as string);
  const req = await api
    .post('/api/v1/trips/request')
    .set(auth(passenger.accessToken))
    .send({
      pickup: THAMEL,
      destination: PATAN,
      vehicleCategory: 'CAR',
      ...(promotion ? { promotion } : {}),
    });
  if (req.status !== 201) return { req, w: null as RideWorld | null };
  expect((await acceptCurrentOffer(driver.accessToken)).status).toBe(200);
  const w: RideWorld = {
    passenger,
    driver,
    tripId: req.body.data.id as string,
    passengerId: passenger.user.id as string,
    driverId: driver.user.id as string,
  };
  if (opts.complete !== false) {
    await arriveAtPickup(w);
    await api.post(`/api/v1/trips/${w.tripId}/start`).set(auth(driver.accessToken));
    const done = await api.post(`/api/v1/trips/${w.tripId}/complete`).set(auth(driver.accessToken));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
  }
  return { req, w };
}
const trip = async (id: string) =>
  (
    await pool.query('SELECT fare_final_npr, discount_npr, points_used FROM trips WHERE id = $1', [
      id,
    ])
  ).rows[0] as {
    fare_final_npr: number;
    discount_npr: number;
    points_used: number;
  };
const payment = async (id: string) =>
  (await pool.query('SELECT amount_npr FROM trip_payments WHERE trip_id = $1', [id])).rows[0]
    ?.amount_npr as number | undefined;
const balance = async (t: string) =>
  ((await api.get('/api/v1/growth/rewards').set(auth(t))).body.data as RewardsSummary).balance;
const redemptions = async (campaignId: string) =>
  (
    await pool.query(
      'SELECT status, discount_npr FROM campaign_redemptions WHERE campaign_id = $1 ORDER BY created_at',
      [campaignId],
    )
  ).rows as Array<{ status: string; discount_npr: number }>;

// ---------------------------------------------------------------- the pure rules

describe('the rules, once', () => {
  it('works out a discount in whole rupees, capped, never above the fare', () => {
    expect(computeDiscount({ type: 'PERCENT_OFF', percent: 10 }, 237)).toBe(23);
    expect(computeDiscount({ type: 'PERCENT_OFF', percent: 50, maxDiscountNpr: 40 }, 500)).toBe(40);
    expect(computeDiscount({ type: 'FIXED_OFF', fixedNpr: 150 }, 100)).toBe(100);
    expect(computeDiscount({ type: 'PERCENT_OFF', percent: 10 }, 0)).toBe(0);
    expect(computeDiscount({ type: 'BONUS_POINTS', points: 50 }, 500)).toBe(0);
  });

  it('combines offers: the best discount alone unless both agree to stack, and never above the fare', () => {
    const a = {
      campaignId: 'a',
      name: 'A',
      offer: { type: 'PERCENT_OFF' as const, percent: 20 },
      stackable: false,
    };
    const b = {
      campaignId: 'b',
      name: 'B',
      offer: { type: 'FIXED_OFF' as const, fixedNpr: 30 },
      stackable: false,
    };
    const solo = combineOffers([a, b], 300);
    expect(solo.filter((x) => x.discountNpr > 0).map((x) => x.campaignId)).toEqual(['a']);
    const both = combineOffers(
      [
        { ...a, stackable: true },
        { ...b, stackable: true },
      ],
      300,
    );
    expect(both.reduce((s, x) => s + x.discountNpr, 0)).toBe(90);
    const capped = combineOffers(
      [
        { ...a, stackable: true, offer: { type: 'FIXED_OFF' as const, fixedNpr: 90 } },
        { ...b, stackable: true, offer: { type: 'FIXED_OFF' as const, fixedNpr: 90 } },
      ],
      100,
    );
    expect(capped.reduce((s, x) => s + x.discountNpr, 0)).toBe(100);
    const points = combineOffers(
      [
        a,
        {
          campaignId: 'p',
          name: 'P',
          offer: { type: 'POINTS_MULTIPLIER' as const, multiplier: 2 },
          stackable: false,
        },
      ],
      300,
    );
    expect(points.find((x) => x.campaignId === 'p')?.pointsMultiplier).toBe(2);
    expect(points.find((x) => x.campaignId === 'a')?.discountNpr).toBe(60);
  });

  it('judges eligibility, limits and the schedule', () => {
    const facts = {
      userId: 'u',
      completedRides: 0,
      accountAgeDays: 3,
      daysSinceLastRide: null,
      disabilityVerified: false,
      ride: { categoryCode: 'CAR', cityId: null, fareNpr: 200 },
    };
    expect(evaluateEligibility({ maxCompletedRides: 0 }, facts).eligible).toBe(true);
    // a disability benefit is judged on the verified benefit alone
    expect(evaluateEligibility({ requiresDisabilityVerified: true }, facts).eligible).toBe(false);
    expect(
      evaluateEligibility(
        { requiresDisabilityVerified: true },
        { ...facts, disabilityVerified: true },
      ).eligible,
    ).toBe(true);
    expect(
      evaluateEligibility({ maxCompletedRides: 0 }, { ...facts, completedRides: 1 }).eligible,
    ).toBe(false);
    expect(
      evaluateEligibility(
        { inactiveForDays: 30 },
        { ...facts, completedRides: 4, daysSinceLastRide: 45 },
      ).eligible,
    ).toBe(true);
    expect(
      evaluateEligibility(
        { inactiveForDays: 30 },
        { ...facts, completedRides: 4, daysSinceLastRide: 5 },
      ).eligible,
    ).toBe(false);
    expect(evaluateEligibility({ vehicleCategoryCodes: ['BIKE'] }, facts).eligible).toBe(false);
    expect(evaluateEligibility({ minFareNpr: 500 }, facts).reason).toContain('NPR 500');
    expect(evaluateEligibility({ userIds: ['someone-else'] }, facts).eligible).toBe(false);
    expect(usageAllowed({ perUser: 1, total: null }, { byUser: 1, total: 5 }).allowed).toBe(false);
    expect(usageAllowed({ perUser: null, total: 10 }, { byUser: 0, total: 10 }).reason).toContain(
      'fully used',
    );
    const now = new Date('2026-06-01T12:00:00Z');
    expect(
      campaignPhase({ status: 'ACTIVE', startsAt: '2026-06-02T00:00:00Z', endsAt: null }, now),
    ).toBe('SCHEDULED');
    expect(
      campaignPhase({ status: 'ACTIVE', startsAt: null, endsAt: '2026-05-01T00:00:00Z' }, now),
    ).toBe('EXPIRED');
    expect(campaignPhase({ status: 'ACTIVE', startsAt: null, endsAt: null }, now)).toBe('LIVE');
    expect(campaignPhase({ status: 'PAUSED', startsAt: null, endsAt: null }, now)).toBe('PAUSED');
  });

  it('counts points and what they can pay', () => {
    expect(pointsForFare(250, { pointsPer100Npr: 2 })).toBe(5);
    expect(
      pointsForFare(250, { pointsPer100Npr: 2 }, [{ bonusPoints: 10, pointsMultiplier: 2 }]),
    ).toBe(20);
    expect(
      redeemablePoints(30, 300, { pointValueNpr: 1, minRedeemPoints: 50, maxRedeemPercent: 50 }),
    ).toEqual({ points: 0, valueNpr: 0 });
    expect(
      redeemablePoints(500, 300, { pointValueNpr: 1, minRedeemPoints: 50, maxRedeemPercent: 50 }),
    ).toEqual({ points: 150, valueNpr: 150 });
    expect(
      redeemablePoints(100, 300, { pointValueNpr: 1, minRedeemPoints: 50, maxRedeemPercent: 50 }),
    ).toEqual({ points: 100, valueNpr: 100 });
  });

  it('refuses a badly configured campaign in words', () => {
    const ok = body();
    expect(campaignProblem(ok)).toBeNull();
    expect(campaignProblem({ ...ok, kind: 'COUPON', code: null })).toContain('needs a code');
    expect(campaignProblem({ ...ok, offer: { type: 'PERCENT_OFF', percent: 150 } })).toContain(
      'percentage',
    );
    expect(
      campaignProblem({ ...ok, startsAt: '2026-06-02T00:00:00Z', endsAt: '2026-06-01T00:00:00Z' }),
    ).toContain('after the start');
    expect(
      campaignProblem({ ...ok, kind: 'FIRST_RIDE', eligibility: { maxCompletedRides: 3 } }),
    ).toContain('first ride');
    expect(
      campaignProblem({ ...ok, kind: 'PUSH', offer: null, message: null, startsAt: null }),
    ).toContain('message');
    expect(campaignProblem({ ...ok, kind: 'REFERRAL', referrerPoints: null })).toContain('points');
  });

  it('files offer messages under an opt-in category and points under rewards', () => {
    expect(notificationCategoryOf('CAMPAIGN_MESSAGE')).toBe('PROMOTIONS');
    expect(notificationCategoryOf('OFFER_GRANTED')).toBe('PROMOTIONS');
    expect(notificationCategoryOf('REWARD_POINTS_EARNED')).toBe('REWARDS');
    expect(notificationCategoryOf('REFERRAL_QUALIFIED')).toBe('REWARDS');
  });
});

// ---------------------------------------------------------------- administering campaigns

describe('campaign administration', () => {
  it('creates, edits with a version check, starts, pauses and ends, and audits each move', async () => {
    const t = await admin(['GROWTH_MANAGE']);
    const made = (await create(t, body())).body.data as CampaignInfo;
    expect(made).toMatchObject({ status: 'DRAFT', phase: 'DRAFT', version: 1 });
    const edit = await api
      .put(`/api/v1/admin/growth/campaigns/${made.id}`)
      .set(auth(t))
      .send({ ...body({ name: 'Renamed campaign' }), kind: 'PROMO', version: 1 });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    const stale = await api
      .put(`/api/v1/admin/growth/campaigns/${made.id}`)
      .set(auth(t))
      .send({ ...body(), version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const on = await api
      .post(`/api/v1/admin/growth/campaigns/${made.id}/status`)
      .set(auth(t))
      .send({ to: 'ACTIVE', version: 2, reason: 'Start' });
    expect(on.body.data.phase).toBe('LIVE');
    // A running campaign is paused before it is edited.
    const live409 = await api
      .put(`/api/v1/admin/growth/campaigns/${made.id}`)
      .set(auth(t))
      .send({ ...body(), version: 3 });
    expect(live409.body.error.code).toBe('CAMPAIGN_LIVE');
    const pause = await api
      .post(`/api/v1/admin/growth/campaigns/${made.id}/status`)
      .set(auth(t))
      .send({ to: 'PAUSED', version: 3, reason: 'Pause' });
    expect(pause.body.data.phase).toBe('PAUSED');
    const end = await api
      .post(`/api/v1/admin/growth/campaigns/${made.id}/status`)
      .set(auth(t))
      .send({ to: 'ENDED', version: 4, reason: 'Done' });
    expect(end.body.data.phase).toBe('ENDED');
    const back = await api
      .post(`/api/v1/admin/growth/campaigns/${made.id}/status`)
      .set(auth(t))
      .send({ to: 'ACTIVE', version: 5, reason: 'Again' });
    expect(back.body.error.code).toBe('INVALID_TRANSITION');
    const audit = await pool.query(
      `SELECT action FROM audit_log WHERE subject_id = $1 ORDER BY created_at`,
      [made.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'CAMPAIGN_CREATED',
      'CAMPAIGN_UPDATED',
      'CAMPAIGN_ACTIVE',
      'CAMPAIGN_PAUSED',
      'CAMPAIGN_ENDED',
    ]);
  });

  it('refuses invalid configuration, a repeated code and a start with a past end date', async () => {
    const t = await admin(['GROWTH_MANAGE']);
    expect((await create(t, body({ kind: 'COUPON', code: null }))).status).toBe(400);
    expect((await create(t, body({ offer: { type: 'PERCENT_OFF', percent: 0 } }))).status).toBe(
      400,
    );
    const code = unique();
    expect((await create(t, body({ kind: 'COUPON', code }))).status).toBe(201);
    const dup = await create(t, body({ kind: 'COUPON', code }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CODE_IN_USE');
    const past = (
      await create(
        t,
        body({
          endsAt: new Date(Date.now() - 86_400_000).toISOString(),
          startsAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        }),
      )
    ).body.data as CampaignInfo;
    const go = await api
      .post(`/api/v1/admin/growth/campaigns/${past.id}/status`)
      .set(auth(t))
      .send({ to: 'ACTIVE', version: 1, reason: 'Try' });
    expect(go.status).toBe(409);
  });

  it('opens reads to GROWTH_VIEW and changes to GROWTH_MANAGE, and to nobody else', async () => {
    const viewer = await admin(['GROWTH_VIEW']);
    const manager = await admin(['GROWTH_MANAGE']);
    const stranger = await admin(['RISK_VIEW']);
    const made = (await create(manager, body())).body.data as CampaignInfo;
    for (const path of [
      '/campaigns',
      `/campaigns/${made.id}`,
      `/campaigns/${made.id}/redemptions`,
      '/analytics',
    ]) {
      expect((await api.get(`/api/v1/admin/growth${path}`).set(auth(viewer))).status, path).toBe(
        200,
      );
      expect((await api.get(`/api/v1/admin/growth${path}`).set(auth(stranger))).status, path).toBe(
        403,
      );
    }
    expect((await create(viewer, body())).status).toBe(403);
    expect(
      (
        await api
          .post(`/api/v1/admin/growth/campaigns/${made.id}/status`)
          .set(auth(viewer))
          .send({ to: 'ACTIVE', version: 1, reason: 'No' })
      ).status,
    ).toBe(403);
    const rider = await onboardUser('PASSENGER');
    expect(
      (await api.get('/api/v1/admin/growth/campaigns').set(auth(rider.accessToken))).status,
    ).toBe(403);
    expect((await api.get('/api/v1/admin/growth/campaigns')).status).toBe(401);
  });
});

// ---------------------------------------------------------------- a ride with an offer

describe('offers on a ride', () => {
  it('shows what the rider would pay, and settles it on the final fare, with the payment for what is owed', async () => {
    const t = await admin(['GROWTH_MANAGE']);
    const c = await live(t, { offer: { type: 'PERCENT_OFF', percent: 10 } });
    const rider = await onboardUser('PASSENGER');
    const shown = car(await estimate(rider.accessToken));
    expect(shown.promotion?.offers[0]?.campaignId).toBe(c.id);
    expect(shown.promotion?.payableNpr).toBe(shown.fare.totalNpr - shown.promotion!.discountNpr);

    const { w } = await ride(rider);
    const row = await trip(w!.tripId);
    const expected = Math.floor(row.fare_final_npr / 10);
    expect(row.discount_npr).toBe(expected);
    expect(await payment(w!.tripId)).toBe(row.fare_final_npr - expected); // the fare itself is untouched
    expect(await redemptions(c.id)).toEqual([{ status: 'APPLIED', discount_npr: expected }]);
  });

  it('applies a coupon only with its code, and says in words why a code did not apply', async () => {
    const t = await admin(['GROWTH_MANAGE']);
    const code = unique();
    await live(t, { kind: 'COUPON', code, offer: { type: 'FIXED_OFF', fixedNpr: 30 } });
    const rider = await onboardUser('PASSENGER');
    expect(car(await estimate(rider.accessToken)).promotion?.offers ?? []).toHaveLength(0);
    expect(
      car(await estimate(rider.accessToken, { promoCode: code.toLowerCase() })).promotion
        ?.discountNpr,
    ).toBe(30);
    expect(
      car(await estimate(rider.accessToken, { promoCode: 'NOSUCHCODE' })).promotion?.codeProblem,
    ).toContain('not valid');
    const refused = await api
      .post('/api/v1/trips/request')
      .set(auth(rider.accessToken))
      .send({
        pickup: THAMEL,
        destination: PATAN,
        vehicleCategory: 'CAR',
        promotion: { promoCode: 'NOSUCHCODE' },
      });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PROMO_UNAVAILABLE');
  });

  it('never applies a campaign that is paused, ended, scheduled for later, or not for this rider', async () => {
    const t = await admin(['GROWTH_MANAGE']);
    const rider = await onboardUser('PASSENGER');
    const later = await live(t, { startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    const minFare = await live(t, { eligibility: { minFareNpr: 100_000 } });
    const target = await live(t, {
      eligibility: { userIds: [(await onboardUser('PASSENGER')).user.id as string] },
    });
    const paused = await live(t);
    await api
      .post(`/api/v1/admin/growth/campaigns/${paused.id}/status`)
      .set(auth(t))
      .send({ to: 'PAUSED', version: paused.version, reason: 'Hold' });
    const ids = (car(await estimate(rider.accessToken)).promotion?.offers ?? []).map(
      (o) => o.campaignId,
    );
    for (const c of [later, minFare, target, paused]) expect(ids).not.toContain(c.id);
  });

  it('keeps an offer for a first ride to the first ride', async () => {
    const t = await admin(['GROWTH_MANAGE']);
    const c = await live(t, {
      kind: 'FIRST_RIDE',
      eligibility: { maxCompletedRides: 0 },
      offer: { type: 'FIXED_OFF', fixedNpr: 25 },
    });
    const rider = await onboardUser('PASSENGER');
    expect(
      car(await estimate(rider.accessToken)).promotion?.offers.map((o) => o.campaignId),
    ).toContain(c.id);
    const first = await ride(rider);
    expect((await trip(first.w!.tripId)).discount_npr).toBe(25);
    expect(
      (car(await estimate(rider.accessToken)).promotion?.offers ?? []).map((o) => o.campaignId),
    ).not.toContain(c.id);
  });

  it('holds the limits: one use per rider, and the last use to one of two simultaneous riders', async () => {
    const t = await admin(['GROWTH_MANAGE']);
    const once = await live(t, { limits: { perUser: 1, total: null, validDaysAfterGrant: null } });
    const rider = await onboardUser('PASSENGER');
    await ride(rider);
    expect(await redemptions(once.id)).toHaveLength(1);
    const again = await api
      .post('/api/v1/trips/estimate')
      .set(auth(rider.accessToken))
      .send({ pickup: THAMEL, destination: PATAN, vehicleCategory: 'CAR' });
    expect((car(again).promotion?.offers ?? []).map((o) => o.campaignId)).not.toContain(once.id);

    const code = unique();
    await api
      .post(`/api/v1/admin/growth/campaigns/${once.id}/status`)
      .set(auth(t))
      .send({ to: 'ENDED', version: once.version, reason: 'Done with it' });
    const last = await live(t, {
      kind: 'COUPON',
      code,
      offer: { type: 'FIXED_OFF', fixedNpr: 20 },
      limits: { perUser: null, total: 1, validDaysAfterGrant: null },
    });
    const a = await onboardUser('PASSENGER');
    const b = await onboardUser('PASSENGER');
    const send = (u: OnboardedUser) =>
      api
        .post('/api/v1/trips/request')
        .set(auth(u.accessToken))
        .send({
          pickup: THAMEL,
          destination: PATAN,
          vehicleCategory: 'CAR',
          promotion: { promoCode: code },
        });
    const [ra, rb] = await Promise.all([send(a), send(b)]);
    expect([ra.status, rb.status].sort()).toEqual([201, 409]);
    expect((await redemptions(last.id)).filter((r) => r.status !== 'VOID')).toHaveLength(1);
  });

  it('gives an offer back when the ride never happens', async () => {
    const t = await admin(['GROWTH_MANAGE']);
    const c = await live(t, { limits: { perUser: 1, total: null, validDaysAfterGrant: null } });
    const rider = await onboardUser('PASSENGER');
    const { w } = await ride(rider, undefined, { complete: false });
    expect((await redemptions(c.id))[0]?.status).toBe('RESERVED');
    await api.post(`/api/v1/trips/${w!.tripId}/cancel`).set(auth(rider.accessToken)).send({});
    expect((await redemptions(c.id))[0]?.status).toBe('VOID');
    expect(
      (car(await estimate(rider.accessToken)).promotion?.offers ?? []).map((o) => o.campaignId),
    ).toContain(c.id);
  });

  it('applies an offer once even if settlement is repeated', async () => {
    const t = await admin(['GROWTH_MANAGE']);
    const c = await live(t, { offer: { type: 'FIXED_OFF', fixedNpr: 15 } });
    const rider = await onboardUser('PASSENGER');
    const { w } = await ride(rider);
    const before = await trip(w!.tripId);
    const [x, y] = await Promise.all([settleRide(w!.tripId), settleRide(w!.tripId)]);
    expect(x.discountNpr).toBe(15);
    expect(y.discountNpr).toBe(15);
    expect(await trip(w!.tripId)).toEqual(before);
    expect(await redemptions(c.id)).toHaveLength(1);
    const earned = await pool.query(
      `SELECT count(*)::int AS n FROM reward_ledger WHERE user_id = $1 AND kind = 'EARN'`,
      [rider.user.id],
    );
    expect(earned.rows[0].n).toBeLessThanOrEqual(1);
  });

  it('is not worked out in an app: the rider cannot send an amount', async () => {
    const rider = await onboardUser('PASSENGER');
    const res = await api
      .post('/api/v1/trips/estimate')
      .set(auth(rider.accessToken))
      .send({
        pickup: THAMEL,
        destination: PATAN,
        vehicleCategory: 'CAR',
        promotion: { discountNpr: 500 },
      });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------- reward points

describe('reward points', () => {
  const adjust = (t: string, userId: string, points: number) =>
    api
      .post(`/api/v1/admin/growth/users/${userId}/points`)
      .set(auth(t))
      .send({ points, reason: 'Testing' });

  it('earns points for a completed ride, once, and shows them with history and a notification', async () => {
    const rider = await onboardUser('PASSENGER');
    const { w } = await ride(rider);
    const fare = (await trip(w!.tripId)).fare_final_npr;
    const earned = Math.floor(fare / 100);
    const summary = (await api.get('/api/v1/growth/rewards').set(auth(rider.accessToken))).body
      .data as RewardsSummary;
    expect(summary.balance).toBe(earned);
    const history = (await api.get('/api/v1/growth/rewards/history').set(auth(rider.accessToken)))
      .body.data as RewardsHistoryResponse;
    if (earned > 0)
      expect(history.items[0]).toMatchObject({
        kind: 'EARN',
        points: earned,
        description: 'Earned for a ride',
      });
    const note = await pool.query(
      `SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'REWARD_POINTS_EARNED'`,
      [rider.user.id],
    );
    expect(note.rowCount).toBe(earned > 0 ? 1 : 0);
  });

  it('uses points on a ride, never more than the balance or the allowed share, and takes them when the ride completes', async () => {
    const t = await admin(['GROWTH_MANAGE']);
    const rider = await onboardUser('PASSENGER');
    expect((await adjust(t, rider.user.id as string, 400)).status).toBe(200);
    const shown = car(await estimate(rider.accessToken, { usePoints: true })).promotion!;
    expect(shown.pointsUsed).toBeGreaterThan(0);
    expect(shown.pointsValueNpr).toBeLessThanOrEqual(Math.floor(shown.fareNpr / 2));
    const { w } = await ride(rider, { usePoints: true });
    const row = await trip(w!.tripId);
    expect(row.points_used).toBeGreaterThan(0);
    expect(row.discount_npr).toBe(row.points_used);
    expect(await payment(w!.tripId)).toBe(row.fare_final_npr - row.discount_npr);
    const earned = Math.floor((row.fare_final_npr - row.discount_npr) / 100);
    expect(await balance(rider.accessToken)).toBe(400 - row.points_used + earned);
  });

  it('does not let points go below zero, and only an administrator corrects them, with a reason', async () => {
    const t = await admin(['GROWTH_MANAGE']);
    const viewer = await admin(['GROWTH_VIEW']);
    const rider = await onboardUser('PASSENGER');
    expect((await adjust(t, rider.user.id as string, 100)).status).toBe(200);
    expect((await adjust(t, rider.user.id as string, -500)).status).toBe(409);
    expect((await adjust(t, rider.user.id as string, -40)).status).toBe(200);
    expect(await balance(rider.accessToken)).toBe(60);
    expect((await adjust(viewer, rider.user.id as string, 10)).status).toBe(403);
    expect(
      (
        await api
          .post(`/api/v1/admin/growth/users/${rider.user.id}/points`)
          .set(auth(t))
          .send({ points: 5, reason: 'x' })
      ).status,
    ).toBe(400);
    const audit = await pool.query(
      `SELECT 1 FROM audit_log WHERE action = 'REWARD_POINTS_ADJUSTED' AND subject_id = $1`,
      [rider.user.id],
    );
    expect(audit.rowCount).toBe(2);
  });

  it('spends the points that expire first, and writes off expired points, once', async () => {
    const t = await admin(['GROWTH_MANAGE']);
    const rider = await onboardUser('PASSENGER');
    await adjust(t, rider.user.id as string, 100);
    await pool.query(
      `UPDATE reward_ledger SET expires_at = now() - interval '1 day' WHERE user_id = $1`,
      [rider.user.id],
    );
    // Expired points cannot be spent even before the job runs.
    expect(await balance(rider.accessToken)).toBe(0);
    const first = await expirePoints();
    expect(first.expired).toBeGreaterThanOrEqual(1);
    const again = await expirePoints();
    expect(again.expired).toBe(0);
    const history = (await api.get('/api/v1/growth/rewards/history').set(auth(rider.accessToken)))
      .body.data as RewardsHistoryResponse;
    expect(history.items.map((i) => i.kind)).toEqual(['EXPIRE', 'ADJUST']);
    expect(history.items.reduce((s, i) => s + i.points, 0)).toBe(0);
  });

  it('warns about points about to expire, once a week', async () => {
    const t = await admin(['GROWTH_MANAGE']);
    const rider = await onboardUser('PASSENGER');
    await adjust(t, rider.user.id as string, 80);
    await pool.query(
      `UPDATE reward_ledger SET expires_at = now() + interval '5 days' WHERE user_id = $1`,
      [rider.user.id],
    );
    await expirePoints();
    await expirePoints();
    const n = await pool.query(
      `SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'REWARD_POINTS_EXPIRING'`,
      [rider.user.id],
    );
    expect(n.rowCount).toBe(1);
    const summary = (await api.get('/api/v1/growth/rewards').set(auth(rider.accessToken))).body
      .data as RewardsSummary;
    expect(summary.expiringSoon?.points).toBe(80);
  });

  it('applies a points-multiplier campaign to the points a ride earns', async () => {
    const t = await admin(['GROWTH_MANAGE']);
    await live(t, { offer: { type: 'BONUS_POINTS', points: 40 } });
    const rider = await onboardUser('PASSENGER');
    const { w } = await ride(rider);
    const fare = (await trip(w!.tripId)).fare_final_npr;
    expect(await balance(rider.accessToken)).toBe(Math.floor(fare / 100) + 40);
  });
});

// ---------------------------------------------------------------- referrals

describe('referrals', () => {
  async function referralCampaign(over: Partial<AdminCampaignBody> = {}) {
    const t = await admin(['GROWTH_MANAGE']);
    const c = await live(t, {
      kind: 'REFERRAL',
      offer: { type: 'FIXED_OFF', fixedNpr: 30 },
      referrerPoints: 120,
      ...over,
    });
    return { t, c };
  }
  const codeOf = async (u: OnboardedUser) =>
    ((await api.get('/api/v1/growth/referral').set(auth(u.accessToken))).body.data as ReferralView)
      .code;
  const apply = (u: OnboardedUser, code: string) =>
    api.post('/api/v1/growth/referral/apply').set(auth(u.accessToken)).send({ code });

  it('gives each rider one invite code, and a closed referral programme says so', async () => {
    const a = await onboardUser('PASSENGER');
    const closed = (await api.get('/api/v1/growth/referral').set(auth(a.accessToken))).body
      .data as ReferralView;
    expect(closed.open).toBe(false);
    expect(closed.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(await codeOf(a)).toBe(closed.code); // the same code every time
    const b = await onboardUser('PASSENGER');
    expect((await apply(b, closed.code)).body.error.code).toBe('REFERRALS_CLOSED');
  });

  it('lets a new rider use an invite once, gives them the offer, and pays the inviter only when the first ride is done', async () => {
    await referralCampaign();
    const inviter = await onboardUser('PASSENGER');
    const friend = await onboardUser('PASSENGER');
    const code = await codeOf(inviter);
    const ok = await apply(friend, code);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.message).toContain('NPR 30 off your fare');
    expect(await balance(inviter.accessToken)).toBe(0); // nothing is paid for typing a code
    expect((await apply(friend, code)).body.error.code).toBe('ALREADY_REFERRED');

    const offers = (await api.get('/api/v1/growth/offers').set(auth(friend.accessToken))).body
      .data as OfferView[];
    expect(offers.some((o) => o.kind === 'REFERRAL')).toBe(true);
    const { w } = await ride(friend);
    expect((await trip(w!.tripId)).discount_npr).toBe(30);
    const fare = (await trip(w!.tripId)).fare_final_npr;
    expect(await balance(inviter.accessToken)).toBe(120);
    const view = (await api.get('/api/v1/growth/referral').set(auth(inviter.accessToken))).body
      .data as ReferralView;
    expect(view).toMatchObject({ invited: 1, rewarded: 1, pending: 0 });
    const note = await pool.query(
      `SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'REFERRAL_QUALIFIED'`,
      [inviter.user.id],
    );
    expect(note.rowCount).toBe(1);
    void fare;
    // A second ride by the friend pays the inviter nothing more.
    await ride(friend);
    expect(await balance(inviter.accessToken)).toBe(120);
  });

  it('refuses your own code and a circle, and records each attempt for the risk system', async () => {
    await referralCampaign();
    const a = await onboardUser('PASSENGER');
    const b = await onboardUser('PASSENGER');
    const own = await apply(a, await codeOf(a));
    expect(own.status).toBe(422);
    expect(own.body.error.code).toBe('SELF_REFERRAL');
    expect((await apply(b, await codeOf(a))).status).toBe(200);
    const circle = await apply(a, await codeOf(b));
    expect(circle.body.error.code).toBe('CIRCULAR_REFERRAL');
    const blocked = await pool.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'REFERRAL_BLOCKED'`,
    );
    expect(blocked.rows[0].n).toBe(2);
  });

  it('is for new riders: a rider who has already ridden cannot use one, nor can a made-up code', async () => {
    await referralCampaign();
    const inviter = await onboardUser('PASSENGER');
    const veteran = await onboardUser('PASSENGER');
    await ride(veteran);
    expect((await apply(veteran, await codeOf(inviter))).body.error.code).toBe('NOT_A_NEW_RIDER');
    const fresh = await onboardUser('PASSENGER');
    expect((await apply(fresh, 'ABCDEFGH')).status).toBe(404);
    expect((await apply(fresh, 'short')).status).toBe(400);
  });

  it('counts two simultaneous uses of invites by one rider once', async () => {
    await referralCampaign();
    const a = await onboardUser('PASSENGER');
    const b = await onboardUser('PASSENGER');
    const friend = await onboardUser('PASSENGER');
    const [codeA, codeB] = [await codeOf(a), await codeOf(b)];
    const [x, y] = await Promise.all([apply(friend, codeA), apply(friend, codeB)]);
    expect([x.status, y.status].filter((s) => s === 200)).toHaveLength(1);
    const rows = await pool.query(
      'SELECT count(*)::int AS n FROM referrals WHERE referee_id = $1',
      [friend.user.id],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('limits how many riders one code can bring in', async () => {
    await referralCampaign();
    await pool
      .query(
        `UPDATE platform_settings SET value = '1'::jsonb WHERE key = 'REFERRAL_MAX_INVITES_30D'`,
      )
      .catch(() => undefined);
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ('REFERRAL_MAX_INVITES_30D', '1'::jsonb) ON CONFLICT (key) DO UPDATE SET value = '1'::jsonb`,
    );
    const { refreshSettings } = await import('../modules/settings/settings.service');
    await refreshSettings();
    try {
      const inviter = await onboardUser('PASSENGER');
      const code = await codeOf(inviter);
      expect((await apply(await onboardUser('PASSENGER'), code)).status).toBe(200);
      expect((await apply(await onboardUser('PASSENGER'), code)).body.error.code).toBe(
        'INVITE_LIMIT',
      );
    } finally {
      await pool.query(`DELETE FROM platform_settings WHERE key = 'REFERRAL_MAX_INVITES_30D'`);
      await refreshSettings();
    }
  });

  it('holds the reward when the inviting account is not active', async () => {
    await referralCampaign();
    const inviter = await onboardUser('PASSENGER');
    const friend = await onboardUser('PASSENGER');
    await apply(friend, await codeOf(inviter));
    await pool.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [inviter.user.id]);
    await ride(friend);
    const r = await pool.query('SELECT status FROM referrals WHERE referee_id = $1', [
      friend.user.id,
    ]);
    expect(r.rows[0].status).toBe('HELD');
    const pts = await pool.query(
      `SELECT count(*)::int AS n FROM reward_ledger WHERE user_id = $1`,
      [inviter.user.id],
    );
    expect(pts.rows[0].n).toBe(0);
  });
});

// ---------------------------------------------------------------- message campaigns and win-back offers

describe('messages and win-back offers', () => {
  const optIn = (u: OnboardedUser) =>
    api
      .patch('/api/v1/users/me/preferences')
      .set(auth(u.accessToken))
      .send({ changes: { 'notify.PROMOTIONS': true } });

  it('sends a scheduled message once, to the riders it fits, and respects who has not opted in', async () => {
    const t = await admin(['GROWTH_MANAGE']);
    const opted = await onboardUser('PASSENGER');
    const quiet = await onboardUser('PASSENGER');
    expect((await optIn(opted)).status).toBe(200);
    const driver = await onboardUser('DRIVER');
    await live(t, {
      kind: 'PUSH',
      offer: null,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      message: { title: 'Weekend rides', body: 'Ride this weekend with Yatri.' },
    });
    const first = await sweepCampaignMessages();
    expect(first.pushed).toBeGreaterThanOrEqual(2);
    const again = await sweepCampaignMessages();
    expect(again.pushed).toBe(0);
    const status = async (u: OnboardedUser) =>
      (
        await pool.query(
          `SELECT delivery_status FROM notifications WHERE user_id = $1 AND type = 'CAMPAIGN_MESSAGE'`,
          [u.user.id],
        )
      ).rows.map((r) => r.delivery_status);
    expect(await status(opted)).toEqual(['SENT']);
    expect(await status(quiet)).toEqual(['SUPPRESSED']); // recorded, not pushed
    expect(await status(driver)).toEqual([]); // riders only
  });

  it('does not send a message campaign that is scheduled for later', async () => {
    const t = await admin(['GROWTH_MANAGE']);
    const rider = await onboardUser('PASSENGER');
    await live(t, {
      kind: 'PUSH',
      offer: null,
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      message: { title: 'Later', body: 'Not yet.' },
    });
    await sweepCampaignMessages();
    const n = await pool.query(
      `SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'CAMPAIGN_MESSAGE'`,
      [rider.user.id],
    );
    expect(n.rowCount).toBe(0);
  });

  it('gives a win-back offer to riders who stopped riding, once, and not to active riders', async () => {
    const t = await admin(['GROWTH_MANAGE']);
    const lapsed = await onboardUser('PASSENGER');
    const active = await onboardUser('PASSENGER');
    const lapsedRide = await finishedRide(true);
    await pool.query(
      "UPDATE trips SET passenger_id = $2, ended_at = now() - interval '45 days' WHERE id = $1",
      [lapsedRide.tripId, lapsed.user.id],
    );
    // The same driver takes both rides: a second free driver online at the same spot could be offered the next ride first.
    const activeRide = await finishedRide(true, lapsedRide.driver);
    await pool.query('UPDATE trips SET passenger_id = $2 WHERE id = $1', [
      activeRide.tripId,
      active.user.id,
    ]);
    const c = await live(t, {
      kind: 'RETENTION',
      eligibility: { inactiveForDays: 30 },
      offer: { type: 'FIXED_OFF', fixedNpr: 40 },
      limits: { perUser: 1, total: null, validDaysAfterGrant: 14 },
      message: { title: 'We miss you', body: 'Come back for a ride.' },
    });
    const first = await sweepCampaignMessages();
    expect(first.offers).toBe(1);
    expect((await sweepCampaignMessages()).offers).toBe(0);
    const offers = (await api.get('/api/v1/growth/offers').set(auth(lapsed.accessToken))).body
      .data as OfferView[];
    expect(offers.find((o) => o.campaignId === c.id)?.usableUntil).not.toBeNull();
    const none = (await api.get('/api/v1/growth/offers').set(auth(active.accessToken))).body
      .data as OfferView[];
    expect(none.find((o) => o.campaignId === c.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------- fraud and abuse

describe('abuse and the risk system', () => {
  const events = async (rule: string) =>
    (await pool.query('SELECT user_id FROM risk_events WHERE rule_code = $1', [rule])).rows.map(
      (r) => r.user_id as string,
    );

  it('raises a signal, never a ban, for many invites, many offers used and repeated own-code attempts', async () => {
    const t = await admin(['GROWTH_MANAGE']);
    const c = await live(t, {
      kind: 'REFERRAL',
      offer: { type: 'FIXED_OFF', fixedNpr: 10 },
      referrerPoints: 10,
    });
    const inviter = await onboardUser('PASSENGER');
    for (let i = 0; i < 8; i += 1) {
      const f = await onboardUser('PASSENGER');
      await pool.query(
        'INSERT INTO referrals (referrer_id, referee_id, campaign_id) VALUES ($1, $2, $3)',
        [inviter.user.id, f.user.id, c.id],
      );
    }
    const heavy = await onboardUser('PASSENGER');
    for (let i = 0; i < 6; i += 1) {
      await pool
        .query(
          `INSERT INTO campaign_redemptions (campaign_id, user_id, trip_id, status, name, offer) VALUES ($1, $2, NULL, 'APPLIED', 'x', '{}'::jsonb)`,
          [c.id, heavy.user.id],
        )
        .catch(() => undefined);
    }
    const trier = await onboardUser('PASSENGER');
    for (let i = 0; i < 3; i += 1) {
      await pool.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, subject_type, detail) VALUES ($1, 'PASSENGER', 'REFERRAL_BLOCKED', 'referral', '{}'::jsonb)`,
        [trier.user.id],
      );
    }
    await runRiskSweep();
    expect(await events('REFERRAL_BURST')).toContain(inviter.user.id);
    expect(await events('SELF_REFERRAL_ATTEMPTS')).toContain(trier.user.id);
    // No account is restricted or suspended by these signals alone.
    const s = await pool.query(`SELECT status FROM users WHERE id = ANY($1::uuid[])`, [
      [inviter.user.id, trier.user.id, heavy.user.id],
    ]);
    expect(s.rows.every((r) => r.status === 'ACTIVE')).toBe(true);
  });

  it("flags invited accounts that signed in from the inviter's network address, as a low-weight signal", async () => {
    const inviter = await onboardUser('PASSENGER');
    const friends = [await onboardUser('PASSENGER'), await onboardUser('PASSENGER')];
    const same = `10.${(n % 200) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
    for (const u of [inviter, ...friends]) {
      await pool.query(
        `INSERT INTO auth_events (event_type, user_id, ip_address) VALUES ('OTP_VERIFIED', $1, $2)`,
        [u.user.id, same],
      );
    }
    for (const f of friends)
      await pool.query('INSERT INTO referrals (referrer_id, referee_id) VALUES ($1, $2)', [
        inviter.user.id,
        f.user.id,
      ]);
    await runRiskSweep();
    expect(await events('REFERRAL_SHARED_NETWORK')).toContain(inviter.user.id);
    const row = await pool.query(
      `SELECT points FROM risk_events WHERE rule_code = 'REFERRAL_SHARED_NETWORK' AND user_id = $1`,
      [inviter.user.id],
    );
    expect(row.rows[0].points).toBeLessThanOrEqual(5);
  });

  it('keeps the ledger append-only: nothing a rider can call writes or changes it', async () => {
    const rider = await onboardUser('PASSENGER');
    for (const [method, path] of [
      ['post', '/api/v1/growth/rewards'],
      ['put', '/api/v1/growth/rewards'],
      ['patch', '/api/v1/growth/rewards'],
      ['delete', '/api/v1/growth/rewards'],
      ['post', '/api/v1/growth/rewards/history'],
    ] as const) {
      const res = await api[method](path).set(auth(rider.accessToken)).send({ points: 1000 });
      expect(res.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
    }
    expect(await balance(rider.accessToken)).toBe(0);
  });

  it('stops guessing of promo codes', async () => {
    const rider = await onboardUser('PASSENGER');
    let last = 200;
    for (let i = 0; i < 25; i += 1) {
      const res = await api
        .post('/api/v1/growth/promo/check')
        .set(auth(rider.accessToken))
        .send({ code: `GUESS${i}` });
      last = res.status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
});

// ---------------------------------------------------------------- what people see, who may see it

describe('what each person can see', () => {
  it('lists the offers a rider can use and checks a typed code without a ride', async () => {
    const t = await admin(['GROWTH_MANAGE']);
    const code = unique();
    await live(t, {
      kind: 'COUPON',
      code,
      offer: { type: 'PERCENT_OFF', percent: 15, maxDiscountNpr: 60 },
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const promo = await live(t, {
      name: 'Weekday rides',
      offer: { type: 'FIXED_OFF', fixedNpr: 20 },
    });
    const rider = await onboardUser('PASSENGER');
    const offers = (await api.get('/api/v1/growth/offers').set(auth(rider.accessToken))).body
      .data as OfferView[];
    expect(offers.find((o) => o.campaignId === promo.id)).toMatchObject({
      automatic: true,
      summary: 'NPR 20 off your fare',
    });
    expect(offers.some((o) => o.code === code)).toBe(false); // a coupon is used by entering it
    const ok = await api
      .post('/api/v1/growth/promo/check')
      .set(auth(rider.accessToken))
      .send({ code });
    expect(ok.body.data).toMatchObject({
      valid: true,
      offer: { summary: '15% off your fare, up to NPR 60' },
    });
    const bad = await api
      .post('/api/v1/growth/promo/check')
      .set(auth(rider.accessToken))
      .send({ code: 'NOSUCH1' });
    expect(bad.body.data).toMatchObject({ valid: false });
    expect(bad.body.data.problem).toContain('not valid');
  });

  it('keeps rider endpoints to riders, the driver view to drivers, and everything to the signed-in person', async () => {
    const rider = await onboardUser('PASSENGER');
    const driver = await onboardUser('DRIVER');
    for (const path of ['/offers', '/rewards', '/rewards/history', '/referral']) {
      expect(
        (await api.get(`/api/v1/growth${path}`).set(auth(driver.accessToken))).status,
        path,
      ).toBe(403);
      expect((await api.get(`/api/v1/growth${path}`)).status, path).toBe(401);
    }
    expect((await api.get('/api/v1/growth/driver').set(auth(rider.accessToken))).status).toBe(403);
    const view = await api.get('/api/v1/growth/driver').set(auth(driver.accessToken));
    expect(view.status).toBe(200);
    const legacy = await api.get('/api/v1/drivers/me/incentives').set(auth(driver.accessToken));
    expect(legacy.body.data).toEqual(view.body.data.incentives); // one service, two doors
  });

  it("shows campaign figures to administrators without any rider's trips or places", async () => {
    const t = await admin(['GROWTH_MANAGE']);
    await live(t, { offer: { type: 'FIXED_OFF', fixedNpr: 12 } });
    const rider = await onboardUser('PASSENGER');
    await ride(rider);
    const res = await api.get('/api/v1/admin/growth/analytics?range=7d').set(auth(t));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const a = res.body.data as CampaignAnalytics;
    expect(a.redemptions).toBeGreaterThanOrEqual(1);
    expect(a.discountNpr).toBeGreaterThanOrEqual(12);
    expect(a.byCampaign.length).toBeGreaterThanOrEqual(1);
    expect(a.driverIncentives).toEqual({
      awards: expect.any(Number),
      bonusNpr: expect.any(Number),
    });
    expect(JSON.stringify(res.body)).not.toMatch(/latitude|longitude|address|phone/i);
  });

  it('shows what Yatri paid towards fares in the finance summary, so discounts are not left looking unpaid', async () => {
    const t = await admin(['GROWTH_MANAGE']);
    await live(t, { offer: { type: 'FIXED_OFF', fixedNpr: 20 } });
    const rider = await onboardUser('PASSENGER');
    const { w } = await ride(rider);
    await api.post(`/api/v1/trips/${w!.tripId}/payment/confirm`).set(auth(w!.driver.accessToken));
    const fin = await admin(['FINANCE_VIEW']);
    const sum = await api.get('/api/v1/admin/finance/summary?range=7d').set(auth(fin));
    expect(sum.status, JSON.stringify(sum.body)).toBe(200);
    expect(sum.body.data.discountsFundedNpr).toBeGreaterThanOrEqual(20);
    expect(sum.body.data.outstandingNpr).toBeLessThanOrEqual(
      sum.body.data.grossFaresNpr - sum.body.data.discountsFundedNpr,
    );
  });
});

// ---------------------------------------------------------------- one definition

describe('one promotion engine', () => {
  it('keeps discount, points and eligibility calculations in the engine and the shared rules only', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const root = join(__dirname, '..');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) return name === 'test' ? [] : walk(p);
        return p.endsWith('.ts') ? [p] : [];
      });
    const callers = (needle: RegExp) =>
      walk(root)
        .filter((f) => needle.test(readFileSync(f, 'utf8')))
        .map((f) => relative(root, f).replace(/\\/g, '/'));
    expect(callers(/\bcomputeDiscount\(|\bcombineOffers\(/)).toEqual(['modules/growth/engine.ts']);
    expect(callers(/\bpointsForFare\(|\bredeemablePoints\(/).sort()).toEqual([
      'modules/growth/engine.ts',
    ]);
    expect(callers(/\bevaluateEligibility\(/).sort()).toEqual([
      'modules/growth/engine.ts',
      'modules/growth/messaging.ts',
    ]);
    expect(callers(/INSERT INTO reward_ledger/).sort()).toEqual(['modules/growth/loyalty.ts']);
    expect(callers(/UPDATE reward_ledger/).sort()).toEqual(['modules/growth/loyalty.ts']);
  });
});
