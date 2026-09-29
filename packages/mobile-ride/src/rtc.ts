import type { CallKind, IceServer } from '@yatri/types';

import type { RtcStatsSample } from './callQuality';

/**
 * The seam between the call controller (pure, tested) and the platform's WebRTC. The controller
 * never touches react-native-webrtc directly, so the state machine is verified without a device
 * and the native adapter stays a thin, replaceable layer.
 */
export type PeerConnectionState = 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';
export type MediaPermission = 'granted' | 'denied';

export interface RtcPeer {
  createOffer(opts?: { iceRestart?: boolean }): Promise<string>;
  createAnswer(): Promise<string>;
  setRemoteDescription(kind: 'offer' | 'answer', sdp: string): Promise<void>;
  addIceCandidate(candidate: Record<string, unknown>): Promise<void>;
  onIceCandidate(cb: (candidate: Record<string, unknown>) => void): void;
  onConnectionState(cb: (state: PeerConnectionState) => void): void;
  /** The other person's video, as a URL the platform video view can render (video calls only). */
  onRemoteStream?(cb: (streamUrl: string) => void): void;
  /** Normalised inbound stats (see callQuality). */
  getStats(): Promise<RtcStatsSample>;
  setMicrophoneMuted(muted: boolean): void;
  setCameraEnabled(enabled: boolean): void;
  close(): void;
}

export interface RtcFactory {
  /** Ask for microphone (and camera for video). Resolves 'denied' rather than throwing. */
  requestPermissions(kind: CallKind): Promise<MediaPermission>;
  createPeer(opts: { iceServers: IceServer[]; kind: CallKind }): Promise<RtcPeer>;
  /** Route audio to the loudspeaker (true) or the earpiece/headset (false). */
  setSpeaker(on: boolean): void;
  /** Called when a call starts/ends so the platform can hold the audio session. */
  setCallActive(active: boolean): void;
}
