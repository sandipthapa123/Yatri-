/**
 * THE logger. One line per event, as JSON outside development (so a log service can index it), with
 * anything that could identify a person or unlock an account removed BEFORE it is written:
 *  - values under keys like authorization, password, token, secret, otp, code, phone, email, body,
 *    address, latitude, longitude are replaced with "[redacted]", at any depth;
 *  - inside text, bearer tokens, JWTs and `key=`/`token=`/`signature=` query values are masked
 *    (a failed HTTP call to a map provider can carry its API key in the URL);
 *  - an Error is written as name, message and (outside production) stack, plus the Postgres error
 *    code when there is one, never the driver's `detail` (which can contain row values).
 * Nothing else in the API calls `console.*`; add fields here, not ad hoc prints.
 *
 * This file reads `process.env` directly (not `config/env`) so configuration errors can be logged
 * before the configuration has been accepted.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level | 'silent', number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

const SENSITIVE_KEY =
  /authorization|cookie|password|passwd|secret|token|otp|^code$|phone|email|body|address|latitude|longitude|signature|api[-_]?key|credential/i;

const MASKS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[jwt]'],
  [
    /([?&](?:key|api_key|apikey|token|signature|sig|secret|access_token)=)[^&\s"']+/gi,
    '$1[redacted]',
  ],
  [/postgres(?:ql)?:\/\/[^\s"']+/gi, 'postgres://[redacted]'],
  [/redis:\/\/[^\s"']+/gi, 'redis://[redacted]'],
];

/** Mask secrets inside free text. */
export function maskText(text: string): string {
  return MASKS.reduce((t, [re, to]) => t.replace(re, to), text);
}

/** A copy of any value that is safe to write to a log. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return maskText(value).slice(0, 2000);
  if (typeof value !== 'object') return value;
  if (value instanceof Error) return serializeError(value);
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1),
    ]),
  );
}

export function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: maskText(String(err)).slice(0, 500) };
  const e = err as Error & { code?: unknown; kind?: unknown; status?: unknown };
  return {
    name: e.name,
    message: maskText(e.message).slice(0, 500),
    ...(typeof e.code === 'string' ? { code: e.code } : {}),
    ...(typeof e.kind === 'string' ? { kind: e.kind } : {}),
    ...(process.env.NODE_ENV === 'production' || !e.stack ? {} : { stack: maskText(e.stack) }),
  };
}

function threshold(): number {
  const configured = process.env.LOG_LEVEL as Level | 'silent' | undefined;
  if (configured && configured in ORDER) return ORDER[configured];
  return process.env.NODE_ENV === 'test' ? ORDER.error : ORDER.info;
}

function write(level: Level, message: string, context: unknown[]) {
  if (ORDER[level] < threshold()) return;
  const fields: Record<string, unknown> = {};
  for (const c of context) {
    if (c instanceof Error) fields.err = serializeError(c);
    else if (c && typeof c === 'object') Object.assign(fields, redact(c) as object);
    else if (c !== undefined) fields.detail = redact(c);
  }
  const line = {
    time: new Date().toISOString(),
    level,
    msg: maskText(message).slice(0, 500),
    service: 'yatri-api',
    ...(process.env.APP_VERSION ? { version: process.env.APP_VERSION } : {}),
    ...fields,
  };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(
    process.env.NODE_ENV === 'development'
      ? `${line.time} ${level.toUpperCase()} ${line.msg}${
          Object.keys(fields).length ? ' ' + JSON.stringify(fields) : ''
        }\n`
      : `${JSON.stringify(line)}\n`,
  );
}

export const log = {
  debug: (message: string, ...context: unknown[]) => write('debug', message, context),
  info: (message: string, ...context: unknown[]) => write('info', message, context),
  warn: (message: string, ...context: unknown[]) => write('warn', message, context),
  error: (message: string, ...context: unknown[]) => write('error', message, context),
};
