/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Driver availability (persistent, authoritative) — separate from ride status.
 *
 *  - driver_availability: one row per driver, the state machine's source of truth.
 *    `state_version` increments on every change so concurrent writers can be detected.
 *  - driver_last_locations (from phase 4): now also carries heading/speed and an index for
 *    future "eligible online drivers near X" bounding-box queries. Still ONE row per
 *    driver, overwritten on a throttle — never a history.
 *  - driver_availability_events: audit trail of state changes and admin location views.
 *  - driver_location_flags: suspicious-location indicators for later fraud analysis.
 *    Flags, not bans: a single signal never penalises a driver.
 *  - users.admin_permissions: fine-grained admin RBAC (e.g. DRIVER_LOCATION_VIEW).
 *
 * PostGIS is still not required; see docs/PHASE_5.md for the upgrade path.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('driver_availability', {
    driver_id: { type: 'uuid', primaryKey: true, references: 'users', onDelete: 'CASCADE' },
    state: { type: 'text', notNull: true, default: 'OFFLINE' },
    state_version: { type: 'integer', notNull: true, default: 0 },
    state_changed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    online_since: { type: 'timestamptz' },
    offline_reason: { type: 'text' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('driver_availability', 'driver_availability_state_check', {
    check:
      "state IN ('OFFLINE', 'GOING_ONLINE', 'ONLINE', 'GOING_OFFLINE', 'SUSPENDED', 'UNAVAILABLE')",
  });
  // Future matching scans ONLINE drivers only; keep that set cheap to find.
  pgm.createIndex('driver_availability', ['state'], {
    name: 'driver_availability_online_idx',
    where: "state = 'ONLINE'",
  });
  pgm.createIndex('driver_availability', ['state', 'state_changed_at']);

  pgm.addColumns('driver_last_locations', {
    heading_degrees: { type: 'real' },
    speed_mps: { type: 'real' },
  });
  pgm.addConstraint('driver_last_locations', 'driver_last_locations_heading_check', {
    check: 'heading_degrees IS NULL OR (heading_degrees >= 0 AND heading_degrees <= 360)',
  });
  pgm.addConstraint('driver_last_locations', 'driver_last_locations_speed_check', {
    check: 'speed_mps IS NULL OR speed_mps >= 0',
  });
  pgm.createIndex('driver_last_locations', ['latitude', 'longitude'], {
    name: 'driver_last_locations_lat_lng_idx',
  });
  pgm.createIndex('driver_last_locations', ['recorded_at']);

  pgm.createTable('driver_availability_events', {
    id: { type: 'bigserial', primaryKey: true },
    driver_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    actor_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    event_type: { type: 'text', notNull: true },
    from_state: { type: 'text' },
    to_state: { type: 'text' },
    reason: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('driver_availability_events', [
    'driver_id',
    { name: 'created_at', sort: 'DESC' },
  ]);

  pgm.createTable('driver_location_flags', {
    id: { type: 'bigserial', primaryKey: true },
    driver_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    kind: { type: 'text', notNull: true },
    details: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('driver_location_flags', ['driver_id', { name: 'created_at', sort: 'DESC' }]);

  pgm.addColumn('users', {
    admin_permissions: { type: 'text[]', notNull: true, default: pgm.func("'{}'") },
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropColumn('users', 'admin_permissions');
  pgm.dropTable('driver_location_flags');
  pgm.dropTable('driver_availability_events');
  pgm.dropIndex('driver_last_locations', ['recorded_at']);
  pgm.dropIndex('driver_last_locations', ['latitude', 'longitude'], {
    name: 'driver_last_locations_lat_lng_idx',
  });
  pgm.dropConstraint('driver_last_locations', 'driver_last_locations_speed_check');
  pgm.dropConstraint('driver_last_locations', 'driver_last_locations_heading_check');
  pgm.dropColumns('driver_last_locations', ['heading_degrees', 'speed_mps']);
  pgm.dropTable('driver_availability');
};
