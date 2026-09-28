/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * One-to-one extension of `users` for driver-only state. Keyed directly by
 * user_id rather than a surrogate id since the relationship is strictly 1:1.
 * `status` gates ride-acceptance in a later phase — document/vehicle
 * verification itself is out of scope here.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createType('driver_status', ['PENDING_VERIFICATION', 'VERIFIED', 'SUSPENDED', 'REJECTED']);

  pgm.createTable('driver_profiles', {
    user_id: {
      type: 'uuid',
      primaryKey: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    status: { type: 'driver_status', notNull: true, default: 'PENDING_VERIFICATION' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('driver_profiles', 'status');

  pgm.createTrigger('driver_profiles', 'driver_profiles_set_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    function: 'set_updated_at',
    level: 'ROW',
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTrigger('driver_profiles', 'driver_profiles_set_updated_at');
  pgm.dropTable('driver_profiles');
  pgm.dropType('driver_status');
};
