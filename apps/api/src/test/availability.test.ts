import { describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { getRedisClient } from '../config/redis';
import {
  canTransition,
  isMatchable,
  locationFreshness,
} from '../modules/availability/availability.machine';
import { getLiveFix } from '../modules/availability/presence.state';
import {
  getStatus,
  goOffline,
  goOnline,
  ingestLocation,
  sweepDrivers,
} from '../modules/availability/availability.service';
import { api, createVerifiedDriver, loginTestAdmin, onboardUser } from './helpers';
import { acceptCurrentOffer, requestRide } from './rides';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const THAMEL = { latitude: 27.7154, longitude: 85.3123 };
const north = (p: { latitude: number; longitude: number }, m: number) => ({
  latitude: p.latitude + m / 111_195,
  longitude: p.longitude,
});

const sample = (over: Record<string, unknown> = {}) => ({
  ...THAMEL,
  accuracyMeters: 8,
  deviceTimeMs: Date.now(),
  ...over,
});
const online = (token: string, body: object = sample()) =>
  api.post('/api/v1/drivers/me/availability/online').set(auth(token)).send(body);
const offline = (token: string) =>
  api.post('/api/v1/drivers/me/availability/offline').set(auth(token));
const status = (token: string) => api.get('/api/v1/drivers/me/availability').set(auth(token));
const events = async (driverId: string) =>
  (
    await pool.query(
      'SELECT event_type, from_state, to_state, reason FROM driver_availability_events WHERE driver_id = $1 ORDER BY id',
      [driverId],
    )
  ).rows;

describe('state machine (pure)', () => {
  it('allows the documented transitions and nothing else', () => {
    expect(canTransition('OFFLINE', 'GOING_ONLINE')).toBe(true);
    expect(canTransition('GOING_ONLINE', 'ONLINE')).toBe(true);
    expect(canTransition('ONLINE', 'GOING_OFFLINE')).toBe(true);
    expect(canTransition('ONLINE', 'UNAVAILABLE')).toBe(true);
    expect(canTransition('OFFLINE', 'ONLINE')).toBe(false); // must pass through GOING_ONLINE
    expect(canTransition('UNAVAILABLE', 'ONLINE')).toBe(false); // must re-confirm via Go Online
    expect(canTransition('SUSPENDED', 'ONLINE')).toBe(false);
  });

  it('matchable means ONLINE and fresh — nothing else', () => {
    expect(isMatchable('ONLINE', 'fresh')).toBe(true);
    expect(isMatchable('ONLINE', 'stale')).toBe(false);
    expect(isMatchable('ONLINE', 'none')).toBe(false);
    expect(isMatchable('GOING_ONLINE', 'fresh')).toBe(false);
    expect(isMatchable('UNAVAILABLE', 'fresh')).toBe(false);
  });

  it('computes freshness from the configured threshold', () => {
    const now = 1_000_000;
    expect(locationFreshness(null, now, 30)).toBe('none');
    expect(locationFreshness(now - 29_000, now, 30)).toBe('fresh');
    expect(locationFreshness(now - 30_000, now, 30)).toBe('fresh');
    expect(locationFreshness(now - 31_000, now, 30)).toBe('stale');
  });
});

describe('going online: eligibility is decided by the server', () => {
  it('lets a fully verified driver go online and reports it', async () => {
    const { driver } = await createVerifiedDriver();
    const res = await online(driver.accessToken);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      state: 'ONLINE',
      locationFreshness: 'fresh',
      accuracyMeters: 8,
    });
    expect(res.body.data.updateIntervalsMs.idle).toBe(10000);
    expect((await status(driver.accessToken)).body.data.state).toBe('ONLINE');
    expect(await getLiveFix(driver.user.id as string)).not.toBeNull();
  });

  it('refuses an unverified driver and leaves them offline, with the reason', async () => {
    const d = await onboardUser('DRIVER');
    const res = await online(d.accessToken);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_ELIGIBLE');
    expect(res.body.error.details.reasons.join(' ')).toMatch(/verification/i);
    expect((await status(d.accessToken)).body.data.state).toBe('OFFLINE');
    expect(
      (await events(d.user.id as string)).some((e) => e.event_type === 'GO_ONLINE_REFUSED'),
    ).toBe(true);
  });

  it('cannot be bypassed by putting anything extra in the request', async () => {
    const d = await onboardUser('DRIVER');
    for (const extra of [{ eligible: true }, { state: 'ONLINE' }, { driverId: d.user.id }]) {
      const res = await online(d.accessToken, sample(extra));
      expect(res.status).toBe(400); // strict schema
    }
    expect((await status(d.accessToken)).body.data.state).toBe('OFFLINE');
  });

  it('removes a driver from availability the moment an admin suspends them, and refuses them afterwards', async () => {
    const { driver, adminToken } = await createVerifiedDriver();
    expect((await online(driver.accessToken)).status).toBe(200);

    const suspend = await api
      .post(`/api/v1/admin/drivers/${driver.user.id}/suspend`)
      .set(auth(adminToken))
      .send({ reason: 'Safety complaint under review' });
    expect(suspend.status).toBe(200);

    const s = (await status(driver.accessToken)).body.data;
    expect(s.state).toBe('SUSPENDED');
    expect(s.reason).toBe('ACCOUNT_SUSPENDED');
    expect(await getLiveFix(driver.user.id as string)).toBeNull();
    const stored = await pool.query('SELECT 1 FROM driver_last_locations WHERE driver_id = $1', [
      driver.user.id,
    ]);
    expect(stored.rowCount).toBe(0);

    const again = await online(driver.accessToken);
    expect(again.status).toBe(403);
    expect(again.body.error.details.reasons.join(' ')).toMatch(/suspended/i);
  });

  it('refuses a driver whose vehicle is no longer approved', async () => {
    const { driver, adminToken } = await createVerifiedDriver();
    const reject = await api
      .post(`/api/v1/admin/vehicles/${driver.vehicleId}/reject`)
      .set(auth(adminToken))
      .send({ reason: 'Insurance certificate unreadable' });
    expect(reject.status).toBe(200);
    const res = await online(driver.accessToken);
    expect(res.status).toBe(403);
    expect(res.body.error.details.reasons.join(' ')).toMatch(/vehicle/i);
  });

  it('refuses a driver who is already on an active trip', async () => {
    const { driver } = await createVerifiedDriver();
    const passenger = await onboardUser('PASSENGER');
    expect((await online(driver.accessToken)).status).toBe(200);
    expect((await requestRide(passenger.accessToken)).status).toBe(201);
    expect((await acceptCurrentOffer(driver.accessToken)).status).toBe(200);
    expect((await offline(driver.accessToken)).status).toBe(200);
    const res = await online(driver.accessToken);
    expect(res.status).toBe(403);
    expect(res.body.error.details.reasons.join(' ')).toMatch(/active trip/i);
  });

  it('needs an accurate, recent, valid opening fix', async () => {
    const { driver } = await createVerifiedDriver();
    const weak = await online(driver.accessToken, sample({ accuracyMeters: 400 }));
    expect([422, 422]).toContain(weak.status);
    expect(
      (await online(driver.accessToken, sample({ accuracyMeters: 150 }))).body.error.code,
    ).toBe('WEAK_GPS_ACCURACY');
    expect(
      (await online(driver.accessToken, sample({ accuracyMeters: null }))).body.error.code,
    ).toBe('WEAK_GPS_ACCURACY');
    const old = await online(driver.accessToken, sample({ deviceTimeMs: Date.now() - 120_000 }));
    expect(old.body.error.code).toBe('STALE_LOCATION');
    for (const bad of [
      { latitude: 91 },
      { longitude: -181 },
      { accuracyMeters: -3 },
      { latitude: 0, longitude: 0 },
    ]) {
      expect((await online(driver.accessToken, sample(bad))).status).toBe(400);
    }
    expect((await status(driver.accessToken)).body.data.state).toBe('OFFLINE'); // every failure left them offline
  });

  it('is limited to authenticated drivers', async () => {
    expect((await api.post('/api/v1/drivers/me/availability/online').send(sample())).status).toBe(
      401,
    );
    const passenger = await onboardUser('PASSENGER');
    expect((await online(passenger.accessToken)).status).toBe(403);
    expect((await status(passenger.accessToken)).status).toBe(403);
  });
});

describe('going offline & repeated requests', () => {
  it('goes offline, stops being visible, and keeps an audit trail', async () => {
    const { driver } = await createVerifiedDriver();
    await online(driver.accessToken);
    const res = await offline(driver.accessToken);
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe('OFFLINE');
    expect(res.body.data.locationFreshness).toBe('none');
    expect(await getLiveFix(driver.user.id as string)).toBeNull();
    expect(
      (
        await pool.query('SELECT 1 FROM driver_last_locations WHERE driver_id = $1', [
          driver.user.id,
        ])
      ).rowCount,
    ).toBe(0);
    const trail = (await events(driver.user.id as string)).map(
      (e) => `${e.from_state}>${e.to_state}`,
    );
    expect(trail).toEqual([
      'OFFLINE>GOING_ONLINE',
      'GOING_ONLINE>ONLINE',
      'ONLINE>GOING_OFFLINE',
      'GOING_OFFLINE>OFFLINE',
    ]);
  });

  it('handles repeated online and offline requests safely', async () => {
    const { driver } = await createVerifiedDriver();
    expect((await online(driver.accessToken)).status).toBe(200);
    expect((await online(driver.accessToken)).status).toBe(200); // idempotent
    const becameOnline = (await events(driver.user.id as string)).filter(
      (e) => e.to_state === 'ONLINE',
    );
    expect(becameOnline).toHaveLength(1);

    expect((await offline(driver.accessToken)).status).toBe(200);
    expect((await offline(driver.accessToken)).status).toBe(200); // idempotent
    expect((await status(driver.accessToken)).body.data.state).toBe('OFFLINE');
  });

  it('survives simultaneous Go Online taps: one wins the transition, state stays consistent', async () => {
    const { driver } = await createVerifiedDriver();
    const results = await Promise.all(Array.from({ length: 6 }, () => online(driver.accessToken)));
    for (const r of results) expect([200, 409]).toContain(r.status);
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect((await status(driver.accessToken)).body.data.state).toBe('ONLINE');
    const started = (await events(driver.user.id as string)).filter(
      (e) => e.to_state === 'GOING_ONLINE',
    );
    expect(started).toHaveLength(1);
  });

  it('stays consistent when Go Offline races a pending Go Online', async () => {
    for (let i = 0; i < 3; i++) {
      const { driver } = await createVerifiedDriver();
      const [a, b] = await Promise.all([online(driver.accessToken), offline(driver.accessToken)]);
      expect([200, 409]).toContain(a.status);
      expect([200, 409]).toContain(b.status);
      const s = (await status(driver.accessToken)).body.data;
      const live = await getLiveFix(driver.user.id as string);
      if (s.state === 'ONLINE') expect(live).not.toBeNull();
      else {
        expect(['OFFLINE']).toContain(s.state);
        expect(live).toBeNull(); // never an "offline" driver with a live position
      }
    }
  });

  it('rolls back a GOING_ONLINE that never completed', async () => {
    const { driver } = await createVerifiedDriver();
    await online(driver.accessToken);
    await offline(driver.accessToken);
    await pool.query(
      "UPDATE driver_availability SET state = 'GOING_ONLINE', state_changed_at = now() - interval '5 minutes' WHERE driver_id = $1",
      [driver.user.id],
    );
    const swept = await sweepDrivers();
    expect(swept.rolledBack).toContain(driver.user.id);
    expect((await status(driver.accessToken)).body.data.state).toBe('OFFLINE');
  });
});

describe('location updates, freshness and stale handling', () => {
  it('accepts valid updates, records heading and speed, and stores the server receive time', async () => {
    const { driver } = await createVerifiedDriver();
    const id = driver.user.id as string;
    const t0 = Date.now();
    await online(driver.accessToken, sample({ deviceTimeMs: t0 }));
    const now = t0;
    const r = await ingestLocation(
      id,
      {
        ...north(THAMEL, 40),
        accuracyMeters: 6,
        headingDegrees: 90,
        speedMps: 5,
        deviceTimeMs: now + 5000,
      },
      now + 5000,
    );
    expect(r, JSON.stringify(r)).toMatchObject({ accepted: true, freshness: 'fresh' });
    const row = (
      await pool.query(
        'SELECT heading_degrees, speed_mps FROM driver_last_locations WHERE driver_id = $1',
        [id],
      )
    ).rows[0];
    expect(row).toMatchObject({ heading_degrees: 90, speed_mps: 5 });
  });

  it('rejects out-of-order, duplicate, stale and unusable updates', async () => {
    const { driver } = await createVerifiedDriver();
    const id = driver.user.id as string;
    const t0 = Date.now();
    await online(driver.accessToken, sample({ deviceTimeMs: t0 }));
    const at = (over: Record<string, unknown>, now: number) =>
      ingestLocation(
        id,
        { ...THAMEL, accuracyMeters: 8, deviceTimeMs: now, ...over } as never,
        now,
      );

    expect(await at({ deviceTimeMs: t0 + 4000 }, t0 + 4000)).toMatchObject({ accepted: true });
    expect(await at({ deviceTimeMs: t0 + 4000 }, t0 + 5000)).toMatchObject({
      accepted: false,
      reason: 'duplicate',
    });
    expect(await at({ deviceTimeMs: t0 + 2000 }, t0 + 5000)).toMatchObject({
      accepted: false,
      reason: 'out_of_order',
    });
    expect(await at({ deviceTimeMs: t0 - 90_000 }, t0 + 6000)).toMatchObject({
      accepted: false,
      reason: 'stale',
    });
    expect(await at({ deviceTimeMs: t0 + 500_000 }, t0 + 6000)).toMatchObject({
      accepted: false,
      reason: 'clock_skew',
    });
    expect(await at({ deviceTimeMs: t0 + 9000, accuracyMeters: 900 }, t0 + 9000)).toMatchObject({
      accepted: false,
      reason: 'low_accuracy',
    });
  });

  it('ignores updates from a driver who is not online', async () => {
    const { driver } = await createVerifiedDriver();
    const now = Date.now();
    expect(
      await ingestLocation(
        driver.user.id as string,
        { ...THAMEL, accuracyMeters: 5, deviceTimeMs: now },
        now,
      ),
    ).toEqual({ accepted: false, reason: 'not_online' });
    expect(await getLiveFix(driver.user.id as string)).toBeNull();
  });

  it('flags suspicious data without punishing the driver', async () => {
    const { driver } = await createVerifiedDriver();
    const id = driver.user.id as string;
    const t0 = Date.now();
    await online(driver.accessToken, sample({ deviceTimeMs: t0 }));

    await ingestLocation(
      id,
      { ...THAMEL, accuracyMeters: 5, deviceTimeMs: t0 + 3000, mockLocation: true },
      t0 + 3000,
    );
    await ingestLocation(
      id,
      { ...THAMEL, accuracyMeters: 5, deviceTimeMs: t0 + 6000, speedMps: 120 },
      t0 + 6000,
    );
    await ingestLocation(
      id,
      { ...north(THAMEL, 50_000), accuracyMeters: 5, deviceTimeMs: t0 + 9000 },
      t0 + 9000,
    );
    // A repeat within the minute does not spam the table.
    await ingestLocation(
      id,
      { ...THAMEL, accuracyMeters: 5, deviceTimeMs: t0 + 12_000, mockLocation: true },
      t0 + 12_000,
    );

    const kinds = (
      await pool.query('SELECT kind FROM driver_location_flags WHERE driver_id = $1 ORDER BY id', [
        id,
      ])
    ).rows.map((r) => r.kind);
    expect(kinds).toEqual(['MOCK_LOCATION', 'IMPLAUSIBLE_SPEED', 'LOCATION_JUMP']);
    expect((await status((driver as { accessToken: string }).accessToken)).body.data.state).toBe(
      'ONLINE',
    );
  });

  it('marks silent drivers stale, unmatchable, then UNAVAILABLE — never online forever', async () => {
    const { driver } = await createVerifiedDriver();
    const id = driver.user.id as string;
    const t0 = Date.now();
    await online(driver.accessToken, sample({ deviceTimeMs: t0 }));

    expect((await getStatus(id, t0 + 10_000)).locationFreshness).toBe('fresh');
    const stale = await getStatus(id, t0 + 45_000);
    expect(stale.locationFreshness).toBe('stale');
    expect(isMatchable(stale.state, stale.locationFreshness)).toBe(false);

    const first = await sweepDrivers(t0 + 45_000);
    expect(first.notifiedStale).toContain(id);
    expect((await sweepDrivers(t0 + 46_000)).notifiedStale).not.toContain(id); // told once
    expect((await getStatus(id, t0 + 46_000)).state).toBe('ONLINE');

    const late = await sweepDrivers(t0 + 200_000);
    expect(late.markedUnavailable).toContain(id);
    const s = (await status(driver.accessToken)).body.data;
    expect(s.state).toBe('UNAVAILABLE');
    expect(s.reason).toBe('STALE_LOCATION');
    expect(await getLiveFix(id)).toBeNull();
    expect((await events(id)).at(-1)).toMatchObject({
      from_state: 'ONLINE',
      to_state: 'UNAVAILABLE',
      reason: 'STALE_LOCATION',
    });

    // The driver has to confirm again; the old shift does not silently resume.
    expect((await online(driver.accessToken, sample({ deviceTimeMs: Date.now() }))).status).toBe(
      200,
    );
  });

  it('keeps a live update from resurrecting a driver the sweeper took offline', async () => {
    const { driver } = await createVerifiedDriver();
    const id = driver.user.id as string;
    const t0 = Date.now();
    await online(driver.accessToken, sample({ deviceTimeMs: t0 }));
    await sweepDrivers(t0 + 500_000);
    const r = await ingestLocation(
      id,
      { ...THAMEL, accuracyMeters: 5, deviceTimeMs: t0 + 1000 },
      t0 + 1000,
    );
    expect(r).toEqual({ accepted: false, reason: 'not_online' });
  });
});

describe('privacy & admin RBAC', () => {
  it('exposes no driver location to passengers or other drivers', async () => {
    const { driver } = await createVerifiedDriver();
    const other = await onboardUser('DRIVER');
    const passenger = await onboardUser('PASSENGER');
    await online(driver.accessToken);

    expect(
      (await api.get('/api/v1/drivers/me/location').set(auth(passenger.accessToken))).status,
    ).toBe(403);
    expect(
      (await api.get('/api/v1/drivers/me/availability').set(auth(passenger.accessToken))).status,
    ).toBe(403);
    // Another driver's "me" is only ever their own (nothing shared yet -> 404), never driver A's.
    expect((await api.get('/api/v1/drivers/me/location').set(auth(other.accessToken))).status).toBe(
      404,
    );
    expect((await status(other.accessToken)).body.data.lastLocationAt).toBeNull();
    // There is no public route to read a driver's position.
    expect([403, 404]).toContain(
      (await api.get(`/api/v1/drivers/${driver.user.id}/location`).set(auth(passenger.accessToken)))
        .status,
    );
    expect([403, 404]).toContain(
      (
        await api
          .get(`/api/v1/drivers/${driver.user.id}/availability`)
          .set(auth(passenger.accessToken))
      ).status,
    );
  });

  it('shows admins availability, but exact coordinates only with DRIVER_LOCATION_VIEW (audited)', async () => {
    const { driver } = await createVerifiedDriver();
    await online(driver.accessToken);
    const plain = await loginTestAdmin(
      `plain-${Date.now()}@yatri.local`,
      'a-strong-test-password-1',
    );
    const privEmail = `priv-${Date.now()}@yatri.local`;
    const privileged = await loginTestAdmin(privEmail, 'a-strong-test-password-1');
    await pool.query(
      "UPDATE users SET admin_permissions = ARRAY['DRIVER_LOCATION_VIEW'] WHERE email = $1",
      [privEmail],
    );

    const asPlain = await api
      .get('/api/v1/admin/availability/drivers?state=ONLINE')
      .set(auth(plain));
    expect(asPlain.status).toBe(200);
    expect(asPlain.body.data.canViewLocation).toBe(false);
    const rowPlain = asPlain.body.data.items.find(
      (i: { driverId: string }) => i.driverId === driver.user.id,
    );
    expect(rowPlain).toMatchObject({
      availabilityState: 'ONLINE',
      online: true,
      locationFreshness: 'fresh',
    });
    expect(rowPlain.location).toBeNull();
    expect(JSON.stringify(asPlain.body)).not.toContain('27.7154');

    const asPriv = await api
      .get('/api/v1/admin/availability/drivers?state=ONLINE')
      .set(auth(privileged));
    expect(asPriv.body.data.canViewLocation).toBe(true);
    const rowPriv = asPriv.body.data.items.find(
      (i: { driverId: string }) => i.driverId === driver.user.id,
    );
    expect(rowPriv.location).toMatchObject({ latitude: 27.7154, longitude: 85.3123 });
    const audit = await pool.query(
      "SELECT 1 FROM audit_log WHERE subject_id = $1 AND action = 'VIEW_DRIVER_LOCATION'",
      [driver.user.id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('filters and paginates on the server, and is admin-only', async () => {
    const a = await createVerifiedDriver();
    await onboardUser('DRIVER');
    await online(a.driver.accessToken);
    const admin = a.adminToken;

    const onlineOnly = await api
      .get('/api/v1/admin/availability/drivers?state=ONLINE')
      .set(auth(admin));
    expect(onlineOnly.body.data.total).toBe(1);
    const offlineOnly = await api
      .get('/api/v1/admin/availability/drivers?state=OFFLINE')
      .set(auth(admin));
    expect(offlineOnly.body.data.total).toBeGreaterThanOrEqual(1);
    const verified = await api
      .get('/api/v1/admin/availability/drivers?verification=VERIFIED')
      .set(auth(admin));
    expect(
      verified.body.data.items.every(
        (i: { verificationStatus: string }) => i.verificationStatus === 'VERIFIED',
      ),
    ).toBe(true);
    const paged = await api
      .get('/api/v1/admin/availability/drivers?pageSize=1&page=1')
      .set(auth(admin));
    expect(paged.body.data.items).toHaveLength(1);
    expect(paged.body.data.total).toBeGreaterThanOrEqual(2);
    expect(
      (await api.get('/api/v1/admin/availability/drivers?pageSize=500').set(auth(admin))).status,
    ).toBe(400);
    expect(
      (await api.get('/api/v1/admin/availability/drivers?state=BOGUS').set(auth(admin))).status,
    ).toBe(400);
    expect(
      (await api.get('/api/v1/admin/availability/drivers').set(auth(a.driver.accessToken))).status,
    ).toBe(403);
    expect((await api.get('/api/v1/admin/availability/drivers')).status).toBe(401);

    // Stale filter: age the persisted sample past the threshold.
    await pool.query(
      "UPDATE driver_last_locations SET recorded_at = now() - interval '10 minutes'",
    );
    const stale = await api
      .get('/api/v1/admin/availability/drivers?freshness=stale')
      .set(auth(admin));
    expect(stale.body.data.total).toBe(1);
  });
});

describe('redis is only a cache of hot state', () => {
  it('recovers state from Postgres if the Redis mirror is lost', async () => {
    const { driver } = await createVerifiedDriver();
    const t0 = Date.now();
    await online(driver.accessToken, sample({ deviceTimeMs: t0 }));
    await getRedisClient().del(`drv:${driver.user.id}:state`);
    const now = t0;
    const r = await ingestLocation(
      driver.user.id as string,
      { ...THAMEL, accuracyMeters: 5, deviceTimeMs: now + 2000 },
      now + 2000,
    );
    expect(r.accepted).toBe(true); // state re-read from the database
    await goOffline(driver.user.id as string);
    expect((await getStatus(driver.user.id as string)).state).toBe('OFFLINE');
    void goOnline;
  });
});
