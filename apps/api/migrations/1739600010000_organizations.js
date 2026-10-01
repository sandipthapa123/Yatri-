/**
 * Business and institutional transport (Phase 18).
 *
 * There is NO separate corporate ride or ledger. A business ride is an ordinary row in `trips` with four new
 * nullable columns (the organization, who booked, the cost centre, the purpose); `passenger_id` stays the person
 * who rides, so booker and passenger are different people exactly when `booked_by` differs. Billing is the
 * existing `trip_payments`: a ride billed to an organization has the payment method ORGANIZATION, and a monthly
 * STATEMENT is only a grouping of those payments (`trip_payments.statement_id`, one statement per payment, so a
 * ride can never be billed twice). The statement's total is always the sum of its payments, never stored.
 *
 *  - organizations / organization_members: organization roles, SEPARATE from platform roles (users.role).
 *  - organization_policies: one row per organization, the one place its booking rules live.
 *  - organization_cost_centers: the department / cost-centre tags rides carry.
 *  - organization_approvals: a booking that needs approval waits here as the request (it is not a ride yet:
 *    a ride would start dispatch). Approving creates the ride through the ordinary request path.
 *  - organization_statements: status and dates only.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
      legal_name text CHECK (legal_name IS NULL OR char_length(legal_name) <= 150),
      billing_email text CHECK (billing_email IS NULL OR char_length(billing_email) <= 200),
      billing_contact_name text CHECK (billing_contact_name IS NULL OR char_length(billing_contact_name) <= 100),
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE organization_cost_centers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      code text NOT NULL CHECK (char_length(code) BETWEEN 1 AND 20),
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
      department text CHECK (department IS NULL OR char_length(department) <= 100),
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX organization_cost_centers_code_idx ON organization_cost_centers (organization_id, lower(code));

    CREATE TABLE organization_members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role text NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'BOOKER', 'MEMBER', 'VIEWER')),
      status text NOT NULL DEFAULT 'INVITED' CHECK (status IN ('INVITED', 'ACTIVE', 'REMOVED')),
      default_cost_center_id uuid REFERENCES organization_cost_centers(id) ON DELETE SET NULL,
      invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
      invited_at timestamptz NOT NULL DEFAULT now(),
      joined_at timestamptz,
      removed_at timestamptz,
      UNIQUE (organization_id, user_id)
    );
    CREATE INDEX organization_members_user_idx ON organization_members (user_id) WHERE status <> 'REMOVED';

    CREATE TABLE organization_policies (
      organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      allowed_category_codes text[] NOT NULL DEFAULT '{}',
      allowed_zone_ids uuid[] NOT NULL DEFAULT '{}',
      per_ride_limit_npr integer CHECK (per_ride_limit_npr IS NULL OR per_ride_limit_npr > 0),
      per_member_monthly_limit_npr integer CHECK (per_member_monthly_limit_npr IS NULL OR per_member_monthly_limit_npr > 0),
      monthly_limit_npr integer CHECK (monthly_limit_npr IS NULL OR monthly_limit_npr > 0),
      approval_over_npr integer CHECK (approval_over_npr IS NULL OR approval_over_npr > 0),
      approval_for_all boolean NOT NULL DEFAULT false,
      member_self_booking boolean NOT NULL DEFAULT true,
      cost_center_required boolean NOT NULL DEFAULT false,
      payment_mode text NOT NULL DEFAULT 'ON_ACCOUNT' CHECK (payment_mode IN ('ON_ACCOUNT', 'EMPLOYEE_CASH')),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE organization_statements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      period_key text NOT NULL CHECK (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
      status text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED', 'PAID', 'VOID')),
      issued_at timestamptz NOT NULL DEFAULT now(),
      due_on date NOT NULL,
      paid_at timestamptz,
      paid_reference text,
      received_by uuid REFERENCES users(id) ON DELETE SET NULL,
      voided_at timestamptz,
      void_reason text
    );
    -- a period is billed once; a cancelled statement frees its period to be issued again
    CREATE UNIQUE INDEX organization_statements_period_idx
      ON organization_statements (organization_id, period_key) WHERE status <> 'VOID';
    CREATE INDEX organization_statements_status_idx ON organization_statements (status, due_on);

    ALTER TABLE trips
      ADD COLUMN organization_id uuid REFERENCES organizations(id),
      ADD COLUMN booked_by uuid REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN cost_center_id uuid REFERENCES organization_cost_centers(id) ON DELETE SET NULL,
      ADD COLUMN purpose text CHECK (purpose IS NULL OR char_length(purpose) <= 200);
    CREATE INDEX trips_organization_idx ON trips (organization_id, requested_at DESC) WHERE organization_id IS NOT NULL;

    ALTER TABLE trip_payments
      ADD COLUMN statement_id uuid REFERENCES organization_statements(id);
    CREATE INDEX trip_payments_statement_idx ON trip_payments (statement_id) WHERE statement_id IS NOT NULL;

    CREATE TABLE organization_approvals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
      passenger_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request jsonb NOT NULL,
      vehicle_category text NOT NULL,
      fare_estimate_npr integer NOT NULL CHECK (fare_estimate_npr >= 0),
      cost_center_id uuid REFERENCES organization_cost_centers(id) ON DELETE SET NULL,
      purpose text CHECK (purpose IS NULL OR char_length(purpose) <= 200),
      reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
      status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'EXPIRED', 'CANCELLED')),
      expires_at timestamptz NOT NULL,
      decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
      decided_at timestamptz,
      decision_note text CHECK (decision_note IS NULL OR char_length(decision_note) <= 300),
      trip_id uuid REFERENCES trips(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX organization_approvals_org_idx ON organization_approvals (organization_id, status, created_at DESC);
    CREATE INDEX organization_approvals_pending_idx ON organization_approvals (expires_at) WHERE status = 'PENDING';

    INSERT INTO retention_policies (record_type, label, action, retain_days, min_retain_days, legal_basis, enforced)
    VALUES ('ORGANIZATION_RECORDS', 'Organization statements, members and approvals', 'KEEP', NULL, NULL,
            'Statements are financial records and members and approvals explain who was billed for which ride; kept with the ride and payment records. Confirm the legal period with counsel.', false);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM retention_policies WHERE record_type = 'ORGANIZATION_RECORDS';
    DROP TABLE organization_approvals;
    DROP INDEX trip_payments_statement_idx;
    ALTER TABLE trip_payments DROP COLUMN statement_id;
    DROP INDEX trips_organization_idx;
    ALTER TABLE trips DROP COLUMN purpose, DROP COLUMN cost_center_id, DROP COLUMN booked_by, DROP COLUMN organization_id;
    DROP TABLE organization_statements;
    DROP TABLE organization_policies;
    DROP TABLE organization_members;
    DROP TABLE organization_cost_centers;
    DROP TABLE organizations;
  `);
};
