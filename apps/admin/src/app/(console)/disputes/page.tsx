import Link from 'next/link';
import { DISPUTE_STATUSES } from '@yatri/types';

import { listAdminDisputes } from '../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { ResolveDisputeForm } from '../rides/ActionForms';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<{ status?: string; page?: string }>;
}

const STATUS_TEXT: Record<string, string> = {
  OPEN: 'Open',
  RESOLVED: 'Resolved',
  REJECTED: 'Rejected',
};

/** Problems reported by passengers and drivers, open ones first. */
export default async function DisputesPage({ searchParams }: PageProps) {
  const accessToken = await requireAdminAccessToken();
  const sp = await searchParams;
  const status = (DISPUTE_STATUSES as readonly string[]).includes(sp.status ?? '')
    ? sp.status
    : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const { items, total } = await listAdminDisputes(accessToken, {
    status,
    page,
    pageSize: PAGE_SIZE,
  });
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const href = (p: number) =>
    `/disputes?${new URLSearchParams({ ...(status ? { status } : {}), page: String(p) })}`;

  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Reported problems</h1>
        <Link href="/" style={styles.backLink}>
          ← Dashboard
        </Link>
      </div>

      <form
        method="get"
        style={styles.filterForm}
        role="search"
        aria-label="Filter reported problems"
      >
        <div style={styles.field}>
          <label htmlFor="status" style={styles.label}>
            Status
          </label>
          <select id="status" name="status" defaultValue={status ?? ''} style={styles.select}>
            <option value="">All</option>
            {DISPUTE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_TEXT[s]}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" style={styles.buttonPrimary}>
          Apply filter
        </button>
      </form>

      {items.length === 0 ? (
        <p style={styles.emptyState}>Nothing has been reported.</p>
      ) : (
        <>
          <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
            {total} report{total === 1 ? '' : 's'}, open ones first
          </p>
          {items.map((d) => (
            <article
              key={d.id}
              style={styles.section}
              aria-label={`Report on a ride: ${STATUS_TEXT[d.status]}`}
            >
              <p style={{ margin: 0 }}>
                <strong>{STATUS_TEXT[d.status]}.</strong>{' '}
                {d.raisedByRole === 'PASSENGER' ? 'Passenger' : 'Driver'} reported on{' '}
                {new Date(d.createdAt).toLocaleString()} (passenger {d.passengerName ?? 'unnamed'},
                driver {d.driverName ?? 'unnamed'}):
              </p>
              <p style={{ margin: 0 }}>{d.reason}</p>
              {d.resolution ? <p style={{ margin: 0 }}>Decision: {d.resolution}</p> : null}
              <Link href={`/rides/${d.tripId}`}>Open the ride</Link>
              {d.status === 'OPEN' ? <ResolveDisputeForm disputeId={d.id} /> : null}
            </article>
          ))}
        </>
      )}

      {totalPages > 1 ? (
        <nav style={styles.pagination} aria-label="Pagination">
          {page > 1 ? (
            <Link href={href(page - 1)}>Previous</Link>
          ) : (
            <span aria-hidden="true">Previous</span>
          )}
          <span aria-current="page">
            Page {page} of {totalPages}
          </span>
          {page < totalPages ? (
            <Link href={href(page + 1)}>Next</Link>
          ) : (
            <span aria-hidden="true">Next</span>
          )}
        </nav>
      ) : null}
    </div>
  );
}
