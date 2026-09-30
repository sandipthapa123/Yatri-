import type { ApiResponse } from '@yatri/types';
import type { Request, Response } from 'express';

import { env } from '../../config/env';
import { getRedisClient } from '../../config/redis';
import { pool } from '../../config/database';

interface LivePayload {
  status: 'ok';
  uptimeSeconds: number;
  timestamp: string;
  version: string | null;
}

interface ReadyPayload extends LivePayload {
  checks: { database: 'ok' | 'failing'; redis: 'ok' | 'failing' };
}

const CHECK_TIMEOUT_MS = 2000;

/** Run a dependency check with a deadline: a hung database must read as "failing", not hang the probe. */
async function check(run: () => Promise<unknown>): Promise<'ok' | 'failing'> {
  try {
    await Promise.race([
      run(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS)),
    ]);
    return 'ok';
  } catch {
    return 'failing';
  }
}

const base = (): LivePayload => ({
  status: 'ok',
  uptimeSeconds: Math.round(process.uptime()),
  timestamp: new Date().toISOString(),
  version: env.APP_VERSION ?? null,
});

/** Liveness: the process is up and serving. It never touches a dependency, so a database outage does not get the process restarted in a loop. */
export function getHealth(_req: Request, res: Response<ApiResponse<LivePayload>>) {
  res.json({ success: true, data: base() });
}

/**
 * Readiness: can this instance do useful work? It checks the two things every request needs.
 * A load balancer stops sending traffic while it answers 503; the body says which dependency is
 * failing and nothing else (no addresses, no versions of the database).
 */
export async function getReady(_req: Request, res: Response<ApiResponse<ReadyPayload>>) {
  const [database, redis] = await Promise.all([
    check(() => pool.query('SELECT 1')),
    check(() => getRedisClient().ping()),
  ]);
  const ok = database === 'ok' && redis === 'ok';
  res.status(ok ? 200 : 503).json(
    ok
      ? { success: true, data: { ...base(), checks: { database, redis } } }
      : {
          success: false,
          error: {
            code: 'NOT_READY',
            message: 'This instance cannot serve requests right now.',
            details: { database, redis },
          },
        },
  );
}
