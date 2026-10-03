import { formatWhen } from '@yatri/types';
import Link from 'next/link';
import type { DriverStatus } from '@yatri/shared';

import { listAdminDrivers } from '../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../lib/session';
import { StatusBadge } from './StatusBadge';
import { STATUS_LABEL, styles } from './styles';

const STATUS_OPTIONS: DriverStatus[] = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'SUBMITTED',
  'UNDER_REVIEW',
  'VERIFIED',
  'REJECTED',
  'SUSPENDED',
];

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<{ search?: string; status?: string; page?: string }>;
}

function buildPageHref(params: { search?: string; status?: string }, page: number): string {
  const qs = new URLSearchParams();
  if (params.search) qs.set('search', params.search);
  if (params.status) qs.set('status', params.status);
  qs.set('page', String(page));
  return `/drivers?${qs.toString()}`;
}

export default async function DriversPage({ searchParams }: PageProps) {
  const accessToken = await requireAdminAccessToken();
  const params = await searchParams;
  const search = params.search?.trim() || undefined;
  const status = (params.status as DriverStatus | undefined) || undefined;
  const page = Math.max(1, Number(params.page) || 1);

  const { items, total } = await listAdminDrivers(accessToken, {
    search,
    status,
    page,
    pageSize: PAGE_SIZE,
  });
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Driver applications</h1>
        <Link href="/" style={styles.backLink}>
          ← Dashboard
        </Link>
      </div>

      <form
        method="get"
        style={styles.filterForm}
        role="search"
        aria-label="Filter driver applications"
      >
        <div style={styles.field}>
          <label htmlFor="search" style={styles.label}>
            Search by name or phone
          </label>
          <input
            id="search"
            name="search"
            type="search"
            defaultValue={search ?? ''}
            style={styles.input}
          />
        </div>
        <div style={styles.field}>
          <label htmlFor="status" style={styles.label}>
            Status
          </label>
          <select id="status" name="status" defaultValue={status ?? ''} style={styles.select}>
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" style={styles.buttonPrimary}>
          Apply filters
        </button>
        {search || status ? (
          <Link href="/drivers" style={styles.buttonSecondary}>
            Clear filters
          </Link>
        ) : null}
      </form>

      {items.length === 0 ? (
        <p style={styles.emptyState}>No driver applications match these filters.</p>
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
            {total} application{total === 1 ? '' : 's'}
          </caption>
          <thead>
            <tr>
              <th style={styles.th} scope="col">
                Name
              </th>
              <th style={styles.th} scope="col">
                Phone
              </th>
              <th style={styles.th} scope="col">
                Status
              </th>
              <th style={styles.th} scope="col">
                Submitted
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((driver) => (
              <tr key={driver.id}>
                <td style={styles.td}>
                  <Link href={`/drivers/${driver.id}`} style={styles.rowLink}>
                    {driver.fullName ?? 'Unnamed driver'}
                  </Link>
                </td>
                <td style={styles.td}>{driver.phoneNumber ?? '—'}</td>
                <td style={styles.td}>
                  <StatusBadge status={driver.driverStatus} />
                </td>
                <td style={styles.td}>
                  {driver.submittedAt ? formatWhen(driver.submittedAt, { style: 'date' }) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {totalPages > 1 ? (
        <nav style={styles.pagination} aria-label="Pagination">
          {page > 1 ? (
            <Link href={buildPageHref(params, page - 1)}>Previous</Link>
          ) : (
            <span aria-hidden="true">Previous</span>
          )}
          <span aria-current="page">
            Page {page} of {totalPages}
          </span>
          {page < totalPages ? (
            <Link href={buildPageHref(params, page + 1)}>Next</Link>
          ) : (
            <span aria-hidden="true">Next</span>
          )}
        </nav>
      ) : null}
    </div>
  );
}
