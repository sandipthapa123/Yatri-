/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Durable record of a place a feature needs to remember (a saved place now;
 * a ride's pickup/destination in a later phase). NOT a GPS log — rows are
 * only created for places a user explicitly chose.
 *
 * Coordinates are numeric(10,7) (~1 cm) with range CHECKs. PostGIS is
 * deliberately not required yet: nothing runs spatial queries until driver
 * matching, at which point a geography column + GiST index can be added
 * (see docs/PHASE_4.md).
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('locations', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    latitude: { type: 'numeric(10,7)', notNull: true },
    longitude: { type: 'numeric(10,7)', notNull: true },
    address: { type: 'text', notNull: true },
    place_name: { type: 'text' },
    city: { type: 'text' },
    province: { type: 'text' },
    country: { type: 'text' },
    postal_code: { type: 'text' },
    provider_metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('locations', 'locations_latitude_range', {
    check: 'latitude >= -90 AND latitude <= 90',
  });
  pgm.addConstraint('locations', 'locations_longitude_range', {
    check: 'longitude >= -180 AND longitude <= 180',
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('locations');
};
