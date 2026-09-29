/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Minimal trip record: the access-control anchor for live location. It says
 * WHO may see WHOSE position and WHEN — nothing about how a trip came to
 * exist. Ride requests, matching, fares and history are later phases; until
 * then trips are created by an admin/test endpoint.
 *
 * Live positions are NOT stored here (or anywhere in Postgres): they live in
 * Redis for the duration of the trip and are deleted when it ends.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('trips', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    passenger_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    driver_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    status: { type: 'text', notNull: true, default: 'DRIVER_EN_ROUTE' },
    pickup_location_id: {
      type: 'uuid',
      notNull: true,
      references: 'locations',
      onDelete: 'RESTRICT',
    },
    destination_location_id: {
      type: 'uuid',
      notNull: true,
      references: 'locations',
      onDelete: 'RESTRICT',
    },
    arrived_at: { type: 'timestamptz' },
    started_at: { type: 'timestamptz' },
    ended_at: { type: 'timestamptz' },
    cancelled_by: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('trips', 'trips_status_check', {
    check:
      "status IN ('DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')",
  });
  pgm.addConstraint('trips', 'trips_participants_differ', {
    check: 'passenger_id <> driver_id',
  });
  // A person can be in at most one active trip at a time (as passenger or as driver).
  pgm.createIndex('trips', ['passenger_id'], {
    name: 'trips_one_active_per_passenger',
    unique: true,
    where: "status IN ('DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS')",
  });
  pgm.createIndex('trips', ['driver_id'], {
    name: 'trips_one_active_per_driver',
    unique: true,
    where: "status IN ('DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS')",
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('trips');
};
