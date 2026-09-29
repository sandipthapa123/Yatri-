/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Phase 2 shipped a 4-value `driver_status` (PENDING_VERIFICATION / VERIFIED /
 * SUSPENDED / REJECTED) as a placeholder. Phase 3 needs the full onboarding
 * lifecycle, so this migration introduces `driver_verification_status` and
 * migrates the column over (old enum values can't just gain new members in
 * a way that also renames PENDING_VERIFICATION -> NOT_STARTED, so we swap
 * the column's type instead of altering the old enum in place).
 *
 * Also adds the current-state snapshot columns (`rejection_reason`,
 * `submitted_at`, `verified_at`, `reviewed_by`) that the rest of Phase 3
 * reads on the hot path (driver's own status screen, admin list) without
 * joining the verification-events history table.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createType('driver_verification_status', [
    'NOT_STARTED',
    'IN_PROGRESS',
    'SUBMITTED',
    'UNDER_REVIEW',
    'VERIFIED',
    'REJECTED',
    'SUSPENDED',
  ]);

  pgm.addColumn('driver_profiles', {
    status_v2: { type: 'driver_verification_status' },
  });

  pgm.sql(`
    UPDATE driver_profiles SET status_v2 = CASE status
      WHEN 'PENDING_VERIFICATION' THEN 'NOT_STARTED'
      WHEN 'VERIFIED' THEN 'VERIFIED'
      WHEN 'SUSPENDED' THEN 'SUSPENDED'
      WHEN 'REJECTED' THEN 'REJECTED'
    END::driver_verification_status
  `);

  pgm.alterColumn('driver_profiles', 'status_v2', {
    notNull: true,
    default: 'NOT_STARTED',
  });

  pgm.dropIndex('driver_profiles', 'status');
  pgm.dropColumn('driver_profiles', 'status');
  pgm.renameColumn('driver_profiles', 'status_v2', 'status');
  pgm.createIndex('driver_profiles', 'status');

  pgm.dropType('driver_status');

  pgm.addColumns('driver_profiles', {
    rejection_reason: { type: 'text' },
    submitted_at: { type: 'timestamptz' },
    verified_at: { type: 'timestamptz' },
    reviewed_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropColumns('driver_profiles', [
    'rejection_reason',
    'submitted_at',
    'verified_at',
    'reviewed_by',
  ]);

  pgm.createType('driver_status', ['PENDING_VERIFICATION', 'VERIFIED', 'SUSPENDED', 'REJECTED']);

  pgm.addColumn('driver_profiles', {
    status_v1: { type: 'driver_status' },
  });

  pgm.sql(`
    UPDATE driver_profiles SET status_v1 = CASE status
      WHEN 'NOT_STARTED' THEN 'PENDING_VERIFICATION'
      WHEN 'IN_PROGRESS' THEN 'PENDING_VERIFICATION'
      WHEN 'SUBMITTED' THEN 'PENDING_VERIFICATION'
      WHEN 'UNDER_REVIEW' THEN 'PENDING_VERIFICATION'
      WHEN 'VERIFIED' THEN 'VERIFIED'
      WHEN 'SUSPENDED' THEN 'SUSPENDED'
      WHEN 'REJECTED' THEN 'REJECTED'
    END::driver_status
  `);

  pgm.alterColumn('driver_profiles', 'status_v1', {
    notNull: true,
    default: 'PENDING_VERIFICATION',
  });

  pgm.dropIndex('driver_profiles', 'status');
  pgm.dropColumn('driver_profiles', 'status');
  pgm.renameColumn('driver_profiles', 'status_v1', 'status');
  pgm.createIndex('driver_profiles', 'status');

  pgm.dropType('driver_verification_status');
};
