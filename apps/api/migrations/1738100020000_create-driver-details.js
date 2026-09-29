/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Sensitive/regulatory driver information, deliberately kept out of
 * `driver_profiles` (which is read on nearly every driver-app request) and
 * out of `users` (which every role shares) — this table is only ever read
 * on the driver's own onboarding/profile screens and by admin verification
 * review, so it's a natural boundary for "separate sensitive information
 * from ordinary profile information."
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('driver_details', {
    user_id: {
      type: 'uuid',
      primaryKey: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    full_legal_name: { type: 'text' },
    date_of_birth: { type: 'date' },
    license_number: { type: 'text' },
    license_expiry_date: { type: 'date' },
    address_line1: { type: 'text' },
    address_line2: { type: 'text' },
    city: { type: 'text' },
    emergency_contact_name: { type: 'text' },
    emergency_contact_phone: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // A license number, once set, must be unique — but many drivers won't have
  // filled it in yet (NULL), and NULLs never conflict under a UNIQUE index.
  pgm.addConstraint('driver_details', 'driver_details_license_number_unique', {
    unique: ['license_number'],
  });

  pgm.createTrigger('driver_details', 'driver_details_set_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    function: 'set_updated_at',
    level: 'ROW',
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTrigger('driver_details', 'driver_details_set_updated_at');
  pgm.dropTable('driver_details');
};
