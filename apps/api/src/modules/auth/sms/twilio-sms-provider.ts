import { providerRequest } from '../../providers/http';
import type { SmsMessage, SmsProvider } from './sms-provider';

export interface TwilioSmsConfig {
  accountSid: string;
  authToken: string;
  from: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/**
 * Sign-in codes through Twilio's Messages API. Sending a text is NOT repeated by a retry here (a second attempt could
 * send a second code); a failure is named (ProviderError) and the caller or the fallback provider decides what next.
 */
export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio';
  constructor(private readonly c: TwilioSmsConfig) {}

  private auth() {
    return `Basic ${Buffer.from(`${this.c.accountSid}:${this.c.authToken}`).toString('base64')}`;
  }

  async send(message: SmsMessage): Promise<void> {
    await providerRequest({
      capability: 'OTP',
      provider: this.name,
      operation: 'send',
      url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.c.accountSid)}/Messages.json`,
      init: {
        method: 'POST',
        headers: { Authorization: this.auth(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: message.toPhoneNumber, From: this.c.from, Body: message.body }).toString(),
      },
      timeoutMs: this.c.timeoutMs,
      idempotent: false,
      expect: 'none',
      ...(this.c.fetchImpl ? { fetchImpl: this.c.fetchImpl } : {}),
    });
  }

  /** The account's own record: free, sends nothing, proves the credentials and the network path. */
  async check(): Promise<void> {
    await providerRequest({
      capability: 'OTP',
      provider: this.name,
      operation: 'check',
      url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.c.accountSid)}.json`,
      init: { headers: { Authorization: this.auth() } },
      timeoutMs: this.c.timeoutMs,
      idempotent: true,
      expect: 'none',
      ...(this.c.fetchImpl ? { fetchImpl: this.c.fetchImpl } : {}),
    });
  }
}
