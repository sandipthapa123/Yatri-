import {
  counterpartLabel,
  describeIncomingCall,
  type CallEndReason,
  type CallInfo,
  type CallKind,
  type CallSignal,
  type IceServersResponse,
  type ServerRealtimeMessage,
  type TripRole,
} from '@yatri/types';

import type { SpokenMessage } from '@yatri/mobile-location';

import { QualityTracker, type CallQuality } from './callQuality';
import type { RideSocket } from './rideSocket';
import type { PeerConnectionState, RtcFactory, RtcPeer } from './rtc';

/** What the call screen shows. Derived from the server's call state plus this device's media. */
export type CallPhase = 'idle' | 'calling' | 'incoming' | 'connecting' | 'connected' | 'ended';
export type MediaState = 'none' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface CallState {
  phase: CallPhase;
  call: CallInfo | null;
  /** Whether this device placed the call. */
  outgoing: boolean;
  media: MediaState;
  /** False when this build has no WebRTC: calls can ring, but no audio can flow. Said plainly. */
  mediaSupported: boolean;
  muted: boolean;
  speaker: boolean;
  cameraOn: boolean;
  /** True while video is paused by the app (weak connection or backgrounded), not by the user. */
  videoPausedByApp: boolean;
  quality: CallQuality | null;
  /** The other person's video, when this is a video call and it is arriving. */
  remoteStreamUrl: string | null;
  error: string | null;
  /** Routine call news, spoken politely. */
  polite: SpokenMessage | null;
  /** Things that need attention now (an incoming call), spoken assertively. */
  assertive: SpokenMessage | null;
}

export type CallSocket = RideSocket;

export interface CallControllerOptions {
  tripId: string;
  role: TripRole;
  socket: CallSocket;
  api: {
    activeCall(): Promise<CallInfo | null>;
    iceServers(): Promise<IceServersResponse>;
  };
  /** Null on builds without WebRTC. */
  rtc: RtcFactory | null;
  statsIntervalMs?: number;
  /** How long a dropped media link may try to recover before the call is ended. */
  reconnectGraceMs?: number;
}

/** Sustained poor video before the app pauses it to protect the audio. */
const VIDEO_PAUSE_AFTER_POOR_READINGS = 3;

/**
 * One call on one trip. The SERVER owns the call's state (ringing/connecting/connected/ended and
 * why); this class follows it, runs the WebRTC negotiation the server merely relays, and decides
 * what to say aloud. Guarantees:
 *  - only ever one live call; state comes from server messages, never from a local guess;
 *  - "connected" is reported to the server only once media really is connected;
 *  - a lost media link gets a grace period to recover, then the call is ended honestly;
 *  - quality is measured (see callQuality) and announced only when it changes;
 *  - video is paused, not left frozen, when the connection can't carry it — audio continues;
 *  - every state change has words, so nothing depends on seeing the screen.
 */
export class CallController {
  private state: CallState;
  private listeners = new Set<() => void>();
  private unsubs: Array<() => void> = [];
  private peer: RtcPeer | null = null;
  private pendingIce: Array<Record<string, unknown>> = [];
  private remoteSet = false;
  private mediaStarting = false;
  private connectedReported = false;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private tracker = new QualityTracker();
  private lastLevel: CallQuality['level'] = 'unknown';
  private poorVideoRun = 0;
  private messageId = 0;
  private everLive = false;
  private appActive = true;
  private cameraBeforeBackground = false;
  private disposed = false;

  constructor(private readonly opts: CallControllerOptions) {
    this.state = {
      phase: 'idle',
      call: null,
      outgoing: false,
      media: 'none',
      mediaSupported: opts.rtc !== null,
      muted: false,
      speaker: false,
      cameraOn: false,
      videoPausedByApp: false,
      quality: null,
      remoteStreamUrl: null,
      error: null,
      polite: null,
      assertive: null,
    };
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  getState = () => this.state;

  start() {
    this.unsubs.push(
      this.opts.socket.onMessage((m) => void this.onSocket(m)),
      this.opts.socket.onConnectionChange((c) => {
        if (c !== 'live') return;
        if (this.everLive) void this.resync();
        this.everLive = true;
      }),
    );
    void this.resync(); // a call may already be ringing when this screen opens
  }

  dispose() {
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.teardownMedia();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------- user actions

  startCall(kind: CallKind) {
    if (this.state.phase !== 'idle' && this.state.phase !== 'ended') return;
    this.set({ error: null, cameraOn: kind === 'VIDEO', muted: false });
    this.opts.socket.send({ type: 'call_start', tripId: this.opts.tripId, kind });
  }

  answer() {
    const call = this.state.call;
    if (this.state.phase !== 'incoming' || !call) return;
    this.set({ cameraOn: call.kind === 'VIDEO' });
    this.opts.socket.send({ type: 'call_answer', callId: call.id });
  }

  decline() {
    const call = this.state.call;
    if (this.state.phase !== 'incoming' || !call) return;
    this.opts.socket.send({ type: 'call_decline', callId: call.id });
  }

  /** Hang up (also cancels a ring the other person hasn't answered). */
  hangUp() {
    const call = this.state.call;
    if (!call || this.state.phase === 'ended' || this.state.phase === 'idle') return;
    this.opts.socket.send({ type: 'call_end', callId: call.id });
  }

  setMuted(muted: boolean) {
    this.peer?.setMicrophoneMuted(muted);
    this.set({ muted });
    this.say(muted ? 'Microphone muted.' : 'Microphone on.');
  }

  setSpeaker(on: boolean) {
    this.opts.rtc?.setSpeaker(on);
    this.set({ speaker: on });
    this.say(on ? 'Speaker on.' : 'Speaker off.');
  }

  setCamera(on: boolean) {
    if (this.state.call?.kind !== 'VIDEO') return;
    this.peer?.setCameraEnabled(on);
    this.poorVideoRun = 0;
    this.set({ cameraOn: on, videoPausedByApp: false });
    this.say(on ? 'Camera on.' : 'Camera off.');
  }

  /** The app moved to/from the background. Audio is kept; video is paused rather than left frozen. */
  setAppActive(active: boolean) {
    if (active === this.appActive) return;
    this.appActive = active;
    if (this.state.call?.kind !== 'VIDEO' || this.state.phase === 'ended') return;
    if (!active && this.state.cameraOn) {
      this.cameraBeforeBackground = true;
      this.peer?.setCameraEnabled(false);
      this.set({ cameraOn: false, videoPausedByApp: true });
    } else if (active && this.cameraBeforeBackground) {
      this.cameraBeforeBackground = false;
      this.peer?.setCameraEnabled(true);
      this.set({ cameraOn: true, videoPausedByApp: false });
      this.say('Camera back on.');
    }
  }

  // ---------------------------------------------------------------- server messages

  private async onSocket(m: ServerRealtimeMessage) {
    if (this.disposed) return;
    if (m.type === 'call_state' && m.call.tripId === this.opts.tripId) {
      await this.onCallState(m.call);
    } else if (m.type === 'call_signal') {
      await this.onSignal(m.callId, m.signal);
    } else if (m.type === 'error' || m.type === 'rejected') {
      // e.g. "You can call once a driver is assigned" — the server's words, shown as they are.
      const message = m.type === 'error' ? m.message : `Not available: ${m.reason}`;
      if (this.state.phase === 'idle' || this.state.phase === 'ended') this.set({ error: message });
    }
  }

  private async resync() {
    try {
      const call = await this.opts.api.activeCall();
      if (this.disposed) return;
      if (call) await this.onCallState(call);
      else if (this.state.call && this.state.phase !== 'ended' && this.state.phase !== 'idle') {
        // The call ended while we were offline.
        await this.onCallState({
          ...this.state.call,
          state: 'ENDED',
          endedAt: new Date().toISOString(),
          endReason: 'FAILED',
        });
      }
    } catch {
      /* the next call_state message resynchronises */
    }
  }

  private async onCallState(call: CallInfo) {
    const prev = this.state.call;
    if (prev && prev.id === call.id && prev.state === 'ENDED') return; // already finished
    if (
      prev &&
      prev.id !== call.id &&
      this.state.phase !== 'ended' &&
      this.state.phase !== 'idle'
    ) {
      return; // a different call while one is live: the server allows only one, ignore stragglers
    }
    const outgoing = call.callerRole === this.opts.role;
    const who = counterpartLabel(this.opts.role);

    switch (call.state) {
      case 'RINGING':
        if (prev?.id === call.id && prev.state === 'RINGING') return;
        this.set({
          call,
          outgoing,
          phase: outgoing ? 'calling' : 'incoming',
          cameraOn: call.kind === 'VIDEO',
          error: null,
        });
        if (outgoing) this.say(`Calling ${who}.`);
        else this.alert(`${describeIncomingCall(this.opts.role, call.kind)} Answer or decline.`);
        return;
      case 'CONNECTING':
        this.set({ call, outgoing, phase: 'connecting' });
        if (prev?.state !== 'CONNECTING') this.say('Connecting the call.');
        await this.startMedia(call, outgoing);
        return;
      case 'CONNECTED':
        this.set({ call, outgoing, phase: 'connected' });
        if (prev?.state !== 'CONNECTED') this.say('Call connected.');
        return;
      case 'ENDED':
        this.finish(call, outgoing);
        return;
    }
  }

  private finish(call: CallInfo, outgoing: boolean) {
    const who = counterpartLabel(this.opts.role);
    this.teardownMedia();
    this.set({
      call,
      outgoing,
      phase: 'ended',
      media: 'none',
      quality: null,
      remoteStreamUrl: null,
      videoPausedByApp: false,
    });
    this.say(endText(call.endReason, outgoing, who));
  }

  // ---------------------------------------------------------------- media (WebRTC)

  private async startMedia(call: CallInfo, outgoing: boolean) {
    if (this.peer || this.mediaStarting) return;
    const rtc = this.opts.rtc;
    if (!rtc) {
      this.failMedia('This version of the app cannot carry call audio yet, so the call was ended.');
      return;
    }
    this.mediaStarting = true;
    this.set({ media: 'connecting' });
    try {
      const permission = await rtc.requestPermissions(call.kind);
      if (permission === 'denied') {
        this.failMedia(
          call.kind === 'VIDEO'
            ? 'Microphone or camera access was denied. Allow it in Settings to take calls.'
            : 'Microphone access was denied. Allow it in Settings to take calls.',
        );
        return;
      }
      const ice = await this.opts.api.iceServers();
      rtc.setCallActive(true);
      const peer = await rtc.createPeer({ iceServers: ice.iceServers, kind: call.kind });
      if (this.disposed || this.state.call?.state === 'ENDED') {
        peer.close();
        rtc.setCallActive(false);
        return;
      }
      this.peer = peer;
      peer.onIceCandidate((candidate) => this.signal(call.id, { kind: 'ice', candidate }));
      peer.onConnectionState((s) => this.onPeerState(call.id, s));
      peer.onRemoteStream?.((url) => this.set({ remoteStreamUrl: url }));
      peer.setMicrophoneMuted(this.state.muted);
      peer.setCameraEnabled(this.state.cameraOn);
      if (outgoing) {
        const sdp = await peer.createOffer();
        this.signal(call.id, { kind: 'offer', sdp });
      }
    } catch (e) {
      this.failMedia(e instanceof Error ? e.message : 'The call could not be set up.');
    } finally {
      this.mediaStarting = false;
    }
  }

  private async onSignal(callId: string, signal: CallSignal) {
    if (this.state.call?.id !== callId) return;
    try {
      // The callee's peer may not exist yet when the offer arrives; wait for it briefly.
      if (!this.peer && signal.kind === 'offer') await this.waitForPeer();
      const peer = this.peer;
      if (!peer) return;
      if (signal.kind === 'offer') {
        await peer.setRemoteDescription('offer', signal.sdp);
        this.remoteSet = true;
        await this.flushIce(peer);
        const sdp = await peer.createAnswer();
        this.signal(callId, { kind: 'answer', sdp });
      } else if (signal.kind === 'answer') {
        await peer.setRemoteDescription('answer', signal.sdp);
        this.remoteSet = true;
        await this.flushIce(peer);
      } else if (this.remoteSet) {
        await peer.addIceCandidate(signal.candidate);
      } else {
        this.pendingIce.push(signal.candidate); // candidates can outrun the offer
      }
    } catch (e) {
      this.failMedia(e instanceof Error ? e.message : 'The call connection failed.');
    }
  }

  private async waitForPeer(timeoutMs = 8000) {
    const start = Date.now();
    while (!this.peer && !this.disposed && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  private async flushIce(peer: RtcPeer) {
    const queued = this.pendingIce;
    this.pendingIce = [];
    for (const c of queued) await peer.addIceCandidate(c);
  }

  private onPeerState(callId: string, s: PeerConnectionState) {
    if (this.state.call?.id !== callId || this.disposed) return;
    if (s === 'connected') {
      this.clearGrace();
      const wasReconnecting = this.state.media === 'reconnecting';
      this.set({ media: 'connected', error: null });
      if (wasReconnecting) this.say('Connection restored.');
      if (!this.connectedReported && this.state.call?.state === 'CONNECTING') {
        this.connectedReported = true;
        this.opts.socket.send({ type: 'call_connected', callId });
      }
      this.startStats();
    } else if (s === 'disconnected' || s === 'failed') {
      if (this.state.phase === 'connected' || this.state.phase === 'connecting') {
        this.set({ media: 'reconnecting' });
        this.say('Connection interrupted. Trying to reconnect.');
        this.armGrace(callId);
        // The caller renegotiates ICE; the callee waits for the new offer.
        if (this.state.outgoing && this.peer) void this.restartIce(callId);
      }
    }
  }

  private async restartIce(callId: string) {
    try {
      const sdp = await this.peer?.createOffer({ iceRestart: true });
      if (sdp) this.signal(callId, { kind: 'offer', sdp });
    } catch {
      /* the grace timer ends the call if this cannot recover */
    }
  }

  private armGrace(callId: string) {
    if (this.graceTimer) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (this.state.call?.id === callId && this.state.media === 'reconnecting') {
        this.set({ error: 'The connection was lost.' });
        this.hangUp();
      }
    }, this.opts.reconnectGraceMs ?? 20_000);
  }

  private clearGrace() {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  private failMedia(message: string) {
    this.set({ media: 'failed', error: message });
    this.say(message);
    // A call with no possible audio is ended for both people rather than left ringing silently.
    this.hangUp();
  }

  private startStats() {
    if (this.statsTimer || !this.peer) return;
    this.statsTimer = setInterval(() => void this.pollStats(), this.opts.statsIntervalMs ?? 3000);
  }

  private async pollStats() {
    const peer = this.peer;
    if (!peer) return;
    try {
      const q = this.tracker.update(await peer.getStats());
      if (this.disposed || this.peer !== peer) return;
      this.set({ quality: q });
      if (q.level !== this.lastLevel && q.level !== 'unknown') {
        if (q.level === 'poor') this.say('Call quality is poor.');
        else if (this.lastLevel === 'poor') this.say('Call quality has improved.');
        this.lastLevel = q.level;
      }
      // Protect the audio: pause video that has been failing for a while (the user may turn it back on).
      if (this.state.cameraOn && (q.level === 'poor' || q.video === 'unknown')) {
        if (++this.poorVideoRun >= VIDEO_PAUSE_AFTER_POOR_READINGS) {
          this.peer?.setCameraEnabled(false);
          this.set({ cameraOn: false, videoPausedByApp: true });
          this.say('Video paused because of a weak connection. Audio continues.');
        }
      } else this.poorVideoRun = 0;
    } catch {
      /* stats are advisory */
    }
  }

  private teardownMedia() {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.clearGrace();
    const peer = this.peer;
    this.peer = null;
    peer?.close();
    if (peer) this.opts.rtc?.setCallActive(false);
    this.pendingIce = [];
    this.remoteSet = false;
    this.connectedReported = false;
    this.mediaStarting = false;
    this.tracker = new QualityTracker();
    this.lastLevel = 'unknown';
    this.poorVideoRun = 0;
    this.cameraBeforeBackground = false;
  }

  // ---------------------------------------------------------------- helpers

  private signal(callId: string, signal: CallSignal) {
    this.opts.socket.send({ type: 'call_signal', callId, signal });
  }

  private say(text: string) {
    this.set({ polite: { id: ++this.messageId, text } });
  }
  private alert(text: string) {
    this.set({ assertive: { id: ++this.messageId, text } });
  }

  private set(patch: Partial<CallState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}

const capitalise = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** How a finished call is described to the person on this device. */
export function endText(
  reason: CallEndReason | null,
  outgoing: boolean,
  who: 'your driver' | 'the passenger',
): string {
  switch (reason) {
    case 'DECLINED':
      return outgoing ? `${capitalise(who)} declined the call.` : 'Call declined.';
    case 'MISSED':
      return outgoing ? `No answer from ${who}.` : `Missed call from ${who}.`;
    case 'CANCELLED':
      return outgoing ? 'Call cancelled.' : `Missed call from ${who}.`;
    case 'FAILED':
      return 'The call failed.';
    case 'TRIP_ENDED':
      return 'The call ended because the ride ended.';
    case 'COMPLETED':
    default:
      return 'Call ended.';
  }
}
