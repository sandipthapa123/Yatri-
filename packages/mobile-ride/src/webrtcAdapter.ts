/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports --
   react-native-webrtc and react-native-incall-manager are OPTIONAL native modules loaded at
   runtime: the app builds and runs without them (calls then report that audio is unavailable),
   and a development build that includes them gets real media. Their typings are not a dependency. */
import type { CallKind, IceServer } from '@yatri/types';
import { PermissionsAndroid, Platform } from 'react-native';

import type { RtcStatsSample } from './callQuality';
import type { MediaPermission, PeerConnectionState, RtcFactory, RtcPeer } from './rtc';

function load(name: string): any | null {
  try {
    // A literal require inside try/catch is an optional dependency to Metro.
    if (name === 'react-native-webrtc') return require('react-native-webrtc');
    if (name === 'react-native-incall-manager') {
      const m = require('react-native-incall-manager');
      return m?.default ?? m;
    }
  } catch {
    /* not installed in this build */
  }
  return null;
}

/** True when this build includes WebRTC. */
export function webrtcAvailable(): boolean {
  return load('react-native-webrtc') !== null;
}

/**
 * The platform WebRTC, or null when the build does not include it. The call controller treats
 * null honestly: the call can be placed, but it says plainly that no audio can flow.
 */
export function createNativeRtc(): RtcFactory | null {
  const webrtc = load('react-native-webrtc');
  if (!webrtc) return null;
  const inCall = load('react-native-incall-manager');
  const { RTCPeerConnection, mediaDevices, RTCIceCandidate, RTCSessionDescription } = webrtc;

  return {
    async requestPermissions(kind: CallKind): Promise<MediaPermission> {
      if (Platform.OS !== 'android') return 'granted'; // iOS asks when the microphone is first opened
      const wanted = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
      if (kind === 'VIDEO') wanted.push(PermissionsAndroid.PERMISSIONS.CAMERA);
      const result = await PermissionsAndroid.requestMultiple(wanted);
      return wanted.every((p) => result[p] === PermissionsAndroid.RESULTS.GRANTED)
        ? 'granted'
        : 'denied';
    },

    async createPeer({ iceServers, kind }: { iceServers: IceServer[]; kind: CallKind }) {
      let stream: any;
      try {
        stream = await mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video:
            kind === 'VIDEO'
              ? { facingMode: 'user', width: 1280, height: 720, frameRate: 30 }
              : false,
        });
      } catch (e) {
        const name = (e as { name?: string }).name ?? '';
        throw new Error(
          /NotAllowed|Permission/i.test(name)
            ? 'Microphone or camera access was denied. Allow it in Settings to take calls.'
            : 'The microphone or camera could not be started.',
        );
      }
      const pc = new RTCPeerConnection({ iceServers });
      stream.getTracks().forEach((t: any) => pc.addTrack(t, stream));

      let onIce: ((c: Record<string, unknown>) => void) | null = null;
      let onState: ((s: PeerConnectionState) => void) | null = null;
      let onRemote: ((url: string) => void) | null = null;
      pc.addEventListener('track', (e: any) => {
        const s = e.streams?.[0];
        if (s && s.getVideoTracks?.().length > 0) onRemote?.(s.toURL());
      });
      pc.addEventListener('icecandidate', (e: any) => {
        if (e.candidate) onIce?.(e.candidate.toJSON ? e.candidate.toJSON() : e.candidate);
      });
      pc.addEventListener('connectionstatechange', () => {
        const s = pc.connectionState as string;
        if (s === 'connected') onState?.('connected');
        else if (s === 'disconnected') onState?.('disconnected');
        else if (s === 'failed') onState?.('failed');
        else if (s === 'closed') onState?.('closed');
        else onState?.('connecting');
      });

      const peer: RtcPeer = {
        async createOffer(opts) {
          const offer = await pc.createOffer({ iceRestart: opts?.iceRestart === true });
          await pc.setLocalDescription(offer);
          return offer.sdp as string;
        },
        async createAnswer() {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          return answer.sdp as string;
        },
        async setRemoteDescription(type, sdp) {
          await pc.setRemoteDescription(new RTCSessionDescription({ type, sdp }));
        },
        async addIceCandidate(candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        },
        onIceCandidate(cb) {
          onIce = cb;
        },
        onConnectionState(cb) {
          onState = cb;
        },
        onRemoteStream(cb) {
          onRemote = cb;
        },
        async getStats(): Promise<RtcStatsSample> {
          return normaliseStats(await pc.getStats());
        },
        setMicrophoneMuted(muted) {
          stream.getAudioTracks().forEach((t: any) => (t.enabled = !muted));
        },
        setCameraEnabled(enabled) {
          stream.getVideoTracks().forEach((t: any) => (t.enabled = enabled));
        },
        close() {
          try {
            stream.getTracks().forEach((t: any) => t.stop());
            pc.close();
          } catch {
            /* already closed */
          }
        },
      };
      return peer;
    },

    setSpeaker(on: boolean) {
      inCall?.setForceSpeakerphoneOn?.(on);
    },
    setCallActive(active: boolean) {
      if (active) inCall?.start?.({ media: 'audio' });
      else inCall?.stop?.();
    },
  };
}

/** Turn the WebRTC stats report into the small shape callQuality understands. */
function normaliseStats(report: any): RtcStatsSample {
  const byId = new Map<string, any>();
  report.forEach((v: any, k: string) => byId.set(v.id ?? k, v));
  let audio: RtcStatsSample['audio'] = null;
  let video: RtcStatsSample['video'] = null;
  let rttMs: number | null = null;

  report.forEach((s: any) => {
    if (
      s.type === 'candidate-pair' &&
      (s.nominated || s.selected) &&
      s.currentRoundTripTime != null
    ) {
      rttMs = s.currentRoundTripTime * 1000;
    }
    if (s.type === 'inbound-rtp' && !s.isRemote) {
      const kind = s.kind ?? s.mediaType;
      if (kind === 'audio') {
        audio = {
          codec: (s.codecId && byId.get(s.codecId)?.mimeType) ?? null,
          bytesReceived: s.bytesReceived ?? 0,
          packetsReceived: s.packetsReceived ?? 0,
          packetsLost: s.packetsLost ?? 0,
          jitterMs: s.jitter != null ? s.jitter * 1000 : null,
          roundTripMs: null,
        };
      } else if (kind === 'video') {
        video = {
          frameWidth: s.frameWidth ?? null,
          frameHeight: s.frameHeight ?? null,
          framesPerSecond: s.framesPerSecond ?? null,
          bytesReceived: s.bytesReceived ?? 0,
          packetsReceived: s.packetsReceived ?? 0,
          packetsLost: s.packetsLost ?? 0,
        };
      }
    }
  });
  const a = audio as RtcStatsSample['audio'];
  return { atMs: Date.now(), audio: a ? { ...a, roundTripMs: rttMs } : null, video };
}

/** The remote video surface. Present only when WebRTC is in the build. */
export function getRtcView(): any | null {
  return load('react-native-webrtc')?.RTCView ?? null;
}
