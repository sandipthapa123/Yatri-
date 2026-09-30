import { CHAT_MAX_LENGTH, describeTripEvent } from '@yatri/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { chatWindow } from '../modules/chat/chat.service';
import { runRetention } from '../modules/compliance/retention.service';
import { getTrip } from '../modules/trips/trips.repository';
import { api, onboardUser } from './helpers';
import { arriveAtPickup, auth, requestRide, rideWorld } from './rides';
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
const cid = () => `msg-${Date.now()}-${++n}-${Math.random().toString(36).slice(2, 8)}`;
const chat = (token: string, tripId: string, path = '') =>
  api.get(`/api/v1/trips/${tripId}/chat${path}`).set(auth(token));
const send = (token: string, tripId: string, body: string, clientMessageId = cid()) =>
  api.post(`/api/v1/trips/${tripId}/chat`).set(auth(token)).send({ clientMessageId, body });
const isMsg = (m: Msg) => m.type === 'chat_message';

describe('chat availability follows the ride', () => {
  it('is closed until a driver accepts, with a reason in words', async () => {
    const p = await onboardUser('PASSENGER');
    const trip = (await requestRide(p.accessToken)).body.data;
    const res = await send(p.accessToken, trip.id, 'Hello?');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHAT_CLOSED');
    const h = (await chat(p.accessToken, trip.id)).body.data;
    expect(h).toMatchObject({ canSend: false });
    expect(h.closedReason).toMatch(/opens when a driver accepts/i);
  });

  it('opens on assignment, includes system messages from real ride events, and stays open briefly after the ride', async () => {
    const w = await rideWorld();
    const h = (await chat(w.passenger.accessToken, w.tripId)).body.data;
    expect(h.canSend).toBe(true);
    const system = h.items.filter((i: { kind: string }) => i.kind === 'system');
    expect(system.map((i: { event: { type: string } }) => i.event.type)).toEqual([
      'DRIVER_ASSIGNED',
    ]);
    expect(describeTripEvent(system[0].event, 'PASSENGER')).toBe('Driver has accepted your ride.');
    // "requested" is not a chat message; nor are internal search details
    expect(
      h.items.some((i: { event?: { type: string } }) => i.event?.type === 'TRIP_REQUESTED'),
    ).toBe(false);

    await arriveAtPickup(w);
    await api.post(`/api/v1/trips/${w.tripId}/start`).set(auth(w.driver.accessToken));
    await api.post(`/api/v1/trips/${w.tripId}/complete`).set(auth(w.driver.accessToken));
    expect(
      (await send(w.passenger.accessToken, w.tripId, 'Thanks — I think I left my umbrella')).status,
    ).toBe(201);

    await pool.query("UPDATE trips SET ended_at = now() - interval '20 minutes' WHERE id = $1", [
      w.tripId,
    ]);
    const late = await send(w.driver.accessToken, w.tripId, 'Found it');
    expect(late.status).toBe(409);
    const after = (await chat(w.driver.accessToken, w.tripId)).body.data;
    expect(after.canSend).toBe(false);
    expect(after.closedReason).toMatch(/read-only/i);
    expect(after.items.filter((i: { kind: string }) => i.kind === 'message')).toHaveLength(1); // history stays readable
  });

  it('the window rule itself', async () => {
    const w = await rideWorld();
    const trip = (await getTrip(w.tripId))!;
    expect(chatWindow(trip).canSend).toBe(true);
    const ended = {
      ...trip,
      status: 'COMPLETED' as const,
      ended_at: new Date(Date.now() - 5 * 60_000),
    };
    expect(chatWindow(ended).canSend).toBe(true);
    expect(chatWindow({ ...ended, ended_at: new Date(Date.now() - 16 * 60_000) }).canSend).toBe(
      false,
    );
    expect(
      chatWindow({ ...ended, status: 'CANCELLED' as const, driver_id: null, matched_at: null })
        .canSend,
    ).toBe(false);
  });
});

describe('sending, ordering and receipts over the socket', () => {
  it('delivers to both people, echoes the client id, and reports delivered then read', async () => {
    const w = await rideWorld();
    const pc = await login(port, w.passenger.accessToken);
    const dc = await login(port, w.driver.accessToken);
    await dc.waitFor((m) => m.type === 'availability');

    const clientMessageId = cid();
    pc.send({
      type: 'chat_send',
      tripId: w.tripId,
      clientMessageId,
      body: 'I am at the main gate',
    });
    const echoed = await pc.waitFor(isMsg);
    expect(echoed.message).toMatchObject({
      seq: 1,
      senderRole: 'PASSENGER',
      clientMessageId,
      readAt: null,
    });
    const received = await dc.waitFor(isMsg);
    expect(received.message).toMatchObject({ body: 'I am at the main gate', seq: 1 });

    const delivered = await pc.waitFor((m) => m.type === 'chat_receipt' && m.kind === 'delivered');
    expect(delivered.upToSeq).toBe(1);

    dc.send({ type: 'chat_read', tripId: w.tripId, upToSeq: 1 });
    const read = await pc.waitFor((m) => m.type === 'chat_receipt' && m.kind === 'read');
    expect(read.upToSeq).toBe(1);
    const h = (await chat(w.passenger.accessToken, w.tripId)).body.data;
    const msg = h.items.find((i: { kind: string }) => i.kind === 'message').message;
    expect(msg.deliveredAt).toEqual(expect.any(String));
    expect(msg.readAt).toEqual(expect.any(String));
  });

  it('keeps a gap-free order under simultaneous sends from both people', async () => {
    const w = await rideWorld();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        send(i % 2 ? w.driver.accessToken : w.passenger.accessToken, w.tripId, `message ${i}`),
      ),
    );
    for (const r of results) expect(r.status).toBe(201);
    const seqs = results.map((r) => r.body.data.seq as number).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const h = (await chat(w.driver.accessToken, w.tripId)).body.data;
    const bySeq = h.items
      .filter((i: { kind: string }) => i.kind === 'message')
      .map((i: { message: { seq: number } }) => i.message.seq);
    expect(bySeq).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('a retried message (same client id) is stored once', async () => {
    const w = await rideWorld();
    const id = cid();
    const [a, b, c] = await Promise.all([
      send(w.passenger.accessToken, w.tripId, 'Are you close?', id),
      send(w.passenger.accessToken, w.tripId, 'Are you close?', id),
      send(w.passenger.accessToken, w.tripId, 'Are you close?', id),
    ]);
    expect([a.status, b.status, c.status].every((s) => s === 201)).toBe(true);
    expect(new Set([a.body.data.id, b.body.data.id, c.body.data.id]).size).toBe(1);
    const rows = await pool.query(
      'SELECT count(*)::int AS n FROM trip_messages WHERE trip_id = $1',
      [w.tripId],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('keeps messages for an offline person and counts them as unread until read', async () => {
    const w = await rideWorld();
    await send(w.passenger.accessToken, w.tripId, 'First');
    await send(w.passenger.accessToken, w.tripId, 'Second');
    expect((await chat(w.driver.accessToken, w.tripId)).body.data.unreadCount).toBe(2);
    expect((await chat(w.passenger.accessToken, w.tripId)).body.data.unreadCount).toBe(0); // your own don't count

    const pc = await login(port, w.passenger.accessToken);
    const r = await api
      .post(`/api/v1/trips/${w.tripId}/chat/read`)
      .set(auth(w.driver.accessToken))
      .send({ upToSeq: 1 });
    expect(r.body.data.upToSeq).toBe(1);
    const receipt = await pc.waitFor((m) => m.type === 'chat_receipt' && m.kind === 'read');
    expect(receipt.upToSeq).toBe(1);
    expect((await chat(w.driver.accessToken, w.tripId)).body.data.unreadCount).toBe(1);
  });

  it('rejects empty, oversized, control-character and badly identified messages', async () => {
    const w = await rideWorld();
    for (const body of ['   ', 'x'.repeat(CHAT_MAX_LENGTH + 1), 'bad\u0000byte']) {
      const res = await send(w.passenger.accessToken, w.tripId, body);
      expect(res.status, JSON.stringify(body).slice(0, 20)).toBe(400);
    }
    expect((await send(w.passenger.accessToken, w.tripId, 'hi', 'short')).status).toBe(400);
    expect(
      (await send(w.passenger.accessToken, w.tripId, 'x'.repeat(CHAT_MAX_LENGTH))).status,
    ).toBe(201); // the limit itself is fine
    // Nepali text and emoji are ordinary messages
    expect((await send(w.driver.accessToken, w.tripId, 'म आउँदैछु 🙏')).status).toBe(201);
  });

  it('is private to the two people on the ride', async () => {
    const w = await rideWorld();
    const stranger = await onboardUser('PASSENGER');
    expect((await chat(stranger.accessToken, w.tripId)).status).toBe(404);
    expect((await send(stranger.accessToken, w.tripId, 'hello')).status).toBe(404);
    expect((await api.get(`/api/v1/trips/${w.tripId}/chat`)).status).toBe(401);
    const sc = await login(port, stranger.accessToken);
    sc.send({ type: 'chat_send', tripId: w.tripId, clientMessageId: cid(), body: 'sneaky' });
    expect((await sc.waitFor((m) => m.type === 'rejected')).reason).toBe('NOT_FOUND');
    const pc = await login(port, w.passenger.accessToken);
    await pc.expectNothing(isMsg, 300); // the stranger's attempt reached nobody
    // and a sender id smuggled into the message is a protocol error
    sc.send({
      type: 'chat_send',
      tripId: w.tripId,
      clientMessageId: cid(),
      body: 'hi',
      senderId: w.driverId,
    });
    await sc.waitFor((m) => m.type === 'error' && m.code === 'BAD_MESSAGE');
  });

  it('reaches every device a person has signed in on', async () => {
    const w = await rideWorld();
    const phone = await login(port, w.passenger.accessToken);
    const tablet = await login(port, w.passenger.accessToken);
    const dc = await login(port, w.driver.accessToken);
    await dc.waitFor((m) => m.type === 'availability');
    dc.send({ type: 'chat_send', tripId: w.tripId, clientMessageId: cid(), body: 'On my way' });
    await phone.waitFor(isMsg);
    await tablet.waitFor(isMsg);
  });
});

describe('retention', () => {
  // The chat rule is the CHAT_MESSAGES retention policy (90 days by seed): the job is the one thing that purges.
  const purgeExpiredChats = async () => (await runRetention()).CHAT_MESSAGES ?? 0;
  const endedAgo = async (tripId: string, days: number) =>
    pool.query("UPDATE trips SET ended_at = now() - ($2::int * interval '1 day') WHERE id = $1", [
      tripId,
      days,
    ]);
  const count = async (tripId: string) =>
    (await pool.query('SELECT count(*)::int AS n FROM trip_messages WHERE trip_id = $1', [tripId]))
      .rows[0].n as number;

  it('deletes chat text older than the retention period, and only that', async () => {
    const old = await rideWorld();
    const recent = await rideWorld();
    for (const w of [old, recent]) {
      await send(w.passenger.accessToken, w.tripId, 'hello');
      await arriveAtPickup(w);
      await api.post(`/api/v1/trips/${w.tripId}/start`).set(auth(w.driver.accessToken));
      await api.post(`/api/v1/trips/${w.tripId}/complete`).set(auth(w.driver.accessToken));
    }
    await endedAgo(old.tripId, 91);
    await endedAgo(recent.tripId, 89);

    expect(await purgeExpiredChats()).toBe(1);
    expect(await count(old.tripId)).toBe(0);
    expect(await count(recent.tripId)).toBe(1);
    // the ride itself and its events are untouched
    const trip = (await api.get(`/api/v1/trips/${old.tripId}`).set(auth(old.passenger.accessToken)))
      .body.data;
    expect(trip.status).toBe('COMPLETED');
  });

  it('keeps the conversation while a dispute on the ride is open, and purges it once resolved', async () => {
    const w = await rideWorld();
    await send(w.passenger.accessToken, w.tripId, 'evidence');
    await arriveAtPickup(w);
    await api.post(`/api/v1/trips/${w.tripId}/start`).set(auth(w.driver.accessToken));
    await api.post(`/api/v1/trips/${w.tripId}/complete`).set(auth(w.driver.accessToken));
    await api.post('/api/v1/support/tickets').set(auth(w.passenger.accessToken)).send({
      categoryCode: 'RIDE_FARE',
      subject: 'The fare was wrong',
      body: 'The fare was wrong',
      tripId: w.tripId,
    });
    await endedAgo(w.tripId, 200);

    expect(await purgeExpiredChats()).toBe(0);
    expect(await count(w.tripId)).toBe(1);
    await pool.query("UPDATE support_tickets SET status = 'RESOLVED' WHERE trip_id = $1", [
      w.tripId,
    ]);
    expect(await purgeExpiredChats()).toBe(1);
    expect(await count(w.tripId)).toBe(0);
  });

  it('never touches a ride that has not ended', async () => {
    const w = await rideWorld();
    await send(w.passenger.accessToken, w.tripId, 'still riding');
    await pool.query("UPDATE trips SET requested_at = now() - interval '400 days' WHERE id = $1", [
      w.tripId,
    ]);
    expect(await purgeExpiredChats()).toBe(0);
    expect(await count(w.tripId)).toBe(1);
  });
});
