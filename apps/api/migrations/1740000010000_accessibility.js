/**
 * Inclusive and accessible rides (Phase 22).
 *
 *  - accessibility_attributes: the catalogue of vehicle features (wheelchair accessible, ramp or lift, extra space,
 *    accessible seating, service animals welcome, and any an administrator adds). A feature can require approval: a
 *    driver's claim then only counts once an administrator has checked the vehicle.
 *  - vehicle_accessibility: which features each EXISTING vehicle declares and whether they count (PENDING, APPROVED,
 *    REJECTED). There is no separate vehicle database; this hangs off `vehicles`.
 *  - passenger_accessibility: what a passenger chose to say about their needs, once, as the starting point for each
 *    ride. Only what the person stated; nothing is inferred from anything else.
 *  - trip_accessibility: a copy taken for one ride (needs, how to be reached, pickup instructions, the vehicle
 *    features that were required), so editing the profile later never changes a ride under way. Deleted by its
 *    retention rule.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE accessibility_attributes (
      code text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{2,39}$'),
      label text NOT NULL CHECK (length(label) BETWEEN 3 AND 80),
      help text NOT NULL CHECK (length(help) BETWEEN 3 AND 300),
      requires_approval boolean NOT NULL DEFAULT false,
      active boolean NOT NULL DEFAULT true,
      core boolean NOT NULL DEFAULT false,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    INSERT INTO accessibility_attributes (code, label, help, requires_approval, core) VALUES
      ('WHEELCHAIR_ACCESSIBLE', 'Wheelchair accessible vehicle',
       'A passenger can travel seated in their wheelchair, or the vehicle can carry it, with the driver able to help.', true, true),
      ('RAMP_OR_LIFT', 'Ramp or lift',
       'The vehicle has a ramp or a lift for getting a wheelchair or mobility aid in and out.', true, true),
      ('EXTRA_SPACE', 'Extra space',
       'Room for a folded wheelchair, walker, large luggage or a guide animal.', false, true),
      ('ACCESSIBLE_SEATING', 'Accessible seating',
       'Seats that are easier to get into and out of (higher, wider, with room to move).', false, true),
      ('SERVICE_ANIMAL_FRIENDLY', 'Service animals welcome',
       'The driver welcomes service animals in the vehicle.', false, true);

    CREATE TABLE vehicle_accessibility (
      vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      attribute_code text NOT NULL REFERENCES accessibility_attributes(code),
      status text NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
      declared_by uuid REFERENCES users(id) ON DELETE SET NULL,
      declared_at timestamptz NOT NULL DEFAULT now(),
      decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
      decided_at timestamptz,
      decision_reason text,
      PRIMARY KEY (vehicle_id, attribute_code)
    );
    CREATE INDEX vehicle_accessibility_review_idx ON vehicle_accessibility (declared_at) WHERE status = 'PENDING';
    CREATE INDEX vehicle_accessibility_attr_idx ON vehicle_accessibility (attribute_code) WHERE status = 'APPROVED';

    CREATE TABLE passenger_accessibility (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      needs text[] NOT NULL DEFAULT '{}',
      communication text NOT NULL DEFAULT 'ANY' CHECK (communication IN ('ANY', 'TEXT_PREFERRED', 'TEXT_ONLY')),
      pickup_instructions text[] NOT NULL DEFAULT '{}',
      pickup_note text CHECK (pickup_note IS NULL OR length(pickup_note) <= 200),
      other_note text CHECK (other_note IS NULL OR length(other_note) <= 200),
      version integer NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE trip_accessibility (
      trip_id uuid PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
      needs text[] NOT NULL DEFAULT '{}',
      communication text NOT NULL DEFAULT 'ANY' CHECK (communication IN ('ANY', 'TEXT_PREFERRED', 'TEXT_ONLY')),
      pickup_instructions text[] NOT NULL DEFAULT '{}',
      pickup_note text CHECK (pickup_note IS NULL OR length(pickup_note) <= 200),
      other_note text CHECK (other_note IS NULL OR length(other_note) <= 200),
      required_attributes text[] NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    INSERT INTO retention_policies (record_type, label, action, retain_days, min_retain_days, legal_basis, enforced) VALUES
      ('ACCESSIBILITY_RIDE_DETAILS', 'Accessibility needs and pickup instructions of a ride', 'DELETE', 30, 1,
       'Needed only while the ride is under way and for a short time after, to resolve a problem with it. Sensitive: kept no longer than that.', true);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM retention_policies WHERE record_type = 'ACCESSIBILITY_RIDE_DETAILS';
    DROP TABLE IF EXISTS trip_accessibility;
    DROP TABLE IF EXISTS passenger_accessibility;
    DROP TABLE IF EXISTS vehicle_accessibility;
    DROP TABLE IF EXISTS accessibility_attributes;
  `);
};
