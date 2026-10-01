/**
 * Fraud and risk (Phase 17).
 *
 *  - risk_events are SIGNALS, not verdicts: one row says a rule fired for a person, with a few points and the
 *    minimal evidence (counts and record ids; never a phone, address or coordinate). `dedupe_key` (rule, person,
 *    time bucket) is unique, so running the detectors again cannot repeat a signal. An administrator reviews an
 *    event (CONFIRMED or DISMISSED); a dismissed one stops counting.
 *  - risk_profiles hold only the temporary restriction (until when, why, who). The risk LEVEL and score are
 *    never stored: they are derived from events, the restriction and users.status, so they cannot disagree.
 *  - risk_rule_overrides hold only what an administrator changed; the rule definitions and defaults live in
 *    @yatri/types.
 *  - risk_notes are internal notes on a person, a ride or an event.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE risk_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rule_code text NOT NULL,
      category text NOT NULL,
      points integer NOT NULL CHECK (points >= 0),
      evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
      trip_id uuid REFERENCES trips(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CONFIRMED', 'DISMISSED')),
      dedupe_key text NOT NULL UNIQUE,
      reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at timestamptz,
      review_note text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX risk_events_user_idx ON risk_events (user_id, created_at DESC);
    CREATE INDEX risk_events_status_idx ON risk_events (status, created_at DESC);
    CREATE INDEX risk_events_trip_idx ON risk_events (trip_id) WHERE trip_id IS NOT NULL;
    CREATE INDEX risk_events_created_idx ON risk_events (created_at);

    CREATE TABLE risk_profiles (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      restricted_until timestamptz,
      restriction_reason text,
      restriction_source text CHECK (restriction_source IN ('ADMIN', 'AUTOMATIC')),
      restriction_set_by uuid REFERENCES users(id) ON DELETE SET NULL,
      restriction_set_at timestamptz,
      -- when the team was last told this person needs a review (so a sweep does not tell them again)
      review_notified_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX risk_profiles_restricted_idx ON risk_profiles (restricted_until)
      WHERE restricted_until IS NOT NULL;

    CREATE TABLE risk_rule_overrides (
      rule_code text PRIMARY KEY,
      enabled boolean NOT NULL DEFAULT true,
      points integer NOT NULL CHECK (points BETWEEN 0 AND 100),
      threshold integer NOT NULL CHECK (threshold >= 1),
      window_hours integer NOT NULL CHECK (window_hours BETWEEN 1 AND 2160),
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE risk_notes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      trip_id uuid REFERENCES trips(id) ON DELETE CASCADE,
      event_id uuid REFERENCES risk_events(id) ON DELETE CASCADE,
      author_id uuid REFERENCES users(id) ON DELETE SET NULL,
      note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 1000),
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (user_id IS NOT NULL OR trip_id IS NOT NULL OR event_id IS NOT NULL)
    );
    CREATE INDEX risk_notes_user_idx ON risk_notes (user_id, created_at DESC) WHERE user_id IS NOT NULL;
    CREATE INDEX risk_notes_trip_idx ON risk_notes (trip_id, created_at DESC) WHERE trip_id IS NOT NULL;
    CREATE INDEX risk_notes_event_idx ON risk_notes (event_id, created_at DESC) WHERE event_id IS NOT NULL;

    INSERT INTO retention_policies (record_type, label, action, retain_days, min_retain_days, legal_basis, enforced)
    VALUES ('RISK_EVENTS', 'Fraud and risk signals', 'DELETE', 365, 90,
            'Counts and record ids kept to investigate misuse and answer an appeal; removed after a year. Notes attached to a signal go with it; the audit log of what was done is kept.', true);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM retention_policies WHERE record_type = 'RISK_EVENTS';
    DROP TABLE risk_notes;
    DROP TABLE risk_rule_overrides;
    DROP TABLE risk_profiles;
    DROP TABLE risk_events;
  `);
};
