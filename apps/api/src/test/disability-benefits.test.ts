import {
  COMPANION_DRIVER_TEXT,
  PASSENGER_NEED_BY_CODE,
  campaignProblem,
  describeAccessibilityForDriver,
  describeConditions,
  evaluateEligibility,
  payableBreakdown,
  type AdminCampaignBody,
  type CampaignInfo,
  type DisabilityBenefitsOverview,
  type FareEstimateResponse,
  type LiveTripSnapshot,
  type TripSummary,
} from '@yatri/types';
import { describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { benefitActiveFor } from '../modules/disability/verification.service';
import { searchRadius } from '../modules/dispatch/matching';
import { settleRide } from '../modules/growth/engine';
import { runRiskSweep } from '../modules/risk/sweep';
import { ME, reviewer, verified } from './disability-fixtures';
import { api, loginTestAdmin, onboardUser, type OnboardedUser } from './helpers';
import {
  PATAN,
  THAMEL,
  acceptCurrentOffer,
  arriveAtPickup,
  auth,
  backdate,
  forceDriverOnline,
} from './rides';

// ---------------------------------------------------------------- helpers

let n = 0;
const unique = () => `B${Date.now().toString(36).toUpperCase()}${(++n).toString(36).toUpperCase()}`;
const growthAdmin = () =>
  loginTestAdmin(`ben-${Date.now()}-${++n}@example.com`, 'a-strong-test-password-1', [
    'GROWTH_MANAGE',
    'DISABILITY_VERIFICATION_VIEW',
  ]);

function benefit(
  over: Partial<AdminCampaignBody> & { userIds?: string[]; companionAllowed?: boolean },
): AdminCampaignBody {
  const { userIds, companionAllowed, ...rest } = over;
  return {
    kind: 'DISABILITY_BENEFIT',
    name: `Disability benefit ${unique()}`,
    description: 'A test benefit',
    code: null,
    startsAt: null,
    endsAt: null,
    eligibility: {
      requiresDisabilityVerified: true,
      ...(userIds ? { userIds } : {}),
      ...(companionAllowed === false ? { companionAllowed: false } : {}),
    },
    offer: { type: 'PERCENT_OFF', percent: 20 },
    referrerPoints: null,
    stackable: false,
    limits: { perUser: null, total: null, validDaysAfterGrant: null },
    message: null,
    reason: 'Testing',
    ...rest,
  };
}

async function liveBenefit(
  admin: string,
  over: Parameters<typeof benefit>[0],
): Promise<CampaignInfo> {
  const res = await api.post('/api/v1/admin/growth/campaigns').set(auth(admin)).send(benefit(over));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const c = res.body.data as CampaignInfo;
  const on = await api
    .post(`/api/v1/admin/growth/campaigns/${c.id}/status`)
    .set(auth(admin))
    .send({ to: 'ACTIVE', version: c.version, reason: 'Go live' });
  expect(on.status, JSON.stringify(on.body)).toBe(200);
  return on.body.data as CampaignInfo;
}

const estimate = (token: string, extra: object = {}) =>
  api
    .post('/api/v1/trips/estimate')
    .set(auth(token))
    .send({ pickup: THAMEL, destination: PATAN, vehicleCategory: 'CAR', ...extra });
const car = (res: { body: { data: FareEstimateResponse } }) =>
  res.body.data.categories.find((c) => c.code === 'CAR')!;
const promo = async (u: OnboardedUser, extra: object = {}) =>
  car(await estimate(u.accessToken, extra)).promotion;

/** A verified rider, scoped so other tests' live campaigns and riders cannot mix with these. */
const verifiedRider = async () => (await verified()).user;
const idOf = (u: OnboardedUser) => u.user.id as string;

async function rideFor(
  passenger: OnboardedUser,
  extra: object = {},
  opts: { complete?: boolean } = {},
) {
  const driver = await onboardUser('DRIVER');
  await forceDriverOnline(driver.user.id as string);
  const req = await api
    .post('/api/v1/trips/request')
    .set(auth(passenger.accessToken))
    .send({ pickup: THAMEL, destination: PATAN, vehicleCategory: 'CAR', ...extra });
  expect(req.status, JSON.stringify(req.body)).toBe(201);
  expect((await acceptCurrentOffer(driver.accessToken)).status).toBe(200);
  const w = {
    passenger,
    driver,
    tripId: req.body.data.id as string,
    passengerId: idOf(passenger),
    driverId: idOf(driver),
  };
  if (opts.complete !== false) {
    await arriveAtPickup(w);
    await api.post(`/api/v1/trips/${w.tripId}/start`).set(auth(driver.accessToken));
    const done = await api.post(`/api/v1/trips/${w.tripId}/complete`).set(auth(driver.accessToken));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
  }
  return w;
}
const tripRow = async (id: string) =>
  (await pool.query('SELECT fare_final_npr, discount_npr FROM trips WHERE id = $1', [id]))
    .rows[0] as { fare_final_npr: number; discount_npr: number };
const paymentOf = async (id: string) =>
  (await pool.query('SELECT amount_npr FROM trip_payments WHERE trip_id = $1', [id])).rows[0] as {
    amount_npr: number;
  };

// ---------------------------------------------------------------- the pure rules

describe('disability benefit rules (pure)', () => {
  const facts = {
    userId: 'u',
    completedRides: 0,
    accountAgeDays: 9,
    daysSinceLastRide: null,
    disabilityVerified: true,
    ride: { categoryCode: 'CAR', cityId: null, fareNpr: 300, withCompanion: false },
  };

  it('judges a benefit on the verified benefit alone, and on the companion rule', () => {
    const rule = { requiresDisabilityVerified: true as const };
    expect(evaluateEligibility(rule, facts).eligible).toBe(true);
    expect(evaluateEligibility(rule, { ...facts, disabilityVerified: false }).eligible).toBe(false);
    expect(
      evaluateEligibility(
        { ...rule, companionAllowed: false },
        { ...facts, ride: { ...facts.ride, withCompanion: true } },
      ).eligible,
    ).toBe(false);
    expect(evaluateEligibility({ ...rule, companionAllowed: false }, facts).eligible).toBe(true);
    expect(
      evaluateEligibility(rule, { ...facts, ride: { ...facts.ride, withCompanion: true } })
        .eligible,
    ).toBe(true); // yes is the default
  });

  it('refuses a disability benefit that is not tied to a verified benefit, and says the conditions in words', () => {
    const b = benefit({ eligibility: {} });
    expect(campaignProblem(b)).toContain('verified');
    expect(campaignProblem(benefit({}))).toBeNull();
    expect(
      describeConditions(
        { requiresDisabilityVerified: true, companionAllowed: false },
        { perUser: 2, total: null },
      ).join(' '),
    ).toContain('companion');
  });

  it('adds the five figures up: standard fare minus each benefit is the amount payable', () => {
    const b = payableBreakdown({
      fareNpr: 400,
      offers: [
        {
          campaignId: 'd',
          name: 'D',
          type: 'PERCENT_OFF',
          discountNpr: 80,
          bonusPoints: 0,
          pointsMultiplier: 1,
          description: '',
          disabilityBenefit: true,
        },
        {
          campaignId: 'o',
          name: 'O',
          type: 'FIXED_OFF',
          discountNpr: 20,
          bonusPoints: 0,
          pointsMultiplier: 1,
          description: '',
          disabilityBenefit: false,
        },
      ],
      pointsValueNpr: 30,
      payableNpr: 270,
    });
    expect(b).toEqual({
      standardFareNpr: 400,
      disabilityBenefitNpr: 80,
      loyaltyBenefitNpr: 30,
      otherDiscountNpr: 20,
      payableNpr: 270,
    });
    expect(
      b.standardFareNpr - b.disabilityBenefitNpr - b.loyaltyBenefitNpr - b.otherDiscountNpr,
    ).toBe(b.payableNpr);
  });

  it('tells the driver about a companion and extra boarding time without saying why', () => {
    const lines = describeAccessibilityForDriver({
      needs: ['EXTRA_BOARDING_TIME'],
      companion: true,
      communication: 'ANY',
      pickupInstructions: [],
      pickupNote: null,
      otherNote: null,
      requiredVehicleAttributes: [],
    });
    expect(lines).toContain(COMPANION_DRIVER_TEXT);
    expect(lines).toContain(PASSENGER_NEED_BY_CODE.EXTRA_BOARDING_TIME.driverText);
    expect(lines.join(' ')).not.toMatch(/disab|diagnos|condition|verified/i);
  });

  it('gives an accessible request a wider search, and an ordinary one the usual', () => {
    expect(searchRadius(0, false)).toBe(5000);
    expect(searchRadius(0, true)).toBe(7500); // +50% by default
    expect(searchRadius(40, true)).toBeGreaterThan(searchRadius(40, false));
  });
});

// ---------------------------------------------------------------- the benefit on the fare

describe('the benefit through the one promotion engine', () => {
  it('applies to a verified rider only, shown as normal fare, disability benefit and amount payable, all from the server', async () => {
    const admin = await growthAdmin();
    const rider = await verifiedRider();
    const c = await liveBenefit(admin, { userIds: [idOf(rider)] });
    const p = await promo(rider);
    expect(p?.offers.map((o) => o.campaignId)).toEqual([c.id]);
    expect(p?.offers[0]?.disabilityBenefit).toBe(true);
    const b = p!.breakdown;
    expect(b.disabilityBenefitNpr).toBe(Math.floor((b.standardFareNpr * 20) / 100));
    expect(
      b.standardFareNpr - b.disabilityBenefitNpr - b.loyaltyBenefitNpr - b.otherDiscountNpr,
    ).toBe(b.payableNpr);
    expect(p!.payableNpr).toBe(b.payableNpr);
    // another rider (not verified) gets nothing from it, even if named
    const other = await onboardUser('PASSENGER');
    const c2 = await liveBenefit(admin, { userIds: [idOf(other)] });
    expect((await promo(other))?.offers.map((o) => o.campaignId) ?? []).not.toContain(c2.id);
  });

  it('stops the moment the verification ends, however it ends', async () => {
    const admin = await growthAdmin();
    const s = await verified();
    await liveBenefit(admin, { userIds: [idOf(s.user)] });
    expect((await promo(s.user))?.breakdown.disabilityBenefitNpr).toBeGreaterThan(0);
    await api
      .post(`/api/v1/admin/disability-verifications/${s.id}/revoke`)
      .set(auth(s.admin))
      .send({ reason: 'Card reported lost.' });
    expect((await promo(s.user))?.breakdown?.disabilityBenefitNpr ?? 0).toBe(0);

    const t = await verified();
    await liveBenefit(admin, { userIds: [idOf(t.user)] });
    await pool.query(
      `UPDATE disability_verifications SET valid_until = current_date - 1, expiry_date = current_date - 1 WHERE id = $1`,
      [t.id],
    );
    expect((await promo(t.user))?.breakdown?.disabilityBenefitNpr ?? 0).toBe(0); // expired by the date alone

    const u = await verified();
    await liveBenefit(admin, { userIds: [idOf(u.user)] });
    await api.patch(ME).set(auth(u.user.accessToken)).send({ withdrawConsent: true });
    expect((await promo(u.user))?.breakdown?.disabilityBenefitNpr ?? 0).toBe(0);
    expect(await benefitActiveFor(idOf(u.user))).toBe(false);
  });

  it('is switched off by the platform setting for everyone at once', async () => {
    const admin = await growthAdmin();
    const rider = await verifiedRider();
    await liveBenefit(admin, { userIds: [idOf(rider)] });
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ('DISABILITY_VERIFICATION_ENABLED', 'false') ON CONFLICT (key) DO UPDATE SET value = 'false'`,
    );
    const { refreshSettings } = await import('../modules/settings/settings.service');
    await refreshSettings();
    try {
      expect((await promo(rider))?.breakdown?.disabilityBenefitNpr ?? 0).toBe(0);
    } finally {
      await pool.query(
        `DELETE FROM platform_settings WHERE key = 'DISABILITY_VERIFICATION_ENABLED'`,
      );
      await refreshSettings();
    }
    expect((await promo(rider))?.breakdown.disabilityBenefitNpr).toBeGreaterThan(0);
  });

  it('respects vehicle types, and the companion rule the administrator chose', async () => {
    const admin = await growthAdmin();
    const rider = await verifiedRider();
    const other = (
      await pool.query(
        `SELECT code FROM vehicle_categories WHERE code <> 'CAR' AND is_active ORDER BY code LIMIT 1`,
      )
    ).rows[0]?.code as string;
    const onlyOther = await liveBenefit(admin, {
      userIds: [idOf(rider)],
      eligibility: {
        requiresDisabilityVerified: true,
        userIds: [idOf(rider)],
        vehicleCategoryCodes: [other],
      },
    });
    expect((await promo(rider))?.offers.map((o) => o.campaignId) ?? []).not.toContain(onlyOther.id); // the ride is a CAR, the benefit is for another type

    const noCompanion = await liveBenefit(admin, {
      userIds: [idOf(rider)],
      companionAllowed: false,
    });
    expect((await promo(rider))?.offers.map((o) => o.campaignId)).toContain(noCompanion.id);
    expect(
      (await promo(rider, { accessibility: { companion: true } }))?.offers.map(
        (o) => o.campaignId,
      ) ?? [],
    ).not.toContain(noCompanion.id);
  });

  it('can add loyalty points through the one points ledger, and never a separate ledger', async () => {
    const admin = await growthAdmin();
    const rider = await verifiedRider();
    await liveBenefit(admin, {
      userIds: [idOf(rider)],
      offer: { type: 'BONUS_POINTS', points: 40 },
    });
    const w = await rideFor(rider);
    const bonus = await pool.query(
      `SELECT COALESCE(sum(points), 0)::int AS p FROM reward_ledger WHERE user_id = $1 AND kind = 'EARN' AND source = 'RIDE' AND source_id = $2`,
      [idOf(rider), w.tripId],
    );
    expect(bonus.rows[0].p).toBeGreaterThanOrEqual(40);
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND (table_name ILIKE '%disab%' OR table_name ILIKE '%benefit%')`,
    );
    expect(tables.rows.map((r) => r.table_name).sort()).toEqual([
      'disability_verification_events',
      'disability_verifications',
    ]); // no benefit ledger, no discount table
  });

  it('honours the limits: usage is tracked per rider and in total', async () => {
    const admin = await growthAdmin();
    const rider = await verifiedRider();
    const c = await liveBenefit(admin, {
      userIds: [idOf(rider)],
      limits: { perUser: 1, total: null, validDaysAfterGrant: null },
    });
    const first = await rideFor(rider);
    expect((await tripRow(first.tripId)).discount_npr).toBeGreaterThan(0);
    const p = await promo(rider);
    expect(p?.offers.map((o) => o.campaignId) ?? []).not.toContain(c.id); // used once, no more
    const used = await pool.query(
      `SELECT count(*)::int AS n FROM campaign_redemptions WHERE campaign_id = $1 AND status = 'APPLIED'`,
      [c.id],
    );
    expect(used.rows[0].n).toBe(1);
  });

  it("settles a ride once: the discount is the platform's, the rider pays the rest, and a repeat changes nothing", async () => {
    const admin = await growthAdmin();
    const rider = await verifiedRider();
    await liveBenefit(admin, { userIds: [idOf(rider)] });
    const w = await rideFor(rider);
    const t = await tripRow(w.tripId);
    expect(t.discount_npr).toBe(Math.floor((t.fare_final_npr * 20) / 100));
    expect((await paymentOf(w.tripId)).amount_npr).toBe(t.fare_final_npr - t.discount_npr);
    await settleRide(w.tripId);
    await settleRide(w.tripId);
    expect((await tripRow(w.tripId)).discount_npr).toBe(t.discount_npr);
    const redemptions = await pool.query(
      `SELECT count(*)::int AS n FROM campaign_redemptions WHERE trip_id = $1 AND status = 'APPLIED'`,
      [w.tripId],
    );
    expect(redemptions.rows[0].n).toBe(1);
  });

  it('gives a limited benefit to exactly one of two riders booking at the same moment', async () => {
    const admin = await growthAdmin();
    const a = await verifiedRider();
    const b = await verifiedRider();
    const c = await liveBenefit(admin, {
      userIds: [idOf(a), idOf(b)],
      limits: { perUser: null, total: 1, validDaysAfterGrant: null },
    });
    const d1 = await onboardUser('DRIVER');
    const d2 = await onboardUser('DRIVER');
    await forceDriverOnline(d1.user.id as string);
    await forceDriverOnline(d2.user.id as string);
    const [x, y] = await Promise.all([
      api
        .post('/api/v1/trips/request')
        .set(auth(a.accessToken))
        .send({ pickup: THAMEL, destination: PATAN, vehicleCategory: 'CAR' }),
      api
        .post('/api/v1/trips/request')
        .set(auth(b.accessToken))
        .send({ pickup: THAMEL, destination: PATAN, vehicleCategory: 'CAR' }),
    ]);
    expect([x.status, y.status]).toEqual([201, 201]);
    const held = await pool.query(
      `SELECT count(*)::int AS n FROM campaign_redemptions WHERE campaign_id = $1 AND status <> 'VOID'`,
      [c.id],
    );
    expect(held.rows[0].n).toBe(1);
  });

  it('stores references only on a redemption: no card, name or document', async () => {
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'campaign_redemptions'`,
    );
    const names = cols.rows.map((r) => r.column_name as string);
    for (const bad of ['card', 'document', 'full_name', 'phone', 'authority', 'last4'])
      expect(names.some((c) => c.includes(bad))).toBe(false);
  });

  it('is not given to anyone but a rider: drivers and admins cannot list or use it', async () => {
    const driver = await onboardUser('DRIVER');
    expect((await api.get('/api/v1/growth/offers').set(auth(driver.accessToken))).status).toBe(403);
    const rider = await verifiedRider();
    const admin = await growthAdmin();
    const c = await liveBenefit(admin, { userIds: [idOf(rider)] });
    const offers = (await api.get('/api/v1/growth/offers').set(auth(rider.accessToken))).body
      .data as Array<{ campaignId: string; summary: string }>;
    expect(offers.find((o) => o.campaignId === c.id)?.summary).toContain('20% off');
    expect(JSON.stringify(offers)).not.toMatch(/cardLast4|issuingAuthority/);
  });
});

// ---------------------------------------------------------------- the accessible service

describe('accessible ride services', () => {
  const live = async (w: { tripId: string; passenger: OnboardedUser }) =>
    (await api.get(`/api/v1/trips/${w.tripId}/live`).set(auth(w.passenger.accessToken))).body
      .data as LiveTripSnapshot;

  it('carries a companion on the ride and tells the driver only that, whether or not the rider has any disability benefit', async () => {
    const rider = await onboardUser('PASSENGER'); // not verified, not applying: a companion needs no verification
    const saved = await api
      .put('/api/v1/users/me/accessibility')
      .set(auth(rider.accessToken))
      .send({
        needs: [],
        companion: true,
        communication: 'ANY',
        pickupInstructions: [],
        pickupNote: null,
        otherNote: null,
        version: 0,
      });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const w = await rideFor(rider, {}, { complete: false });
    const trip = (await api.get(`/api/v1/trips/${w.tripId}`).set(auth(w.driver.accessToken))).body
      .data as TripSummary;
    expect(trip.accessibility?.companion).toBe(true);
    expect(describeAccessibilityForDriver(trip.accessibility!)).toContain(COMPANION_DRIVER_TEXT);
    expect(JSON.stringify(trip)).not.toMatch(/verified disability/i);
    expect(trip.disability).toBeNull();
  });

  it('keeps booker, passenger and companion apart: the benefit follows the passenger account, not who else is on the ride', async () => {
    const admin = await growthAdmin();
    const rider = await verifiedRider();
    const c = await liveBenefit(admin, { userIds: [idOf(rider)] });
    const w = await rideFor(rider, { accessibility: { companion: true } });
    const row = (
      await pool.query('SELECT passenger_id, booked_by FROM trips WHERE id = $1', [w.tripId])
    ).rows[0];
    expect(row.passenger_id).toBe(idOf(rider));
    const r = await pool.query(
      `SELECT user_id FROM campaign_redemptions WHERE campaign_id = $1 AND trip_id = $2`,
      [c.id, w.tripId],
    );
    expect(r.rows.map((x) => x.user_id)).toEqual([idOf(rider)]);
  });

  it('gives a rider who needs it extra boarding time: the waiting rule the apps show is longer, with no extra charge', async () => {
    const ordinary = await onboardUser('PASSENGER');
    const needy = await onboardUser('PASSENGER');
    await api
      .put('/api/v1/users/me/accessibility')
      .set(auth(needy.accessToken))
      .send({
        needs: ['EXTRA_BOARDING_TIME'],
        companion: false,
        communication: 'ANY',
        pickupInstructions: [],
        pickupNote: null,
        otherNote: null,
        version: 0,
      });
    const w1 = await rideFor(ordinary, {}, { complete: false });
    await arriveAtPickup(w1);
    const w2 = await rideFor(needy, {}, { complete: false });
    await arriveAtPickup(w2);
    const a = (await live(w1)).waiting!;
    const b = (await live(w2)).waiting!;
    const extra = 300; // EXTRA_BOARDING_SECONDS default
    expect(b.rule.freeSeconds).toBe(a.rule.freeSeconds + extra);
    expect(b.rule.noShowAfterSeconds).toBe(a.rule.noShowAfterSeconds + extra);
    expect(b.rule.perMinuteNpr).toBe(a.rule.perMinuteNpr); // no extra charge
    // the driver is told, without a reason
    const trip = (await api.get(`/api/v1/trips/${w2.tripId}`).set(auth(w2.driver.accessToken))).body
      .data as TripSummary;
    expect(describeAccessibilityForDriver(trip.accessibility!).join(' ')).toContain('extra time');
  });

  it("refuses a driver's no-show report during the extra boarding time", async () => {
    const needy = await onboardUser('PASSENGER');
    await api
      .put('/api/v1/users/me/accessibility')
      .set(auth(needy.accessToken))
      .send({
        needs: ['EXTRA_BOARDING_TIME'],
        companion: false,
        communication: 'ANY',
        pickupInstructions: [],
        pickupNote: null,
        otherNote: null,
        version: 0,
      });
    const w = await rideFor(needy, {}, { complete: false });
    await arriveAtPickup(w);
    // waited past the ordinary no-show time, but not past the extended one
    await backdate(w.tripId, 'arrived_at', 6 * 60);
    const early = await api
      .post(`/api/v1/trips/${w.tripId}/no-show`)
      .set(auth(w.driver.accessToken));
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('NO_SHOW_TOO_EARLY');
  });
});

// ---------------------------------------------------------------- staff, fraud, privacy

describe('the staff view of benefits, and abuse prevention', () => {
  it('shows policies with their use, the service options and what to review, to staff who may see it only, with no identity or card', async () => {
    const admin = await growthAdmin();
    const rider = await verifiedRider();
    const c = await liveBenefit(admin, { userIds: [idOf(rider)] });
    await rideFor(rider);
    expect((await api.get('/api/v1/admin/disability-benefits/overview')).status).toBe(401);
    const nobody = await reviewer(['FLEET_VIEW']);
    expect(
      (await api.get('/api/v1/admin/disability-benefits/overview').set(auth(nobody))).status,
    ).toBe(403);
    const driver = await onboardUser('DRIVER');
    expect(
      (await api.get('/api/v1/admin/disability-benefits/overview').set(auth(driver.accessToken)))
        .status,
    ).toBe(403);
    const res = await api.get('/api/v1/admin/disability-benefits/overview').set(auth(admin));
    expect(res.status).toBe(200);
    const o = res.body.data as DisabilityBenefitsOverview;
    const policy = o.policies.find((p) => p.campaignId === c.id);
    expect(policy?.uses).toBe(1);
    expect(policy?.discountNpr).toBeGreaterThan(0);
    expect(o.serviceOptions.extraBoardingSeconds).toBe(300);
    expect(JSON.stringify(res.body)).not.toMatch(
      /cardLast4|card_hash|issuingAuthority|documentName/,
    );
  });

  it('raises a risk signal for a benefit used on many rides in a day, without stopping the benefit', async () => {
    const admin = await growthAdmin();
    const rider = await verifiedRider();
    const c = await liveBenefit(admin, { userIds: [idOf(rider)] });
    for (let i = 0; i < 5; i += 1) {
      await pool.query(
        `INSERT INTO campaign_redemptions (campaign_id, user_id, status, discount_npr, name, offer, stackable, applied_at)
         VALUES ($1, $2, 'APPLIED', 20, 'x', '{"type":"PERCENT_OFF","percent":20}', false, now())`,
        [c.id, idOf(rider)],
      );
    }
    await runRiskSweep();
    const signal = await pool.query(
      `SELECT 1 FROM risk_events WHERE rule_code = 'DISABILITY_BENEFIT_BURST' AND user_id = $1`,
      [idOf(rider)],
    );
    expect(signal.rowCount).toBeGreaterThanOrEqual(1);
    expect(await benefitActiveFor(idOf(rider))).toBe(true); // a signal asks a person to look; it does not stop anyone
  });

  it('has no second verification, discount engine, ledger or matching system (single source of truth)', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return f === 'test' || f === 'node_modules'
          ? []
          : statSync(p).isDirectory()
            ? files(p)
            : p.endsWith('.ts')
              ? [p]
              : [];
      });
    const src = files(join(__dirname, '..'));
    // the discount is worked out in @yatri/types only; nothing in the API defines another
    expect(
      src.filter((f) =>
        /function computeDiscount|function combineOffers/.test(readFileSync(f, 'utf8')),
      ),
    ).toEqual([]);
    // the verification module never touches fares, the points ledger, redemptions or matching
    const inDisability = (f: string) =>
      f.split(String.fromCharCode(92)).join('/').includes('/modules/disability/');
    const disability = src
      .filter(inDisability)
      .map((f) => readFileSync(f, 'utf8'))
      .join(String.fromCharCode(10));
    expect(disability).not.toMatch(
      /reward_ledger|computeDiscount|campaign_redemptions|INSERT INTO trips|findEligibleDrivers/,
    );
  });
});
