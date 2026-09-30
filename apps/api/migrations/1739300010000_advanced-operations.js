/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Advanced operations: service zones, dynamic pricing rules, driver incentives.
 *
 *  - service_zones hold a boundary as a list of [latitude, longitude] corners (jsonb): the same
 *    coordinate system as every location in the platform, tested by the one point-in-polygon in
 *    @yatri/types. No second geographic system and no PostGIS requirement.
 *  - pricing_rules are data an administrator edits (zone, time window, vehicle category, demand, special
 *    event, multiplier). A ride records the multiplier it was quoted at (trips.surge_multiplier) so the
 *    final fare uses the price the rider saw, whatever the rules say later.
 *  - incentive_rules and incentive_awards: a bonus is computed in one place when a ride completes and
 *    recorded as an award; awards never touch fares or payments.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE service_zones (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]{2,40}$'),
      name text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('SERVICE_AREA', 'CITY', 'RESTRICTED', 'AIRPORT', 'VENUE')),
      polygon jsonb NOT NULL CHECK (jsonb_typeof(polygon) = 'array' AND jsonb_array_length(polygon) >= 3),
      pickup_allowed boolean NOT NULL DEFAULT true,
      dropoff_allowed boolean NOT NULL DEFAULT true,
      note text,
      priority integer NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE pricing_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      label text NOT NULL,
      zone_id uuid REFERENCES service_zones(id) ON DELETE CASCADE,
      vehicle_category_id uuid REFERENCES vehicle_categories(id) ON DELETE CASCADE,
      days_of_week integer[],
      start_minute integer CHECK (start_minute IS NULL OR (start_minute >= 0 AND start_minute <= 1440)),
      end_minute integer CHECK (end_minute IS NULL OR (end_minute >= 0 AND end_minute <= 1440)),
      starts_at timestamptz,
      ends_at timestamptz,
      min_demand_ratio numeric(6,2) CHECK (min_demand_ratio IS NULL OR min_demand_ratio > 0),
      multiplier numeric(4,2) NOT NULL CHECK (multiplier > 1 AND multiplier <= 10),
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX pricing_rules_active_idx ON pricing_rules (is_active);

    CREATE TABLE incentive_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('RIDE_TARGET', 'TIME_BONUS', 'ZONE_BONUS')),
      zone_id uuid REFERENCES service_zones(id) ON DELETE CASCADE,
      vehicle_category_id uuid REFERENCES vehicle_categories(id) ON DELETE CASCADE,
      days_of_week integer[],
      start_minute integer CHECK (start_minute IS NULL OR (start_minute >= 0 AND start_minute <= 1440)),
      end_minute integer CHECK (end_minute IS NULL OR (end_minute >= 0 AND end_minute <= 1440)),
      starts_at timestamptz,
      ends_at timestamptz,
      period text CHECK (period IN ('DAILY', 'WEEKLY')),
      target_rides integer CHECK (target_rides IS NULL OR target_rides > 0),
      bonus_npr integer NOT NULL CHECK (bonus_npr > 0),
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- One row per bonus earned. A per-ride bonus is unique per ride; a target bonus per person and period:
    -- a repeated completion or two sweeps cannot pay the same bonus twice.
    CREATE TABLE incentive_awards (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      rule_id uuid NOT NULL REFERENCES incentive_rules(id) ON DELETE CASCADE,
      driver_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      trip_id uuid REFERENCES trips(id) ON DELETE SET NULL,
      period_key text NOT NULL,
      amount_npr integer NOT NULL CHECK (amount_npr > 0),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX incentive_awards_per_ride ON incentive_awards (rule_id, trip_id) WHERE trip_id IS NOT NULL;
    CREATE UNIQUE INDEX incentive_awards_per_period ON incentive_awards (rule_id, driver_id, period_key) WHERE trip_id IS NULL;
    CREATE INDEX incentive_awards_driver_idx ON incentive_awards (driver_id, created_at DESC);

    ALTER TABLE trips
      ADD COLUMN surge_multiplier numeric(4,2) NOT NULL DEFAULT 1 CHECK (surge_multiplier >= 1),
      ADD COLUMN surge_label text,
      ADD COLUMN pickup_zone_id uuid REFERENCES service_zones(id) ON DELETE SET NULL;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE trips DROP COLUMN pickup_zone_id, DROP COLUMN surge_label, DROP COLUMN surge_multiplier;
    DROP TABLE incentive_awards;
    DROP TABLE incentive_rules;
    DROP TABLE pricing_rules;
    DROP TABLE service_zones;
  `);
};
