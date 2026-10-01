/**
 * Navigation and route intelligence (Phase 23).
 *
 *  - trips.route_deviations / trips.reroutes: how many times the driver was confirmed off the planned route on this
 *    ride and how many new routes were planned. Counts only: never a coordinate, never a track. The risk rule
 *    ROUTE_DEVIATION_PATTERN reads them (a pattern over several rides, never one deviation).
 *  - trips.nav_eta_seconds: the duration of the first route planned for the ride itself, kept to measure how good the
 *    arrival estimates are against the actual duration (which the ride already records). A number, not a place.
 *  - navigation_metrics: daily counters of operational facts (routes planned, routing provider failures, arrivals
 *    detected) for the admin screen. No trip, person or place in it.
 *
 * Live routes and positions stay in Redis only while a ride is active and die with it, as before.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE trips
      ADD COLUMN route_deviations integer NOT NULL DEFAULT 0,
      ADD COLUMN reroutes integer NOT NULL DEFAULT 0,
      ADD COLUMN nav_eta_seconds integer;

    CREATE TABLE navigation_metrics (
      day date NOT NULL,
      metric text NOT NULL CHECK (metric ~ '^[A-Z_]{3,40}$'),
      value bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (day, metric)
    );
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS navigation_metrics;
    ALTER TABLE trips DROP COLUMN IF EXISTS nav_eta_seconds, DROP COLUMN IF EXISTS reroutes, DROP COLUMN IF EXISTS route_deviations;
  `);
};
