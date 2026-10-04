import { NOTIFICATION_MAX_ATTEMPTS, NOTIFICATION_RETRY_SECONDS } from '@yatri/types';

import { env } from '../../config/env';
import { getRedisClient } from '../../config/redis';
import { ExpoPushProvider } from './expo-provider';
import { query } from '../db';
import { ConsoleNotificationProvider } from './console-provider';
import type { NotificationPayload, NotificationProvider } from './provider';
import { log } from '../logger';
import { shouldDeliver } from '../../modules/preferences/preferences.service';

let provider: NotificationProvider | undefined;

export function getProvider(): NotificationProvider {
  provider ??=
    env.PUSH_PROVIDER === 'expo'
      ? new ExpoPushProvider({
          ...(env.EXPO_ACCESS_TOKEN ? { accessToken: env.EXPO_ACCESS_TOKEN } : {}),
          timeoutMs: env.PROVIDER_TIMEOUT_MS,
        })
      : new ConsoleNotificationProvider();
  return provider;
}

/** Test seam. */
export function setPushProviderForTests(p: NotificationProvider | undefined): void {
  provider = p;
}

/**
 * THE notification service. `notify` records the notification (the durable record of "this happened") and then pushes
 * it through the configured provider. Delivery is reliable in three ways:
 *  - what the person switched off is recorded as SUPPRESSED and not pushed (preferences);
 *  - a push that fails is kept as FAILED with a back-off and retried by the `notification-retry` job (the one job
 *    architecture), then given up on as DEAD: a provider outage never fails the caller's own operation, and never loses
 *    the record;
 *  - a notification with a `dedupeKey` is recorded and delivered at most once for that person, however often the code
 *    that raises it runs.
 */
export async function notify(payload: NotificationPayload): Promise<void> {
  const deliver = await shouldDeliver(payload.userId, payload.type).catch(() => true);
  const inserted = await query<{ id: string }>(
    `INSERT INTO notifications (user_id, type, title, body, metadata, delivery_status, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      payload.userId,
      payload.type,
      payload.title,
      payload.body,
      JSON.stringify(payload.metadata ?? {}),
      deliver ? 'PENDING' : 'SUPPRESSED',
      payload.dedupeKey ?? null,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id || !deliver) return; // a repeat of something already recorded, or switched off by the person
  await attemptDelivery(id, payload);
}

/** One push attempt: SENT if it goes, otherwise FAILED with the next time to try (or DEAD after the last try). */
async function attemptDelivery(id: string, payload: NotificationPayload): Promise<void> {
  try {
    await getProvider().send(payload);
    await query(
      `UPDATE notifications SET delivery_status = 'SENT', attempts = attempts + 1, next_attempt_at = NULL, last_error = NULL WHERE id = $1`,
      [id],
    );
  } catch (err) {
    log.error('Notification delivery failed', payload.type, err);
    const text = err instanceof Error ? err.message : String(err);
    await query(
      `UPDATE notifications SET attempts = attempts + 1, last_error = left($2, 300),
         delivery_status = CASE WHEN attempts + 1 >= $3 THEN 'DEAD' ELSE 'FAILED' END,
         next_attempt_at = CASE WHEN attempts + 1 >= $3 THEN NULL
                                ELSE now() + ((($4::int[])[LEAST(attempts + 1, $5)]) * interval '1 second') END
       WHERE id = $1`,
      [
        id,
        text,
        NOTIFICATION_MAX_ATTEMPTS,
        [...NOTIFICATION_RETRY_SECONDS],
        NOTIFICATION_RETRY_SECONDS.length,
      ],
    );
  }
}

/**
 * The `notification-retry` job: push again whatever failed and is due. Rows are claimed with SKIP LOCKED, so two
 * instances (or two overlapping runs) never push the same notification twice.
 */
export async function retryFailedNotifications(
  limit = 100,
): Promise<{ retried: number; sent: number; dead: number }> {
  const due = await query<{
    id: string;
    user_id: string;
    type: string;
    title: string;
    body: string;
    metadata: Record<string, unknown>;
  }>(
    `UPDATE notifications SET next_attempt_at = now() + interval '5 minutes'
     WHERE id IN (SELECT id FROM notifications
                  WHERE delivery_status = 'FAILED' AND next_attempt_at <= now()
                  ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id, user_id, type, title, body, metadata`,
    [limit],
  );
  let sent = 0;
  let dead = 0;
  for (const n of due.rows) {
    await attemptDelivery(n.id, {
      userId: n.user_id,
      type: n.type,
      title: n.title,
      body: n.body,
      metadata: n.metadata,
    });
    const after = await query<{ delivery_status: string }>(
      'SELECT delivery_status FROM notifications WHERE id = $1',
      [n.id],
    );
    if (after.rows[0]?.delivery_status === 'SENT') sent += 1;
    if (after.rows[0]?.delivery_status === 'DEAD') dead += 1;
  }
  return { retried: due.rows.length, sent, dead };
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
