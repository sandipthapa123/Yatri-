import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getLiveFix, getSeen, setLiveFix } from '../modules/availability/presence.state';
import { sweepDrivers } from '../modules/availability/availability.service';
import { api, createVerifiedDriver, onboardUser } from './helpers';
import { Client, startTestServer, type Msg } from './wsClient';

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

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const THAMEL = { latitude: 27.7154, longitude: 85.3123 };
const fix = (over: Record<string, unknown> = {}) => ({
  ...THAMEL,
  accuracyMeters: 8,
  deviceTimeMs: Date.now(),
  ...over,
});

async function connect(token: string): Promise<Client> {
  const c = await Client.connect(port);
  c.send({ type: 'auth', token });
  await c.waitFor((m) => m.type === 'authed');
  return c;
}
const availability = (m: Msg) => m.type === 'availability';

describe('driver presence over WebSocket', () => {
  it('greets an authenticated driver with connection info and current availability', async () => {
    const { driver } = await createVerifiedDriver();
    const c = await connect(driver.accessToken);
    const conn = await c.waitFor((m) => m.type === 'connection');
    expect(conn).toMatchObject({ status: 'connected', updateIntervalMs: 10000 });
    const a = await c.waitFor(availability);
    expect(a.status.state).toBe('OFFLINE');
    expect(a.status.eligibility.eligible).toBe(true);
    await c.close();
  });

  it('rejects unauthenticated presence messages and closes the socket', async () => {
    const c = await Client.connect(port);
    c.send({ type: 'location', ...fix() });
    await c.waitFor((m) => m.type === 'error' && m.code === 'UNAUTHENTICATED');
    await c.waitFor(() => false).catch(() => undefined);
    expect(c.closed?.code).toBe(4401);
  });

  it('goes online, streams locations with acknowledgements, and goes offline', async () => {
    const { driver } = await createVerifiedDriver();
    const c = await connect(driver.accessToken);
    await c.waitFor(availability);

    c.send({ type: 'availability', action: 'online', location: fix() });
    const on = await c.waitFor((m) => availability(m) && m.status.state === 'ONLINE');
    expect(on.status.locationFreshness).toBe('fresh');

    c.send({
      type: 'location',
      ...fix({ deviceTimeMs: Date.now() + 1000, headingDegrees: 45, speedMps: 3 }),
    });
    const ack = await c.waitFor((m) => m.type === 'location_ack');
    expect(ack.freshness).toBe('fresh');
    expect(new Date(ack.receivedAt).getTime()).toBeGreaterThan(Date.now() - 5000);

    c.send({ type: 'availability', action: 'offline' });
    const off = await c.waitFor((m) => availability(m) && m.status.state === 'OFFLINE');
    expect(off.status.locationFreshness).toBe('none');
    expect(await getLiveFix(driver.user.id as string)).toBeNull();

    // After offline, location messages are not accepted and never resurrect the driver.
    c.send({ type: 'location', ...fix({ deviceTimeMs: Date.now() + 2000 }) });
    expect((await c.waitFor((m) => m.type === 'rejected')).reason).toBe('not_online');
  });

  it('explains why a driver cannot go online, and leaves them offline', async () => {
    const d = await onboardUser('DRIVER');
    const c = await connect(d.accessToken);
    await c.waitFor(availability);
    c.send({ type: 'availability', action: 'online', location: fix() });
    const err = await c.waitFor((m) => m.type === 'availability_error');
    expect(err.code).toBe('NOT_ELIGIBLE');
    const s = await api.get('/api/v1/drivers/me/availability').set(auth(d.accessToken));
    expect(s.body.data.state).toBe('OFFLINE');
  });

  it('identifies the driver from the connection: a driverId in a message is a protocol error', async () => {
    const a = await createVerifiedDriver();
    const b = await createVerifiedDriver();
    const ca = await connect(a.driver.accessToken);
    await ca.waitFor(availability);
    const cb = await connect(b.driver.accessToken);
    await cb.waitFor(availability);
    cb.send({ type: 'availability', action: 'online', location: fix() });
    await cb.waitFor((m) => availability(m) && m.status.state === 'ONLINE');

    ca.send({ type: 'location', driverId: b.driver.user.id, ...fix({ latitude: 28.2 }) });
    await ca.waitFor((m) => m.type === 'error' && m.code === 'BAD_MESSAGE');
    ca.send({ type: 'availability', action: 'offline', driverId: b.driver.user.id });
    await ca.waitFor((m) => m.type === 'error' && m.code === 'BAD_MESSAGE');

    // B is untouched.
    const live = await getLiveFix(b.driver.user.id as string);
    expect(live?.fix.latitude).toBe(THAMEL.latitude);
    const s = await api.get('/api/v1/drivers/me/availability').set(auth(b.driver.accessToken));
    expect(s.body.data.state).toBe('ONLINE');
  });

  it('never lets a passenger use driver presence messages', async () => {
    const p = await onboardUser('PASSENGER');
    const c = await connect(p.accessToken);
    c.send({ type: 'location', ...fix() });
    expect((await c.waitFor((m) => m.type === 'availability_error')).code).toBe('FORBIDDEN');
    c.send({ type: 'availability', action: 'online', location: fix() });
    expect((await c.waitFor((m) => m.type === 'availability_error')).code).toBe('FORBIDDEN');
  });

  it('rejects malformed locations at the protocol level', async () => {
    const { driver } = await createVerifiedDriver();
    const c = await connect(driver.accessToken);
    await c.waitFor(availability);
    for (const bad of [
      { latitude: 91 },
      { longitude: 200 },
      { latitude: 'x' },
      { accuracyMeters: -5 },
      { accuracyMeters: 'good' },
      { headingDegrees: 400 },
      { speedMps: -1 },
      { deviceTimeMs: 'now' },
    ]) {
      c.send({ type: 'location', ...fix(bad) });
      await c.waitFor((m) => m.type === 'error' && m.code === 'BAD_MESSAGE');
      await new Promise((r) => setTimeout(r, 150)); // stay under the per-socket message rate limit
    }
  });

  it('answers heartbeats and records the driver as seen', async () => {
    const { driver } = await createVerifiedDriver();
    const c = await connect(driver.accessToken);
    await c.waitFor(availability);
    const before = (await getSeen(driver.user.id as string)) ?? 0;
    await new Promise((r) => setTimeout(r, 20));
    c.send({ type: 'ping' });
    await c.waitFor((m) => m.type === 'pong');
    expect((await getSeen(driver.user.id as string)) ?? 0).toBeGreaterThan(before);
  });

  it('a newer connection supersedes the older one, so two devices never fight over the shift', async () => {
    const { driver } = await createVerifiedDriver();
    const first = await connect(driver.accessToken);
    await first.waitFor(availability);
    const second = await connect(driver.accessToken);
    await second.waitFor(availability);

    const sup = await first.waitFor((m) => m.type === 'connection' && m.status === 'superseded');
    expect(sup).toBeTruthy();
    await first.waitFor(() => false).catch(() => undefined);
    expect(first.closed?.code).toBe(4409);

    second.send({ type: 'availability', action: 'online', location: fix() });
    await second.waitFor((m) => availability(m) && m.status.state === 'ONLINE');
  });

  it('a network blip does not cost the shift; reconnecting resumes updates', async () => {
    const { driver } = await createVerifiedDriver();
    let c = await connect(driver.accessToken);
    await c.waitFor(availability);
    c.send({ type: 'availability', action: 'online', location: fix() });
    await c.waitFor((m) => availability(m) && m.status.state === 'ONLINE');

    await c.close(); // connection drops
    const still = await api.get('/api/v1/drivers/me/availability').set(auth(driver.accessToken));
    expect(still.body.data.state).toBe('ONLINE'); // staleness, not the socket, decides this

    c = await connect(driver.accessToken); // driver comes back
    const resumed = await c.waitFor(availability);
    expect(resumed.status.state).toBe('ONLINE');
    c.send({ type: 'location', ...fix({ deviceTimeMs: Date.now() + 3000 }) });
    expect((await c.waitFor((m) => m.type === 'location_ack')).freshness).toBe('fresh');
  });

  it('after a disconnect the driver goes stale and is told on return, instead of staying online forever', async () => {
    const { driver } = await createVerifiedDriver();
    const c = await connect(driver.accessToken);
    await c.waitFor(availability);
    c.send({ type: 'availability', action: 'online', location: fix() });
    await c.waitFor((m) => availability(m) && m.status.state === 'ONLINE');
    await c.close();

    await sweepDrivers(Date.now() + 200_000); // no updates for longer than the stale timeout

    const back = await connect(driver.accessToken);
    const a = await back.waitFor(availability);
    expect(a.status).toMatchObject({ state: 'UNAVAILABLE', reason: 'STALE_LOCATION' });
    expect(a.status.eligibility.eligible).toBe(true); // can simply go online again
  });

  it('pushes availability changes to a connected driver (e.g. an admin suspension)', async () => {
    const { driver, adminToken } = await createVerifiedDriver();
    const c = await connect(driver.accessToken);
    await c.waitFor(availability);
    c.send({ type: 'availability', action: 'online', location: fix() });
    await c.waitFor((m) => availability(m) && m.status.state === 'ONLINE');

    await api
      .post(`/api/v1/admin/drivers/${driver.user.id}/suspend`)
      .set(auth(adminToken))
      .send({ reason: 'Under review pending investigation' });
    const pushed = await c.waitFor((m) => availability(m) && m.status.state === 'SUSPENDED');
    expect(pushed.status.reason).toBe('ACCOUNT_SUSPENDED');
  });

  it('tells a connected online driver when their location has gone stale', async () => {
    const { driver } = await createVerifiedDriver();
    const c = await connect(driver.accessToken);
    await c.waitFor(availability);
    c.send({ type: 'availability', action: 'online', location: fix() });
    await c.waitFor((m) => availability(m) && m.status.state === 'ONLINE');

    // Age the live fix by 45 s (the gateway judges freshness with the real clock), then sweep.
    const live = await getLiveFix(driver.user.id as string);
    await setLiveFix(driver.user.id as string, {
      ...live!,
      fix: { ...live!.fix, receivedAtMs: Date.now() - 45_000 },
    });
    await sweepDrivers();
    const pushed = await c.waitFor(
      (m) => availability(m) && m.status.locationFreshness === 'stale',
    );
    expect(pushed.status.state).toBe('ONLINE');
  });
});
