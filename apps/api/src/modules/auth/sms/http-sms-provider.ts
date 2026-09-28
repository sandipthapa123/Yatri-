import type { SmsMessage, SmsProvider } from './sms-provider';

/**
 * Generic webhook-style provider: POSTs { to, body } as JSON to a
 * configured endpoint with a bearer API key. This is a placeholder
 * integration point — point SMS_HTTP_ENDPOINT at your real vendor's API
 * (Sparrow SMS, Twilio, etc.) or replace this class with a vendor-specific
 * one that still implements SmsProvider. Nothing else in the codebase
 * needs to change either way.
 */
export class HttpSmsProvider implements SmsProvider {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string | undefined,
  ) {}

  async send(message: SmsMessage): Promise<void> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ to: message.toPhoneNumber, body: message.body }),
    });

    if (!response.ok) {
      throw new Error(`SMS provider responded with status ${response.status}`);
    }
  }
}
