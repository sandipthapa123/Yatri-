import { env } from '../../config/env';
import { log } from '../logger';
import {
  ConsoleErrorReporter,
  SentryErrorReporter,
  scrubbedEvent,
  type ErrorContext,
  type ErrorReporter,
} from './reporter';

let reporter: ErrorReporter | undefined;

export function getErrorReporter(): ErrorReporter {
  reporter ??=
    env.MONITORING_PROVIDER === 'sentry'
      ? new SentryErrorReporter({
          dsn: env.SENTRY_DSN ?? '',
          environment: env.NODE_ENV,
          release: env.APP_VERSION ?? 'dev', // the one version the service already reports (health)
          timeoutMs: env.PROVIDER_TIMEOUT_MS,
        })
      : new ConsoleErrorReporter();
  return reporter;
}

/**
 * Tell the team an unexpected error happened. Fire and forget: reporting can never fail or slow the request it describes,
 * and what is sent is the scrubbed event only (reporter.ts).
 */
export function reportError(err: unknown, ctx: ErrorContext): void {
  void getErrorReporter()
    .capture(scrubbedEvent(err, ctx))
    .catch(() => log.warn('Error report could not be delivered'));
}

/** Test seam. */
export function setErrorReporterForTests(r: ErrorReporter | undefined): void {
  reporter = r;
}

export { ConsoleErrorReporter } from './reporter';
export type { ErrorContext, ErrorReporter, ScrubbedEvent } from './reporter';
