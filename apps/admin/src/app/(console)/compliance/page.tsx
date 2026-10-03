import Link from 'next/link';
import {
  DATA_REQUEST_KINDS,
  DATA_REQUEST_KIND_LABELS,
  DATA_REQUEST_STATES,
  DATA_REQUEST_STATUS_LABELS,
  formatWhen,
} from '@yatri/types';

import { listDataRequests, listPolicies, listRetention } from '../../../lib/apiClient';
import { loadOrDenied } from '../../../lib/access';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { NoAccess } from '../ui/NoAccess';
import { Pagination, withParams } from '../ui/Pagination';
import { DataRequestForm, PublishPolicyForm, RetentionForm } from './Forms';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

const at = (iso: string) => formatWhen(iso);

/**
 * Privacy and compliance: policy versions and where their text is, the queue of account-deletion and
 * data-access requests with their due dates, and the retention rule for every kind of record. Nothing
 * here holds policy words or a retention number of its own: it edits the records the API keeps.
 */
export default async function CompliancePage({ searchParams }: PageProps) {
  const token = await requireAdminAccessToken();
  const sp = await searchParams;
  const status = (DATA_REQUEST_STATES as readonly string[]).includes(sp.status ?? '')
    ? sp.status
    : undefined;
  const kind = (DATA_REQUEST_KINDS as readonly string[]).includes(sp.kind ?? '')
    ? sp.kind
    : undefined;
  const open = sp.open === 'true' ? 'true' : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const { data, denied } = await loadOrDenied(async () => {
    const [policies, requests, retention] = await Promise.all([
      listPolicies(token),
      listDataRequests(token, { status, kind, open, page, pageSize: PAGE_SIZE }),
      listRetention(token),
    ]);
    return { policies, requests, retention };
  });
  if (denied || !data) return <NoAccess what="privacy and compliance" />;
  const { policies, requests, retention } = data;
  const href = (p: number) => withParams('/compliance', { status, kind, open, page: String(p) });

  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Privacy and compliance</h1>
        <Link href="/" style={styles.backLink}>
          ← Dashboard
        </Link>
      </div>

      <section aria-labelledby="dr-h" style={styles.section}>
        <h2 id="dr-h" style={styles.sectionTitle}>
          Deletion and data requests
        </h2>
        <form method="get" style={styles.filterForm} role="search" aria-label="Filter requests">
          <div style={styles.field}>
            <label htmlFor="open" style={styles.label}>
              Show
            </label>
            <select id="open" name="open" defaultValue={open ?? ''} style={styles.select}>
              <option value="">All</option>
              <option value="true">Only those still open</option>
            </select>
          </div>
          <div style={styles.field}>
            <label htmlFor="kind" style={styles.label}>
              Kind
            </label>
            <select id="kind" name="kind" defaultValue={kind ?? ''} style={styles.select}>
              <option value="">Both</option>
              {DATA_REQUEST_KINDS.map((k) => (
                <option key={k} value={k}>
                  {DATA_REQUEST_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <div style={styles.field}>
            <label htmlFor="status" style={styles.label}>
              Status
            </label>
            <select id="status" name="status" defaultValue={status ?? ''} style={styles.select}>
              <option value="">Any</option>
              {DATA_REQUEST_STATES.map((s) => (
                <option key={s} value={s}>
                  {DATA_REQUEST_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" style={styles.buttonPrimary}>
            Apply filters
          </button>
        </form>
        {requests.items.length === 0 ? (
          <p style={{ margin: 0 }}>No requests.</p>
        ) : (
          requests.items.map((r) => (
            <article
              key={r.id}
              style={{ display: 'grid', gap: 8, paddingBottom: 12 }}
              aria-label={`${DATA_REQUEST_KIND_LABELS[r.kind]} from ${r.userName ?? 'an unnamed person'}`}
            >
              <p style={{ margin: 0 }}>
                <strong>{DATA_REQUEST_KIND_LABELS[r.kind]}</strong> from{' '}
                {r.userName ?? 'an unnamed person'} ({r.userRole.toLowerCase()}), asked{' '}
                {at(r.createdAt)}. <strong>{DATA_REQUEST_STATUS_LABELS[r.status]}.</strong>{' '}
                {r.overdue ? `Late: it was due ${at(r.dueAt)}.` : `Due by ${at(r.dueAt)}.`}
                {r.note ? ` They wrote: ${r.note}` : ''}
                {r.decisionNote ? ` Our note: ${r.decisionNote}` : ''}
                {r.decidedByName ? ` Handled by ${r.decidedByName}.` : ''}
              </p>
              <DataRequestForm request={r} />
            </article>
          ))
        )}
        <Pagination page={page} pageSize={PAGE_SIZE} total={requests.total} href={href} />
      </section>

      <section aria-labelledby="pol-h" style={styles.section}>
        <h2 id="pol-h" style={styles.sectionTitle}>
          Policies and consent
        </h2>
        {policies.map((p) => (
          <div key={p.key} style={{ display: 'grid', gap: 8, paddingBottom: 12 }}>
            <p style={{ margin: 0 }}>
              <strong>{p.title}</strong> · version {p.version} · in force since {at(p.effectiveAt)}{' '}
              · {p.required ? 'must be accepted' : 'optional consent'} · applies to{' '}
              {p.appliesTo.join(' and ').toLowerCase()}s.{' '}
              {p.contentUrl ? (
                <>
                  Text at <a href={p.contentUrl}>{p.contentUrl}</a>.
                </>
              ) : (
                'The text has not been published yet.'
              )}
            </p>
            <PublishPolicyForm policy={p} />
          </div>
        ))}
      </section>

      <section aria-labelledby="ret-h" style={styles.section}>
        <h2 id="ret-h" style={styles.sectionTitle}>
          How long each kind of record is kept
        </h2>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-secondary)' }}>
          A rule marked &quot;kept&quot; is never deleted by a job. The legal periods for financial
          and ride records should be confirmed with counsel for your country; nothing here claims
          them.
        </p>
        {retention.map((r) => (
          <div key={r.recordType} style={{ display: 'grid', gap: 6, paddingBottom: 12 }}>
            <p style={{ margin: 0 }}>
              <strong>{r.label}:</strong>{' '}
              {r.action === 'KEEP'
                ? 'kept.'
                : `deleted after ${r.retainDays} days${r.enforced ? '' : ' (not enforced yet)'}.`}{' '}
              {r.legalBasis}
              {r.lastRunAt
                ? ` Last clean-up ${at(r.lastRunAt)} removed ${r.lastRunCount ?? 0}.`
                : ''}
            </p>
            <RetentionForm rule={r} />
          </div>
        ))}
      </section>
    </div>
  );
}
