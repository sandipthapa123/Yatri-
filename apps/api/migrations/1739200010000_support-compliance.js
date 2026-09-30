/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Support, disputes, refunds and compliance.
 *
 *  - support_priorities / support_categories are DATA an administrator edits (labels, who may pick a
 *    category, how long an unanswered ticket may wait): nothing about them is written into an app.
 *  - support_tickets are the one conversation-and-lifecycle record. A ride dispute is a ticket in a
 *    category of kind DISPUTE that points at the ride (trip_id); it holds no copy of the ride. The old
 *    trip_disputes rows are moved into tickets here and the table is dropped, so there is one state
 *    machine, not two.
 *  - refunds refer to the payment of a ride (trip_payments) and the ticket they came from. A refund never
 *    changes the payment row: what has been refunded is the sum of COMPLETED refunds.
 *  - compliance_policies hold the CURRENT version of each policy (title, version, where the words are);
 *    compliance_records are append-only "this person accepted this version at this time".
 *  - data_requests are account-deletion and data-access requests with a due date.
 *  - retention_policies are the one place retention is decided (how long, what happens, why, and the shortest
 *    it may be set to). Records that must be kept say KEEP.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE support_priorities (
      code text PRIMARY KEY,
      label text NOT NULL,
      rank integer NOT NULL UNIQUE,
      first_response_hours integer NOT NULL CHECK (first_response_hours > 0),
      -- what an unanswered ticket of this priority is raised to when it waits too long (null: only the team is told)
      escalates_to text REFERENCES support_priorities(code),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO support_priorities (code, label, rank, first_response_hours) VALUES
      ('LOW', 'Low', 1, 72), ('NORMAL', 'Normal', 2, 24), ('HIGH', 'High', 3, 8), ('URGENT', 'Urgent', 4, 2);
    UPDATE support_priorities SET escalates_to = 'NORMAL' WHERE code = 'LOW';
    UPDATE support_priorities SET escalates_to = 'HIGH' WHERE code = 'NORMAL';
    UPDATE support_priorities SET escalates_to = 'URGENT' WHERE code = 'HIGH';

    CREATE TABLE support_categories (
      code text PRIMARY KEY,
      label text NOT NULL,
      help text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('GENERAL', 'DISPUTE')),
      for_roles text[] NOT NULL DEFAULT ARRAY['PASSENGER', 'DRIVER'],
      requires_ride boolean NOT NULL DEFAULT false,
      default_priority text NOT NULL REFERENCES support_priorities(code),
      is_active boolean NOT NULL DEFAULT true,
      sort_order integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO support_categories (code, label, help, kind, for_roles, requires_ride, default_priority, sort_order) VALUES
      ('ACCOUNT', 'My account or signing in', 'Problems with your profile, phone number or signing in.', 'GENERAL', ARRAY['PASSENGER','DRIVER'], false, 'NORMAL', 10),
      ('APP_PROBLEM', 'The app is not working', 'Something in the app is broken, slow or confusing.', 'GENERAL', ARRAY['PASSENGER','DRIVER'], false, 'NORMAL', 20),
      ('PAYMENTS', 'Payments and fares in general', 'Questions about how fares or cash payments work (for a specific ride, use a ride problem).', 'GENERAL', ARRAY['PASSENGER','DRIVER'], false, 'NORMAL', 30),
      ('DRIVER_VERIFICATION', 'Driver verification and documents', 'Your application, documents or vehicle review.', 'GENERAL', ARRAY['DRIVER'], false, 'NORMAL', 40),
      ('LOST_ITEM', 'Something left in a vehicle', 'You or your passenger left something behind on a ride.', 'GENERAL', ARRAY['PASSENGER','DRIVER'], true, 'NORMAL', 50),
      ('FEEDBACK', 'A suggestion or feedback', 'An idea, or something we could do better.', 'GENERAL', ARRAY['PASSENGER','DRIVER'], false, 'LOW', 60),
      ('OTHER', 'Something else', 'Anything that does not fit above.', 'GENERAL', ARRAY['PASSENGER','DRIVER'], false, 'NORMAL', 90),
      ('RIDE_FARE', 'Fare', 'The fare was different from what you expected or is wrong.', 'DISPUTE', ARRAY['PASSENGER','DRIVER'], true, 'NORMAL', 110),
      ('RIDE_CANCELLATION', 'Cancellation', 'A cancellation or a cancellation fee you disagree with.', 'DISPUTE', ARRAY['PASSENGER','DRIVER'], true, 'NORMAL', 120),
      ('RIDE_DRIVER_BEHAVIOUR', 'Driver behaviour', 'How the driver behaved or drove.', 'DISPUTE', ARRAY['PASSENGER'], true, 'HIGH', 130),
      ('RIDE_PASSENGER_BEHAVIOUR', 'Passenger behaviour', 'How the passenger behaved.', 'DISPUTE', ARRAY['DRIVER'], true, 'HIGH', 140),
      ('RIDE_PAYMENT', 'Payment for this ride', 'Cash was taken or confirmed wrongly, or the amount paid was not the fare.', 'DISPUTE', ARRAY['PASSENGER','DRIVER'], true, 'HIGH', 150),
      ('RIDE_ROUTE', 'Route', 'The route taken, or the distance or time charged for.', 'DISPUTE', ARRAY['PASSENGER','DRIVER'], true, 'NORMAL', 160),
      ('RIDE_WAITING_TIME', 'Waiting time', 'A waiting charge, or how long someone waited.', 'DISPUTE', ARRAY['PASSENGER','DRIVER'], true, 'NORMAL', 170),
      ('RIDE_SAFETY', 'Safety on this ride', 'A safety concern about this ride (in danger now? use Emergency SOS or call the emergency number first).', 'DISPUTE', ARRAY['PASSENGER','DRIVER'], true, 'URGENT', 180),
      ('RIDE_OTHER', 'Another problem with this ride', 'Any other problem with a ride.', 'DISPUTE', ARRAY['PASSENGER','DRIVER'], true, 'NORMAL', 190);

    CREATE TABLE support_tickets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      requester_role text NOT NULL CHECK (requester_role IN ('PASSENGER', 'DRIVER')),
      category_code text NOT NULL REFERENCES support_categories(code),
      is_dispute boolean NOT NULL DEFAULT false,
      subject text NOT NULL,
      status text NOT NULL DEFAULT 'OPEN'
        CHECK (status IN ('OPEN', 'IN_REVIEW', 'WAITING_FOR_USER', 'WAITING_FOR_ADMIN', 'RESOLVED', 'CLOSED')),
      priority text NOT NULL REFERENCES support_priorities(code),
      assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
      trip_id uuid REFERENCES trips(id) ON DELETE SET NULL,
      outcome text CHECK (outcome IN ('UPHELD', 'REJECTED')),
      resolution_note text,
      escalation_level integer NOT NULL DEFAULT 0,
      escalated_at timestamptz,
      first_admin_response_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz,
      closed_at timestamptz
    );
    CREATE INDEX support_tickets_requester_idx ON support_tickets (requester_id, updated_at DESC);
    CREATE INDEX support_tickets_queue_idx ON support_tickets (status, created_at);
    CREATE INDEX support_tickets_assigned_idx ON support_tickets (assigned_to, status);
    CREATE INDEX support_tickets_trip_idx ON support_tickets (trip_id) WHERE trip_id IS NOT NULL;
    CREATE INDEX support_tickets_created_idx ON support_tickets (created_at);
    -- one open dispute per person per ride, even under simultaneous requests
    CREATE UNIQUE INDEX support_tickets_one_open_dispute
      ON support_tickets (trip_id, requester_id)
      WHERE is_dispute AND status NOT IN ('RESOLVED', 'CLOSED');

    CREATE TABLE support_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      author_id uuid REFERENCES users(id) ON DELETE SET NULL,
      author_kind text NOT NULL CHECK (author_kind IN ('REQUESTER', 'ADMIN', 'SYSTEM')),
      kind text NOT NULL CHECK (kind IN ('MESSAGE', 'NOTE', 'STATUS', 'RESOLUTION')),
      body text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX support_messages_ticket_idx ON support_messages (ticket_id, created_at, id);

    CREATE TABLE support_attachments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      message_id uuid REFERENCES support_messages(id) ON DELETE SET NULL,
      uploader_id uuid REFERENCES users(id) ON DELETE SET NULL,
      storage_key text NOT NULL UNIQUE,
      filename text NOT NULL,
      content_type text NOT NULL,
      size_bytes integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX support_attachments_ticket_idx ON support_attachments (ticket_id, created_at);

    CREATE TABLE refunds (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id uuid REFERENCES support_tickets(id) ON DELETE SET NULL,
      trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      payment_id uuid NOT NULL REFERENCES trip_payments(id) ON DELETE CASCADE,
      requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
      requested_by_role text NOT NULL CHECK (requested_by_role IN ('PASSENGER', 'DRIVER', 'ADMIN')),
      amount_npr integer NOT NULL CHECK (amount_npr > 0),
      reason text NOT NULL CHECK (reason IN ('FULL_FARE', 'WAITING_CHARGE', 'PARTIAL')),
      status text NOT NULL DEFAULT 'REQUESTED'
        CHECK (status IN ('REQUESTED', 'REVIEWING', 'APPROVED', 'PROCESSING', 'COMPLETED', 'REJECTED', 'FAILED')),
      method text CHECK (method IN ('PLATFORM', 'DRIVER_CASH')),
      reference text,
      decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
      decision_note text,
      decided_at timestamptz,
      processed_by uuid REFERENCES users(id) ON DELETE SET NULL,
      failed_reason text,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX refunds_payment_idx ON refunds (payment_id);
    CREATE INDEX refunds_ticket_idx ON refunds (ticket_id) WHERE ticket_id IS NOT NULL;
    CREATE INDEX refunds_queue_idx ON refunds (status, created_at);
    -- at most one refund under way per payment, even under simultaneous requests
    CREATE UNIQUE INDEX refunds_one_active_per_payment
      ON refunds (payment_id)
      WHERE status NOT IN ('COMPLETED', 'REJECTED');

    CREATE TABLE compliance_policies (
      key text PRIMARY KEY,
      kind text NOT NULL CHECK (kind IN ('POLICY', 'CONSENT')),
      title text NOT NULL,
      version text NOT NULL,
      effective_at timestamptz NOT NULL DEFAULT now(),
      content_url text,
      required boolean NOT NULL DEFAULT true,
      applies_to text[] NOT NULL DEFAULT ARRAY['PASSENGER', 'DRIVER'],
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO compliance_policies (key, kind, title, version, required, applies_to) VALUES
      ('TERMS', 'POLICY', 'Terms of service', '1', true, ARRAY['PASSENGER','DRIVER']),
      ('PRIVACY', 'POLICY', 'Privacy policy', '1', true, ARRAY['PASSENGER','DRIVER']),
      ('DRIVER_AGREEMENT', 'POLICY', 'Driver agreement', '1', true, ARRAY['DRIVER']),
      ('LOCATION_CONSENT', 'CONSENT', 'Location sharing during rides', '1', false, ARRAY['PASSENGER','DRIVER']);

    CREATE TABLE compliance_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      policy_key text NOT NULL REFERENCES compliance_policies(key),
      policy_version text NOT NULL,
      source text NOT NULL DEFAULT 'APP' CHECK (source IN ('APP', 'ADMIN')),
      accepted_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, policy_key, policy_version)
    );
    CREATE INDEX compliance_records_user_idx ON compliance_records (user_id, accepted_at DESC);

    CREATE TABLE data_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('DATA_ACCESS', 'ACCOUNT_DELETION')),
      status text NOT NULL DEFAULT 'REQUESTED'
        CHECK (status IN ('REQUESTED', 'REVIEWING', 'COMPLETED', 'REJECTED', 'CANCELLED')),
      note text,
      decision_note text,
      decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
      due_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    );
    CREATE INDEX data_requests_queue_idx ON data_requests (status, due_at);
    CREATE INDEX data_requests_user_idx ON data_requests (user_id, created_at DESC);
    -- one request of each kind under way per person
    CREATE UNIQUE INDEX data_requests_one_open
      ON data_requests (user_id, kind)
      WHERE status IN ('REQUESTED', 'REVIEWING');

    CREATE TABLE retention_policies (
      record_type text PRIMARY KEY,
      label text NOT NULL,
      action text NOT NULL CHECK (action IN ('DELETE', 'KEEP')),
      retain_days integer CHECK (retain_days IS NULL OR retain_days > 0),
      min_retain_days integer CHECK (min_retain_days IS NULL OR min_retain_days > 0),
      legal_basis text NOT NULL,
      enforced boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now(),
      last_run_at timestamptz,
      last_run_count integer,
      CHECK (action = 'KEEP' OR retain_days IS NOT NULL)
    );
    INSERT INTO retention_policies (record_type, label, action, retain_days, min_retain_days, legal_basis, enforced) VALUES
      ('OTP_REQUESTS', 'One-time sign-in codes', 'DELETE', 7, 1, 'Only needed to prove a code was sent and to limit abuse; short-lived by design.', true),
      ('NOTIFICATIONS', 'Notification history', 'DELETE', 180, 30, 'Convenience history for the person; not a record of anything.', true),
      ('AUTH_EVENTS', 'Sign-in and security events', 'DELETE', 400, 90, 'Needed to investigate account misuse; kept for a year, then removed.', true),
      ('CHAT_MESSAGES', 'Ride chat text', 'DELETE', 90, 15, 'Kept after a ride only in case of a problem; a ride with an open dispute is never purged.', true),
      ('SUPPORT_EVIDENCE', 'Files attached to closed support tickets', 'DELETE', 730, 180, 'Evidence for a dispute; removed a while after the ticket is closed.', true),
      ('TRIPS', 'Ride records', 'KEEP', NULL, NULL, 'Operational and financial record of a service given; needed for payments, disputes and safety. Confirm the legal period with counsel.', false),
      ('PAYMENTS', 'Payment records', 'KEEP', NULL, NULL, 'Financial record; kept. Confirm the legal period with counsel.', false),
      ('REFUNDS', 'Refund records', 'KEEP', NULL, NULL, 'Financial record; kept. Confirm the legal period with counsel.', false),
      ('SUPPORT_TICKETS', 'Support ticket text and decisions', 'KEEP', NULL, NULL, 'Record of what was decided and why, needed to answer a later complaint.', false),
      ('SAFETY_RECORDS', 'SOS alerts and incident reports', 'KEEP', NULL, NULL, 'Safety and legal record; kept.', false),
      ('AUDIT_LOG', 'Audit log', 'KEEP', NULL, NULL, 'Accountability for administrative actions; never removed.', false),
      ('COMPLIANCE_RECORDS', 'Policy acceptances', 'KEEP', NULL, NULL, 'Proof of what was agreed, and when; never removed.', false),
      ('DATA_REQUESTS', 'Account and data requests', 'KEEP', NULL, NULL, 'Proof that a request was received and answered in time; kept.', false);

    -- The old ride disputes become tickets (one lifecycle, one conversation), then the old table goes.
    INSERT INTO support_tickets (id, requester_id, requester_role, category_code, is_dispute, subject, status, priority,
                                 trip_id, outcome, resolution_note, created_at, updated_at, resolved_at)
      SELECT d.id, d.raised_by, CASE WHEN t.passenger_id = d.raised_by THEN 'PASSENGER' ELSE 'DRIVER' END,
             'RIDE_OTHER', true, left(d.reason, 100),
             CASE WHEN d.status = 'OPEN' THEN 'OPEN' ELSE 'RESOLVED' END, 'NORMAL', d.trip_id,
             CASE d.status WHEN 'RESOLVED' THEN 'UPHELD' WHEN 'REJECTED' THEN 'REJECTED' ELSE NULL END,
             d.resolution, d.created_at, COALESCE(d.resolved_at, d.created_at), d.resolved_at
      FROM trip_disputes d JOIN trips t ON t.id = d.trip_id;
    INSERT INTO support_messages (ticket_id, author_id, author_kind, kind, body, created_at)
      SELECT d.id, d.raised_by, 'REQUESTER', 'MESSAGE', d.reason, d.created_at FROM trip_disputes d;
    INSERT INTO support_messages (ticket_id, author_id, author_kind, kind, body, created_at)
      SELECT d.id, d.resolved_by, 'ADMIN', 'RESOLUTION', d.resolution, d.resolved_at
      FROM trip_disputes d WHERE d.resolution IS NOT NULL AND d.resolved_at IS NOT NULL;
    DROP TABLE trip_disputes;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    CREATE TABLE trip_disputes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      raised_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason text NOT NULL,
      status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'REJECTED')),
      resolution text,
      resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz
    );
    CREATE INDEX trip_disputes_trip_id_index ON trip_disputes (trip_id);
    CREATE INDEX trip_disputes_status_created_at_index ON trip_disputes (status, created_at);
    INSERT INTO trip_disputes (id, trip_id, raised_by, reason, status, resolution, created_at, resolved_at)
      SELECT id, trip_id, requester_id,
             COALESCE((SELECT body FROM support_messages m WHERE m.ticket_id = t.id AND m.kind = 'MESSAGE'
                       ORDER BY created_at LIMIT 1), t.subject),
             CASE WHEN status IN ('RESOLVED', 'CLOSED') THEN CASE WHEN outcome = 'REJECTED' THEN 'REJECTED' ELSE 'RESOLVED' END ELSE 'OPEN' END,
             resolution_note, created_at, resolved_at
      FROM support_tickets t WHERE is_dispute AND trip_id IS NOT NULL;
    DROP TABLE retention_policies;
    DROP TABLE data_requests;
    DROP TABLE compliance_records;
    DROP TABLE compliance_policies;
    DROP TABLE refunds;
    DROP TABLE support_attachments;
    DROP TABLE support_messages;
    DROP TABLE support_tickets;
    DROP TABLE support_categories;
    DROP TABLE support_priorities;
  `);
};
