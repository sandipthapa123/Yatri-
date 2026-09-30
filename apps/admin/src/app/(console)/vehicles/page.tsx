import Link from 'next/link';

import { listAdminVehicles, listVehicleCategories } from '../../../lib/apiClient';
import { loadOrDenied } from '../../../lib/access';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { NoAccess } from '../ui/NoAccess';
import { Pagination, withParams } from '../ui/Pagination';
import { SortableTh } from '../ui/SortLink';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<{
    status?: string;
    category?: string;
    expiring?: string;
    search?: string;
    sort?: string;
    page?: string;
  }>;
}

const STATUS_TEXT: Record<string, string> = {
  PENDING: 'Pending review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
};
const oneOf = (v: string | undefined, allowed: string[]) =>
  v && allowed.includes(v) ? v : undefined;

/** Every vehicle: filter by review state, category and papers expiring within 30 days. */
export default async function VehiclesPage({ searchParams }: PageProps) {
  const token = await requireAdminAccessToken();
  const sp = await searchParams;
  const params = {
    status: oneOf(sp.status, Object.keys(STATUS_TEXT)),
    category: sp.category?.trim() || undefined,
    expiring: sp.expiring === 'true' ? 'true' : undefined,
    search: sp.search?.trim() || undefined,
    sort: oneOf(sp.sort, ['newest', 'oldest', 'registration']) ?? 'newest',
  };
  const page = Math.max(1, Number(sp.page) || 1);
  const { data, denied } = await loadOrDenied(async () => {
    const [list, categories] = await Promise.all([
      listAdminVehicles(token, { ...params, page, pageSize: PAGE_SIZE }),
      // Categories come from the settings permission; without it the filter is just a text box.
      listVehicleCategories(token).catch(() => []),
    ]);
    return { list, categories };
  });
  if (denied || !data) return <NoAccess what="vehicles" />;
  const { list, categories } = data;
  const href = (over: Record<string, string | undefined>) =>
    withParams('/vehicles', { ...params, ...over });

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>Vehicles</h1>
      <form method="get" style={styles.filterForm} role="search" aria-label="Filter vehicles">
        <div style={styles.field}>
          <label htmlFor="search" style={styles.label}>
            Search by registration, make, model or owner
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
            Review state
          </label>
          <select
            id="status"
            name="status"
            defaultValue={params.status ?? ''}
            style={styles.select}
          >
            <option value="">All</option>
            {Object.entries(STATUS_TEXT).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
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
            defaultValue={params.category ?? ''}
            style={styles.select}
          >
            <option value="">All</option>
            {categories.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div style={{ ...styles.field, justifyContent: 'flex-end' }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
            <input
              type="checkbox"
              name="expiring"
              value="true"
              defaultChecked={!!params.expiring}
            />
            Papers expiring within 30 days
          </label>
        </div>
        <input type="hidden" name="sort" value={params.sort} />
        <button type="submit" style={styles.buttonPrimary}>
          Apply filters
        </button>
        {params.status || params.category || params.expiring || params.search ? (
          <Link href="/vehicles" style={styles.buttonSecondary}>
            Clear filters
          </Link>
        ) : null}
      </form>

      {list.items.length === 0 ? (
        <p style={styles.emptyState}>No vehicles match these filters.</p>
      ) : (
        <div className="table-scroll">
          <table style={styles.table}>
            <caption style={{ textAlign: 'left', fontSize: 13, marginBottom: 8 }}>
              {list.total} vehicle{list.total === 1 ? '' : 's'}.
            </caption>
            <thead>
              <tr>
                <SortableTh
                  label="Registration"
                  sortKey="registration"
                  current={params.sort}
                  style={styles.th}
                  href={(s) => href({ sort: s, page: undefined })}
                />
                {[
                  'Vehicle',
                  'Category',
                  'Owner',
                  'Review state',
                  'Registration expires',
                  'Insurance expires',
                ].map((h) => (
                  <th key={h} scope="col" style={styles.th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.items.map((v) => (
                <tr key={v.id}>
                  <td style={styles.td}>{v.registrationNumber}</td>
                  <td style={styles.td}>
                    {v.make} {v.model}
                    {v.year ? ` (${v.year})` : ''}
                  </td>
                  <td style={styles.td}>{v.categoryLabel ?? '—'}</td>
                  <td style={styles.td}>
                    <Link href={`/drivers/${v.driverId}`} style={styles.rowLink}>
                      {v.driverName ?? 'Unnamed'}
                    </Link>
                  </td>
                  <td style={styles.td}>
                    {STATUS_TEXT[v.verificationStatus] ?? v.verificationStatus}
                  </td>
                  <td style={styles.td}>{v.registrationExpiryDate ?? '—'}</td>
                  <td style={styles.td}>{v.insuranceExpiryDate ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={list.total}
        href={(p) => href({ page: String(p) })}
      />
      <p style={{ margin: 0 }}>
        Approve or reject a vehicle from its owner&apos;s verification file.
      </p>
    </div>
  );
}
