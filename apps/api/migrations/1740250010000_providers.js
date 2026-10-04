/**
 * Phase 25: service providers.
 *  - provider_usage: a daily counter per need, vendor and outcome (no address, key, message, person or place).
 *  - provider_health: the last live check per need and vendor (state, when, how long, the kind of the last failure).
 *  - push_tokens: a phone's address for push notifications, held only to deliver that person's own notifications.
 *  - payment_attempts: one row per try to pay a ride online; the unique provider reference and the one open attempt per
 *    ride make a repeated request or a repeated callback harmless (payment idempotency).
 */
exports.up = (pgm) => {
  pgm.createTable('provider_usage', {
    day: { type: 'date', notNull: true },
    capability: { type: 'text', notNull: true },
    provider: { type: 'text', notNull: true },
    outcome: { type: 'text', notNull: true },
    calls: { type: 'integer', notNull: true, default: 0 },
    total_ms: { type: 'bigint', notNull: true, default: 0 },
  });
  pgm.addConstraint('provider_usage', 'provider_usage_pkey', {
    primaryKey: ['day', 'capability', 'provider', 'outcome'],
  });

  pgm.createTable('provider_health', {
    capability: { type: 'text', notNull: true },
    provider: { type: 'text', notNull: true },
    ok: { type: 'boolean', notNull: true },
    latency_ms: { type: 'integer' },
    failure_kind: { type: 'text' },
    checked_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('provider_health', 'provider_health_pkey', {
    primaryKey: ['capability', 'provider'],
  });

  pgm.createTable('push_tokens', {
    token: { type: 'text', primaryKey: true },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    platform: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_seen_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('push_tokens', 'push_tokens_platform_check', {
    check: "platform IN ('ios', 'android')",
  });
  pgm.createIndex('push_tokens', ['user_id']);

  pgm.createTable('payment_attempts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    trip_id: { type: 'uuid', notNull: true, references: 'trips', onDelete: 'CASCADE' },
    provider: { type: 'text', notNull: true },
    provider_ref: { type: 'text' },
    amount_npr: { type: 'integer', notNull: true },
    status: { type: 'text', notNull: true, default: 'INITIATED' },
    payment_url: { type: 'text' },
    expires_at: { type: 'timestamptz' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    completed_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('payment_attempts', 'payment_attempts_status_check', {
    check: "status IN ('INITIATED', 'COMPLETED', 'FAILED', 'EXPIRED')",
  });
  pgm.addConstraint('payment_attempts', 'payment_attempts_amount_check', {
    check: 'amount_npr >= 0',
  });
  // At most one open attempt per ride: asking again returns it instead of opening a second one.
  pgm.createIndex('payment_attempts', ['trip_id'], {
    unique: true,
    where: "status = 'INITIATED'",
    name: 'payment_attempts_open_one',
  });
  // A vendor reference belongs to one attempt: a repeated callback cannot be applied to two rides.
  pgm.createIndex('payment_attempts', ['provider', 'provider_ref'], {
    unique: true,
    where: 'provider_ref IS NOT NULL',
    name: 'payment_attempts_provider_ref',
  });
  // At most one completed attempt per ride: a ride cannot be paid twice online.
  pgm.createIndex('payment_attempts', ['trip_id'], {
    unique: true,
    where: "status = 'COMPLETED'",
    name: 'payment_attempts_completed_one',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('payment_attempts');
  pgm.dropTable('push_tokens');
  pgm.dropTable('provider_health');
  pgm.dropTable('provider_usage');
};
