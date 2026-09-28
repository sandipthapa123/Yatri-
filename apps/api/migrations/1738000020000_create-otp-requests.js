/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * One row per OTP ever issued. Only the bcrypt hash of the code is stored,
 * never the plaintext. `max_attempts` snapshots the configured limit at
 * issuance so changing the env var later doesn't retroactively change the
 * rules for OTPs already in flight.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createType('otp_purpose', ['LOGIN']);

  pgm.createTable('otp_requests', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    phone_number: { type: 'text', notNull: true },
    role: { type: 'user_role', notNull: true },
    purpose: { type: 'otp_purpose', notNull: true, default: 'LOGIN' },
    otp_hash: { type: 'text', notNull: true },
    attempts: { type: 'integer', notNull: true, default: 0 },
    max_attempts: { type: 'integer', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    consumed_at: { type: 'timestamptz' },
    invalidated_at: { type: 'timestamptz' },
    requester_ip: { type: 'inet' },
    user_agent: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('otp_requests', 'otp_requests_attempts_nonnegative_check', {
    check: 'attempts >= 0 AND attempts <= max_attempts',
  });

  // Fetching "the current active OTP for this phone/role/purpose" is the hot path.
  pgm.createIndex('otp_requests', ['phone_number', 'role', 'purpose', 'created_at']);
  pgm.createIndex('otp_requests', 'expires_at');
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('otp_requests');
  pgm.dropType('otp_purpose');
};
