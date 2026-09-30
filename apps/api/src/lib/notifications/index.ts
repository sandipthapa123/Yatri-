import { getRedisClient } from '../../config/redis';
import { query } from '../db';
import { ConsoleNotificationProvider } from './console-provider';
import type { NotificationPayload, NotificationProvider } from './provider';
import { log } from '../logger';

let provider: NotificationProvider | undefined;

function getProvider(): NotificationProvider {
  if (!provider) provider = new ConsoleNotificationProvider();
  return provider;
}

/**
 * Persists the notification (the durable record of "this happened") and
 * best-effort delivers it through the configured provider. A delivery
 * failure never fails the caller's actual operation (e.g. approving a
 * driver must succeed even if the push provider is down).
 */
export async function notify(payload: NotificationPayload): Promise<void> {
  await query(
    `INSERT INTO notifications (user_id, type, title, body, metadata) VALUES ($1, $2, $3, $4, $5)`,
    [
      payload.userId,
      payload.type,
      payload.title,
      payload.body,
      JSON.stringify(payload.metadata ?? {}),
    ],
  );
  try {
    await getProvider().send(payload);
  } catch (err) {
    log.error('Notification delivery failed', payload.type, err);
  }
}

/**
 * notify(), at most once per `key` within `windowSeconds`. For bursts (a run of chat messages) where
 * one nudge is right and ten would be noise. The key decides what counts as "the same" nudge.
 */
export async function notifyThrottled(
  key: string,
  windowSeconds: number,
  payload: NotificationPayload,
): Promise<boolean> {
  const first = await getRedisClient().set(`notif:${key}`, '1', 'EX', windowSeconds, 'NX');
  if (first !== 'OK') return false;
  await notify(payload);
  return true;
}

export type { NotificationPayload, NotificationProvider } from './provider';
