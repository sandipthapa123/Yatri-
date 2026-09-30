/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Index hygiene, found by auditing pg_indexes against the queries the code runs.
 *
 *  - Redundant indexes are dropped. Every index is paid for on every write, and the driver's
 *    location row is written every few seconds per online driver:
 *      driver_last_locations_geo_idx     identical to driver_last_locations_lat_lng_idx
 *      users_email_index                 the unique users_email_unique already serves lookups
 *      users_phone_number_index          users_phone_role_unique starts with phone_number
 *      users_role_index                  users_role_created_idx starts with role
 *  - Range scans the admin reports make now have an index to walk: ratings, incident reports, SOS
 *    alerts and disputes by creation time (analytics counts them per period).
 *  - The audit log's indexes still carried the name of the table it used to be (admin_access_log).
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.dropIndex('driver_last_locations', [], {
    name: 'driver_last_locations_geo_idx',
    ifExists: true,
  });
  pgm.dropIndex('users', [], { name: 'users_email_index', ifExists: true });
  pgm.dropIndex('users', [], { name: 'users_phone_number_index', ifExists: true });
  pgm.dropIndex('users', [], { name: 'users_role_index', ifExists: true });

  pgm.createIndex('trip_ratings', ['created_at'], {
    name: 'trip_ratings_created_at_idx',
    ifNotExists: true,
  });
  pgm.createIndex('incident_reports', ['created_at'], {
    name: 'incident_reports_created_at_idx',
    ifNotExists: true,
  });
  pgm.createIndex('sos_events', ['created_at'], {
    name: 'sos_events_created_at_idx',
    ifNotExists: true,
  });
  pgm.createIndex('trip_disputes', ['created_at'], {
    name: 'trip_disputes_created_at_idx',
    ifNotExists: true,
  });

  pgm.sql(
    'ALTER INDEX IF EXISTS admin_access_log_admin_id_created_at_index RENAME TO audit_log_actor_created_idx',
  );
  pgm.sql(
    'ALTER INDEX IF EXISTS admin_access_log_subject_type_subject_id_created_at_index RENAME TO audit_log_subject_created_idx',
  );
  pgm.sql('ALTER INDEX IF EXISTS admin_access_log_pkey RENAME TO audit_log_pkey');
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql('ALTER INDEX IF EXISTS audit_log_pkey RENAME TO admin_access_log_pkey');
  pgm.sql(
    'ALTER INDEX IF EXISTS audit_log_subject_created_idx RENAME TO admin_access_log_subject_type_subject_id_created_at_index',
  );
  pgm.sql(
    'ALTER INDEX IF EXISTS audit_log_actor_created_idx RENAME TO admin_access_log_admin_id_created_at_index',
  );

  pgm.dropIndex('trip_disputes', [], { name: 'trip_disputes_created_at_idx', ifExists: true });
  pgm.dropIndex('sos_events', [], { name: 'sos_events_created_at_idx', ifExists: true });
  pgm.dropIndex('incident_reports', [], {
    name: 'incident_reports_created_at_idx',
    ifExists: true,
  });
  pgm.dropIndex('trip_ratings', [], { name: 'trip_ratings_created_at_idx', ifExists: true });

  pgm.createIndex('users', ['role'], { name: 'users_role_index', ifNotExists: true });
  pgm.createIndex('users', ['phone_number'], {
    name: 'users_phone_number_index',
    ifNotExists: true,
  });
  pgm.createIndex('users', ['email'], { name: 'users_email_index', ifNotExists: true });
  pgm.createIndex('driver_last_locations', ['latitude', 'longitude'], {
    name: 'driver_last_locations_geo_idx',
    ifNotExists: true,
  });
};
