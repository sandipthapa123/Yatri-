/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Fleet and driver operations.
 *
 *  - fleets: an operator with contact details and a status.
 *  - vehicles.fleet_id and vehicles.driver_user_id: the ONE source of "who drives which vehicle" is
 *    vehicles.driver_user_id (now nullable: a fleet vehicle can be unassigned). vehicles.lifecycle_status is
 *    the vehicle lifecycle, separate from verification_status (the review of its papers).
 *  - driver_profiles.fleet_id and operational_*: the driver's operator and their operational status,
 *    separate from account status (users), verification (driver_profiles.status), availability and rides.
 *  - vehicle_service_records: inspections and maintenance. They reference the vehicle and nothing else:
 *    no ride, payment or refund column, so a record cannot alter financial or ride data.
 *  - expiry_notices: which reminder was already sent for which item and date, so one is sent once.
 *
 * Documents stay in the existing documents tables; nothing here stores a document.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE fleets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      contact_name text,
      contact_phone text,
      contact_email text,
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    ALTER TABLE vehicles
      ALTER COLUMN driver_user_id DROP NOT NULL,
      ADD COLUMN fleet_id uuid REFERENCES fleets(id) ON DELETE SET NULL,
      ADD COLUMN lifecycle_status text NOT NULL DEFAULT 'ACTIVE'
        CHECK (lifecycle_status IN ('ACTIVE', 'INACTIVE', 'MAINTENANCE', 'SUSPENDED', 'RETIRED'));
    CREATE INDEX vehicles_fleet_idx ON vehicles (fleet_id) WHERE fleet_id IS NOT NULL;
    CREATE INDEX vehicles_lifecycle_idx ON vehicles (lifecycle_status);

    ALTER TABLE driver_profiles
      ADD COLUMN fleet_id uuid REFERENCES fleets(id) ON DELETE SET NULL,
      ADD COLUMN operational_status text NOT NULL DEFAULT 'ACTIVE'
        CHECK (operational_status IN ('ACTIVE', 'RESTRICTED', 'SUSPENDED')),
      ADD COLUMN operational_reason text,
      ADD COLUMN operational_until timestamptz,
      ADD COLUMN operational_changed_at timestamptz;
    CREATE INDEX driver_profiles_fleet_idx ON driver_profiles (fleet_id) WHERE fleet_id IS NOT NULL;
    CREATE INDEX driver_profiles_operational_idx ON driver_profiles (operational_status)
      WHERE operational_status <> 'ACTIVE';

    CREATE TABLE vehicle_service_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('INSPECTION', 'MAINTENANCE')),
      status text NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
      performed_on date,
      next_due_on date,
      result text CHECK (result IN ('PASSED', 'FAILED')),
      notes text,
      recorded_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    );
    CREATE INDEX vehicle_service_records_vehicle_idx ON vehicle_service_records (vehicle_id, created_at DESC);
    -- a vehicle has at most one piece of maintenance under way, even under simultaneous requests
    CREATE UNIQUE INDEX vehicle_service_one_open ON vehicle_service_records (vehicle_id)
      WHERE status = 'IN_PROGRESS';

    CREATE TABLE expiry_notices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      subject_key text NOT NULL,
      -- the date the reminder was about; 1970-01-01 when an item has no date (a missing document)
      due_on date NOT NULL DEFAULT '1970-01-01',
      stage text NOT NULL,
      notified_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (subject_key, due_on, stage)
    );
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE expiry_notices;
    DROP TABLE vehicle_service_records;
    DROP INDEX driver_profiles_operational_idx;
    DROP INDEX driver_profiles_fleet_idx;
    ALTER TABLE driver_profiles
      DROP COLUMN operational_changed_at, DROP COLUMN operational_until,
      DROP COLUMN operational_reason, DROP COLUMN operational_status, DROP COLUMN fleet_id;
    DROP INDEX vehicles_lifecycle_idx;
    DROP INDEX vehicles_fleet_idx;
    DELETE FROM vehicles WHERE driver_user_id IS NULL;
    ALTER TABLE vehicles
      DROP COLUMN lifecycle_status, DROP COLUMN fleet_id, ALTER COLUMN driver_user_id SET NOT NULL;
    DROP TABLE fleets;
  `);
};
