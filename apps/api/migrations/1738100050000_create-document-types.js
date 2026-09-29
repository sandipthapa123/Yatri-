/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Which documents are required is operational policy, not application
 * code — ops should be able to add "COVID_VACCINATION_CARD" or make
 * insurance optional for motorcycles without a mobile app release. The
 * mobile/admin apps fetch this table (GET /documents/types) to know what
 * to ask for, instead of hard-coding a document checklist.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createType('document_owner_type', ['DRIVER', 'VEHICLE']);

  pgm.createTable('document_types', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    code: { type: 'text', notNull: true },
    label: { type: 'text', notNull: true },
    owner_type: { type: 'document_owner_type', notNull: true },
    is_required: { type: 'boolean', notNull: true, default: true },
    // NULL = applies to every vehicle category. Only meaningful when owner_type = VEHICLE.
    vehicle_category_id: {
      type: 'uuid',
      references: 'vehicle_categories',
      onDelete: 'CASCADE',
    },
    is_active: { type: 'boolean', notNull: true, default: true },
    sort_order: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('document_types', 'document_types_code_unique', { unique: ['code'] });
  pgm.addConstraint('document_types', 'document_types_vehicle_scope_check', {
    check: `owner_type = 'VEHICLE' OR vehicle_category_id IS NULL`,
  });
  pgm.createIndex('document_types', 'owner_type');

  pgm.sql(`
    INSERT INTO document_types (code, label, owner_type, is_required, sort_order) VALUES
      ('DRIVING_LICENSE', 'Driving licence', 'DRIVER', true, 1),
      ('IDENTITY_DOCUMENT', 'Government-issued identity document', 'DRIVER', true, 2),
      ('DRIVER_PHOTOGRAPH', 'Driver photograph', 'DRIVER', true, 3),
      ('VEHICLE_REGISTRATION', 'Vehicle registration certificate', 'VEHICLE', true, 1),
      ('VEHICLE_INSURANCE', 'Vehicle insurance document', 'VEHICLE', true, 2)
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('document_types');
  pgm.dropType('document_owner_type');
};
