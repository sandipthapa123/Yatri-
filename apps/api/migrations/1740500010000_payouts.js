/**
 * Phase 28: refunds and payouts for online payments.
 *  - driver_payout_accounts: where a driver wants to be paid. The number is encrypted (AES-256-GCM, a key derived from the
 *    storage signing secret for this one purpose); only the last four characters are readable without it.
 *  - driver_payouts: one row per payout, with a snapshot of the account it was prepared for, so changing the account later
 *    never redirects a payout already under way.
 *  - driver_payout_items: the rides a payout pays. trip_id is UNIQUE: a ride can be in at most one payout, ever, so a payout
 *    cannot be prepared twice for the same money, however many staff press the button at once.
 *  - refunds.provider_ref: the payment provider's own refund reference, for refunds returned through the provider.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE driver_payout_accounts (
      driver_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('BANK', 'KHALTI', 'ESEWA', 'IME_PAY')),
      holder_name text NOT NULL,
      account_cipher text NOT NULL,
      account_last4 text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE driver_payouts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      driver_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount_npr integer NOT NULL CHECK (amount_npr > 0),
      status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED')),
      account_kind text NOT NULL,
      account_holder text NOT NULL,
      account_cipher text NOT NULL,
      account_last4 text NOT NULL,
      reference text,
      failed_reason text,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      paid_at timestamptz
    );
    CREATE INDEX driver_payouts_driver_idx ON driver_payouts (driver_id, created_at DESC);
    CREATE INDEX driver_payouts_queue_idx ON driver_payouts (status, created_at);

    CREATE TABLE driver_payout_items (
      payout_id uuid NOT NULL REFERENCES driver_payouts(id) ON DELETE CASCADE,
      trip_id uuid NOT NULL UNIQUE REFERENCES trips(id) ON DELETE CASCADE,
      amount_npr integer NOT NULL CHECK (amount_npr >= 0)
    );
    CREATE INDEX driver_payout_items_payout_idx ON driver_payout_items (payout_id);

    ALTER TABLE refunds ADD COLUMN provider_ref text;

    INSERT INTO retention_policies (record_type, label, action, retain_days, min_retain_days, legal_basis, enforced) VALUES
      ('DRIVER_PAYOUTS', 'Driver payouts', 'KEEP', NULL, NULL,
       'A record of money paid to drivers, kept so what a driver was paid can always be checked and explained.', false);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM retention_policies WHERE record_type = 'DRIVER_PAYOUTS';
    ALTER TABLE refunds DROP COLUMN IF EXISTS provider_ref;
    DROP TABLE IF EXISTS driver_payout_items;
    DROP TABLE IF EXISTS driver_payouts;
    DROP TABLE IF EXISTS driver_payout_accounts;
  `);
};
