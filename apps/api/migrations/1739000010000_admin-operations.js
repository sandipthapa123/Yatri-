/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Admin operations.
 *
 *  - platform_settings: the ONE store for values operations change without a deploy (fares,
 *    cancellation, waiting, availability, notification thresholds). A row only exists once an admin
 *    has set a value; until then the deployment default (environment) applies. `version` makes two
 *    admins editing the same setting safe: an edit quotes the version it saw, a stale one is refused.
 *    Who changed what, and why, is in the ONE audit log, not repeated here.
 *  - Admin permissions become granular. Admins that existed before this migration keep exactly what
 *    they could already do (operations, driver review, cancelling rides, disputes); anything new
 *    (users, finance, analytics, settings, audit, administrators) has to be granted deliberately.
 *  - Indexes for the reads the dashboard and reports make (by time and status).
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('platform_settings', {
    key: { type: 'text', primaryKey: true },
    value: { type: 'jsonb', notNull: true },
    version: { type: 'integer', notNull: true, default: 1 },
    updated_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.sql(`
    UPDATE users
       SET admin_permissions = (
         SELECT COALESCE(array_agg(DISTINCT p ORDER BY p), '{}')
           FROM unnest(
             admin_permissions
             || ARRAY['OPERATIONS_VIEW', 'DRIVERS_REVIEW', 'RIDES_MANAGE', 'DISPUTES_MANAGE']
           ) AS p
       )
     WHERE role = 'ADMIN'`);

  pgm.createIndex('trips', ['requested_at'], { name: 'trips_requested_at_idx', ifNotExists: true });
  pgm.createIndex('trips', ['status', 'requested_at'], {
    name: 'trips_status_requested_idx',
    ifNotExists: true,
  });
  pgm.createIndex('trip_payments', ['created_at'], {
    name: 'trip_payments_created_at_idx',
    ifNotExists: true,
  });
  pgm.createIndex('notifications', ['created_at'], {
    name: 'notifications_created_at_idx',
    ifNotExists: true,
  });
  pgm.createIndex('audit_log', [{ name: 'created_at', sort: 'DESC' }], {
    name: 'audit_log_created_at_idx',
    ifNotExists: true,
  });
  pgm.createIndex('users', ['role', 'created_at'], {
    name: 'users_role_created_idx',
    ifNotExists: true,
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropIndex('users', ['role', 'created_at'], { name: 'users_role_created_idx', ifExists: true });
  pgm.dropIndex('audit_log', ['created_at'], { name: 'audit_log_created_at_idx', ifExists: true });
  pgm.dropIndex('notifications', ['created_at'], {
    name: 'notifications_created_at_idx',
    ifExists: true,
  });
  pgm.dropIndex('trip_payments', ['created_at'], {
    name: 'trip_payments_created_at_idx',
    ifExists: true,
  });
  pgm.dropIndex('trips', ['status', 'requested_at'], {
    name: 'trips_status_requested_idx',
    ifExists: true,
  });
  pgm.dropIndex('trips', ['requested_at'], { name: 'trips_requested_at_idx', ifExists: true });
  pgm.dropTable('platform_settings');
};
