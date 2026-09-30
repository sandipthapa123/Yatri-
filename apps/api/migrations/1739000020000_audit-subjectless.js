/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Some audited actions have no single record they are about (a platform setting was changed, an
 * administrator's permissions were listed). Those rows carry the facts in `detail` and no subject.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.alterColumn('audit_log', 'subject_id', { notNull: false });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql('DELETE FROM audit_log WHERE subject_id IS NULL');
  pgm.alterColumn('audit_log', 'subject_id', { notNull: true });
};
