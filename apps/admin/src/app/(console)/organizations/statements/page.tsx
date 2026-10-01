import Link from 'next/link';
import { ORG_STATEMENT_STATUSES, ORG_STATEMENT_STATUS_LABELS, formatNpr } from '@yatri/types';

import { listOrgStatementsApi } from '../../../../lib/apiClient';
import { loadOrDenied } from '../../../../lib/access';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../drivers/styles';
import { NoAccess } from '../../ui/NoAccess';
import { Pagination, withParams } from '../../ui/Pagination';
import { IssueForm } from '../Forms';

const PAGE_SIZE = 25;

interface PageProps {
  searchParams: Promise<{ status?: string; page?: string }>;
}

/** Monthly statements of every organization, newest first. Issuing and recording payment need the manage permission. */
export default async function StatementsPage({ searchParams }: PageProps) {
  const token = await requireAdminAccessToken();
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const status = ORG_STATEMENT_STATUSES.find((s) => s === sp.status);
  const { data, denied } = await loadOrDenied(() =>
    listOrgStatementsApi(token, { ...(status ? { status } : {}), page, pageSize: PAGE_SIZE }),
  );
  if (denied || !data) return <NoAccess what="statements" />;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Statements</h1>
        <Link href="/organizations" style={styles.backLink}>
          ← Organizations
        </Link>
      </div>
      <form method="get" style={styles.filterForm} role="search" aria-label="Filter statements">
        <div style={styles.field}>
          <label htmlFor="status" style={styles.label}>
            Status
          </label>
          <select id="status" name="status" defaultValue={status ?? ''} style={styles.select}>
            <option value="">Any status</option>
            {ORG_STATEMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ORG_STATEMENT_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" style={styles.buttonSecondary}>
          Filter
        </button>
      </form>
      <p style={{ margin: 0 }}>{data.total} statements.</p>
      {data.items.length === 0 ? null : (
        <table style={styles.table}>
          <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>
            Statements, newest first
          </caption>
          <thead>
            <tr>
              {['Statement', 'Organization', 'Month', 'Status', 'Rides', 'Total', 'Due'].map(
                (h) => (
                  <th key={h} scope="col" style={styles.th}>
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {data.items.map((s) => (
              <tr key={s.id}>
                <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                  <Link href={`/organizations/statements/${s.id}`}>Statement {s.number}</Link>
                </th>
                <td style={styles.td}>
                  <Link href={`/organizations/${s.organizationId}`}>{s.organizationName}</Link>
                </td>
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
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={data.total}
        href={(p) =>
          withParams('/organizations/statements', { page: String(p), status: status ?? '' })
        }
      />
      <section aria-labelledby="issue-h" style={styles.section}>
        <h2 id="issue-h" style={styles.sectionTitle}>
          Issue statements
        </h2>
        <p style={{ margin: 0 }}>
          Statements are issued automatically in the first days of each month for the month before.
          Use this to issue one now, or to catch up a month.
        </p>
        <IssueForm />
      </section>
    </div>
  );
}
