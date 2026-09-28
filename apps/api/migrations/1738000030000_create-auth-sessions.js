/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * One row per issued refresh token (= one logged-in device/session). The
 * access-token JWT carries this row's id so `authenticate` can check
 * liveness (not revoked, not expired) on every request — revocation and
 * suspension take effect immediately rather than waiting for token expiry.
 * Only the SHA-256 hash of the opaque refresh token is stored.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('auth_sessions', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    refresh_token_hash: { type: 'text', notNull: true },
    device_label: { type: 'text' },
    user_agent: { type: 'text' },
    ip_address: { type: 'inet' },
    expires_at: { type: 'timestamptz', notNull: true },
    revoked_at: { type: 'timestamptz' },
    last_used_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('auth_sessions', 'auth_sessions_refresh_token_hash_unique', {
    unique: ['refresh_token_hash'],
  });
  pgm.createIndex('auth_sessions', 'user_id');
  pgm.createIndex('auth_sessions', 'expires_at');
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('auth_sessions');
};
