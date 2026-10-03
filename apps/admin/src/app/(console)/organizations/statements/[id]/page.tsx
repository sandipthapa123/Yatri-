import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ORG_STATEMENT_STATUS_LABELS, formatNpr, formatWhen } from '@yatri/types';

import { ApiError, getOrgStatementApi } from '../../../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../../../lib/session';
import { styles } from '../../../drivers/styles';
import { PaidForm, VoidForm } from '../../Forms';

interface PageProps {
  params: Promise<{ id: string }>;
}

const caption = { textAlign: 'left', position: 'absolute', left: -9999 } as const;

/** One statement: the rides on it with who booked and who rode, the total by cost centre, and how it is settled. */
export default async function StatementPage({ params }: PageProps) {
  const token = await requireAdminAccessToken();
  const { id } = await params;
  let s;
  try {
    s = await getOrgStatementApi(token, id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>
          Statement {s.number}: {s.organizationName}
        </h1>
        <Link href="/organizations/statements" style={styles.backLink}>
          ← Statements
        </Link>
      </div>

      <section aria-labelledby="sum-h" style={styles.section}>
        <h2 id="sum-h" style={styles.sectionTitle}>
          Summary
        </h2>
        <p style={{ margin: 0 }}>
          <strong>{ORG_STATEMENT_STATUS_LABELS[s.status]}.</strong> Month {s.periodKey}. {s.rides}{' '}
          rides, total {formatNpr(s.totalNpr)}. Issued {formatWhen(s.issuedAt, { style: 'date' })},
          due {s.dueOn}.
          {s.paidAt
            ? ` Paid ${formatWhen(s.paidAt, { style: 'date' })}, reference ${s.paidReference ?? 'none'}.`
            : ''}
        </p>
        <Link href={`/organizations/${s.organizationId}`}>Open the organization</Link>
      </section>

      <section aria-labelledby="cc-h" style={styles.section}>
        <h2 id="cc-h" style={styles.sectionTitle}>
          By cost centre
        </h2>
        <table style={styles.table}>
          <caption style={caption}>Totals by cost centre</caption>
          <thead>
            <tr>
              {['Cost centre', 'Rides', 'Total'].map((h) => (
                <th key={h} scope="col" style={styles.th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.byCostCenter.map((g) => (
              <tr key={g.code ?? 'none'}>
                <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                  {g.code ? `${g.code}, ${g.name ?? ''}` : 'No cost centre'}
                </th>
                <td style={styles.td}>{g.rides}</td>
                <td style={styles.td}>{formatNpr(g.totalNpr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="lines-h" style={styles.section}>
        <h2 id="lines-h" style={styles.sectionTitle}>
          Rides
        </h2>
        <table style={styles.table}>
          <caption style={caption}>Rides on this statement</caption>
          <thead>
            <tr>
              {['Ride', 'Ended', 'Rider', 'Booked by', 'Cost centre', 'Purpose', 'Amount'].map(
                (h) => (
                  <th key={h} scope="col" style={styles.th}>
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {s.lines.map((l) => (
              <tr key={l.tripId}>
                <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                  <Link href={`/rides/${l.tripId}`}>{l.tripId.slice(0, 8)}</Link>
                </th>
                <td style={styles.td}>{l.endedAt ? formatWhen(l.endedAt) : '—'}</td>
                <td style={styles.td}>{l.passengerName ?? 'Unnamed'}</td>
                <td style={styles.td}>{l.bookedByName ?? '—'}</td>
                <td style={styles.td}>{l.costCenterCode ?? '—'}</td>
                <td style={styles.td}>{l.purpose ?? '—'}</td>
                <td style={styles.td}>{formatNpr(l.amountNpr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {s.status === 'ISSUED' ? (
        <>
          <section aria-labelledby="paid-h" style={styles.section}>
            <h2 id="paid-h" style={styles.sectionTitle}>
              Record payment
            </h2>
            <PaidForm statementId={s.id} totalNpr={s.totalNpr} />
          </section>
          <section aria-labelledby="void-h" style={styles.section}>
            <h2 id="void-h" style={styles.sectionTitle}>
              Cancel the statement
            </h2>
            <VoidForm statementId={s.id} />
          </section>
        </>
      ) : null}
    </div>
  );
}
