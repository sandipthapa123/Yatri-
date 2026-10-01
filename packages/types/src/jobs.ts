/**
 * Background jobs: the ONE description of the time-based work the platform does (expiring rides, finding stale drivers,
 * retrying notifications, reminders, reconciliation, housekeeping). Every such task is a job in the one registry
 * (`apps/api/src/modules/jobs`), run by the one scheduler under a lock so that however many API instances run, a job runs
 * once per interval, and every run is recorded here for the admin screen. A feature that needs something done "later" or
 * "every few minutes" registers a job; it never starts its own timer.
 */
/**
 * Notification delivery: a push that failed is tried again after these waits (seconds), then given up on. The record of the
 * notification (what happened) is never lost either way; only the push stops.
 */
export const NOTIFICATION_RETRY_SECONDS = [30, 120, 600, 3600] as const;
export const NOTIFICATION_MAX_ATTEMPTS = NOTIFICATION_RETRY_SECONDS.length + 1;
export const NOTIFICATION_DELIVERY_STATUSES = [
  'PENDING',
  'SENT',
  'FAILED',
  'DEAD',
  'SUPPRESSED',
] as const;
export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

export type JobTrigger = 'SCHEDULE' | 'MANUAL';
export type JobRunStatus = 'OK' | 'FAILED' | 'SKIPPED';

export interface JobRunInfo {
  id: string;
  name: string;
  trigger: JobTrigger;
  status: JobRunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  /** What the job reported (counts, never personal data), or the reason it failed or was skipped. */
  result: Record<string, unknown> | null;
  error: string | null;
}

export interface JobInfo {
  name: string;
  label: string;
  /** What it is for, in a sentence. */
  help: string;
  everySeconds: number;
  lastRun: JobRunInfo | null;
  /** True when it ran recently and the last run did not fail. A job that has not run for three intervals is late. */
  healthy: boolean;
  /** In words: "Ran 20 seconds ago", "Late: last ran 12 minutes ago", "Has not run yet". */
  statusText: string;
}

/** How late a job may be before it is called late: this many intervals, and never less than this many seconds. */
export const JOB_LATE_INTERVALS = 3;
export const JOB_LATE_MIN_SECONDS = 60;

export function describeJobState(
  everySeconds: number,
  last: { status: JobRunStatus; finishedAt: string | null; startedAt: string } | null,
  nowMs: number,
): { healthy: boolean; text: string } {
  if (!last) return { healthy: true, text: 'Has not run yet' };
  const at = new Date(last.finishedAt ?? last.startedAt).getTime();
  const ago = Math.max(0, Math.round((nowMs - at) / 1000));
  const words =
    ago < 90
      ? `${ago} seconds ago`
      : ago < 5400
        ? `${Math.round(ago / 60)} minutes ago`
        : `${Math.round(ago / 3600)} hours ago`;
  if (last.status === 'FAILED') return { healthy: false, text: `Failed ${words}` };
  const late = ago > Math.max(JOB_LATE_MIN_SECONDS, everySeconds * JOB_LATE_INTERVALS);
  return late
    ? { healthy: false, text: `Late: last ran ${words}` }
    : { healthy: true, text: `Ran ${words}` };
}
