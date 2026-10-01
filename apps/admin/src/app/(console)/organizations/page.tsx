import Link from 'next/link';
import { ORG_STATUSES, ORG_STATUS_LABELS, formatNpr } from '@yatri/types';

import { listOrganizationsApi } from '../../../lib/apiClient';
import { loadOrDenied } from '../../../lib/access';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { NoAccess } from '../ui/NoAccess';
import { Pagination, withParams } from '../ui/Pagination';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<{ status?: string; search?: string; page?: string }>;
}

/** Business accounts: who they are, how many people, this month's rides and spend, and what is still owed. */
export default async function OrganizationsPage({ searchParams }: PageProps) {
  const token = await requireAdminAccessToken();
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const status = ORG_STATUSES.find((s) => s === sp.status);
  const { data, denied } = await loadOrDenied(() =>
    listOrganizationsApi(token, {
      ...(status ? { status } : {}),
      ...(sp.search ? { search: sp.search } : {}),
      page,
      pageSize: PAGE_SIZE,
    }),
  );
  if (denied || !data) return <NoAccess what="business accounts" />;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Business accounts</h1>
        <Link href="/" style={styles.backLink}>
          ← Dashboard
        </Link>
      </div>
      <nav aria-label="Business sections" style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <Link href="/organizations">Organizations</Link>
        <Link href="/organizations/statements">Statements</Link>
        <Link href="/organizations/statements?status=ISSUED">Statements awaiting payment</Link>
      </nav>
      <form method="get" style={styles.filterForm} role="search" aria-label="Filter organizations">
        <div style={styles.field}>
          <label htmlFor="status" style={styles.label}>
            Status
          </label>
          <select id="status" name="status" defaultValue={status ?? ''} style={styles.select}>
            <option value="">Any status</option>
            {ORG_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ORG_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.field}>
          <label htmlFor="search" style={styles.label}>
            Name
          </label>
          <input id="search" name="search" defaultValue={sp.search ?? ''} style={styles.input} />
        </div>
        <button type="submit" style={styles.buttonSecondary}>
          Filter
        </button>
      </form>
      <p style={{ margin: 0 }}>{data.total} organizations.</p>
      {data.items.length === 0 ? null : (
        <table style={styles.table}>
          <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>
            Business accounts
          </caption>
          <thead>
            <tr>
              {[
                'Organization',
                'Status',
                'Members',
                'Rides this month',
                'Spend this month',
                'Owed, not yet paid',
              ].map((h) => (
                <th key={h} scope="col" style={styles.th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.items.map((o) => (
              <tr key={o.id}>
                <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                  <Link href={`/organizations/${o.id}`}>{o.name}</Link>
                </th>
                <td style={styles.td}>{ORG_STATUS_LABELS[o.status]}</td>
                <td style={styles.td}>{o.members}</td>
                <td style={styles.td}>{o.ridesThisMonth}</td>
                <td style={styles.td}>{formatNpr(o.spendThisMonthNpr)}</td>
                <td style={styles.td}>{formatNpr(o.outstandingNpr)}</td>
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
          withParams('/organizations', {
            page: String(p),
            status: status ?? '',
            search: sp.search ?? '',
          })
        }
      />
    </div>
  );
}
