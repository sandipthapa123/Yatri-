import Link from 'next/link';
import { TRIP_STATUSES, TRIP_STATUS_LABELS, type TripStatus } from '@yatri/types';

import { listAdminTrips } from '../../lib/apiClient';
import { requireAdminAccessToken } from '../../lib/session';
import { styles } from '../drivers/styles';
import { AutoRefresh } from './AutoRefresh';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<{ status?: string; search?: string; page?: string }>;
}

type Params = { status?: string; search?: string };

function pageHref(p: Params, page: number): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) qs.set(k, v);
  qs.set('page', String(page));
  return `/rides?${qs.toString()}`;
}

const isStatus = (s: string | undefined): s is TripStatus =>
  !!s && (TRIP_STATUSES as readonly string[]).includes(s);

const PAYMENT_TEXT: Record<string, string> = {
  NONE: 'No payment yet',
  PENDING: 'Awaiting cash',
  PAID: 'Paid',
  FAILED: 'Failed',
  VOID: 'Not due',
};

/** All rides, live ones first. Every figure and state comes from the same API the apps use. */
export default async function RidesPage({ searchParams }: PageProps) {
  const accessToken = await requireAdminAccessToken();
  const sp = await searchParams;
  const params: Params = {
    status: isStatus(sp.status) ? sp.status : undefined,
    search: sp.search?.trim() || undefined,
  };
  const page = Math.max(1, Number(sp.page) || 1);
  const { items, total } = await listAdminTrips(accessToken, {
    ...params,
    page,
    pageSize: PAGE_SIZE,
  });
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const anyFilter = Object.values(params).some(Boolean);

  return (
    <main style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Rides</h1>
        <Link href="/" style={styles.backLink}>
          ← Dashboard
        </Link>
      </div>

      <AutoRefresh />

      <form method="get" style={styles.filterForm} role="search" aria-label="Filter rides">
        <div style={styles.field}>
          <label htmlFor="search" style={styles.label}>
            Search by passenger or driver name or phone
          </label>
          <input
            id="search"
            name="search"
            type="search"
            defaultValue={params.search ?? ''}
            style={styles.input}
          />
        </div>
        <div style={styles.field}>
          <label htmlFor="status" style={styles.label}>
            Status
          </label>
          <select
            id="status"
            name="status"
            defaultValue={params.status ?? ''}
            style={styles.select}
          >
            <option value="">All</option>
            {TRIP_STATUSES.map((s) => (
              <option key={s} value={s}>
                {TRIP_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" style={styles.buttonPrimary}>
          Apply filters
        </button>
        {anyFilter ? (
          <Link href="/rides" style={styles.buttonSecondary}>
            Clear filters
          </Link>
        ) : null}
      </form>

      {items.length === 0 ? (
        <p style={styles.emptyState}>No rides match these filters.</p>
      ) : (
        <table style={styles.table}>
          <caption
            style={{
              textAlign: 'left',
              fontSize: 13,
              color: 'var(--color-text-secondary)',
              marginBottom: 8,
              captionSide: 'top',
            }}
          >
            {total} ride{total === 1 ? '' : 's'}, live rides first
          </caption>
          <thead>
            <tr>
              {['Requested', 'Status', 'Passenger', 'Driver', 'Route', 'Payment', 'Disputes'].map(
                (h) => (
                  <th key={h} style={styles.th} scope="col">
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {items.map((t) => (
              <tr key={t.id}>
                <td style={styles.td}>
                  <Link href={`/rides/${t.id}`} style={styles.rowLink}>
                    {new Date(t.requestedAt).toLocaleString()}
                  </Link>
                </td>
                <td style={styles.td}>{TRIP_STATUS_LABELS[t.status]}</td>
                <td style={styles.td}>{t.passengerName ?? 'Unnamed'}</td>
                <td style={styles.td}>{t.driverName ?? '—'}</td>
                <td style={styles.td}>
                  {t.pickupName} to {t.destinationName}
                </td>
                <td style={styles.td}>{PAYMENT_TEXT[t.paymentStatus] ?? t.paymentStatus}</td>
                <td style={styles.td}>{t.openDisputes > 0 ? `${t.openDisputes} open` : 'None'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {totalPages > 1 ? (
        <nav style={styles.pagination} aria-label="Pagination">
          {page > 1 ? (
            <Link href={pageHref(params, page - 1)}>Previous</Link>
          ) : (
            <span aria-hidden="true">Previous</span>
          )}
          <span aria-current="page">
            Page {page} of {totalPages}
          </span>
          {page < totalPages ? (
            <Link href={pageHref(params, page + 1)}>Next</Link>
          ) : (
            <span aria-hidden="true">Next</span>
          )}
        </nav>
      ) : null}
    </main>
  );
}
