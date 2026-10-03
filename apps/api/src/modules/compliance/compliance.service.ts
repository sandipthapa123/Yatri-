import { isoOrNull } from '../../lib/dates';
import type {
  ComplianceRecordInfo,
  MyPolicyStatus,
  PolicyInfo,
  PublishPolicyBody,
  TripRole,
} from '@yatri/types';

import { recordAudit } from '../../lib/audit';
import { query, withTransaction, type Queryable } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';

/**
 * Compliance records: what a person agreed to, and when. The policy text is NOT here or in any app: a
 * policy row holds its title, its current VERSION and the ONE address where the words are served. A
 * record is append-only ("this person accepted version X of policy K at time T") and is never updated or
 * deleted, so what someone agreed to at the time stays provable after a policy changes.
 */
interface PolicyRow {
  key: string;
  kind: 'POLICY' | 'CONSENT';
  title: string;
  version: string;
  effective_at: Date;
  content_url: string | null;
  required: boolean;
  applies_to: TripRole[];
}
const toPolicy = (r: PolicyRow): PolicyInfo => ({
  key: r.key,
  kind: r.kind,
  title: r.title,
  version: r.version,
  effectiveAt: r.effective_at.toISOString(),
  contentUrl: r.content_url,
  required: r.required,
  appliesTo: r.applies_to,
});
const COLS = 'key, kind, title, version, effective_at, content_url, required, applies_to';

/** Policies as they are now, for a role (or every one, for administrators). */
export async function listPolicies(role?: TripRole): Promise<PolicyInfo[]> {
  const r = await query<PolicyRow>(
    `SELECT ${COLS} FROM compliance_policies WHERE ($1::text IS NULL OR $1 = ANY(applies_to)) ORDER BY key`,
    [role ?? null],
  );
  return r.rows.map(toPolicy);
}

/** Each policy that applies to this person, with whether they have accepted its CURRENT version. */
export async function myPolicyStatus(userId: string, role: TripRole): Promise<MyPolicyStatus[]> {
  const r = await query<
    PolicyRow & {
      accepted_version: string | null;
      accepted_at: Date | null;
      accepted_current: boolean;
    }
  >(
    `SELECT ${COLS.split(', ')
      .map((c) => `p.${c}`)
      .join(', ')},
            (SELECT policy_version FROM compliance_records c WHERE c.user_id = $1 AND c.policy_key = p.key
               AND c.withdrawn_at IS NULL ORDER BY accepted_at DESC LIMIT 1) AS accepted_version,
            (SELECT accepted_at FROM compliance_records c WHERE c.user_id = $1 AND c.policy_key = p.key
               AND c.withdrawn_at IS NULL ORDER BY accepted_at DESC LIMIT 1) AS accepted_at,
            EXISTS (SELECT 1 FROM compliance_records c WHERE c.user_id = $1 AND c.policy_key = p.key
                    AND c.policy_version = p.version AND c.withdrawn_at IS NULL) AS accepted_current
     FROM compliance_policies p WHERE $2 = ANY(p.applies_to) ORDER BY p.key`,
    [userId, role],
  );
  return r.rows.map((x) => ({
    ...toPolicy(x),
    accepted: x.accepted_current,
    acceptedVersion: x.accepted_version,
    acceptedAt: isoOrNull(x.accepted_at),
  }));
}

/** Policies this person still has to accept (required ones whose current version they have not accepted). */
export async function pendingPolicies(userId: string, role: TripRole): Promise<MyPolicyStatus[]> {
  return (await myPolicyStatus(userId, role)).filter((p) => p.required && !p.accepted);
}

/**
 * Accept the current version of a policy. The version quoted must be the current one: a person who read an
 * older text is told to read the new one, never recorded as having agreed to it. Accepting twice is a no-op.
 */
export async function acceptPolicy(
  userId: string,
  role: TripRole,
  key: string,
  version: string,
  source: 'APP' | 'ADMIN' = 'APP',
): Promise<ComplianceRecordInfo> {
  const p = await query<PolicyRow>(`SELECT ${COLS} FROM compliance_policies WHERE key = $1`, [key]);
  const policy = p.rows[0];
  if (!policy || !policy.applies_to.includes(role)) {
    throw new HttpError(404, 'NOT_FOUND', 'Policy not found.');
  }
  if (policy.version !== version) {
    throw new HttpError(
      409,
      'POLICY_VERSION_CHANGED',
      'This policy was updated. Please read the current version and accept that.',
    );
  }
  const r = await query<{ id: string; accepted_at: Date }>(
    `INSERT INTO compliance_records (user_id, policy_key, policy_version, source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, policy_key, policy_version) DO UPDATE SET
       accepted_at = CASE WHEN compliance_records.withdrawn_at IS NULL THEN compliance_records.accepted_at ELSE now() END,
       withdrawn_at = NULL
     RETURNING id, accepted_at`,
    [userId, key, version, source],
  );
  const row = r.rows[0] as { id: string; accepted_at: Date };
  return {
    id: row.id,
    policyKey: key,
    policyVersion: version,
    acceptedAt: row.accepted_at.toISOString(),
    source,
    withdrawnAt: null,
  };
}

/**
 * A person withdraws a CONSENT (never a policy, which is the terms of using the service). The record of what they agreed
 * to stays; it is marked withdrawn, once, so everything that acts on the consent stops. Idempotent. The caller audits it
 * and erases whatever the consent was for.
 */
export async function withdrawConsent(
  userId: string,
  key: string,
  client?: Queryable,
): Promise<number> {
  const run = client ?? { query };
  const policy = await run.query<{ kind: string }>(
    'SELECT kind FROM compliance_policies WHERE key = $1',
    [key],
  );
  if (policy.rows[0]?.kind !== 'CONSENT') {
    throw new HttpError(400, 'NOT_A_CONSENT', 'Only a consent can be withdrawn.');
  }
  const r = await run.query(
    `UPDATE compliance_records SET withdrawn_at = now()
     WHERE user_id = $1 AND policy_key = $2 AND withdrawn_at IS NULL`,
    [userId, key],
  );
  return r.rowCount ?? 0;
}

export async function myComplianceRecords(userId: string): Promise<ComplianceRecordInfo[]> {
  const r = await query<{
    id: string;
    policy_key: string;
    policy_version: string;
    accepted_at: Date;
    source: 'APP' | 'ADMIN';
    withdrawn_at: Date | null;
  }>(
    `SELECT id, policy_key, policy_version, accepted_at, source, withdrawn_at FROM compliance_records
     WHERE user_id = $1 ORDER BY accepted_at DESC, id`,
    [userId],
  );
  return r.rows.map((x) => ({
    id: x.id,
    policyKey: x.policy_key,
    policyVersion: x.policy_version,
    acceptedAt: x.accepted_at.toISOString(),
    source: x.source,
    withdrawnAt: isoOrNull(x.withdrawn_at),
  }));
}

/**
 * Publish a new version of a policy (its new version label, and where the words now are). Earlier
 * acceptances stay exactly as they were; everyone must accept the new version to be up to date.
 */
export async function publishPolicy(
  key: string,
  body: PublishPolicyBody,
  adminId: string,
): Promise<PolicyInfo> {
  const row = await withTransaction(async (client) => {
    const cur = await client.query<PolicyRow>(
      `SELECT ${COLS} FROM compliance_policies WHERE key = $1 FOR UPDATE`,
      [key],
    );
    const current = cur.rows[0];
    if (!current) throw new HttpError(404, 'NOT_FOUND', 'Policy not found.');
    if (current.version === body.version) {
      throw new HttpError(
        409,
        'SAME_VERSION',
        'Give the new text a new version so people can be asked to accept it.',
      );
    }
    const upd = await client.query<PolicyRow>(
      `UPDATE compliance_policies SET version = $2, title = COALESCE($3, title),
         content_url = CASE WHEN $4::boolean THEN $5 ELSE content_url END,
         effective_at = COALESCE($6::timestamptz, now()), updated_at = now()
       WHERE key = $1 RETURNING ${COLS}`,
      [
        key,
        body.version,
        body.title ?? null,
        body.contentUrl !== undefined,
        body.contentUrl ?? null,
        body.effectiveAt ?? null,
      ],
    );
    return { updated: upd.rows[0] as PolicyRow, from: current.version };
  });
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'POLICY_PUBLISHED',
    subjectType: 'policy',
    subjectIds: null,
    detail: { key, from: row.from, to: body.version, reason: body.reason },
  });
  return toPolicy(row.updated);
}
