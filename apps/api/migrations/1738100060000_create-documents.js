/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * One table for both driver-owned and vehicle-owned documents (driving
 * licence, ID, vehicle registration, insurance, ...) rather than two
 * near-identical tables — the verification state machine
 * (PENDING/APPROVED/REJECTED/EXPIRED) and review metadata are identical
 * either way. `owner_type` plus a check constraint keeps exactly one of
 * `driver_user_id` / `vehicle_id` set.
 *
 * `storage_key` is an opaque handle into the storage provider
 * (apps/api/src/lib/storage) — never a public URL. Nothing here (or
 * anywhere else) stores document *content*; that lives entirely in the
 * storage provider's backing store (local disk in dev, object storage in
 * production).
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createType('document_status', ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED']);

  pgm.createTable('documents', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    owner_type: { type: 'document_owner_type', notNull: true },
    driver_user_id: { type: 'uuid', references: 'users', onDelete: 'CASCADE' },
    vehicle_id: { type: 'uuid', references: 'vehicles', onDelete: 'CASCADE' },
    document_type_id: {
      type: 'uuid',
      notNull: true,
      references: 'document_types',
      onDelete: 'RESTRICT',
    },
    storage_key: { type: 'text', notNull: true },
    original_filename: { type: 'text', notNull: true },
    mime_type: { type: 'text', notNull: true },
    file_size: { type: 'integer', notNull: true },
    status: { type: 'document_status', notNull: true, default: 'PENDING' },
    rejection_reason: { type: 'text' },
    expiry_date: { type: 'date' },
    reviewed_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    reviewed_at: { type: 'timestamptz' },
    uploaded_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('documents', 'documents_owner_shape_check', {
    check: `
      (owner_type = 'DRIVER' AND driver_user_id IS NOT NULL AND vehicle_id IS NULL) OR
      (owner_type = 'VEHICLE' AND vehicle_id IS NOT NULL AND driver_user_id IS NULL)
    `,
  });

  pgm.createIndex('documents', 'driver_user_id');
  pgm.createIndex('documents', 'vehicle_id');
  pgm.createIndex('documents', 'document_type_id');
  pgm.createIndex('documents', 'status');
  pgm.createIndex('documents', 'storage_key', { unique: true });

  pgm.createTrigger('documents', 'documents_set_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    function: 'set_updated_at',
    level: 'ROW',
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTrigger('documents', 'documents_set_updated_at');
  pgm.dropTable('documents');
  pgm.dropType('document_status');
};
