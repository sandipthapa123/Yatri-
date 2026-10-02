import { ProviderError } from '../../providers/errors';
import { log } from '../../../lib/logger';
import type { SmsMessage, SmsProvider } from './sms-provider';

/**
 * Sign-in codes must arrive, so a second vendor stands behind the first. The fallback is tried only when the primary fails
 * in a way that may pass by itself (a timeout, an outage, a rate limit, a tripped breaker): a bad request or wrong
 * credentials would fail the same way again and say something is misconfigured, which is for a person to fix. If both
 * fail, the primary's failure is the one reported.
 */
export class FallbackSmsProvider implements SmsProvider {
  readonly name: string;
  constructor(
    private readonly primary: SmsProvider,
    private readonly fallback: SmsProvider,
  ) {
    this.name = `${primary.name ?? 'primary'}+${fallback.name ?? 'fallback'}`;
  }

  async send(message: SmsMessage): Promise<void> {
    try {
      await this.primary.send(message);
    } catch (err) {
      if (!(err instanceof ProviderError) || !err.retryable) throw err;
      log.warn(`SMS primary failed (${err.kind}); using the fallback provider`);
      try {
        await this.fallback.send(message);
      } catch {
        throw err;
      }
    }
  }

  async check(): Promise<void> {
    await this.primary.check?.();
  }
}
