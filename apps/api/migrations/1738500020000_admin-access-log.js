/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * ONE audit trail for every time an admin reads sensitive data (exact driver coordinates,
 * trip chat). Replaces ad-hoc per-feature audit rows so "who looked at what" has one source.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('admin_access_log', {
    id: { type: 'bigserial', primaryKey: true },
    admin_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    action: { type: 'text', notNull: true },
    subject_type: { type: 'text', notNull: true },
    subject_id: { type: 'uuid', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('admin_access_log', [
    'subject_type',
    'subject_id',
    { name: 'created_at', sort: 'DESC' },
  ]);
  pgm.createIndex('admin_access_log', ['admin_id', { name: 'created_at', sort: 'DESC' }]);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('admin_access_log');
};
