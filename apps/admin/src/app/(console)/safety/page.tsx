import Link from 'next/link';
import {
  INCIDENT_CATEGORIES,
  INCIDENT_CATEGORY_LABELS,
  INCIDENT_STATES,
  INCIDENT_STATUS_LABELS,
  type IncidentCategory,
  type IncidentStatus,
  SOS_STATES,
  SOS_STATUS_LABELS,
} from '@yatri/types';

import { listAdminIncidents, listAdminSos } from '../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<{ sos?: string; status?: string; category?: string; page?: string }>;
}

const at = (iso: string) => new Date(iso).toLocaleString();

/** SOS alerts (newest open first) and incident reports, for people holding SAFETY_REVIEW. */
export default async function SafetyPage({ searchParams }: PageProps) {
  const accessToken = await requireAdminAccessToken();
  const sp = await searchParams;
  const sosStatus = (SOS_STATES as readonly string[]).includes(sp.sos ?? '') ? sp.sos : undefined;
  const status = (INCIDENT_STATES as readonly string[]).includes(sp.status ?? '')
    ? (sp.status as IncidentStatus)
    : undefined;
  const category = (INCIDENT_CATEGORIES as readonly string[]).includes(sp.category ?? '')
    ? (sp.category as IncidentCategory)
    : undefined;
  const page = Math.max(1, Number(sp.page) || 1);

  const [alerts, reports] = await Promise.all([
    listAdminSos(accessToken, { status: sosStatus, pageSize: PAGE_SIZE }),
    listAdminIncidents(accessToken, { status, category, page, pageSize: PAGE_SIZE }),
  ]);
  const totalPages = Math.max(1, Math.ceil(reports.total / PAGE_SIZE));
  const href = (p: number) =>
    `/safety?${new URLSearchParams({
      ...(sosStatus ? { sos: sosStatus } : {}),
      ...(status ? { status } : {}),
      ...(category ? { category } : {}),
      page: String(p),
    })}`;

  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Safety</h1>
        <Link href="/" style={styles.backLink}>
          ← Dashboard
        </Link>
      </div>

      <section aria-labelledby="sos-h" style={styles.section}>
        <h2 id="sos-h" style={styles.sectionTitle}>
          SOS alerts
        </h2>
        <form method="get" style={styles.filterForm} role="search" aria-label="Filter SOS alerts">
          {status ? <input type="hidden" name="status" value={status} /> : null}
          {category ? <input type="hidden" name="category" value={category} /> : null}
          <div style={styles.field}>
            <label htmlFor="sos" style={styles.label}>
              Status
            </label>
            <select id="sos" name="sos" defaultValue={sosStatus ?? ''} style={styles.select}>
              <option value="">All</option>
              {SOS_STATES.map((s) => (
                <option key={s} value={s}>
                  {SOS_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" style={styles.buttonPrimary}>
            Apply filter
          </button>
        </form>
        {alerts.items.length === 0 ? (
          <p style={styles.emptyState}>No SOS alerts.</p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 8 }}>
            {alerts.items.map((a) => (
              <li key={a.id}>
                <Link href={`/safety/sos/${a.id}`}>
                  {SOS_STATUS_LABELS[a.status]}: {a.role === 'PASSENGER' ? 'passenger' : 'driver'}{' '}
                  {a.userName ?? 'unnamed'}, raised {at(a.createdAt)}
                  {a.locationRecorded ? ', location recorded' : ', no location'}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="inc-h" style={styles.section}>
        <h2 id="inc-h" style={styles.sectionTitle}>
          Incident reports
        </h2>
        <form
          method="get"
          style={styles.filterForm}
          role="search"
          aria-label="Filter incident reports"
        >
          {sosStatus ? <input type="hidden" name="sos" value={sosStatus} /> : null}
          <div style={styles.field}>
            <label htmlFor="status" style={styles.label}>
              Status
            </label>
            <select id="status" name="status" defaultValue={status ?? ''} style={styles.select}>
              <option value="">All</option>
              {INCIDENT_STATES.map((s) => (
                <option key={s} value={s}>
                  {INCIDENT_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div style={styles.field}>
            <label htmlFor="category" style={styles.label}>
              Category
            </label>
            <select
              id="category"
              name="category"
              defaultValue={category ?? ''}
              style={styles.select}
            >
              <option value="">All</option>
              {INCIDENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {INCIDENT_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" style={styles.buttonPrimary}>
            Apply filter
          </button>
        </form>
        {reports.items.length === 0 ? (
          <p style={styles.emptyState}>No incident reports.</p>
        ) : (
          <>
            <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
              {reports.total} report{reports.total === 1 ? '' : 's'}, newest first
            </p>
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 8 }}>
              {reports.items.map((r) => (
                <li key={r.id}>
                  <Link href={`/safety/incidents/${r.id}`}>
                    {INCIDENT_CATEGORY_LABELS[r.category]}: {INCIDENT_STATUS_LABELS[r.status]},
                    reported by {r.reporterRole === 'PASSENGER' ? 'passenger' : 'driver'}{' '}
                    {r.reporterName ?? 'unnamed'} on {at(r.createdAt)}
                  </Link>
                </li>
              ))}
            </ul>
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
      </section>
    </div>
  );
}
