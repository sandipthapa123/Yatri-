/**
 * Multi-city service (Phase 20).
 *
 * A city is DATA. Its boundary is its service zones (`service_zones.city_id`: the existing geofence, no second map
 * system). Everything a city can change is one of the tables below and falls back to the platform value when the city
 * sets nothing, so adding a city never needs code:
 *  - cities / city_hours: status and opening hours (no hours = open all day);
 *  - city_categories: vehicle categories switched off here (no row = offered);
 *  - city_settings: the city's value for a fare / cancellation / waiting platform setting (no row = inherits);
 *  - city_payment_methods: payment methods switched off here (no row = offered);
 *  - city_requirements: extra documents a driver must hold to go online here.
 * `cities.version` goes up with every edit of a city or anything under it, so two administrators cannot overwrite
 * each other unseen. `trips.city_id` records the city a ride was requested in, so its fare, waiting and cancellation
 * rules are those of that city for the life of the ride.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE cities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]{2,30}$'),
      name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
      province_code text NOT NULL,
      status text NOT NULL DEFAULT 'COMING_SOON' CHECK (status IN ('COMING_SOON', 'ACTIVE', 'PAUSED')),
      time_zone text NOT NULL,
      center_latitude numeric(9,6) NOT NULL CHECK (center_latitude BETWEEN -90 AND 90),
      center_longitude numeric(9,6) NOT NULL CHECK (center_longitude BETWEEN -180 AND 180),
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE city_hours (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      city_id uuid NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
      days_of_week integer[],
      start_minute integer CHECK (start_minute IS NULL OR (start_minute >= 0 AND start_minute <= 1440)),
      end_minute integer CHECK (end_minute IS NULL OR (end_minute >= 0 AND end_minute <= 1440))
    );
    CREATE INDEX city_hours_city_idx ON city_hours (city_id);

    CREATE TABLE city_categories (
      city_id uuid NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
      category_id uuid NOT NULL REFERENCES vehicle_categories(id) ON DELETE CASCADE,
      enabled boolean NOT NULL,
      PRIMARY KEY (city_id, category_id)
    );

    CREATE TABLE city_settings (
      city_id uuid NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
      key text NOT NULL,
      value jsonb NOT NULL,
      PRIMARY KEY (city_id, key)
    );

    CREATE TABLE city_payment_methods (
      city_id uuid NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
      method text NOT NULL,
      enabled boolean NOT NULL,
      PRIMARY KEY (city_id, method)
    );

    CREATE TABLE city_requirements (
      city_id uuid NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
      document_type_id uuid NOT NULL REFERENCES document_types(id) ON DELETE CASCADE,
      PRIMARY KEY (city_id, document_type_id)
    );

    ALTER TABLE service_zones ADD COLUMN city_id uuid REFERENCES cities(id) ON DELETE SET NULL;
    CREATE INDEX service_zones_city_idx ON service_zones (city_id) WHERE city_id IS NOT NULL;

    ALTER TABLE trips ADD COLUMN city_id uuid REFERENCES cities(id) ON DELETE SET NULL;
    CREATE INDEX trips_city_idx ON trips (city_id, requested_at DESC) WHERE city_id IS NOT NULL;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX trips_city_idx;
    ALTER TABLE trips DROP COLUMN city_id;
    DROP INDEX service_zones_city_idx;
    ALTER TABLE service_zones DROP COLUMN city_id;
    DROP TABLE city_requirements;
    DROP TABLE city_payment_methods;
    DROP TABLE city_settings;
    DROP TABLE city_categories;
    DROP TABLE city_hours;
    DROP TABLE cities;
  `);
};
