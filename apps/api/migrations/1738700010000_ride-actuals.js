/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * What actually happened on a ride, recorded on the ONE ride record (no second table): where it
 * started and ended, the distance measured from the driver's accepted location updates, and the
 * time it took. These are the inputs of the final fare; the estimate columns are untouched, so an
 * estimated and a final fare stay separate.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumns('trips', {
    started_latitude: { type: 'numeric(9,6)' },
    started_longitude: { type: 'numeric(9,6)' },
    ended_latitude: { type: 'numeric(9,6)' },
    ended_longitude: { type: 'numeric(9,6)' },
    actual_distance_meters: { type: 'integer' },
    actual_duration_seconds: { type: 'integer' },
  });
  pgm.addConstraint('trips', 'trips_actuals_check', {
    check:
      '(actual_distance_meters IS NULL OR actual_distance_meters >= 0) AND (actual_duration_seconds IS NULL OR actual_duration_seconds >= 0)',
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropConstraint('trips', 'trips_actuals_check');
  pgm.dropColumns('trips', [
    'started_latitude',
    'started_longitude',
    'ended_latitude',
    'ended_longitude',
    'actual_distance_meters',
    'actual_duration_seconds',
  ]);
};
