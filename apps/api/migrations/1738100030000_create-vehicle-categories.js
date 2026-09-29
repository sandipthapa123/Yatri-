/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Vehicle categories are reference data, not an enum — operations should be
 * able to add "TUK_TUK" or retire "SCOOTER" without a code deploy. `code` is
 * the stable identifier the rest of the schema references; `label` is what
 * the UI displays.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('vehicle_categories', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    code: { type: 'text', notNull: true },
    label: { type: 'text', notNull: true },
    is_active: { type: 'boolean', notNull: true, default: true },
    sort_order: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('vehicle_categories', 'vehicle_categories_code_unique', {
    unique: ['code'],
  });

  pgm.sql(`
    INSERT INTO vehicle_categories (code, label, sort_order) VALUES
      ('MOTORCYCLE', 'Motorcycle', 1),
      ('SCOOTER', 'Scooter', 2),
      ('CAR', 'Car', 3),
      ('SUV', 'SUV', 4)
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('vehicle_categories');
};
