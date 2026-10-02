/**
 * Phase 27: disability benefits and accessible ride services.
 *  - campaigns.kind gains DISABILITY_BENEFIT (a benefit policy: an ordinary campaign whose eligibility needs a verified benefit).
 *  - passenger_accessibility.companion / trip_accessibility.companion: a companion travels with the passenger. The flag is the
 *    whole record: the companion has no account and nothing is stored about them.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_kind_check;
    ALTER TABLE campaigns ADD CONSTRAINT campaigns_kind_check
      CHECK (kind IN ('PROMO', 'COUPON', 'FIRST_RIDE', 'REFERRAL', 'RETENTION', 'DISABILITY_BENEFIT', 'PUSH'));
    ALTER TABLE passenger_accessibility ADD COLUMN companion boolean NOT NULL DEFAULT false;
    ALTER TABLE trip_accessibility ADD COLUMN companion boolean NOT NULL DEFAULT false;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE trip_accessibility DROP COLUMN IF EXISTS companion;
    ALTER TABLE passenger_accessibility DROP COLUMN IF EXISTS companion;
    DELETE FROM campaigns WHERE kind = 'DISABILITY_BENEFIT';
    ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_kind_check;
    ALTER TABLE campaigns ADD CONSTRAINT campaigns_kind_check
      CHECK (kind IN ('PROMO', 'COUPON', 'FIRST_RIDE', 'REFERRAL', 'RETENTION', 'PUSH'));
  `);
};
