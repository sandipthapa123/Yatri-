import { query } from '../db';
import { ConsoleNotificationProvider } from './console-provider';
import type { NotificationPayload, NotificationProvider } from './provider';

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
    console.error('Notification delivery failed', payload.type, err);
  }
}

export type { NotificationPayload, NotificationProvider } from './provider';
