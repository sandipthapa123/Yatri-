import { env } from '../../../config/env';
import { ConsoleSmsProvider } from './console-sms-provider';
import { FallbackSmsProvider } from './fallback-sms-provider';
import { HttpSmsProvider } from './http-sms-provider';
import type { SmsProvider } from './sms-provider';
import { TwilioSmsProvider } from './twilio-sms-provider';

let provider: SmsProvider | undefined;

function build(kind: 'console' | 'http' | 'twilio'): SmsProvider {
  switch (kind) {
    case 'http':
      return new HttpSmsProvider(env.SMS_HTTP_ENDPOINT ?? '', env.SMS_HTTP_API_KEY, env.PROVIDER_TIMEOUT_MS);
    case 'twilio':
      return new TwilioSmsProvider({
        accountSid: env.TWILIO_ACCOUNT_SID ?? '',
        authToken: env.TWILIO_AUTH_TOKEN ?? '',
        from: env.TWILIO_FROM_NUMBER ?? '',
        timeoutMs: env.PROVIDER_TIMEOUT_MS,
      });
    case 'console':
      return new ConsoleSmsProvider();
  }
}

/** The configured sign-in code sender, with the configured fallback behind it (if any). */
export function getSmsProvider(): SmsProvider {
  if (!provider) {
    const primary = build(env.SMS_PROVIDER);
    provider = env.SMS_FALLBACK_PROVIDER === 'none' ? primary : new FallbackSmsProvider(primary, build(env.SMS_FALLBACK_PROVIDER));
  }
  return provider;
}

/** Test seam. */
export function setSmsProviderForTests(p: SmsProvider | undefined): void {
  provider = p;
}

export type { SmsProvider } from './sms-provider';
