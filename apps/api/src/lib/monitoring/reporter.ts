import { randomUUID } from 'node:crypto';

import { log } from '../logger';
import { providerRequest } from '../../modules/providers/http';

/**
 * Error reporting. `reportError` is the one call the server makes when something fails that the team should hear about
 * (an unexpected error answering a request, a background job failing, a crash). What leaves the process is deliberately
 * small: the error's name and message, a stack trace, the place it happened (a route or a job name), the environment and
 * the release. Never a request body, a header, a token, a phone number, an address, a coordinate or a person's name:
 * `scrub` removes them from the text, and the context is built from a fixed list of safe fields.
 */
export interface ErrorContext {
  /** Where: "GET /api/v1/trips/:id" or "job:trip-sweep". Never a URL with ids or a query. */
  where: string;
  status?: number;
  requestId?: string;
}

export interface ErrorReporter {
  readonly name: string;
  capture(event: ScrubbedEvent): Promise<void>;
  check?(): Promise<void>;
}

export interface ScrubbedEvent {
  name: string;
  message: string;
  stack: string | null;
  where: string;
  status: number | null;
  requestId: string | null;
}

// Order matters: the most specific shapes first, so a phone-number pattern cannot chew half of an id or a token.
const PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:Bearer|Basic)\s+[\w.~+/=-]+/gi, '[credential]'],
  [/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\b/g, '[token]'], // JWTs and dotted tokens
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]'],
  [/-?\d{1,3}\.\d{4,},\s*-?\d{1,3}\.\d{4,}/g, '[place]'], // a coordinate pair
  [/\b[A-Za-z0-9+/=_-]{32,}\b/g, '[secret]'],
  [/\+?\d[\d\s().-]{8,}\d/g, '[number]'], // phone numbers and long digit strings
];

export function scrub(text: string): string {
  return PATTERNS.reduce((t, [re, to]) => t.replace(re, to), text).slice(0, 4000);
}

export function scrubbedEvent(err: unknown, ctx: ErrorContext): ScrubbedEvent {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Unknown error');
  return {
    name: e.name,
    message: scrub(e.message),
    stack: e.stack ? scrub(e.stack) : null,
    where: ctx.where.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id').slice(0, 120),
    status: ctx.status ?? null,
    requestId: ctx.requestId ?? null,
  };
}

/** Development and tests: says an error would have been reported, with the same scrubbed event, and keeps it for tests. */
export class ConsoleErrorReporter implements ErrorReporter {
  readonly name = 'none';
  readonly seen: ScrubbedEvent[] = [];
  async capture(event: ScrubbedEvent): Promise<void> {
    this.seen.push(event);
    if (this.seen.length > 50) this.seen.shift();
    log.debug('error recorded (no reporter configured)');
  }
}

export interface SentryConfig {
  dsn: string;
  environment: string;
  release: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** Error reporting to Sentry through its HTTP envelope API (no SDK, so no vendor code runs inside the server). */
export class SentryErrorReporter implements ErrorReporter {
  readonly name = 'sentry';
  private readonly endpoint: string;
  private readonly key: string;
  constructor(private readonly c: SentryConfig) {
    const u = new URL(c.dsn);
    this.key = u.username;
    const projectId = u.pathname.replace(/^\//, '');
    this.endpoint = `${u.protocol}//${u.host}/api/${projectId}/envelope/`;
  }

  async capture(e: ScrubbedEvent): Promise<void> {
    const eventId = randomUUID().replace(/-/g, '');
    const event = {
      event_id: eventId,
      timestamp: Date.now() / 1000,
      platform: 'node',
      level: 'error',
      environment: this.c.environment,
      release: this.c.release,
      logger: 'yatri-api',
      transaction: e.where,
      message: { formatted: `${e.name}: ${e.message}` },
      tags: {
        status: e.status === null ? 'none' : String(e.status),
        request_id: e.requestId ?? 'none',
      },
      exception: {
        values: [
          {
            type: e.name,
            value: e.message,
            ...(e.stack
              ? {
                  stacktrace: {
                    frames: [{ filename: e.stack.split('\n').slice(0, 12).join(' | ') }],
                  },
                }
              : {}),
          },
        ],
      },
    };
    const body = [
      JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify(event),
    ].join('\n');
    await providerRequest({
      capability: 'MONITORING',
      provider: this.name,
      operation: 'capture',
      url: this.endpoint,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-sentry-envelope',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=yatri-api/1.0, sentry_key=${this.key}`,
        },
        body,
      },
      timeoutMs: this.c.timeoutMs,
      idempotent: false,
      expect: 'none',
      ...(this.c.fetchImpl ? { fetchImpl: this.c.fetchImpl } : {}),
    });
  }
}
