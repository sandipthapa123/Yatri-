import { createHash } from 'node:crypto';

import { SHARE_TOKEN_PATTERN, describeShareView, describeTripEvent } from '@yatri/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '../config/env';
import { pool } from '../config/database';
import { expireDueShares } from '../modules/sharing/sharing.service';
import { api, onboardUser } from './helpers';
import {
  THAMEL,
  arriveAtPickup,
  auth,
  backdate,
  driverAt,
  north,
  rideWorld,
  type RideWorld,
} from './rides';
import { login, startTestServer, type Msg } from './wsClient';

let port = 0;
let stop: () => Promise<void>;
beforeAll(async () => {
  const s = await startTestServer();
  port = s.port;
  stop = s.close;
});
afterAll(async () => {
  await stop();
});

const create = (token: string, tripId: string) =>
  api.post(`/api/v1/trips/${tripId}/shares`).set(auth(token));
const tokenFrom = (url: string) => url.split('/share/')[1] as string;
const data = (token: string) => api.get(`/share/${token}/data`);
const events = async (token: string, tripId: string) =>
  (await api.get(`/api/v1/trips/${tripId}/events`).set(auth(token))).body.data as Array<{
    seq: number;
    type: string;
    payload: Record<string, unknown>;
  }>;
const shared = async (w: RideWorld) => {
  const res = await create(w.passenger.accessToken, w.tripId);
  expect(res.status).toBe(201);
  return { ...res.body.data, token: tokenFrom(res.body.data.url) } as {
    shareId: string;
    url: string;
    expiresAt: string;
    token: string;
  };
};

describe('who may create a share', () => {
  it('only the ride’s passenger, only with a driver assigned, only while the ride is live', async () => {
    const w = await rideWorld();
    const stranger = await onboardUser('PASSENGER');
    expect((await create(w.driver.accessToken, w.tripId)).status).toBe(403);
    expect((await create(stranger.accessToken, w.tripId)).status).toBe(404); // same as a missing ride
    expect((await api.post(`/api/v1/trips/${w.tripId}/shares`)).status).toBe(401);
    // nobody else's ride, nobody else's list
    expect(
      (await api.get(`/api/v1/trips/${w.tripId}/shares`).set(auth(stranger.accessToken))).status,
    ).toBe(404);
    expect(
      (await api.get(`/api/v1/trips/${w.tripId}/shares`).set(auth(w.driver.accessToken))).status,
    ).toBe(403);

    // still searching: there is no driver to share yet
    const p2 = await onboardUser('PASSENGER');
    const searching = await api
      .post('/api/v1/trips/request')
      .set(auth(p2.accessToken))
      .send({
        pickup: THAMEL,
        destination: { latitude: 27.6727, longitude: 85.325, address: 'Patan' },
        vehicleCategory: 'CAR',
      });
    expect(searching.status).toBe(201);
    const early = await create(p2.accessToken, searching.body.data.id);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('SHARE_NOT_AVAILABLE');

    // finished rides cannot be shared
    await arriveAtPickup(w);
    await api.post(`/api/v1/trips/${w.tripId}/start`).set(auth(w.driver.accessToken));
    await api.post(`/api/v1/trips/${w.tripId}/complete`).set(auth(w.driver.accessToken));
    expect((await create(w.passenger.accessToken, w.tripId)).status).toBe(409);
  });

  it('keeps the number of live links per ride to the limit, even under a burst', async () => {
    const w = await rideWorld();
    const burst = await Promise.all(
      Array.from({ length: env.SHARE_MAX_PER_TRIP + 3 }, () =>
        create(w.passenger.accessToken, w.tripId),
      ),
    );
    expect(burst.filter((r) => r.status === 201)).toHaveLength(env.SHARE_MAX_PER_TRIP);
    const refused = burst.find((r) => r.status === 409);
    expect(refused?.body.error.code).toBe('SHARE_LIMIT');
  });
});

describe('the secret', () => {
  it('is 32 random bytes, shown once, and only its hash is stored', async () => {
    const w = await rideWorld();
    const s = await shared(w);
    expect(s.url.startsWith(`${env.PUBLIC_BASE_URL}/share/`)).toBe(true);
    expect(SHARE_TOKEN_PATTERN.test(s.token)).toBe(true);
    const second = await shared(w);
    expect(second.token).not.toBe(s.token);

    const rows = await pool.query('SELECT token_hash FROM trip_shares WHERE id = $1', [s.shareId]);
    expect(rows.rows[0].token_hash).toBe(createHash('sha256').update(s.token).digest('hex'));
    const raw = await pool.query(
      'SELECT count(*)::int AS n FROM trip_shares WHERE token_hash = $1',
      [s.token],
    );
    expect(raw.rows[0].n).toBe(0); // the secret itself is nowhere in the table

    const list = (
      await api.get(`/api/v1/trips/${w.tripId}/shares`).set(auth(w.passenger.accessToken))
    ).body.data;
    expect(list).toHaveLength(2);
    expect(JSON.stringify(list)).not.toContain(s.token);
    expect(list.every((x: { active: boolean }) => x.active)).toBe(true);
  });
});

describe('what the link holder sees', () => {
  it('shows the driver, vehicle, status, location, destination and arrival — and nothing personal', async () => {
    const w = await rideWorld();
    await pool.query('UPDATE users SET full_name = $2, phone_number = $3 WHERE id = $1', [
      w.driverId,
      'Ram Bahadur Thapa',
      '+977981111111',
    ]);
    await pool.query('UPDATE users SET full_name = $2 WHERE id = $1', [
      w.passengerId,
      'Sita Sharma',
    ]);
    const s = await shared(w);
    await driverAt(w.tripId, w.driverId, north(THAMEL, 240));

    const res = await data(s.token);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-robots-tag']).toContain('noindex');
    const { view, headline, details } = res.body.data;
    expect(view).toMatchObject({
      status: 'DRIVER_EN_ROUTE',
      ended: false,
      driver: { firstName: 'Ram', vehicle: 'White Toyota Corolla' },
      distanceTo: 'pickup',
      destination: { name: 'Patan Durbar Square' },
    });
    expect(view.driver.registration).toMatch(/^T-/);
    expect(view.distanceMeters).toBeGreaterThan(200);
    expect(view.distanceMeters).toBeLessThan(280);
    expect(view.etaSeconds).toBeGreaterThan(0);
    expect(view.location).toMatchObject({ freshness: 'live' });
    expect({ headline, details }).toEqual(describeShareView(view)); // the words come from the one function
    expect(headline).toBe('Ram is on the way to pick up the rider.');
    expect(details.join(' ')).toMatch(/The driver is 2\d\d meters from the pickup\./);

    // nothing that identifies anyone beyond the driver's first name
    const text = JSON.stringify(res.body);
    for (const secret of [
      'Thapa',
      'Sita',
      'Sharma',
      '+977981111111',
      w.passengerId,
      w.driverId,
      w.tripId,
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it('follows the ride live: arrival with the driver’s waiting time, then the trip to the destination', async () => {
    const w = await rideWorld();
    const s = await shared(w);
    await arriveAtPickup(w);
    await backdate(w.tripId, 'arrived_at', 200);
    let v = (await data(s.token)).body.data;
    expect(v.view).toMatchObject({ status: 'DRIVER_ARRIVED' });
    expect(v.view.waitingSeconds).toBeGreaterThanOrEqual(200);
    expect(v.headline).toMatch(/has arrived at the pickup\.$/);
    expect(v.details.join(' ')).toMatch(/The driver has waited 3 minutes/);

    await api.post(`/api/v1/trips/${w.tripId}/start`).set(auth(w.driver.accessToken));
    await driverAt(w.tripId, w.driverId, north(THAMEL, 120));
    v = (await data(s.token)).body.data;
    expect(v.view).toMatchObject({ status: 'IN_PROGRESS', distanceTo: 'destination' });
    expect(v.view.distanceMeters).toBeGreaterThan(4000);
    expect(v.headline).toBe('The trip is under way.');
  });

  it('renders an accessible page with the same words, a script nonce, and escaped text', async () => {
    const w = await rideWorld();
    await pool.query('UPDATE users SET full_name = $2 WHERE id = $1', [
      w.driverId,
      '<script>alert(1)</script> Ram',
    ]);
    const s = await shared(w);
    const res = await api.get(`/share/${s.token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    const csp = res.headers['content-security-policy'] as string;
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1] as string;
    expect(nonce).toBeTruthy();
    expect(res.text).toContain(`<script nonce="${nonce}">`);
    expect(csp).toContain("default-src 'none'");
    expect(res.text).toContain('lang="en"');
    expect(res.text).toContain('role="status" aria-live="polite"');
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&#60;script&#62;alert(1)&#60;/script&#62;');
    expect(res.text).toContain('is on the way to pick up the rider.');
  });
});

describe('a link that is not a working link', () => {
  it('gives every failure the same answer, so a link cannot be probed', async () => {
    const w = await rideWorld();
    const s = await shared(w);
    const missing = 'A'.repeat(43);
    const answers = await Promise.all([
      data('short'),
      data(missing),
      data(`${s.token}x`),
      api.get(`/share/${missing}`),
      api.get('/share/not-a-token'),
    ]);
    for (const a of answers) expect(a.status).toBe(404);
    expect(answers[0]?.body).toEqual(answers[1]?.body);
    expect(answers[3]?.text).toContain('This link is not available.');
    expect((await data(s.token)).status).toBe(200); // and the real one still works
  });

  it('stops the moment the passenger stops it, and says so to both people', async () => {
    const w = await rideWorld();
    const s = await shared(w);
    const other = await shared(w);
    expect((await data(s.token)).status).toBe(200);

    const stranger = await onboardUser('PASSENGER');
    expect(
      (
        await api
          .delete(`/api/v1/trips/${w.tripId}/shares/${s.shareId}`)
          .set(auth(stranger.accessToken))
      ).status,
    ).toBe(404);
    expect(
      (
        await api
          .delete(`/api/v1/trips/${w.tripId}/shares/${s.shareId}`)
          .set(auth(w.driver.accessToken))
      ).status,
    ).toBe(403);
    expect((await data(s.token)).status).toBe(200); // strangers changed nothing

    expect(
      (
        await api
          .delete(`/api/v1/trips/${w.tripId}/shares/${s.shareId}`)
          .set(auth(w.passenger.accessToken))
      ).status,
    ).toBe(200);
    expect((await data(s.token)).status).toBe(404);
    expect((await data(other.token)).status).toBe(200); // the other link is unaffected
    expect(
      (
        await api
          .delete(`/api/v1/trips/${w.tripId}/shares/${s.shareId}`)
          .set(auth(w.passenger.accessToken))
      ).status,
    ).toBe(200); // harmless twice
    expect(
      (
        await api
          .delete(`/api/v1/trips/${w.tripId}/shares/00000000-0000-4000-8000-000000000000`)
          .set(auth(w.passenger.accessToken))
      ).status,
    ).toBe(404);

    const stopped = (await events(w.passenger.accessToken, w.tripId)).filter(
      (e) => e.type === 'TRIP_SHARE_STOPPED',
    );
    expect(stopped).toHaveLength(1); // once, not once per call
    expect(describeTripEvent(stopped[0] as never, 'PASSENGER')).toBe(
      'You stopped sharing this trip.',
    );
    expect(describeTripEvent(stopped[0] as never, 'DRIVER')).toBe('Trip sharing has ended.');
  });

  it('shows the outcome and no location when the ride ends, stops sharing, then goes away after the grace', async () => {
    const w = await rideWorld();
    const s = await shared(w);
    await arriveAtPickup(w);
    await api.post(`/api/v1/trips/${w.tripId}/start`).set(auth(w.driver.accessToken));
    await api.post(`/api/v1/trips/${w.tripId}/complete`).set(auth(w.driver.accessToken));

    const v = (await data(s.token)).body.data;
    expect(v.view).toMatchObject({
      status: 'COMPLETED',
      ended: true,
      driver: null,
      location: null,
    });
    expect(v.headline).toBe('This trip is complete.');
    const list = (
      await api.get(`/api/v1/trips/${w.tripId}/shares`).set(auth(w.passenger.accessToken))
    ).body.data;
    expect(list[0].active).toBe(false);

    const ended = (await events(w.passenger.accessToken, w.tripId)).filter(
      (e) => e.type === 'TRIP_SHARE_STOPPED',
    );
    expect(ended).toHaveLength(1);
    expect(describeTripEvent(ended[0] as never, 'PASSENGER')).toBe(
      'Trip sharing ended because the ride is over.',
    );

    await pool.query("UPDATE trips SET ended_at = now() - interval '20 minutes' WHERE id = $1", [
      w.tripId,
    ]);
    expect((await data(s.token)).status).toBe(404); // past the grace
  });

  it('stops when the sharing period runs out, even mid-ride', async () => {
    const w = await rideWorld();
    const s = await shared(w);
    await pool.query(
      "UPDATE trip_shares SET expires_at = now() - interval '1 second' WHERE id = $1",
      [s.shareId],
    );
    expect((await data(s.token)).status).toBe(404); // dead at once, before any sweep runs
    expect(await expireDueShares()).toBe(1);
    expect(await expireDueShares()).toBe(0); // and the sweep is idempotent
    const ev = (await events(w.passenger.accessToken, w.tripId)).filter(
      (e) => e.type === 'TRIP_SHARE_STOPPED',
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload.reason).toBe('EXPIRED');
    expect(describeTripEvent(ev[0] as never, 'PASSENGER')).toBe(
      'Trip sharing ended: the sharing period is over.',
    );
  });

  it('keeps a link alive through a driver change (the ride goes back to searching)', async () => {
    const w = await rideWorld();
    const s = await shared(w);
    expect(
      (await api.post(`/api/v1/trips/${w.tripId}/cancel`).set(auth(w.driver.accessToken)).send({}))
        .status,
    ).toBe(200);
    const v = (await data(s.token)).body.data;
    expect(v.view).toMatchObject({ status: 'SEARCHING', driver: null, location: null });
    expect(v.headline).toBe('Looking for a driver.');
  });
});

describe('sharing is announced to the people on the ride, on every device', () => {
  it('tells the passenger’s phone and tablet and the driver, once, and raises a notification', async () => {
    const w = await rideWorld();
    const phone = await login(port, w.passenger.accessToken);
    const tablet = await login(port, w.passenger.accessToken);
    const dc = await login(port, w.driver.accessToken);
    await dc.waitFor((m) => m.type === 'availability');

    await shared(w);
    const isStart = (m: Msg) => m.type === 'trip_event' && m.event?.type === 'TRIP_SHARE_STARTED';
    const a = await phone.waitFor(isStart);
    const b = await tablet.waitFor(isStart);
    const c = await dc.waitFor(isStart);
    expect(a.event.seq).toBe(b.event.seq);
    expect(describeTripEvent(a.event, 'PASSENGER')).toBe(
      'You are sharing this trip with a trusted contact.',
    );
    expect(describeTripEvent(c.event, 'DRIVER')).toBe(
      'This trip is being shared with a trusted contact.',
    );
    expect(a.important).toBe(false); // announced politely, not as an alarm

    const note = await pool.query(
      "SELECT body FROM notifications WHERE user_id = $1 AND type = 'TRIP_TRIP_SHARE_STARTED'",
      [w.passengerId],
    );
    expect(note.rows).toHaveLength(1);
    expect(note.rows[0].body).toBe('You are sharing this trip with a trusted contact.');
    // the link itself is never in an event or a notification
    expect(JSON.stringify([a, c, note.rows])).not.toMatch(/\/share\//);
  });
});
