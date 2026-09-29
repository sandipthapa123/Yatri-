/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * One driver may register several vehicles; each is independently
 * reviewed. `verification_status` is this table's own authoritative state
 * (mirrors the driver-level pattern) — a vehicle is only "eligible" once
 * APPROVED and not past its registration/insurance expiry, which later
 * phases (ride matching) will check directly against this table rather
 * than a separate "eligible vehicles" cache.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createType('vehicle_verification_status', ['PENDING', 'APPROVED', 'REJECTED']);

  pgm.createTable('vehicles', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    driver_user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    category_id: {
      type: 'uuid',
      notNull: true,
      references: 'vehicle_categories',
      onDelete: 'RESTRICT',
    },
    make: { type: 'text', notNull: true },
    model: { type: 'text', notNull: true },
    year: { type: 'integer', notNull: true },
    color: { type: 'text', notNull: true },
    registration_number: { type: 'text', notNull: true },
    vin: { type: 'text' },
    registration_expiry_date: { type: 'date' },
    insurance_provider: { type: 'text' },
    insurance_policy_number: { type: 'text' },
    insurance_expiry_date: { type: 'date' },
    verification_status: {
      type: 'vehicle_verification_status',
      notNull: true,
      default: 'PENDING',
    },
    rejection_reason: { type: 'text' },
    reviewed_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    reviewed_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('vehicles', 'vehicles_year_check', {
    check: 'year >= 1970 AND year <= 2100',
  });
  pgm.addConstraint('vehicles', 'vehicles_registration_number_unique', {
    unique: ['registration_number'],
  });
  pgm.addConstraint('vehicles', 'vehicles_vin_unique', { unique: ['vin'] });

  pgm.createIndex('vehicles', 'driver_user_id');
  pgm.createIndex('vehicles', 'verification_status');

  pgm.createTrigger('vehicles', 'vehicles_set_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    function: 'set_updated_at',
    level: 'ROW',
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTrigger('vehicles', 'vehicles_set_updated_at');
  pgm.dropTable('vehicles');
  pgm.dropType('vehicle_verification_status');
};
