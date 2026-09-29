/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Append-only verification audit trail — who did what, what changed, and
 * why. This is the "verification history" the admin UI reads; it is never
 * updated or deleted, only inserted into, so a verification record can't
 * be silently altered after the fact. Distinct from `auth_events` (Phase
 * 2), which is about authentication/session security, not verification
 * decisions — different actors, different retention/query needs, and
 * conflating them would make both harder to reason about.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createType('driver_verification_action', [
    'SUBMITTED',
    'DOCUMENT_APPROVED',
    'DOCUMENT_REJECTED',
    'VEHICLE_APPROVED',
    'VEHICLE_REJECTED',
    'DRIVER_APPROVED',
    'DRIVER_REJECTED',
    'DRIVER_SUSPENDED',
  ]);

  pgm.createTable('driver_verification_events', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    driver_user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    // NULL means the driver themself performed the action (e.g. submitted);
    // set to an admin's user id for reviewer actions.
    actor_user_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    action: { type: 'driver_verification_action', notNull: true },
    previous_status: { type: 'driver_verification_status' },
    new_status: { type: 'driver_verification_status' },
    document_id: { type: 'uuid', references: 'documents', onDelete: 'SET NULL' },
    vehicle_id: { type: 'uuid', references: 'vehicles', onDelete: 'SET NULL' },
    reason: { type: 'text' },
    metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('driver_verification_events', 'driver_user_id');
  pgm.createIndex('driver_verification_events', 'created_at');
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('driver_verification_events');
  pgm.dropType('driver_verification_action');
};
