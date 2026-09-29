/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Ride requests by vehicle category, and a complete cancellation record.
 *
 *  - vehicle_categories gets OPTIONAL fare overrides. NULL means "use the platform default from
 *    configuration" (FARE_* env), so the default lives in one place and a category only stores how
 *    it differs. Operations can retune a category without a deploy.
 *  - trips records the category that was requested and, for a cancellation, the state it was
 *    cancelled from and the fee the cancellation rules produced (recorded, not charged: payments
 *    are a later phase).
 *  - indexes for the queries this phase adds: rides by category/status and by request time, and a
 *    bounding-box search over the last known driver locations.
 *
 * The seeded overrides are placeholders for operations to confirm.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumns('vehicle_categories', {
    base_fare_npr: { type: 'integer' },
    per_km_npr: { type: 'integer' },
    per_minute_npr: { type: 'integer' },
    minimum_fare_npr: { type: 'integer' },
  });
  for (const col of ['base_fare_npr', 'per_km_npr', 'per_minute_npr', 'minimum_fare_npr']) {
    pgm.addConstraint('vehicle_categories', `vehicle_categories_${col}_check`, {
      check: `${col} IS NULL OR ${col} >= 0`,
    });
  }
  pgm.sql(`
    UPDATE vehicle_categories SET base_fare_npr = 40, per_km_npr = 22, per_minute_npr = 1, minimum_fare_npr = 80
      WHERE code IN ('MOTORCYCLE', 'SCOOTER');
    UPDATE vehicle_categories SET base_fare_npr = 80, per_km_npr = 45, per_minute_npr = 3, minimum_fare_npr = 180
      WHERE code = 'SUV';
  `);

  pgm.addColumns('trips', {
    vehicle_category_id: { type: 'uuid', references: 'vehicle_categories', onDelete: 'RESTRICT' },
    cancelled_from_status: { type: 'text' },
    cancellation_fee_npr: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addConstraint('trips', 'trips_cancellation_fee_check', {
    check: 'cancellation_fee_npr >= 0',
  });

  pgm.createIndex('trips', ['vehicle_category_id', 'status'], {
    name: 'trips_category_status_idx',
  });
  pgm.createIndex('trips', [{ name: 'requested_at', sort: 'DESC' }], {
    name: 'trips_requested_at_idx',
  });
  pgm.createIndex('driver_last_locations', ['latitude', 'longitude'], {
    name: 'driver_last_locations_geo_idx',
  });
  pgm.createIndex('vehicles', ['category_id', 'driver_user_id'], {
    name: 'vehicles_approved_category_idx',
    where: "verification_status = 'APPROVED'",
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropIndex('vehicles', ['category_id', 'driver_user_id'], {
    name: 'vehicles_approved_category_idx',
  });
  pgm.dropIndex('driver_last_locations', ['latitude', 'longitude'], {
    name: 'driver_last_locations_geo_idx',
  });
  pgm.dropIndex('trips', [{ name: 'requested_at', sort: 'DESC' }], {
    name: 'trips_requested_at_idx',
  });
  pgm.dropIndex('trips', ['vehicle_category_id', 'status'], { name: 'trips_category_status_idx' });
  pgm.dropConstraint('trips', 'trips_cancellation_fee_check');
  pgm.dropColumns('trips', [
    'vehicle_category_id',
    'cancelled_from_status',
    'cancellation_fee_npr',
  ]);
  for (const col of ['base_fare_npr', 'per_km_npr', 'per_minute_npr', 'minimum_fare_npr']) {
    pgm.dropConstraint('vehicle_categories', `vehicle_categories_${col}_check`);
  }
  pgm.dropColumns('vehicle_categories', [
    'base_fare_npr',
    'per_km_npr',
    'per_minute_npr',
    'minimum_fare_npr',
  ]);
};
