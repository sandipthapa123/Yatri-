import { describeIncomingCall, describeNewMessage } from '@yatri/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { activeCallProvider, webrtcProvider } from '../modules/calls/call-provider';
import { api } from './helpers';
import { arriveAtPickup, auth, rideWorld } from './rides';
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

let n = 0;
const send = (token: string, tripId: string, body: string) =>
  api
    .post(`/api/v1/trips/${tripId}/chat`)
    .set(auth(token))
    .send({ clientMessageId: `comm-${Date.now()}-${++n}-abcdef`, body });
const notes = async (userId: string, type: string) =>
  (
    await pool.query(
      'SELECT body, metadata FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY created_at',
      [userId, type],
    )
  ).rows as Array<{ body: string; metadata: Record<string, unknown> }>;

describe('notifications for communication go through the one notification system', () => {
  it('nudges the other person about new messages — without the message, and once per burst', async () => {
    const w = await rideWorld();
    for (const text of ['I am at the gate', 'Blue gate, next to the bakery', 'Can you see me?']) {
      expect((await send(w.driver.accessToken, w.tripId, text)).status).toBe(201);
    }
    const forPassenger = await notes(w.passengerId, 'CHAT_MESSAGE');
    expect(forPassenger).toHaveLength(1); // three messages, one nudge
    expect(forPassenger[0]?.body).toBe(describeNewMessage('PASSENGER'));
    expect(forPassenger[0]?.body).toBe('You have a new message from your driver.');
    expect(forPassenger[0]?.metadata).toEqual({ tripId: w.tripId });
    expect(JSON.stringify(forPassenger)).not.toMatch(/gate|bakery|see me/i); // no content on a lock screen

    // the sender is never nudged about their own message; the other direction has its own nudge
    expect(await notes(w.driverId, 'CHAT_MESSAGE')).toHaveLength(0);
    await send(w.passenger.accessToken, w.tripId, 'Coming now');
    const forDriver = await notes(w.driverId, 'CHAT_MESSAGE');
    expect(forDriver).toHaveLength(1);
    expect(forDriver[0]?.body).toBe('You have a new message from the passenger.');
  });

  it('notifies the person being called, in the shared words, once per call', async () => {
    const w = await rideWorld();
    const pc = await login(port, w.passenger.accessToken);
    const dc = await login(port, w.driver.accessToken);
    await dc.waitFor((m) => m.type === 'availability');
    pc.send({ type: 'call_start', tripId: w.tripId, kind: 'AUDIO' });
    await dc.waitFor((m) => m.type === 'call_state' && m.call.state === 'RINGING');
    const forDriver = await notes(w.driverId, 'CALL_INCOMING');
    expect(forDriver).toHaveLength(1);
    expect(forDriver[0]?.body).toBe(describeIncomingCall('DRIVER', 'AUDIO'));
    expect(forDriver[0]?.body).toBe('Incoming audio call from the passenger.');
    expect(forDriver[0]?.metadata).toMatchObject({ tripId: w.tripId });
    expect(await notes(w.passengerId, 'CALL_INCOMING')).toHaveLength(0); // the caller is not notified of their own call
    expect(JSON.stringify(forDriver)).not.toMatch(/\+977|phone/i);
  });

  it('notifies the passenger the moment the driver arrives', async () => {
    const w = await rideWorld();
    await arriveAtPickup(w);
    const arrival = await notes(w.passengerId, 'TRIP_DRIVER_ARRIVED');
    expect(arrival).toHaveLength(1);
    expect(arrival[0]?.body).toBe('Your driver has arrived.');
  });
});

describe('the call provider is replaceable', () => {
  it('is chosen by configuration and answers only "how do these two connect"', async () => {
    expect(activeCallProvider()).toBe(webrtcProvider);
    expect(activeCallProvider().name).toBe('webrtc');
    const w = await rideWorld();
    const viaEndpoint = (
      await api.get(`/api/v1/trips/${w.tripId}/calls/ice`).set(auth(w.passenger.accessToken))
    ).body.data;
    const viaProvider = await activeCallProvider().connectionInfo(w.passengerId);
    expect(viaEndpoint.iceServers).toEqual(viaProvider.iceServers);
    expect(viaEndpoint.ttlSeconds).toBe(viaProvider.ttlSeconds);
    // never a phone number: only network addresses and (when configured) short-lived credentials
    expect(JSON.stringify(viaEndpoint)).not.toMatch(/\+977|phone/i);
    // and only the two people on the ride may ask
    const stranger = await rideWorld();
    expect(
      (
        await api
          .get(`/api/v1/trips/${w.tripId}/calls/ice`)
          .set(auth(stranger.passenger.accessToken))
      ).status,
    ).toBe(404);
  });
});

describe('waiting communication', () => {
  it('tells both people the same server-owned waiting facts the moment the driver arrives', async () => {
    const w = await rideWorld();
    await arriveAtPickup(w);
    const forDriver = (
      await api.get(`/api/v1/trips/${w.tripId}/live`).set(auth(w.driver.accessToken))
    ).body.data;
    const forPassenger = (
      await api.get(`/api/v1/trips/${w.tripId}/live`).set(auth(w.passenger.accessToken))
    ).body.data;
    // the driver's wait, and that the passenger has already been told (server timestamp, not a device guess)
    expect(forDriver.waiting.driver).toMatchObject({ seconds: expect.any(Number) });
    expect(typeof forDriver.waiting.driver.notifiedAt).toBe('string');
    expect(forPassenger.waiting.driver.startedAt).toBe(forDriver.waiting.driver.startedAt);
    // the rule is the server's, not each app's
    expect(forDriver.waiting.rule).toEqual(forPassenger.waiting.rule);
  });

  it('lets the passenger message the waiting driver on every signed-in device, in order', async () => {
    const w = await rideWorld();
    await arriveAtPickup(w);
    const phone = await login(port, w.passenger.accessToken);
    const tablet = await login(port, w.passenger.accessToken);
    const dc = await login(port, w.driver.accessToken);
    await dc.waitFor((m) => m.type === 'availability');
    const isMsg = (m: Msg) => m.type === 'chat_message';

    phone.send({
      type: 'chat_send',
      tripId: w.tripId,
      clientMessageId: `wait-${Date.now()}-1-abcdef`,
      body: 'Two minutes please',
    });
    await new Promise((r) => setTimeout(r, 150));
    dc.send({
      type: 'chat_send',
      tripId: w.tripId,
      clientMessageId: `wait-${Date.now()}-2-abcdef`,
      body: 'I will wait',
    });

    for (const c of [phone, tablet, dc]) {
      const first = await c.waitFor(isMsg);
      const second = await c.waitFor(isMsg);
      expect([first.message.seq, second.message.seq]).toEqual([1, 2]);
      expect([first.message.body, second.message.body]).toEqual([
        'Two minutes please',
        'I will wait',
      ]);
    }
  });
});
