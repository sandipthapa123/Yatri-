/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Exactly one row per driver, overwritten on each explicit update: this is
 * "last known position", not a location history. Continuous broadcasting
 * (Redis/socket based) arrives with live ride tracking.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('driver_last_locations', {
    driver_id: { type: 'uuid', primaryKey: true, references: 'users', onDelete: 'CASCADE' },
    latitude: { type: 'numeric(10,7)', notNull: true },
    longitude: { type: 'numeric(10,7)', notNull: true },
    accuracy_meters: { type: 'real' },
    recorded_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('driver_last_locations', 'driver_last_locations_lat_range', {
    check: 'latitude >= -90 AND latitude <= 90',
  });
  pgm.addConstraint('driver_last_locations', 'driver_last_locations_lng_range', {
    check: 'longitude >= -180 AND longitude <= 180',
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('driver_last_locations');
};
