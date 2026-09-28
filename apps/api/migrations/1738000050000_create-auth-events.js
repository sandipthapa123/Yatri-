/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Append-only audit trail for every authentication-relevant event. user_id
 * is nullable because some events happen before an account is resolved
 * (e.g. an OTP request for a phone/role with no account yet, or a failed
 * admin login with an unknown email) — phone_number/email carry identity
 * in that case instead.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createType('auth_event_type', [
    'OTP_REQUESTED',
    'OTP_REQUEST_BLOCKED',
    'OTP_VERIFIED',
    'OTP_VERIFY_FAILED',
    'OTP_LOCKED',
    'LOGIN_SUCCESS',
    'LOGIN_FAILED',
    'LOGOUT',
    'TOKEN_REFRESHED',
    'TOKEN_REFRESH_FAILED',
    'SESSION_REVOKED',
    'ACCESS_BLOCKED_SUSPENDED',
    'ACCESS_BLOCKED_DEACTIVATED',
  ]);

  pgm.createTable('auth_events', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    user_id: {
      type: 'uuid',
      references: 'users',
      onDelete: 'SET NULL',
    },
    event_type: { type: 'auth_event_type', notNull: true },
    phone_number: { type: 'text' },
    email: { type: 'text' },
    ip_address: { type: 'inet' },
    user_agent: { type: 'text' },
    metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('auth_events', 'user_id');
  pgm.createIndex('auth_events', 'event_type');
  pgm.createIndex('auth_events', 'created_at');
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('auth_events');
  pgm.dropType('auth_event_type');
};
