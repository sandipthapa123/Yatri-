import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { sweepCalls } from '../modules/calls/calls.service';
import { api, onboardUser } from './helpers';
import { auth, requestRide, rideWorld, type RideWorld } from './rides';
import { login, startTestServer, type Client, type Msg } from './wsClient';

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

const callState = (state: string) => (m: Msg) => m.type === 'call_state' && m.call.state === state;
const SDP =
  'v=0\r\no=- 46117317 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

interface Room {
  w: RideWorld;
  pc: Client;
  dc: Client;
}
async function room(): Promise<Room> {
  const w = await rideWorld();
  const pc = await login(port, w.passenger.accessToken);
  const dc = await login(port, w.driver.accessToken);
  await dc.waitFor((m) => m.type === 'availability');
  return { w, pc, dc };
}
/** Passenger rings, driver answers: both sides are CONNECTING. */
async function ringAndAnswer(r: Room) {
  r.pc.send({ type: 'call_start', tripId: r.w.tripId, kind: 'AUDIO' });
  const ringing = (await r.dc.waitFor(callState('RINGING'))).call;
  r.dc.send({ type: 'call_answer', callId: ringing.id });
  await r.pc.waitFor(callState('CONNECTING'));
  return ringing.id as string;
}

describe('call setup and state', () => {
  it('rings the other person, addressed by ride role only — never a phone number', async () => {
    const { w, pc, dc } = await room();
    pc.send({ type: 'call_start', tripId: w.tripId, kind: 'AUDIO' });
    const incoming = await dc.waitFor(callState('RINGING'));
    expect(incoming.call).toMatchObject({
      tripId: w.tripId,
      kind: 'AUDIO',
      callerRole: 'PASSENGER',
      endReason: null,
    });
    expect(JSON.stringify(incoming)).not.toMatch(/\+977|phone/i);
    await pc.waitFor(callState('RINGING')); // the caller sees it ring too
  });

  it('walks RINGING → CONNECTING → CONNECTED → ENDED, and both sides see each step', async () => {
    const r = await room();
    const callId = await ringAndAnswer(r);
    r.pc.send({ type: 'call_connected', callId });
    const connected = await r.dc.waitFor(callState('CONNECTED'));
    expect(connected.call.connectedAt).toEqual(expect.any(String));
    r.dc.send({ type: 'call_end', callId });
    const ended = await r.pc.waitFor(callState('ENDED'));
    expect(ended.call).toMatchObject({ endReason: 'COMPLETED', endedAt: expect.any(String) });
    r.pc.send({ type: 'call_end', callId }); // hanging up twice is harmless
    await r.pc.expectNothing((m) => m.type === 'rejected', 300);
  });

  it('works both ways: the driver can call the passenger, and video is a kind of call', async () => {
    const { w, pc, dc } = await room();
    dc.send({ type: 'call_start', tripId: w.tripId, kind: 'VIDEO' });
    const incoming = await pc.waitFor(callState('RINGING'));
    expect(incoming.call).toMatchObject({ kind: 'VIDEO', callerRole: 'DRIVER' });
  });

  it('records a declined call', async () => {
    const { w, pc, dc } = await room();
    pc.send({ type: 'call_start', tripId: w.tripId, kind: 'AUDIO' });
    const ringing = (await dc.waitFor(callState('RINGING'))).call;
    dc.send({ type: 'call_decline', callId: ringing.id });
    expect((await pc.waitFor(callState('ENDED'))).call.endReason).toBe('DECLINED');
  });

  it('a caller who hangs up while it rings leaves a missed call', async () => {
    const { w, pc, dc } = await room();
    pc.send({ type: 'call_start', tripId: w.tripId, kind: 'AUDIO' });
    const ringing = (await dc.waitFor(callState('RINGING'))).call;
    pc.send({ type: 'call_end', callId: ringing.id });
    expect((await dc.waitFor(callState('ENDED'))).call.endReason).toBe('CANCELLED');
    // the missed-call event and the state change arrive together (in either order)
    const missed = dc.msgs.find((m) => m.type === 'trip_event' && m.event.type === 'CALL_MISSED');
    expect(missed?.important).toBe(false);
  });

  it('an unanswered ring times out into exactly one missed call', async () => {
    const { w, pc, dc } = await room();
    pc.send({ type: 'call_start', tripId: w.tripId, kind: 'AUDIO' });
    await dc.waitFor(callState('RINGING'));
    await pool.query(
      "UPDATE trip_calls SET created_at = now() - interval '2 minutes' WHERE trip_id = $1",
      [w.tripId],
    );
    expect(await sweepCalls()).toBe(1);
    expect((await dc.waitFor(callState('ENDED'))).call.endReason).toBe('MISSED');
    expect(await sweepCalls()).toBe(0);
    const events = await pool.query(
      "SELECT count(*)::int AS n FROM trip_events WHERE trip_id = $1 AND type = 'CALL_MISSED'",
      [w.tripId],
    );
    expect(events.rows[0].n).toBe(1);
  });

  it('allows one live call per ride, then a new one after it ends', async () => {
    const r = await room();
    r.pc.send({ type: 'call_start', tripId: r.w.tripId, kind: 'AUDIO' });
    const ringing = (await r.dc.waitFor(callState('RINGING'))).call;
    r.dc.send({ type: 'call_start', tripId: r.w.tripId, kind: 'AUDIO' });
    expect((await r.dc.waitFor((m) => m.type === 'rejected')).reason).toBe('CALL_IN_PROGRESS');
    r.dc.send({ type: 'call_decline', callId: ringing.id });
    await r.pc.waitFor(callState('ENDED'));
    r.dc.send({ type: 'call_start', tripId: r.w.tripId, kind: 'AUDIO' });
    await r.pc.waitFor(callState('RINGING'));
  });

  it('only the person being called can answer or decline', async () => {
    const { w, pc, dc } = await room();
    pc.send({ type: 'call_start', tripId: w.tripId, kind: 'AUDIO' });
    const ringing = (await dc.waitFor(callState('RINGING'))).call;
    pc.send({ type: 'call_answer', callId: ringing.id });
    expect((await pc.waitFor((m) => m.type === 'rejected')).reason).toBe('FORBIDDEN');
    pc.send({ type: 'call_decline', callId: ringing.id });
    expect((await pc.waitFor((m) => m.type === 'rejected')).reason).toBe('FORBIDDEN');
    dc.send({ type: 'call_answer', callId: ringing.id });
    await pc.waitFor(callState('CONNECTING'));
    dc.send({ type: 'call_answer', callId: ringing.id }); // answering twice
    expect((await dc.waitFor((m) => m.type === 'rejected')).reason).toBe('CALL_NOT_RINGING');
  });
});

describe('call authorization', () => {
  it('needs an assigned driver and an active ride', async () => {
    const p = await onboardUser('PASSENGER');
    const trip = (await requestRide(p.accessToken)).body.data; // still searching
    const pc = await login(port, p.accessToken);
    pc.send({ type: 'call_start', tripId: trip.id, kind: 'AUDIO' });
    expect((await pc.waitFor((m) => m.type === 'rejected')).reason).toBe('CALL_NOT_AVAILABLE');

    const r = await room();
    await api
      .post(`/api/v1/trips/${r.w.tripId}/cancel`)
      .set(auth(r.w.passenger.accessToken))
      .send({});
    r.pc.send({ type: 'call_start', tripId: r.w.tripId, kind: 'AUDIO' });
    expect((await r.pc.waitFor((m) => m.type === 'rejected')).reason).toBe('CALL_NOT_AVAILABLE');
  });

  it('strangers cannot start, join, or signal a call on someone else’s ride', async () => {
    const r = await room();
    const stranger = await onboardUser('DRIVER');
    const sc = await login(port, stranger.accessToken);
    sc.send({ type: 'call_start', tripId: r.w.tripId, kind: 'AUDIO' });
    expect((await sc.waitFor((m) => m.type === 'rejected')).reason).toBe('NOT_FOUND');

    r.pc.send({ type: 'call_start', tripId: r.w.tripId, kind: 'AUDIO' });
    const ringing = (await r.dc.waitFor(callState('RINGING'))).call;
    sc.send({ type: 'call_signal', callId: ringing.id, signal: { kind: 'offer', sdp: SDP } });
    expect((await sc.waitFor((m) => m.type === 'rejected')).reason).toBe('NOT_FOUND');
    sc.send({ type: 'call_answer', callId: ringing.id });
    expect(
      (await sc.waitFor((m) => m.type === 'rejected' && m.reason === 'NOT_FOUND')).reason,
    ).toBe('NOT_FOUND');
    sc.send({ type: 'call_end', callId: ringing.id });
    await sc.waitFor((m) => m.type === 'rejected');
    // nothing happened to the real call
    const row = await pool.query('SELECT state FROM trip_calls WHERE id = $1', [ringing.id]);
    expect(row.rows[0].state).toBe('RINGING');
  });

  it('a call cannot outlive the ride: cancelling ends it for both people', async () => {
    const r = await room();
    const callId = await ringAndAnswer(r);
    void callId;
    await api
      .post(`/api/v1/trips/${r.w.tripId}/cancel`)
      .set(auth(r.w.passenger.accessToken))
      .send({});
    expect((await r.dc.waitFor(callState('ENDED'))).call.endReason).toBe('TRIP_ENDED');
    expect((await r.pc.waitFor(callState('ENDED'))).call.endReason).toBe('TRIP_ENDED');
  });

  it('lets a reconnecting app learn the current call, and hands out ICE servers to participants only', async () => {
    const r = await room();
    expect(
      (await api.get(`/api/v1/trips/${r.w.tripId}/calls/active`).set(auth(r.w.driver.accessToken)))
        .body.data,
    ).toBeNull();
    await ringAndAnswer(r);
    const active = (
      await api.get(`/api/v1/trips/${r.w.tripId}/calls/active`).set(auth(r.w.driver.accessToken))
    ).body.data;
    expect(active).toMatchObject({ state: 'CONNECTING', kind: 'AUDIO' });

    const ice = await api
      .get(`/api/v1/trips/${r.w.tripId}/calls/ice`)
      .set(auth(r.w.passenger.accessToken));
    expect(ice.status).toBe(200);
    expect(ice.body.data.iceServers[0].urls[0]).toMatch(/^stun:/);
    expect(JSON.stringify(ice.body)).not.toMatch(/secret|credential/i); // no TURN configured in tests
    const stranger = await onboardUser('PASSENGER');
    expect(
      (await api.get(`/api/v1/trips/${r.w.tripId}/calls/ice`).set(auth(stranger.accessToken)))
        .status,
    ).toBe(404);
    expect((await api.get(`/api/v1/trips/${r.w.tripId}/calls/active`)).status).toBe(401);
  });
});

describe('WebRTC signalling relay', () => {
  it('relays offer, answer and ICE candidates to the other party only, untouched', async () => {
    const r = await room();
    r.pc.send({ type: 'call_start', tripId: r.w.tripId, kind: 'AUDIO' });
    const ringing = (await r.dc.waitFor(callState('RINGING'))).call;
    // the caller may send its offer while still ringing
    r.pc.send({ type: 'call_signal', callId: ringing.id, signal: { kind: 'offer', sdp: SDP } });
    const offer = await r.dc.waitFor((m) => m.type === 'call_signal');
    expect(offer).toMatchObject({ callId: ringing.id, signal: { kind: 'offer', sdp: SDP } });

    // the callee cannot signal before answering
    r.dc.send({ type: 'call_signal', callId: ringing.id, signal: { kind: 'answer', sdp: SDP } });
    expect((await r.dc.waitFor((m) => m.type === 'rejected')).reason).toBe('CALL_NOT_ANSWERED');
    r.dc.send({ type: 'call_answer', callId: ringing.id });
    await r.pc.waitFor(callState('CONNECTING'));
    r.dc.send({ type: 'call_signal', callId: ringing.id, signal: { kind: 'answer', sdp: SDP } });
    expect((await r.pc.waitFor((m) => m.type === 'call_signal')).signal.kind).toBe('answer');

    const candidate = {
      candidate: 'candidate:1 1 UDP 2122252543 10.0.0.2 54321 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    r.pc.send({ type: 'call_signal', callId: ringing.id, signal: { kind: 'ice', candidate } });
    r.dc.send({ type: 'call_signal', callId: ringing.id, signal: { kind: 'ice', candidate } });
    expect(
      (await r.dc.waitFor((m) => m.type === 'call_signal' && m.signal.kind === 'ice')).signal
        .candidate,
    ).toEqual(candidate);
    expect(
      (await r.pc.waitFor((m) => m.type === 'call_signal' && m.signal.kind === 'ice')).signal
        .candidate,
    ).toEqual(candidate);
    // a sender never hears its own signal echoed back
    await r.pc.expectNothing((m) => m.type === 'call_signal' && m.signal.kind === 'offer', 300);
  });

  it('refuses malformed or oversized signals, and signals on ended calls', async () => {
    const r = await room();
    const callId = await ringAndAnswer(r);
    for (const signal of [
      { kind: 'offer' },
      { kind: 'offer', sdp: '' },
      { kind: 'offer', sdp: 'x'.repeat(30_001) },
      { kind: 'ice', candidate: 'not-an-object' },
      { kind: 'nonsense', sdp: SDP },
      { kind: 'offer', sdp: SDP, extra: true },
    ]) {
      r.pc.send({ type: 'call_signal', callId, signal });
      await r.pc.waitFor((m) => m.type === 'error' && m.code === 'BAD_MESSAGE');
      await new Promise((res) => setTimeout(res, 150)); // stay under the per-socket message rate limit
      await new Promise((res) => setTimeout(res, 150)); // stay under the per-socket message rate limit
    }
    r.pc.send({ type: 'call_end', callId });
    await r.dc.waitFor(callState('ENDED'));
    r.pc.send({ type: 'call_signal', callId, signal: { kind: 'offer', sdp: SDP } });
    expect((await r.pc.waitFor((m) => m.type === 'rejected')).reason).toBe('CALL_ENDED');
  });

  it('accepts a realistic video-sized SDP (well above the 4 KB limit for ordinary messages)', async () => {
    const r = await room();
    const callId = await ringAndAnswer(r);
    const bigSdp = SDP + 'a=fmtp:96 profile-level-id=42e01f\r\n'.repeat(400); // ≈ 14 KB
    r.pc.send({ type: 'call_signal', callId, signal: { kind: 'offer', sdp: bigSdp } });
    expect((await r.dc.waitFor((m) => m.type === 'call_signal')).signal.sdp.length).toBe(
      bigSdp.length,
    );
  });
});
