import type { NotificationPayload, NotificationProvider } from './provider';

/** Development/foundation provider: logs instead of sending a real push/SMS/email. */
export class ConsoleNotificationProvider implements NotificationProvider {
  async send(payload: NotificationPayload): Promise<void> {
    console.log(`[notification] user=${payload.userId} type=${payload.type} "${payload.title}"`);
  }
}
