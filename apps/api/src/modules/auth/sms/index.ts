import { env } from '../../../config/env';
import { ConsoleSmsProvider } from './console-sms-provider';
import { HttpSmsProvider } from './http-sms-provider';
import type { SmsProvider } from './sms-provider';

let provider: SmsProvider | undefined;

export function getSmsProvider(): SmsProvider {
  if (!provider) {
    provider =
      env.SMS_PROVIDER === 'http'
        ? new HttpSmsProvider(env.SMS_HTTP_ENDPOINT!, env.SMS_HTTP_API_KEY)
        : new ConsoleSmsProvider();
  }
  return provider;
}

export type { SmsProvider } from './sms-provider';
