import { isoOrNull } from '../../lib/dates';
import { randomUUID } from 'node:crypto';

import type { JobRunInfo, JobRunStatus, JobTrigger } from '@yatri/types';

import { getRedisClient } from '../../config/redis';
import { query } from '../../lib/db';
import { log } from '../../lib/logger';
import { reportError } from '../../lib/monitoring';

/**
 * THE background job runner. A job is a name, how often it runs and a function; the registry (`registry.ts`) lists
 * them all and nothing else in the system starts a timer for time-based work. Running a job:
 *  - takes a Redis lock named after the job, so with any number of API instances (or a manual run at the same moment)
 *    it runs once; a run that finds the lock held is recorded as SKIPPED;
 *  - records the run (`job_runs`): when, how it ended, what it counted;
 *  - cannot take the process down: a failure is caught, logged and recorded, and the next interval runs as usual;
 *  - is bounded by a timeout, and its lock expires with it, so a crashed instance never blocks the job for long.
 * A job must be safe to run twice and to be interrupted: it finds work by looking at the data (what is due now), never by
 * remembering what it did last time.
 */
export interface JobDef {
  name: string;
  label: string;
  help: string;
  everySeconds: number;
  /** A run longer than this is abandoned (its lock lapses). Default: the smaller of the interval and 5 minutes, at least 20 s. */
  timeoutSeconds?: number;
  run: () => Promise<unknown>;
}

const lockKey = (name: string) => `job:lock:${name}`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export const timeoutOf = (j: JobDef) =>
  j.timeoutSeconds ?? Math.max(20, Math.min(300, j.everySeconds));

async function record(
  name: string,
  trigger: JobTrigger,
  status: JobRunStatus,
  startedAtMs: number,
  result: unknown,
  error: string | null,
): Promise<number> {
  const r = await query<{ id: string }>(
    `INSERT INTO job_runs (name, trigger, status, started_at, finished_at, result, error)
     VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), now(), $5::jsonb, $6) RETURNING id`,
    [
      name,
      trigger,
      status,
      startedAtMs,
      result === undefined ? null : JSON.stringify(result),
      error,
    ],
  );
  return Number(r.rows[0]?.id);
}

/** Run one job now (on schedule or by hand). Never throws: the outcome is the returned status and the recorded run. */
export async function runJob(
  job: JobDef,
  trigger: JobTrigger = 'SCHEDULE',
): Promise<{ status: JobRunStatus; result?: unknown; error?: string }> {
  const redis = getRedisClient();
  const token = randomUUID();
  const started = Date.now();
  let locked: string | null = null;
  try {
    locked = await redis.set(lockKey(job.name), token, 'EX', timeoutOf(job) + 10, 'NX');
  } catch (err) {
    log.error('Job lock failed', job.name, err);
    return { status: 'FAILED', error: 'The job lock could not be taken.' };
  }
  if (locked !== 'OK') {
    // Another instance (or the previous run) still has it. Scheduled skips are normal and not recorded; a manual
    // run that cannot start says so.
    if (trigger === 'MANUAL') {
      await record(
        job.name,
        trigger,
        'SKIPPED',
        started,
        { reason: 'already running' },
        null,
      ).catch(() => undefined);
    }
    return { status: 'SKIPPED', result: { reason: 'already running' } };
  }
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out after ${timeoutOf(job)} seconds.`)),
        timeoutOf(job) * 1000,
      );
    });
    try {
      const result = await Promise.race([job.run(), timeout]);
      await record(job.name, trigger, 'OK', started, result ?? null, null);
      return { status: 'OK', result };
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    log.error('Job failed', job.name, err);
    reportError(err, { where: `job:${job.name}` });
    await record(job.name, trigger, 'FAILED', started, null, text.slice(0, 500)).catch(
      () => undefined,
    );
    return { status: 'FAILED', error: text };
  } finally {
    await redis.eval(RELEASE, 1, lockKey(job.name), token).catch(() => undefined);
  }
}

/**
 * Start the scheduler: every job on its own interval (with a little jitter so instances do not all fire together).
 * Returns the function that stops it. Called once per process.
 */
export function startJobScheduler(jobs: readonly JobDef[]): () => void {
  const timers = jobs.map((job) => {
    const every = job.everySeconds * 1000;
    const timer = setInterval(
      () => {
        void runJob(job).catch((err) => log.error('Job runner error', job.name, err));
      },
      every + Math.round(Math.random() * Math.min(1000, every / 10)),
    );
    timer.unref?.();
    return timer;
  });
  return () => timers.forEach(clearInterval);
}

/** The last run of each job, for the admin screen. */
export async function lastRuns(): Promise<Map<string, JobRunInfo>> {
  const r = await query<{
    id: string;
    name: string;
    trigger: JobTrigger;
    status: JobRunStatus;
    started_at: Date;
    finished_at: Date | null;
    result: Record<string, unknown> | null;
    error: string | null;
  }>(
    `SELECT DISTINCT ON (name) id, name, trigger, status, started_at, finished_at, result, error
     FROM job_runs WHERE status <> 'SKIPPED' ORDER BY name, id DESC`,
  );
  return new Map(r.rows.map((x) => [x.name, toRun(x)]));
}

export function toRun(x: {
  id: string;
  name: string;
  trigger: JobTrigger;
  status: JobRunStatus;
  started_at: Date;
  finished_at: Date | null;
  result: Record<string, unknown> | null;
  error: string | null;
}): JobRunInfo {
  return {
    id: String(x.id),
    name: x.name,
    trigger: x.trigger,
    status: x.status,
    startedAt: x.started_at.toISOString(),
    finishedAt: isoOrNull(x.finished_at),
    durationMs: x.finished_at ? x.finished_at.getTime() - x.started_at.getTime() : null,
    result: x.result,
    error: x.error,
  };
}
