/**
 * Phase 26: voluntary disability identity card verification.
 *
 *  - disability_verifications: ONE row per rider. It holds only what is needed to decide and to recognise a card: a keyed
 *    hash of the number (to notice the same card on two accounts) and its last four characters, never the number itself;
 *    the issuing authority and dates; the document's storage key and name (the bytes live behind the storage provider);
 *    the status, how it was chosen and how it was actually verified; and the timestamps.
 *  - disability_verification_events: the append-only history of every move (who, from, to, how, why).
 *  - compliance_records.withdrawn_at: the one field of a consent that may be set after the fact, once, when the person
 *    withdraws it. (The accepted record itself stays; the audit log keeps both moments.)
 *  - the consent itself is a row in the existing compliance_policies (kind CONSENT): no second consent store.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE disability_verifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'NOT_SUBMITTED' CHECK (status IN
        ('NOT_SUBMITTED', 'SUBMITTED', 'UNDER_REVIEW', 'NEEDS_CORRECTION', 'VERIFIED', 'REJECTED', 'EXPIRED', 'REVOKED')),
      method text NOT NULL DEFAULT 'MANUAL' CHECK (method IN ('MANUAL', 'OFFICIAL_API')),
      verified_method text CHECK (verified_method IN ('MANUAL', 'OFFICIAL_API')),
      card_hash text,
      card_last4 text,
      issuing_authority text,
      issue_date date,
      expiry_date date,
      document_key text,
      document_name text,
      document_mime text,
      document_size integer,
      document_uploaded_at timestamptz,
      message text,
      submitted_at timestamptz,
      decided_at timestamptz,
      decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
      verified_at timestamptz,
      valid_until date,
      warned_days integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    -- the same card on two accounts is found by this index; it is a reason to look, never a refusal
    CREATE INDEX disability_verifications_card_idx ON disability_verifications (card_hash) WHERE card_hash IS NOT NULL;
    CREATE INDEX disability_verifications_queue_idx ON disability_verifications (status, submitted_at);
    CREATE INDEX disability_verifications_expiry_idx ON disability_verifications (valid_until) WHERE status = 'VERIFIED';

    CREATE TABLE disability_verification_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      verification_id uuid NOT NULL REFERENCES disability_verifications(id) ON DELETE CASCADE,
      from_status text NOT NULL,
      to_status text NOT NULL,
      actor_kind text NOT NULL CHECK (actor_kind IN ('PASSENGER', 'ADMIN', 'SYSTEM')),
      actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
      method text CHECK (method IN ('MANUAL', 'OFFICIAL_API')),
      note text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX disability_verification_events_idx ON disability_verification_events (verification_id, created_at);

    ALTER TABLE compliance_records ADD COLUMN withdrawn_at timestamptz;

    INSERT INTO compliance_policies (key, kind, title, version, required, applies_to) VALUES
      ('DISABILITY_BENEFIT_CONSENT', 'CONSENT', 'Using your disability identity card details to give you disability benefits', '1', false, ARRAY['PASSENGER']);

    INSERT INTO retention_policies (record_type, label, action, retain_days, min_retain_days, legal_basis, enforced) VALUES
      ('DISABILITY_VERIFICATION', 'Disability card verification', 'DELETE', 730, NULL,
       'Card details and the document are erased at once when a rider withdraws consent. Otherwise they are kept while the benefit may be used and, once an application has ended, for this long, so a decision can be explained. Then they are erased.', true);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM retention_policies WHERE record_type = 'DISABILITY_VERIFICATION';
    DELETE FROM compliance_records WHERE policy_key = 'DISABILITY_BENEFIT_CONSENT';
    DELETE FROM compliance_policies WHERE key = 'DISABILITY_BENEFIT_CONSENT';
    ALTER TABLE compliance_records DROP COLUMN IF EXISTS withdrawn_at;
    DROP TABLE IF EXISTS disability_verification_events;
    DROP TABLE IF EXISTS disability_verifications;
  `);
};
