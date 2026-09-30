import { log } from '../logger';
import type { NotificationPayload, NotificationProvider } from './provider';

/**
 * The only delivery channel today: it records that a notification exists (the row in
 * `notifications` is the durable copy the apps read) and logs the fact, not the words. No push
 * provider is connected yet; when one is, it is another NotificationProvider and nothing else changes.
 */
export class ConsoleNotificationProvider implements NotificationProvider {
  async send(payload: NotificationPayload): Promise<void> {
    log.debug('notification recorded', { userId: payload.userId, type: payload.type });
  }
}
