/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Core identity table for every account type (passenger, driver, admin).
 * Role-specific data lives in its own table (e.g. driver_profiles);
 * this table is the single source of truth for "who is this and what
 * role/status do they have" — the only thing authorization trusts.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createType('user_role', ['PASSENGER', 'DRIVER', 'ADMIN']);
  pgm.createType('account_status', ['ACTIVE', 'SUSPENDED', 'DEACTIVATED']);

  pgm.createTable('users', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    role: { type: 'user_role', notNull: true },
    status: { type: 'account_status', notNull: true, default: 'ACTIVE' },
    // Passenger/driver identity. Null for admin accounts.
    phone_number: { type: 'text' },
    // Admin identity (also usable by passenger/driver later). Stored lowercase.
    email: { type: 'text' },
    // Admin only. Null for passenger/driver (no passwords — OTP only).
    password_hash: { type: 'text' },
    full_name: { type: 'text' },
    profile_picture_url: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('users', 'users_phone_format_check', {
    check: `phone_number IS NULL OR phone_number ~ '^\\+[1-9][0-9]{6,14}$'`,
  });
  pgm.addConstraint('users', 'users_email_format_check', {
    check: `email IS NULL OR email = lower(email)`,
  });
  // A role determines which app surface an account belongs to; the same
  // phone number may hold both a passenger and a driver account.
  pgm.addConstraint('users', 'users_phone_role_unique', {
    unique: ['phone_number', 'role'],
  });
  pgm.addConstraint('users', 'users_email_unique', { unique: ['email'] });

  pgm.createIndex('users', 'phone_number');
  pgm.createIndex('users', 'email');
  pgm.createIndex('users', 'role');
  pgm.createIndex('users', 'status');

  pgm.createFunction(
    'set_updated_at',
    [],
    { returns: 'trigger', language: 'plpgsql', replace: true },
    `BEGIN NEW.updated_at = now(); RETURN NEW; END;`,
  );
  pgm.createTrigger('users', 'users_set_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    function: 'set_updated_at',
    level: 'ROW',
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTrigger('users', 'users_set_updated_at');
  pgm.dropFunction('set_updated_at', []);
  pgm.dropTable('users');
  pgm.dropType('account_status');
  pgm.dropType('user_role');
};
