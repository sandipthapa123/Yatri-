import { env } from '../../config/env';
import { ConsoleEmailProvider, ResendEmailProvider, type EmailMessage, type EmailProvider } from './email-provider';

let provider: EmailProvider | undefined;

/** The configured email sender (EMAIL_PROVIDER). Anything that must be email goes through `sendEmail`; nothing names a vendor. */
export function getEmailProvider(): EmailProvider {
  provider ??=
    env.EMAIL_PROVIDER === 'resend'
      ? new ResendEmailProvider({ apiKey: env.RESEND_API_KEY ?? '', from: env.EMAIL_FROM ?? '', timeoutMs: env.PROVIDER_TIMEOUT_MS })
      : new ConsoleEmailProvider();
  return provider;
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  await getEmailProvider().send(message);
}

/** Test seam. */
export function setEmailProviderForTests(p: EmailProvider | undefined): void {
  provider = p;
}

export type { EmailMessage, EmailProvider } from './email-provider';
