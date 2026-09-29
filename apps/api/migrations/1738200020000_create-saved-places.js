/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable('saved_places', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    location_id: { type: 'uuid', notNull: true, references: 'locations', onDelete: 'RESTRICT' },
    kind: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    label: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('saved_places', 'saved_places_kind_check', {
    check: "kind IN ('HOME', 'WORK', 'FAVOURITE')",
  });
  pgm.createIndex('saved_places', ['user_id', 'created_at']);
  // One Home and one Work per user.
  pgm.createIndex('saved_places', ['user_id', 'kind'], {
    name: 'saved_places_one_home_work',
    unique: true,
    where: "kind IN ('HOME', 'WORK')",
  });
  // Names are unique per user, case-insensitively (duplicate handling).
  pgm.sql('CREATE UNIQUE INDEX saved_places_unique_name ON saved_places (user_id, lower(name))');
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('saved_places');
};
