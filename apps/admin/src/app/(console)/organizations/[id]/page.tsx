import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ORG_STATEMENT_STATUS_LABELS,
  ORG_STATUS_LABELS,
  describeOrgPolicy,
  formatNpr,
} from '@yatri/types';

import { ApiError, getOrganizationApi } from '../../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../drivers/styles';
import { AuditTrail } from '../../safety/AuditTrail';
import { MoveForm } from '../Forms';

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * One organization, as the platform sees it: who owns it, its policy, what is owed and its statements. The
 * platform can suspend or reactivate; it cannot change members, policy or rides (the organization's own roles do).
 */
export default async function OrganizationPage({ params }: PageProps) {
  const token = await requireAdminAccessToken();
  const { id } = await params;
  let o;
  try {
    o = await getOrganizationApi(token, id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const p = o.policy;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>{o.name}</h1>
        <Link href="/organizations" style={styles.backLink}>
          ← Organizations
        </Link>
      </div>

      <section aria-labelledby="sum-h" style={styles.section}>
        <h2 id="sum-h" style={styles.sectionTitle}>
          Summary
        </h2>
        <p style={{ margin: 0 }}>
          <strong>{ORG_STATUS_LABELS[o.status]}.</strong> {o.members} members. This month:{' '}
          {o.ridesThisMonth} rides, {formatNpr(o.spendThisMonthNpr)}. Owed and not yet paid:{' '}
          {formatNpr(o.outstandingNpr)}.
        </p>
        <p style={{ margin: 0 }}>
          Legal name: {o.legalName ?? 'not given'}. Billing contact:{' '}
          {o.billingContactName ?? 'not given'}, {o.billingEmail ?? 'no email'}.
        </p>
        <p style={{ margin: 0 }}>
          Owners:{' '}
          {o.owners.length === 0 ? 'none' : o.owners.map((x) => x.name ?? 'Unnamed').join(', ')}.
        </p>
      </section>

      <section aria-labelledby="pol-h" style={styles.section}>
        <h2 id="pol-h" style={styles.sectionTitle}>
          Policy
        </h2>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {describeOrgPolicy(p).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="st-h" style={styles.section}>
        <h2 id="st-h" style={styles.sectionTitle}>
          Statements
        </h2>
        {o.statements.length === 0 ? (
          <p style={{ margin: 0 }}>No statements yet.</p>
        ) : (
          <table style={styles.table}>
            <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>
              Statements of {o.name}
            </caption>
            <thead>
              <tr>
                {['Statement', 'Month', 'Status', 'Rides', 'Total', 'Due'].map((h) => (
                  <th key={h} scope="col" style={styles.th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {o.statements.map((s) => (
                <tr key={s.id}>
                  <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                    <Link href={`/organizations/statements/${s.id}`}>Statement {s.number}</Link>
                  </th>
                  <td style={styles.td}>{s.periodKey}</td>
                  <td style={styles.td}>{ORG_STATEMENT_STATUS_LABELS[s.status]}</td>
                  <td style={styles.td}>{s.rides}</td>
                  <td style={styles.td}>{formatNpr(s.totalNpr)}</td>
                  <td style={styles.td}>{s.dueOn}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="act-h" style={styles.section}>
        <h2 id="act-h" style={styles.sectionTitle}>
          {o.allowedNext === 'SUSPENDED' ? 'Suspend' : 'Reactivate'}
        </h2>
        <MoveForm organizationId={o.id} to={o.allowedNext} />
      </section>

      <AuditTrail entries={o.audit} />
    </div>
  );
}
