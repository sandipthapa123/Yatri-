import { formatWhen } from '@yatri/types';
import Link from 'next/link';

import { listAdminAudit } from '../../../lib/apiClient';
import { loadOrDenied } from '../../../lib/access';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { NoAccess } from '../ui/NoAccess';
import { Pagination, withParams } from '../ui/Pagination';
import { RangeFilter, rangeParamsOf } from '../ui/RangeFilter';

const PAGE_SIZE = 30;

interface PageProps {
  searchParams: Promise<{
    range?: string;
    from?: string;
    to?: string;
    action?: string;
    subjectType?: string;
    search?: string;
    page?: string;
  }>;
}

const words = (s: string) => s.replaceAll('_', ' ').toLowerCase();

/** The audit log: who did or looked at what, and when. Reading it is itself recorded. */
export default async function AuditPage({ searchParams }: PageProps) {
  const token = await requireAdminAccessToken();
  const sp = await searchParams;
  const range = rangeParamsOf(sp);
  const action = sp.action?.trim() || undefined;
  const subjectType = sp.subjectType?.trim() || undefined;
  const search = sp.search?.trim() || undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const { data, denied } = await loadOrDenied(() =>
    listAdminAudit(token, { ...range, action, subjectType, search, page, pageSize: PAGE_SIZE }),
  );
  if (denied || !data) return <NoAccess what="the audit log" />;
  const keep = { action, subjectType, search };
  const href = (over: Record<string, string | undefined>) =>
    withParams('/audit', { ...range, ...keep, ...over });

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>Audit log</h1>
      <RangeFilter range={sp.range} from={sp.from} to={sp.to} defaultPreset="7d" keep={keep} />
      <form method="get" style={styles.filterForm} role="search" aria-label="Filter the audit log">
        {Object.entries(range).map(([k, v]) =>
          v ? <input key={k} type="hidden" name={k} value={v} /> : null,
        )}
        <div style={styles.field}>
          <label htmlFor="search" style={styles.label}>
            Search by who did it, or by action
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
          <label htmlFor="action" style={styles.label}>
            Exact action (for example USER_SUSPENDED)
          </label>
          <input id="action" name="action" defaultValue={action ?? ''} style={styles.input} />
        </div>
        <div style={styles.field}>
          <label htmlFor="subjectType" style={styles.label}>
            About (for example user, trip, setting)
          </label>
          <input
            id="subjectType"
            name="subjectType"
            defaultValue={subjectType ?? ''}
            style={styles.input}
          />
        </div>
        <button type="submit" style={styles.buttonPrimary}>
          Apply filters
        </button>
        {action || subjectType || search ? (
          <Link href={withParams('/audit', range)} style={styles.buttonSecondary}>
            Clear filters
          </Link>
        ) : null}
      </form>
      {data.items.length === 0 ? (
        <p style={styles.emptyState}>Nothing was recorded in this period.</p>
      ) : (
        <div className="table-scroll">
          <table style={styles.table}>
            <caption style={{ textAlign: 'left', fontSize: 13, marginBottom: 8 }}>
              {data.total} entr{data.total === 1 ? 'y' : 'ies'}, newest first.
            </caption>
            <thead>
              <tr>
                {['When', 'Who', 'Did', 'About', 'Detail'].map((h) => (
                  <th key={h} scope="col" style={styles.th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.items.map((e) => (
                <tr key={e.id}>
                  <td style={styles.td}>{formatWhen(e.createdAt)}</td>
                  <td style={styles.td}>
                    {e.actorName ?? (e.actorRole ? words(e.actorRole) : 'the system')}
                  </td>
                  <td style={styles.td}>{words(e.action)}</td>
                  <td style={styles.td}>{e.subjectType}</td>
                  <td style={styles.td}>
                    {Object.entries(e.detail)
                      .map(
                        ([k, v]) =>
                          `${words(k)}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`,
                      )
                      .join('; ') || '—'}
                  </td>
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
