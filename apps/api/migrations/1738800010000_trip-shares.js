/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Trip-sharing links: a passenger lets a trusted contact follow one ride.
 *
 * The link's secret is never stored: only its SHA-256 hash, so a database read cannot reveal a
 * working link, and the secret cannot be shown again after it is created. A share belongs to one
 * ride and dies with it (see the sharing service for the exact rule); there is no contact list, no
 * phone number and no second copy of any ride data here.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('trip_shares', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    trip_id: { type: 'uuid', notNull: true, references: 'trips', onDelete: 'CASCADE' },
    created_by: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    token_hash: { type: 'text', notNull: true, unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true },
    stopped_at: { type: 'timestamptz' },
    stopped_reason: { type: 'text' },
  });
  pgm.addConstraint('trip_shares', 'trip_shares_reason_check', {
    check: "stopped_reason IS NULL OR stopped_reason IN ('PASSENGER', 'RIDE_ENDED', 'EXPIRED')",
  });
  pgm.createIndex('trip_shares', ['trip_id', 'created_at']);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('trip_shares');
};
