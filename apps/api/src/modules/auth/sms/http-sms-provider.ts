import { providerRequest } from '../../providers/http';
import type { SmsMessage, SmsProvider } from './sms-provider';

/**
 * Generic webhook-style provider: POSTs { to, body } as JSON to a configured endpoint with a bearer API key. Point
 * SMS_HTTP_ENDPOINT at a local gateway (Sparrow SMS and similar) or use a vendor-specific class. The call goes through the
 * one vendor-call function, so it has a deadline, a named failure and usage counters; a text is never sent twice by a retry.
 */
export class HttpSmsProvider implements SmsProvider {
  readonly name = 'http';
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string | undefined,
    private readonly timeoutMs: number,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async send(message: SmsMessage): Promise<void> {
    await providerRequest({
      capability: 'OTP',
      provider: this.name,
      operation: 'send',
      url: this.endpoint,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ to: message.toPhoneNumber, body: message.body }),
      },
      timeoutMs: this.timeoutMs,
      idempotent: false,
      expect: 'none',
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
  }
}
