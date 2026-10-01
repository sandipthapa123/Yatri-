/**
 * Reliability (Phase 21).
 *
 *  - job_runs: one row per run of a background job (the one job architecture): when, how it ended, what it counted.
 *  - idempotency_keys: the stored answer to an important action sent with an Idempotency-Key, so a retry (a lost
 *    response, a double tap, a client that came back online) replays the answer instead of doing the action twice.
 *    The key is scoped to the person and the endpoint; the request hash catches a key reused for a different request.
 *  - notifications: delivery state, so a push that failed is retried with a back-off by the job runner and a
 *    notification with a dedupe key is recorded and delivered at most once.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE job_runs (
      id bigserial PRIMARY KEY,
      name text NOT NULL,
      trigger text NOT NULL CHECK (trigger IN ('SCHEDULE', 'MANUAL')),
      status text NOT NULL CHECK (status IN ('OK', 'FAILED', 'SKIPPED')),
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      result jsonb,
      error text
    );
    CREATE INDEX job_runs_name_idx ON job_runs (name, id DESC);
    CREATE INDEX job_runs_started_idx ON job_runs (started_at);

    CREATE TABLE idempotency_keys (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint text NOT NULL,
      key text NOT NULL CHECK (char_length(key) BETWEEN 8 AND 100),
      request_hash text NOT NULL,
      status_code integer,
      response jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      PRIMARY KEY (user_id, endpoint, key)
    );
    CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

    ALTER TABLE notifications
      ADD COLUMN delivery_status text NOT NULL DEFAULT 'SENT'
        CHECK (delivery_status IN ('PENDING', 'SENT', 'FAILED', 'DEAD', 'SUPPRESSED')),
      ADD COLUMN attempts integer NOT NULL DEFAULT 0,
      ADD COLUMN next_attempt_at timestamptz,
      ADD COLUMN last_error text,
      ADD COLUMN dedupe_key text;
    -- one record of delivery: the Phase 19 suppressed flag becomes the SUPPRESSED delivery status
    UPDATE notifications SET delivery_status = 'SUPPRESSED' WHERE suppressed;
    ALTER TABLE notifications DROP COLUMN suppressed;
    CREATE UNIQUE INDEX notifications_dedupe_idx ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX notifications_retry_idx ON notifications (next_attempt_at) WHERE delivery_status = 'FAILED';

    INSERT INTO retention_policies (record_type, label, action, retain_days, min_retain_days, legal_basis, enforced) VALUES
      ('JOB_RUNS', 'Background job history', 'DELETE', 14, 1, 'Operational history of scheduled work; only useful while diagnosing a recent problem.', true),
      ('IDEMPOTENCY_KEYS', 'Stored answers for retried actions', 'DELETE', 2, 1, 'Needed only long enough for a client to retry an action it was not sure had gone through.', true);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM retention_policies WHERE record_type IN ('JOB_RUNS', 'IDEMPOTENCY_KEYS');
    DROP INDEX notifications_retry_idx;
    DROP INDEX notifications_dedupe_idx;
    ALTER TABLE notifications ADD COLUMN suppressed boolean NOT NULL DEFAULT false;
    UPDATE notifications SET suppressed = true WHERE delivery_status = 'SUPPRESSED';
    ALTER TABLE notifications
      DROP COLUMN dedupe_key, DROP COLUMN last_error, DROP COLUMN next_attempt_at,
      DROP COLUMN attempts, DROP COLUMN delivery_status;
    DROP TABLE idempotency_keys;
    DROP TABLE job_runs;
  `);
};
