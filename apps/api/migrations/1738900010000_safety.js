/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Safety: SOS alerts, emergency contacts, incident reports, and ONE audit log.
 *
 *  - The admin access log becomes the audit log: it now also records ACTIONS (an SOS acknowledged, an
 *    incident moved) and non-admin actors (the person who raised an SOS), with a small `detail`.
 *    One trail for "who did what to which safety record", not one per feature.
 *  - sos_events: one row per emergency. A partial unique index allows only ONE open alert per person
 *    per ride, so two simultaneous triggers cannot create two alerts. The recorded position is the
 *    position at the moment of the alert; there is no location history table.
 *  - trip_shares.purpose: links created by an SOS for the person's emergency contacts are marked, so
 *    they are quiet (no ride event to the other person) and do not use up the person's own sharing limit.
 *  - incident_reports + incident_notes: reports about a ride, and the safety team's internal notes and
 *    actions (also the status history). Notes are never shown to the reporter.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // ---- one audit log
  pgm.renameTable('admin_access_log', 'audit_log');
  pgm.renameColumn('audit_log', 'admin_id', 'actor_id');
  pgm.alterColumn('audit_log', 'actor_id', { notNull: false });
  pgm.addColumns('audit_log', {
    actor_role: { type: 'text' },
    detail: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
  });

  // ---- emergency contacts
  pgm.createTable('emergency_contacts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    phone_number: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('emergency_contacts', 'emergency_contacts_user_phone_unique', {
    unique: ['user_id', 'phone_number'],
  });
  pgm.createIndex('emergency_contacts', ['user_id']);

  // ---- SOS
  pgm.createTable('sos_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    trip_id: { type: 'uuid', notNull: true, references: 'trips', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    role: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'ACTIVE' },
    latitude: { type: 'numeric(9,6)' },
    longitude: { type: 'numeric(9,6)' },
    accuracy_meters: { type: 'real' },
    location_source: { type: 'text', notNull: true, default: 'NONE' },
    location_at: { type: 'timestamptz' },
    contacts_notified: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    acknowledged_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    acknowledged_at: { type: 'timestamptz' },
    resolved_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    resolved_at: { type: 'timestamptz' },
    resolution_note: { type: 'text' },
    cancelled_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('sos_events', 'sos_events_status_check', {
    check: "status IN ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'CANCELLED')",
  });
  pgm.addConstraint('sos_events', 'sos_events_role_check', {
    check: "role IN ('PASSENGER', 'DRIVER')",
  });
  pgm.addConstraint('sos_events', 'sos_events_location_source_check', {
    check: "location_source IN ('DEVICE', 'DRIVER_FEED', 'NONE')",
  });
  pgm.createIndex('sos_events', ['trip_id', 'user_id'], {
    name: 'sos_events_one_open_per_person_per_trip',
    unique: true,
    where: "status IN ('ACTIVE', 'ACKNOWLEDGED')",
  });
  pgm.createIndex('sos_events', ['status', { name: 'created_at', sort: 'DESC' }]);

  // ---- shares created by an SOS
  pgm.addColumn('trip_shares', { purpose: { type: 'text', notNull: true, default: 'TRIP' } });
  pgm.addConstraint('trip_shares', 'trip_shares_purpose_check', {
    check: "purpose IN ('TRIP', 'SOS')",
  });

  // ---- incident reports
  pgm.createTable('incident_reports', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    trip_id: { type: 'uuid', notNull: true, references: 'trips', onDelete: 'CASCADE' },
    reporter_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    reporter_role: { type: 'text', notNull: true },
    category: { type: 'text', notNull: true },
    description: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'OPEN' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('incident_reports', 'incident_reports_category_check', {
    check:
      "category IN ('SAFETY_ISSUE', 'HARASSMENT', 'ACCIDENT', 'FRAUD', 'VEHICLE_ISSUE', 'OTHER')",
  });
  pgm.addConstraint('incident_reports', 'incident_reports_status_check', {
    check: "status IN ('OPEN', 'UNDER_REVIEW', 'ACTION_TAKEN', 'RESOLVED', 'DISMISSED')",
  });
  pgm.createIndex('incident_reports', ['status', { name: 'created_at', sort: 'DESC' }]);
  pgm.createIndex('incident_reports', ['trip_id']);
  pgm.createIndex('incident_reports', ['reporter_id', { name: 'created_at', sort: 'DESC' }]);

  pgm.createTable('incident_notes', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    incident_id: { type: 'uuid', notNull: true, references: 'incident_reports', onDelete: 'CASCADE' },
    admin_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    kind: { type: 'text', notNull: true },
    body: { type: 'text', notNull: true },
    from_status: { type: 'text' },
    to_status: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('incident_notes', 'incident_notes_kind_check', {
    check: "kind IN ('NOTE', 'ACTION', 'STATUS')",
  });
  pgm.createIndex('incident_notes', ['incident_id', 'created_at']);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('incident_notes');
  pgm.dropTable('incident_reports');
  pgm.dropConstraint('trip_shares', 'trip_shares_purpose_check');
  pgm.dropColumn('trip_shares', 'purpose');
  pgm.dropTable('sos_events');
  pgm.dropTable('emergency_contacts');
  pgm.dropColumns('audit_log', ['actor_role', 'detail']);
  pgm.alterColumn('audit_log', 'actor_id', { notNull: true });
  pgm.renameColumn('audit_log', 'actor_id', 'admin_id');
  pgm.renameTable('audit_log', 'admin_access_log');
};
