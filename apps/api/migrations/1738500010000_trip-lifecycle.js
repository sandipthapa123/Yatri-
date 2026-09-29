/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Phase 6: the full trip ("ride") lifecycle.
 *
 * `trips` stays THE trip table (no parallel "rides" table). It gains the request/dispatch
 * fields, and `driver_id` becomes nullable because a trip now exists (SEARCHING) before a
 * driver does. Everything else hangs off it and cascades:
 *   trip_events   – the authoritative, per-trip numbered domain event log
 *   trip_offers   – the dispatcher's offers to drivers (one per driver per trip)
 *   trip_messages – chat (system messages are NOT stored here; they are trip_events)
 *   trip_calls    – call state machine records (no media, no phone numbers)
 *   trip_payments / trip_ratings / trip_disputes
 * Status literals below are a historical snapshot; the live list is TRIP_STATUSES in
 * @yatri/types.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.alterColumn('trips', 'driver_id', { notNull: false });
  pgm.dropConstraint('trips', 'trips_status_check');
  pgm.addConstraint('trips', 'trips_status_check', {
    check:
      "status IN ('SEARCHING', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_DRIVERS')",
  });
  pgm.alterColumn('trips', 'status', { default: 'SEARCHING' });

  pgm.dropIndex('trips', ['passenger_id'], { name: 'trips_one_active_per_passenger' });
  pgm.dropIndex('trips', ['driver_id'], { name: 'trips_one_active_per_driver' });
  pgm.createIndex('trips', ['passenger_id'], {
    name: 'trips_one_active_per_passenger',
    unique: true,
    where: "status IN ('SEARCHING', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS')",
  });
  pgm.createIndex('trips', ['driver_id'], {
    name: 'trips_one_active_per_driver',
    unique: true,
    where:
      "driver_id IS NOT NULL AND status IN ('DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS')",
  });
  pgm.createIndex('trips', ['status', 'created_at']);
  pgm.createIndex('trips', ['passenger_id', { name: 'created_at', sort: 'DESC' }], {
    name: 'trips_passenger_history_idx',
  });
  pgm.createIndex('trips', ['driver_id', { name: 'created_at', sort: 'DESC' }], {
    name: 'trips_driver_history_idx',
  });

  pgm.addColumns('trips', {
    requested_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    matched_at: { type: 'timestamptz' },
    search_deadline_at: { type: 'timestamptz' },
    cancel_reason: { type: 'text' },
    distance_meters: { type: 'integer' },
    duration_seconds: { type: 'integer' },
    fare_estimate_npr: { type: 'integer' },
    waiting_charge_npr: { type: 'integer', notNull: true, default: 0 },
    fare_final_npr: { type: 'integer' },
    passenger_notified_at: { type: 'timestamptz' },
    event_seq: { type: 'integer', notNull: true, default: 0 },
    chat_seq: { type: 'integer', notNull: true, default: 0 },
  });

  pgm.createTable('trip_events', {
    id: { type: 'bigserial', primaryKey: true },
    trip_id: { type: 'uuid', notNull: true, references: 'trips', onDelete: 'CASCADE' },
    seq: { type: 'integer', notNull: true },
    type: { type: 'text', notNull: true },
    actor_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    payload: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    // Lets time-driven events (waiting milestones, nearby thresholds) be raised at most once.
    dedupe_key: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('trip_events', 'trip_events_trip_seq_unique', { unique: ['trip_id', 'seq'] });
  pgm.createIndex('trip_events', ['trip_id', 'dedupe_key'], {
    name: 'trip_events_dedupe_unique',
    unique: true,
    where: 'dedupe_key IS NOT NULL',
  });

  pgm.createTable('trip_offers', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    trip_id: { type: 'uuid', notNull: true, references: 'trips', onDelete: 'CASCADE' },
    driver_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    status: { type: 'text', notNull: true, default: 'OFFERED' },
    pickup_distance_meters: { type: 'integer', notNull: true },
    offered_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true },
    responded_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('trip_offers', 'trip_offers_status_check', {
    check: "status IN ('OFFERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED')",
  });
  // A driver is offered a given trip at most once (declines/timeouts are never re-offered).
  pgm.addConstraint('trip_offers', 'trip_offers_trip_driver_unique', {
    unique: ['trip_id', 'driver_id'],
  });
  // A driver holds at most ONE open offer at a time.
  pgm.createIndex('trip_offers', ['driver_id'], {
    name: 'trip_offers_one_open_per_driver',
    unique: true,
    where: "status = 'OFFERED'",
  });
  pgm.createIndex('trip_offers', ['status', 'expires_at']);

  pgm.createTable('trip_messages', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    trip_id: { type: 'uuid', notNull: true, references: 'trips', onDelete: 'CASCADE' },
    seq: { type: 'integer', notNull: true },
    sender_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    body: { type: 'text', notNull: true },
    client_message_id: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    delivered_at: { type: 'timestamptz' },
    read_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('trip_messages', 'trip_messages_trip_seq_unique', {
    unique: ['trip_id', 'seq'],
  });
  pgm.addConstraint('trip_messages', 'trip_messages_idempotency_unique', {
    unique: ['trip_id', 'sender_id', 'client_message_id'],
  });
  pgm.addConstraint('trip_messages', 'trip_messages_body_length', {
    check: 'char_length(body) BETWEEN 1 AND 1000',
  });

  pgm.createTable('trip_calls', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    trip_id: { type: 'uuid', notNull: true, references: 'trips', onDelete: 'CASCADE' },
    caller_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    callee_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    kind: { type: 'text', notNull: true },
    state: { type: 'text', notNull: true, default: 'RINGING' },
    end_reason: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    answered_at: { type: 'timestamptz' },
    connected_at: { type: 'timestamptz' },
    ended_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('trip_calls', 'trip_calls_kind_check', { check: "kind IN ('AUDIO', 'VIDEO')" });
  pgm.addConstraint('trip_calls', 'trip_calls_state_check', {
    check: "state IN ('RINGING', 'CONNECTING', 'CONNECTED', 'ENDED')",
  });
  // One live call per trip.
  pgm.createIndex('trip_calls', ['trip_id'], {
    name: 'trip_calls_one_live_per_trip',
    unique: true,
    where: "state <> 'ENDED'",
  });
  pgm.createIndex('trip_calls', ['trip_id', 'created_at']);

  pgm.createTable('trip_payments', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    trip_id: {
      type: 'uuid',
      notNull: true,
      unique: true,
      references: 'trips',
      onDelete: 'CASCADE',
    },
    amount_npr: { type: 'integer', notNull: true },
    method: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'PENDING' },
    confirmed_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    provider_ref: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    paid_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('trip_payments', 'trip_payments_status_check', {
    check: "status IN ('PENDING', 'PAID', 'FAILED', 'VOID')",
  });
  pgm.addConstraint('trip_payments', 'trip_payments_amount_check', { check: 'amount_npr >= 0' });

  pgm.createTable('trip_ratings', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    trip_id: { type: 'uuid', notNull: true, references: 'trips', onDelete: 'CASCADE' },
    rater_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    ratee_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    rater_role: { type: 'text', notNull: true },
    stars: { type: 'smallint', notNull: true },
    comment: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('trip_ratings', 'trip_ratings_stars_check', {
    check: 'stars BETWEEN 1 AND 5',
  });
  pgm.addConstraint('trip_ratings', 'trip_ratings_one_per_rater', {
    unique: ['trip_id', 'rater_id'],
  });
  pgm.createIndex('trip_ratings', ['ratee_id']);

  pgm.createTable('trip_disputes', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    trip_id: { type: 'uuid', notNull: true, references: 'trips', onDelete: 'CASCADE' },
    raised_by: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    reason: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'OPEN' },
    resolution: { type: 'text' },
    resolved_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    resolved_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('trip_disputes', 'trip_disputes_status_check', {
    check: "status IN ('OPEN', 'RESOLVED', 'REJECTED')",
  });
  pgm.createIndex('trip_disputes', ['status', 'created_at']);
  pgm.createIndex('trip_disputes', ['trip_id']);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('trip_disputes');
  pgm.dropTable('trip_ratings');
  pgm.dropTable('trip_payments');
  pgm.dropTable('trip_calls');
  pgm.dropTable('trip_messages');
  pgm.dropTable('trip_offers');
  pgm.dropTable('trip_events');
  pgm.dropColumns('trips', [
    'requested_at',
    'matched_at',
    'search_deadline_at',
    'cancel_reason',
    'distance_meters',
    'duration_seconds',
    'fare_estimate_npr',
    'waiting_charge_npr',
    'fare_final_npr',
    'passenger_notified_at',
    'event_seq',
    'chat_seq',
  ]);
};
