import { describeJobState } from '@yatri/types';
import type { ApiResponse, JobInfo, JobRunInfo } from '@yatri/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';
import { requireParam } from '../../lib/params';
import { HttpError } from '../../middleware/errorHandler';
import { lastRuns, runJob, toRun } from '../jobs/jobs';
import { JOBS, jobByName } from '../jobs/registry';

/** The background jobs screen: what runs, when it last ran, how it ended; and running one now by hand. */
type Res<T> = Response<ApiResponse<T>>;

export const jobHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export async function listJobsHandler(_req: Request, res: Res<JobInfo[]>) {
  const last = await lastRuns();
  const now = Date.now();
  const data = JOBS.map((j) => {
    const run = last.get(j.name) ?? null;
    const state = describeJobState(j.everySeconds, run, now);
    return {
      name: j.name,
      label: j.label,
      help: j.help,
      everySeconds: j.everySeconds,
      lastRun: run,
      healthy: state.healthy,
      statusText: state.text,
    };
  });
  res.json({ success: true, data });
}

export async function jobHistoryHandler(req: Request, res: Res<JobRunInfo[]>) {
  const name = requireParam(req, 'name');
  if (!jobByName(name)) throw new HttpError(404, 'JOB_NOT_FOUND', 'There is no such job.');
  const limit = Number((req.query as { limit?: number }).limit ?? 30);
  const r = await query<Parameters<typeof toRun>[0]>(
    `SELECT id, name, trigger, status, started_at, finished_at, result, error
     FROM job_runs WHERE name = $1 ORDER BY id DESC LIMIT $2`,
    [name, limit],
  );
  res.json({ success: true, data: r.rows.map(toRun) });
}

export async function runJobHandler(req: Request, res: Res<{ status: string; message: string }>) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const name = requireParam(req, 'name');
  const job = jobByName(name);
  if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', 'There is no such job.');
  await recordAudit({
    actorId: req.auth.userId,
    actorRole: req.auth.role,
    action: 'JOB_RUN_MANUALLY',
    subjectType: 'job',
    subjectIds: null,
    detail: { name },
  });
  const out = await runJob(job, 'MANUAL');
  const message =
    out.status === 'OK'
      ? `${job.label} ran.`
      : out.status === 'SKIPPED'
        ? `${job.label} is already running, so it was not started again.`
        : `${job.label} failed: ${out.error ?? 'unknown error'}`;
  res.json({ success: true, data: { status: out.status, message } });
}
