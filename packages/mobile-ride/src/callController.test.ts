import type { CallInfo, CallKind, ServerRealtimeMessage } from '@yatri/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CallController, endText, type CallSocket } from './callController';
import type { RtcStatsSample } from './callQuality';
import type { PeerConnectionState, RtcFactory, RtcPeer } from './rtc';

class FakeSocket implements CallSocket {
  sent: Array<Record<string, unknown>> = [];
  private ml = new Set<(m: ServerRealtimeMessage) => void>();
  private cl = new Set<(c: string) => void>();
  send(m: object) {
    this.sent.push(m as Record<string, unknown>);
  }
  onMessage(l: (m: ServerRealtimeMessage) => void) {
    this.ml.add(l);
    return () => this.ml.delete(l);
  }
  onConnectionChange(l: (c: string) => void) {
    this.cl.add(l);
    return () => this.cl.delete(l);
  }
  push(m: ServerRealtimeMessage) {
    this.ml.forEach((l) => l(m));
  }
  connection(c: string) {
    this.cl.forEach((l) => l(c));
  }
  ofType(t: string) {
    return this.sent.filter((m) => m.type === t);
  }
}

class FakePeer implements RtcPeer {
  ice: ((c: Record<string, unknown>) => void) | null = null;
  state: ((s: PeerConnectionState) => void) | null = null;
  calls: string[] = [];
  remote: Array<[string, string]> = [];
  candidates: Array<Record<string, unknown>> = [];
  closed = false;
  stats: RtcStatsSample[] = [];
  async createOffer(o?: { iceRestart?: boolean }) {
    this.calls.push(o?.iceRestart ? 'offer-restart' : 'offer');
    return 'OFFER-SDP';
  }
  async createAnswer() {
    this.calls.push('answer');
    return 'ANSWER-SDP';
  }
  async setRemoteDescription(kind: 'offer' | 'answer', sdp: string) {
    this.remote.push([kind, sdp]);
  }
  async addIceCandidate(c: Record<string, unknown>) {
    this.candidates.push(c);
  }
  onIceCandidate(cb: (c: Record<string, unknown>) => void) {
    this.ice = cb;
  }
  onConnectionState(cb: (s: PeerConnectionState) => void) {
    this.state = cb;
  }
  async getStats() {
    return this.stats.shift() as RtcStatsSample;
  }
  setMicrophoneMuted(m: boolean) {
    this.calls.push(m ? 'mute' : 'unmute');
  }
  setCameraEnabled(e: boolean) {
    this.calls.push(e ? 'camera-on' : 'camera-off');
  }
  close() {
    this.closed = true;
  }
}

function fakeRtc(permission: 'granted' | 'denied' = 'granted') {
  const peers: FakePeer[] = [];
  const rtc: RtcFactory & { peers: FakePeer[]; speaker: boolean[]; active: boolean[] } = {
    peers,
    speaker: [],
    active: [],
    requestPermissions: vi.fn(async (_k: CallKind) => permission),
    createPeer: vi.fn(async () => {
      const p = new FakePeer();
      peers.push(p);
      return p;
    }),
    setSpeaker(on) {
      rtc.speaker.push(on);
    },
    setCallActive(a) {
      rtc.active.push(a);
    },
  };
  return rtc;
}

const call = (over: Partial<CallInfo> = {}): CallInfo => ({
  id: 'c1',
  tripId: 't',
  kind: 'AUDIO',
  state: 'RINGING',
  callerRole: 'PASSENGER',
  createdAt: '2026-01-01T10:00:00.000Z',
  answeredAt: null,
  connectedAt: null,
  endedAt: null,
  endReason: null,
  ...over,
});
const state = (c: CallInfo): ServerRealtimeMessage => ({ type: 'call_state', call: c });
const tick = async () => {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
};

function setup(role: 'PASSENGER' | 'DRIVER', rtc: ReturnType<typeof fakeRtc> | null = fakeRtc()) {
  const socket = new FakeSocket();
  let active: CallInfo | null = null;
  const api = {
    activeCall: vi.fn(async () => active),
    iceServers: vi.fn(async () => ({ iceServers: [{ urls: ['stun:x'] }], ttlSeconds: 60 })),
  };
  const c = new CallController({
    tripId: 't',
    role,
    socket,
    api,
    rtc,
    statsIntervalMs: 1000,
    reconnectGraceMs: 5000,
  });
  c.start();
  return { c, socket, api, rtc, setActive: (x: CallInfo | null) => (active = x) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('outgoing call', () => {
  it('rings, negotiates as the caller, reports connected only once media is up, and ends cleanly', async () => {
    const { c, socket, rtc } = setup('PASSENGER');
    await tick();
    c.startCall('AUDIO');
    expect(socket.sent.at(-1)).toEqual({ type: 'call_start', tripId: 't', kind: 'AUDIO' });

    socket.push(state(call()));
    expect(c.getState()).toMatchObject({ phase: 'calling', outgoing: true });
    expect(c.getState().polite?.text).toBe('Calling your driver.');

    socket.push(state(call({ state: 'CONNECTING' })));
    await tick();
    const peer = rtc!.peers[0]!;
    expect(rtc!.requestPermissions).toHaveBeenCalledWith('AUDIO');
    expect(socket.ofType('call_signal')[0]).toMatchObject({
      callId: 'c1',
      signal: { kind: 'offer', sdp: 'OFFER-SDP' },
    });

    socket.push({ type: 'call_signal', callId: 'c1', signal: { kind: 'answer', sdp: 'A' } });
    await tick();
    expect(peer.remote).toEqual([['answer', 'A']]);

    expect(socket.ofType('call_connected')).toHaveLength(0); // signalling done is not media connected
    peer.state!('connected');
    peer.state!('connected');
    expect(socket.ofType('call_connected')).toHaveLength(1); // once

    socket.push(state(call({ state: 'CONNECTED', connectedAt: 'x' })));
    expect(c.getState()).toMatchObject({ phase: 'connected', media: 'connected' });
    expect(c.getState().polite?.text).toBe('Call connected.');

    socket.push(state(call({ state: 'ENDED', endReason: 'COMPLETED' })));
    expect(c.getState()).toMatchObject({ phase: 'ended', media: 'none' });
    expect(c.getState().polite?.text).toBe('Call ended.');
    expect(peer.closed).toBe(true);
    expect(rtc!.active).toEqual([true, false]);
  });

  it('does not start a second call while one is live', async () => {
    const { c, socket } = setup('PASSENGER');
    await tick();
    socket.push(state(call()));
    c.startCall('AUDIO');
    expect(socket.ofType('call_start')).toHaveLength(0);
  });
});

describe('incoming call', () => {
  it('alerts assertively, answers on request, and answers the offer — even when ICE arrives first', async () => {
    const { c, socket, rtc } = setup('DRIVER');
    await tick();
    socket.push(state(call()));
    expect(c.getState()).toMatchObject({ phase: 'incoming', outgoing: false });
    expect(c.getState().assertive?.text).toBe(
      'Incoming audio call from the passenger. Answer or decline.',
    );

    c.answer();
    expect(socket.sent.at(-1)).toEqual({ type: 'call_answer', callId: 'c1' });
    socket.push(state(call({ state: 'CONNECTING' })));
    await tick();
    const peer = rtc!.peers[0]!;
    expect(socket.ofType('call_signal')).toHaveLength(0); // the callee waits for the offer

    socket.push({
      type: 'call_signal',
      callId: 'c1',
      signal: { kind: 'ice', candidate: { c: 1 } },
    });
    socket.push({ type: 'call_signal', callId: 'c1', signal: { kind: 'offer', sdp: 'O' } });
    await tick();
    expect(peer.remote).toEqual([['offer', 'O']]);
    expect(peer.candidates).toEqual([{ c: 1 }]); // the early candidate was held, then applied
    expect(socket.ofType('call_signal').at(-1)).toMatchObject({
      signal: { kind: 'answer', sdp: 'ANSWER-SDP' },
    });

    peer.ice!({ c: 2 });
    expect(socket.ofType('call_signal').at(-1)).toMatchObject({
      signal: { kind: 'ice', candidate: { c: 2 } },
    });
  });

  it('declines, and words a declined / missed call for each side', async () => {
    const { c, socket } = setup('DRIVER');
    await tick();
    socket.push(state(call()));
    c.decline();
    expect(socket.sent.at(-1)).toEqual({ type: 'call_decline', callId: 'c1' });
    socket.push(state(call({ state: 'ENDED', endReason: 'DECLINED' })));
    expect(c.getState().polite?.text).toBe('Call declined.');

    expect(endText('DECLINED', true, 'your driver')).toBe('Your driver declined the call.');
    expect(endText('MISSED', false, 'the passenger')).toBe('Missed call from the passenger.');
    expect(endText('MISSED', true, 'your driver')).toBe('No answer from your driver.');
    expect(endText('CANCELLED', false, 'your driver')).toBe('Missed call from your driver.');
    expect(endText('TRIP_ENDED', true, 'your driver')).toBe(
      'The call ended because the ride ended.',
    );
  });
});

describe('permissions and unsupported builds', () => {
  it('ends the call and says why when the microphone is denied', async () => {
    const { c, socket } = setup('PASSENGER', fakeRtc('denied'));
    await tick();
    socket.push(state(call({ state: 'CONNECTING' })));
    await tick();
    expect(c.getState().error).toMatch(/microphone access was denied/i);
    expect(socket.ofType('call_end')).toHaveLength(1);
  });

  it('is honest on a build without WebRTC: no fake audio, the call is ended with an explanation', async () => {
    const { c, socket } = setup('PASSENGER', null);
    expect(c.getState().mediaSupported).toBe(false);
    await tick();
    socket.push(state(call({ state: 'CONNECTING' })));
    await tick();
    expect(c.getState().error).toMatch(/cannot carry call audio/i);
    expect(socket.ofType('call_end')).toHaveLength(1);
  });
});

describe('during the call', () => {
  async function connected(role: 'PASSENGER' | 'DRIVER' = 'PASSENGER', kind: CallKind = 'AUDIO') {
    const s = setup(role);
    await tick();
    const callerRole = role;
    s.socket.push(state(call({ kind, callerRole })));
    s.socket.push(state(call({ kind, callerRole, state: 'CONNECTING' })));
    await tick();
    const peer = s.rtc!.peers[0]!;
    peer.state!('connected');
    s.socket.push(state(call({ kind, callerRole, state: 'CONNECTED' })));
    return { ...s, peer };
  }

  it('mutes, and switches speaker, with spoken confirmation', async () => {
    const { c, peer, rtc } = await connected();
    c.setMuted(true);
    expect(c.getState()).toMatchObject({ muted: true });
    expect(peer.calls).toContain('mute');
    expect(c.getState().polite?.text).toBe('Microphone muted.');
    c.setSpeaker(true);
    expect(rtc!.speaker).toEqual([true]);
    expect(c.getState().polite?.text).toBe('Speaker on.');
  });

  it('survives a media drop within the grace period, and ends the call when it does not recover', async () => {
    const a = await connected();
    a.peer.state!('disconnected');
    expect(a.c.getState().media).toBe('reconnecting');
    expect(a.c.getState().polite?.text).toBe('Connection interrupted. Trying to reconnect.');
    await tick();
    expect(a.peer.calls).toContain('offer-restart'); // the caller renegotiates
    a.peer.state!('connected');
    expect(a.c.getState().media).toBe('connected');
    expect(a.c.getState().polite?.text).toBe('Connection restored.');
    await vi.advanceTimersByTimeAsync(6000);
    expect(a.socket.ofType('call_end')).toHaveLength(0); // recovered: grace timer cancelled

    const b = await connected();
    b.peer.state!('failed');
    await vi.advanceTimersByTimeAsync(5100);
    expect(b.socket.ofType('call_end')).toHaveLength(1);
    expect(b.c.getState().error).toBe('The connection was lost.');
  });

  it('announces quality changes once each, from measurements', async () => {
    const { c, peer } = await connected();
    const at = (t: number, lost: number): RtcStatsSample => ({
      atMs: t * 1000,
      audio: {
        codec: 'audio/opus',
        bytesReceived: t * 5000,
        packetsReceived: t * 50 - lost,
        packetsLost: lost,
        jitterMs: 5,
        roundTripMs: 80,
      },
      video: null,
    });
    peer.stats = [at(0, 0), at(1, 0), at(2, 30), at(3, 60), at(4, 60), at(5, 60), at(6, 60)];
    const said: string[] = [];
    c.subscribe(() => {
      const t = c.getState().polite?.text;
      if (t && said.at(-1) !== t) said.push(t);
    });
    await vi.advanceTimersByTimeAsync(7000);
    expect(said.filter((t) => t.startsWith('Call quality'))).toEqual([
      'Call quality is poor.',
      'Call quality has improved.',
    ]);
  });

  it('pauses video that the connection cannot carry, keeps audio, and lets the user resume', async () => {
    const { c, peer } = await connected('PASSENGER', 'VIDEO');
    expect(c.getState().cameraOn).toBe(true);
    const bad = (t: number): RtcStatsSample => ({
      atMs: t * 1000,
      audio: {
        codec: 'audio/opus',
        bytesReceived: t * 1000,
        packetsReceived: t * 50 - t * 20,
        packetsLost: t * 20,
        jitterMs: 5,
        roundTripMs: 80,
      },
      video: {
        frameWidth: 0,
        frameHeight: 0,
        framesPerSecond: 0,
        bytesReceived: 0,
        packetsReceived: 0,
        packetsLost: 0,
      },
    });
    peer.stats = [bad(0), bad(1), bad(2), bad(3), bad(4), bad(5)];
    await vi.advanceTimersByTimeAsync(6000);
    expect(c.getState()).toMatchObject({ cameraOn: false, videoPausedByApp: true });
    expect(peer.calls).toContain('camera-off');
    c.setCamera(true);
    expect(c.getState()).toMatchObject({ cameraOn: true, videoPausedByApp: false });
  });

  it('pauses video in the background and restores it, but only if it was on', async () => {
    const { c, peer } = await connected('PASSENGER', 'VIDEO');
    c.setAppActive(false);
    expect(c.getState()).toMatchObject({ cameraOn: false, videoPausedByApp: true });
    c.setAppActive(true);
    expect(c.getState()).toMatchObject({ cameraOn: true, videoPausedByApp: false });
    expect(peer.calls.filter((x) => x.startsWith('camera'))).toEqual([
      'camera-on',
      'camera-off',
      'camera-on',
    ]);

    c.setCamera(false);
    c.setAppActive(false);
    c.setAppActive(true);
    expect(c.getState().cameraOn).toBe(false); // the user's choice is kept
  });

  it('ends with the ride, with the reason in words', async () => {
    const { c, socket, peer } = await connected();
    socket.push(state(call({ state: 'ENDED', endReason: 'TRIP_ENDED' })));
    expect(c.getState().polite?.text).toBe('The call ended because the ride ended.');
    expect(peer.closed).toBe(true);
  });
});

describe('reconnecting the app', () => {
  it('picks up a ringing call when the screen opens', async () => {
    const s = setup('DRIVER');
    s.setActive(call());
    s.socket.connection('live'); // first connect
    s.socket.connection('live'); // later reconnect triggers a resync
    await tick();
    expect(s.c.getState().phase).toBe('incoming');
  });

  it('learns that a call ended while it was offline', async () => {
    const s = setup('PASSENGER');
    await tick();
    s.socket.push(state(call()));
    s.setActive(null);
    s.socket.connection('live');
    s.socket.connection('live');
    await tick();
    expect(s.c.getState().phase).toBe('ended');
    expect(s.c.getState().polite?.text).toBe('The call failed.');
  });
});
