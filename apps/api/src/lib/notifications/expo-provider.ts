import { query } from '../db';
import { log } from '../logger';
import { providerRequest } from '../../modules/providers/http';
import type { NotificationPayload, NotificationProvider } from './provider';

export interface ExpoConfig {
  accessToken?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface Ticket {
  status: 'ok' | 'error';
  details?: { error?: string };
}

/**
 * Push notifications to phones through Expo's push service. The person's phone addresses (push tokens) are the only thing
 * this needs from Yatri's data, and they are used only to deliver that person's own notifications. What is pushed is the
 * title, the body and a minimal `data` (the type and, for a ride, its id): never an accessibility detail, a note, a
 * location or a document, which are never in a notification at all. A phone that no longer exists is removed. A failure
 * is named and thrown, so the notification service keeps the notification and retries it (Phase 21), never loses it.
 */
export class ExpoPushProvider implements NotificationProvider {
  readonly name = 'expo';
  constructor(private readonly c: ExpoConfig) {}

  private headers() {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(this.c.accessToken ? { Authorization: `Bearer ${this.c.accessToken}` } : {}),
    };
  }

  async send(payload: NotificationPayload): Promise<void> {
    const tokens = await query<{ token: string }>('SELECT token FROM push_tokens WHERE user_id = $1', [payload.userId]);
    if (tokens.rows.length === 0) return; // nowhere to push: the record in the app's notification list is the delivery
    const tripId = typeof payload.metadata?.tripId === 'string' ? payload.metadata.tripId : undefined;
    const messages = tokens.rows.map((t) => ({
      to: t.token,
      title: payload.title,
      body: payload.body,
      sound: 'default',
      data: { type: payload.type, ...(tripId ? { tripId } : {}) },
    }));
    const res = await providerRequest<{ data?: Ticket[] }>({
      capability: 'PUSH',
      provider: this.name,
      operation: 'send',
      url: 'https://exp.host/--/api/v2/push/send',
      init: { method: 'POST', headers: this.headers(), body: JSON.stringify(messages) },
      timeoutMs: this.c.timeoutMs,
      idempotent: false,
      expect: 'json',
      ...(this.c.fetchImpl ? { fetchImpl: this.c.fetchImpl } : {}),
    });
    const tickets = res.data.data ?? [];
    for (let i = 0; i < tickets.length; i += 1) {
      const t = tickets[i];
      if (t?.status === 'error' && t.details?.error === 'DeviceNotRegistered') {
        await query('DELETE FROM push_tokens WHERE token = $1', [messages[i]?.to]).catch((err) => log.warn('Could not remove a stale push token', err));
      }
    }
  }

  /** The receipts endpoint with nothing to look up: a free call that proves the service answers. */
  async check(): Promise<void> {
    await providerRequest({
      capability: 'PUSH',
      provider: this.name,
      operation: 'check',
      url: 'https://exp.host/--/api/v2/push/getReceipts',
      init: { method: 'POST', headers: this.headers(), body: JSON.stringify({ ids: [] }) },
      timeoutMs: this.c.timeoutMs,
      idempotent: true,
      expect: 'none',
      ...(this.c.fetchImpl ? { fetchImpl: this.c.fetchImpl } : {}),
    });
  }
}
