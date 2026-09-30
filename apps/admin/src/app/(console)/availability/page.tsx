import Link from 'next/link';

import { listDriverAvailability } from '../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../lib/session';
import { STATUS_LABEL, styles } from '../drivers/styles';

const PAGE_SIZE = 20;

const STATE_OPTIONS = ['ONLINE', 'OFFLINE', 'UNAVAILABLE', 'SUSPENDED'] as const;
const FRESHNESS_OPTIONS = [
  ['fresh', 'Fresh'],
  ['stale', 'Stale'],
  ['none', 'No location'],
] as const;
const VERIFICATION_OPTIONS = ['VERIFIED', 'SUSPENDED', 'UNDER_REVIEW', 'SUBMITTED', 'REJECTED'];

interface PageProps {
  searchParams: Promise<{
    search?: string;
    state?: string;
    freshness?: string;
    verification?: string;
    page?: string;
  }>;
}

type Params = { search?: string; state?: string; freshness?: string; verification?: string };

function pageHref(p: Params, page: number): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) qs.set(k, v);
  qs.set('page', String(page));
  return `/availability?${qs.toString()}`;
}

// State and freshness are always shown as words (never colour alone).
const STATE_TEXT: Record<string, string> = {
  ONLINE: 'Online',
  OFFLINE: 'Offline',
  GOING_ONLINE: 'Going online',
  GOING_OFFLINE: 'Going offline',
  UNAVAILABLE: 'Unavailable (location lost)',
  SUSPENDED: 'Suspended',
};
const FRESHNESS_TEXT: Record<string, string> = {
  fresh: 'Fresh',
  stale: 'Stale',
  none: 'No location',
};

export default async function AvailabilityPage({ searchParams }: PageProps) {
  const accessToken = await requireAdminAccessToken();
  const sp = await searchParams;
  const params: Params = {
    search: sp.search?.trim() || undefined,
    state: sp.state || undefined,
    freshness: sp.freshness || undefined,
    verification: sp.verification || undefined,
  };
  const page = Math.max(1, Number(sp.page) || 1);

  const { items, total, canViewLocation } = await listDriverAvailability(accessToken, {
    ...params,
    page,
    pageSize: PAGE_SIZE,
  });
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const anyFilter = Object.values(params).some(Boolean);

  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Driver availability</h1>
        <Link href="/" style={styles.backLink}>
          ← Dashboard
        </Link>
      </div>

      <p style={{ color: 'var(--color-text-secondary)', margin: 0 }}>
        {canViewLocation
          ? 'Exact driver coordinates are shown because you hold the location-view permission. Each view is audited.'
          : 'Exact coordinates are hidden. Ask an administrator for the driver location-view permission if you need them.'}
      </p>

      <form
        method="get"
        style={styles.filterForm}
        role="search"
        aria-label="Filter driver availability"
      >
        <div style={styles.field}>
          <label htmlFor="search" style={styles.label}>
            Search by name or phone
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
          <label htmlFor="state" style={styles.label}>
            Availability
          </label>
          <select id="state" name="state" defaultValue={params.state ?? ''} style={styles.select}>
            <option value="">All</option>
            {STATE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {STATE_TEXT[s]}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.field}>
          <label htmlFor="freshness" style={styles.label}>
            Location freshness
          </label>
          <select
            id="freshness"
            name="freshness"
            defaultValue={params.freshness ?? ''}
            style={styles.select}
          >
            <option value="">All</option>
            {FRESHNESS_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.field}>
          <label htmlFor="verification" style={styles.label}>
            Verification
          </label>
          <select
            id="verification"
            name="verification"
            defaultValue={params.verification ?? ''}
            style={styles.select}
          >
            <option value="">All</option>
            {VERIFICATION_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {STATUS_LABEL[v] ?? v}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" style={styles.buttonPrimary}>
          Apply filters
        </button>
        {anyFilter ? (
          <Link href="/availability" style={styles.buttonSecondary}>
            Clear filters
          </Link>
        ) : null}
      </form>

      {items.length === 0 ? (
        <p style={styles.emptyState}>No drivers match these filters.</p>
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
            {total} driver{total === 1 ? '' : 's'}
          </caption>
          <thead>
            <tr>
              {[
                'Driver',
                'Verification',
                'Availability',
                'Last location',
                'Freshness',
                'Position',
              ].map((h) => (
                <th key={h} style={styles.th} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((d) => (
              <tr key={d.driverId}>
                <td style={styles.td}>
                  <Link href={`/drivers/${d.driverId}`} style={styles.rowLink}>
                    {d.name ?? 'Unnamed driver'}
                  </Link>
                </td>
                <td style={styles.td}>
                  {STATUS_LABEL[d.verificationStatus] ?? d.verificationStatus}
                </td>
                <td style={styles.td}>{STATE_TEXT[d.availabilityState] ?? d.availabilityState}</td>
                <td style={styles.td}>
                  {d.lastLocationAt ? new Date(d.lastLocationAt).toLocaleString() : '—'}
                </td>
                <td style={styles.td}>
                  {d.online || d.lastLocationAt ? FRESHNESS_TEXT[d.locationFreshness] : '—'}
                </td>
                <td style={styles.td}>
                  {d.location
                    ? `${d.location.latitude.toFixed(5)}, ${d.location.longitude.toFixed(5)}${
                        d.location.accuracyMeters !== null
                          ? ` (±${Math.round(d.location.accuracyMeters)} m)`
                          : ''
                      }`
                    : canViewLocation
                      ? '—'
                      : 'Restricted'}
                </td>
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
    </div>
  );
}
