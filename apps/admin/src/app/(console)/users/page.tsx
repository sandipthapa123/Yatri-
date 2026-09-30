import { ROLE_LABELS, ACCOUNT_STATUS_LABELS } from '@yatri/types';
import Link from 'next/link';

import { listAdminUsers } from '../../../lib/apiClient';
import { loadOrDenied } from '../../../lib/access';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { NoAccess } from '../ui/NoAccess';
import { Pagination, withParams } from '../ui/Pagination';
import { SortableTh } from '../ui/SortLink';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<{
    role?: string;
    status?: string;
    search?: string;
    sort?: string;
    page?: string;
  }>;
}

const oneOf = (v: string | undefined, allowed: string[]) =>
  v && allowed.includes(v) ? v : undefined;

/** Search, filter, sort and page through every account. Opening one is recorded in the audit log. */
export default async function UsersPage({ searchParams }: PageProps) {
  const token = await requireAdminAccessToken();
  const sp = await searchParams;
  const params = {
    role: oneOf(sp.role, Object.keys(ROLE_LABELS)),
    status: oneOf(sp.status, Object.keys(ACCOUNT_STATUS_LABELS)),
    search: sp.search?.trim() || undefined,
    sort: oneOf(sp.sort, ['newest', 'oldest', 'name']) ?? 'newest',
  };
  const page = Math.max(1, Number(sp.page) || 1);
  const { data, denied } = await loadOrDenied(() =>
    listAdminUsers(token, { ...params, page, pageSize: PAGE_SIZE }),
  );
  if (denied || !data) return <NoAccess what="user accounts" />;
  const href = (over: Record<string, string | undefined>) =>
    withParams('/users', { ...params, ...over });

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>Users</h1>

      <form method="get" style={styles.filterForm} role="search" aria-label="Filter users">
        <div style={styles.field}>
          <label htmlFor="search" style={styles.label}>
            Search by name, phone or email
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
          <label htmlFor="role" style={styles.label}>
            Role
          </label>
          <select id="role" name="role" defaultValue={params.role ?? ''} style={styles.select}>
            <option value="">All</option>
            {Object.entries(ROLE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.field}>
          <label htmlFor="status" style={styles.label}>
            Account status
          </label>
          <select
            id="status"
            name="status"
            defaultValue={params.status ?? ''}
            style={styles.select}
          >
            <option value="">All</option>
            {Object.entries(ACCOUNT_STATUS_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <input type="hidden" name="sort" value={params.sort} />
        <button type="submit" style={styles.buttonPrimary}>
          Apply filters
        </button>
        {params.role || params.status || params.search ? (
          <Link href="/users" style={styles.buttonSecondary}>
            Clear filters
          </Link>
        ) : null}
      </form>

      {data.items.length === 0 ? (
        <p style={styles.emptyState}>No users match these filters.</p>
      ) : (
        <div className="table-scroll">
          <table style={styles.table}>
            <caption style={{ textAlign: 'left', fontSize: 13, marginBottom: 8 }}>
              {data.total} user{data.total === 1 ? '' : 's'}. Sort by using the column headings.
            </caption>
            <thead>
              <tr>
                <SortableTh
                  label="Name"
                  sortKey="name"
                  current={params.sort}
                  style={styles.th}
                  href={(s) => href({ sort: s, page: undefined })}
                />
                <th scope="col" style={styles.th}>
                  Role
                </th>
                <th scope="col" style={styles.th}>
                  Status
                </th>
                <th scope="col" style={styles.th}>
                  Phone or email
                </th>
                <th scope="col" style={styles.th}>
                  Rides completed
                </th>
                <SortableTh
                  label="Joined (newest)"
                  sortKey="newest"
                  current={params.sort}
                  style={styles.th}
                  href={(s) => href({ sort: s, page: undefined })}
                />
              </tr>
            </thead>
            <tbody>
              {data.items.map((u) => (
                <tr key={u.id}>
                  <td style={styles.td}>
                    <Link href={`/users/${u.id}`} style={styles.rowLink}>
                      {u.fullName ?? 'Unnamed'}
                    </Link>
                  </td>
                  <td style={styles.td}>{ROLE_LABELS[u.role]}</td>
                  <td style={styles.td}>{ACCOUNT_STATUS_LABELS[u.status]}</td>
                  <td style={styles.td}>{u.phoneNumber ?? u.email ?? '—'}</td>
                  <td style={styles.td}>{u.ridesCompleted}</td>
                  <td style={styles.td}>{new Date(u.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={data.total}
        href={(p) => href({ page: String(p) })}
      />
    </div>
  );
}
