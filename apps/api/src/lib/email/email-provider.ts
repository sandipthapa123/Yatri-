import { log } from '../logger';
import { providerRequest } from '../../modules/providers/http';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Everything above this interface sends email through `sendEmail`; which vendor carries it is configuration. */
export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
  check?(): Promise<void>;
}

/** Development only: says that an email would have been sent, never what it said or to whom. */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';
  async send(): Promise<void> {
    log.debug('email recorded (console provider)');
  }
}

export interface ResendConfig {
  apiKey: string;
  from: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** Email through Resend's HTTP API. Sending is not repeated by a retry (a second attempt could send a second email). */
export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';
  constructor(private readonly c: ResendConfig) {}

  private headers() {
    return { Authorization: `Bearer ${this.c.apiKey}`, 'Content-Type': 'application/json' };
  }

  async send(m: EmailMessage): Promise<void> {
    await providerRequest({
      capability: 'EMAIL',
      provider: this.name,
      operation: 'send',
      url: 'https://api.resend.com/emails',
      init: {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ from: this.c.from, to: [m.to], subject: m.subject, text: m.text }),
      },
      timeoutMs: this.c.timeoutMs,
      idempotent: false,
      expect: 'none',
      ...(this.c.fetchImpl ? { fetchImpl: this.c.fetchImpl } : {}),
    });
  }

  /** Listing domains is a read that proves the key and the network path without sending anything. */
  async check(): Promise<void> {
    await providerRequest({
      capability: 'EMAIL',
      provider: this.name,
      operation: 'check',
      url: 'https://api.resend.com/domains',
      init: { headers: this.headers() },
      timeoutMs: this.c.timeoutMs,
      idempotent: true,
      expect: 'none',
      ...(this.c.fetchImpl ? { fetchImpl: this.c.fetchImpl } : {}),
    });
  }
}
