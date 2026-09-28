import { isProduction } from '../../../config/env';
import type { SmsMessage, SmsProvider } from './sms-provider';

/**
 * Development/local-only provider: logs the message instead of sending a
 * real SMS. Refuses to run in production so a misconfiguration can never
 * silently "send" OTPs to a log file instead of a phone.
 */
export class ConsoleSmsProvider implements SmsProvider {
  constructor() {
    if (isProduction) {
      throw new Error('ConsoleSmsProvider must not be used when NODE_ENV=production');
    }
  }

  async send(message: SmsMessage): Promise<void> {
    console.log(`[dev-sms] to=${message.toPhoneNumber} body="${message.body}"`);
  }
}
