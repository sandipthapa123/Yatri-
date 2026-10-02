import type { IceServer, IceServersResponse } from '@yatri/types';

import { providerRequest } from '../providers/http';
import type { CallProvider } from './call-provider';

export interface TwilioIceConfig {
  accountSid: string;
  authToken: string;
  ttlSeconds: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface TwilioToken {
  ice_servers?: Array<{ url?: string; urls?: string | string[]; username?: string; credential?: string }>;
  ttl?: string | number;
}

/**
 * Calls through a managed relay: Twilio's Network Traversal Service hands out short-lived STUN and TURN credentials, so the
 * media still flows between the two phones (or through the relay when they cannot reach each other) and Yatri still only
 * relays the signalling. The same CallProvider interface as peer-to-peer: nothing in the call logic knows which is used.
 * Credentials are shared and short-lived, so they are fetched once and reused for most of their life.
 */
export class TwilioIceProvider implements CallProvider {
  readonly name = 'twilio';
  private cached: { value: IceServersResponse; until: number } | null = null;
  constructor(private readonly c: TwilioIceConfig) {}

  private auth() {
    return `Basic ${Buffer.from(`${this.c.accountSid}:${this.c.authToken}`).toString('base64')}`;
  }

  private async fetchToken(): Promise<IceServersResponse> {
    const res = await providerRequest<TwilioToken>({
      capability: 'CALLS',
      provider: this.name,
      operation: 'token',
      url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.c.accountSid)}/Tokens.json`,
      init: {
        method: 'POST',
        headers: { Authorization: this.auth(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ Ttl: String(this.c.ttlSeconds) }).toString(),
      },
      timeoutMs: this.c.timeoutMs,
      idempotent: true, // asking for another token is harmless
      expect: 'json',
      ...(this.c.fetchImpl ? { fetchImpl: this.c.fetchImpl } : {}),
    });
    const servers: IceServer[] = (res.data.ice_servers ?? []).flatMap((s) => {
      const urls = s.urls ?? s.url;
      if (!urls) return [];
      return [{ urls, ...(s.username ? { username: s.username } : {}), ...(s.credential ? { credential: s.credential } : {}) } as IceServer];
    });
    return { iceServers: servers, ttlSeconds: Number(res.data.ttl ?? this.c.ttlSeconds) };
  }

  async connectionInfo(): Promise<IceServersResponse> {
    const now = (this.c.now ?? Date.now)();
    if (this.cached && this.cached.until > now) return this.cached.value;
    const value = await this.fetchToken();
    this.cached = { value, until: now + Math.max(1, value.ttlSeconds) * 600 }; // 60% of the life, in ms
    return value;
  }

  async check(): Promise<void> {
    await this.fetchToken();
  }
}
