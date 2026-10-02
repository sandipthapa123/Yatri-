import { createHmac } from 'node:crypto';

import type { IceServer, IceServersResponse } from '@yatri/types';

import { env } from '../../config/env';
import { TwilioIceProvider } from './twilio-ice-provider';

/**
 * What a call provider is to the rest of the server. The call state machine, authorization and
 * signalling relay (`calls.service`) never know which provider carries the media; a provider only
 * answers "what does this person need to connect a call". Swapping providers is a new class here and
 * a value for CALL_PROVIDER — no other file changes. Media is never stored by Yatri.
 */
export interface CallProvider {
  readonly name: string;
  /** A live check of the vendor (optional: peer-to-peer has none). */
  check?(): Promise<void>;
  /** What the caller/callee needs to reach each other (for peer-to-peer: STUN, and TURN credentials). */
  connectionInfo(userId: string): Promise<IceServersResponse>;
}

/** Peer-to-peer WebRTC: media flows between the phones; Yatri only relays signalling. */
export const webrtcProvider: CallProvider = {
  name: 'webrtc',
  async connectionInfo(userId) {
    const servers: IceServer[] = [];
    if (env.CALL_STUN_URLS.length) servers.push({ urls: env.CALL_STUN_URLS });
    if (env.CALL_TURN_URLS.length && env.CALL_TURN_SHARED_SECRET) {
      // coturn's time-limited shared-secret scheme: the credential proves itself and dies on its own.
      const expiry = Math.floor(Date.now() / 1000) + env.CALL_TURN_CREDENTIAL_TTL_SECONDS;
      const username = `${expiry}:${userId}`;
      const credential = createHmac('sha1', env.CALL_TURN_SHARED_SECRET)
        .update(username)
        .digest('base64');
      servers.push({ urls: env.CALL_TURN_URLS, username, credential });
    }
    return { iceServers: servers, ttlSeconds: env.CALL_TURN_CREDENTIAL_TTL_SECONDS };
  },
};

let active: CallProvider | undefined;

/** The configured call provider (CALL_PROVIDER): peer-to-peer with our own relay, or a managed relay (Twilio). */
export function activeCallProvider(): CallProvider {
  active ??=
    env.CALL_PROVIDER === 'twilio'
      ? new TwilioIceProvider({
          accountSid: env.TWILIO_ACCOUNT_SID ?? '',
          authToken: env.TWILIO_AUTH_TOKEN ?? '',
          ttlSeconds: env.CALL_TURN_CREDENTIAL_TTL_SECONDS,
          timeoutMs: env.PROVIDER_TIMEOUT_MS,
        })
      : webrtcProvider;
  return active;
}
