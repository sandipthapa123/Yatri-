import { ROLE_LABELS, formatWhen } from '@yatri/types';
import Link from 'next/link';

import { getNotificationSummary, listAdminNotifications } from '../../../lib/apiClient';
import { loadOrDenied } from '../../../lib/access';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { NoAccess } from '../ui/NoAccess';
import { Pagination, withParams } from '../ui/Pagination';
import { RangeFilter, rangeParamsOf } from '../ui/RangeFilter';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<{
    range?: string;
    from?: string;
    to?: string;
    type?: string;
    read?: string;
    search?: string;
    page?: string;
  }>;
}

/**
 * What the platform has sent, by type and when. The message text is never shown here (it can hold
 * places, names or fares); operations can see that notifications are flowing and being read.
 * How often they are sent is a setting (Settings, Notification settings).
 */
export default async function NotificationsPage({ searchParams }: PageProps) {
  const token = await requireAdminAccessToken();
  const sp = await searchParams;
  const range = rangeParamsOf(sp);
  const type = sp.type?.trim() || undefined;
  const read = sp.read === 'true' || sp.read === 'false' ? sp.read : undefined;
  const search = sp.search?.trim() || undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const { data, denied } = await loadOrDenied(async () => {
    const [summary, list] = await Promise.all([
      getNotificationSummary(token, range),
      listAdminNotifications(token, { ...range, type, read, search, page, pageSize: PAGE_SIZE }),
    ]);
    return { summary, list };
  });
  if (denied || !data) return <NoAccess what="notification monitoring" />;
  const { summary, list } = data;
  const keep = { type, read, search };
  const href = (over: Record<string, string | undefined>) =>
    withParams('/notifications', { ...range, ...keep, ...over });

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>Notifications</h1>
      <RangeFilter
        range={sp.range}
        from={sp.from}
        to={sp.to}
        defaultPreset="7d"
        keep={keep}
        resolved={summary.range}
      />

      <section aria-labelledby="sum-h" style={styles.section}>
        <h2 id="sum-h" style={styles.sectionTitle}>
          Summary
        </h2>
        <dl style={styles.definitionList}>
          <dt style={styles.dt}>Sent</dt>
          <dd style={styles.dd}>{summary.total}</dd>
          <dt style={styles.dt}>Read</dt>
          <dd style={styles.dd}>{summary.read}</dd>
          <dt style={styles.dt}>Not read</dt>
          <dd style={styles.dd}>{summary.unread}</dd>
        </dl>
        {summary.byType.length > 0 ? (
          <div className="table-scroll">
            <table style={styles.table}>
              <caption style={{ textAlign: 'left', fontSize: 13, marginBottom: 8 }}>
                By type
              </caption>
              <thead>
                <tr>
                  <th scope="col" style={styles.th}>
                    Type
                  </th>
                  <th scope="col" style={styles.th}>
                    Sent
                  </th>
                </tr>
              </thead>
              <tbody>
                {summary.byType.map((t) => (
                  <tr key={t.type}>
                    <td style={styles.td}>
                      <Link href={href({ type: t.type, page: undefined })} style={styles.rowLink}>
                        {t.type}
                      </Link>
                    </td>
                    <td style={styles.td}>{t.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="list-h" style={styles.section}>
        <h2 id="list-h" style={styles.sectionTitle}>
          Sent notifications
        </h2>
        <form
          method="get"
          style={styles.filterForm}
          role="search"
          aria-label="Filter notifications"
        >
          {Object.entries(range).map(([k, v]) =>
            v ? <input key={k} type="hidden" name={k} value={v} /> : null,
          )}
          <div style={styles.field}>
            <label htmlFor="search" style={styles.label}>
              Search by recipient name or type
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
            <label htmlFor="type" style={styles.label}>
              Type
            </label>
            <input id="type" name="type" defaultValue={type ?? ''} style={styles.input} />
          </div>
          <div style={styles.field}>
            <label htmlFor="read" style={styles.label}>
              Read?
            </label>
            <select id="read" name="read" defaultValue={read ?? ''} style={styles.select}>
              <option value="">Either</option>
              <option value="true">Read</option>
              <option value="false">Not read</option>
            </select>
          </div>
          <button type="submit" style={styles.buttonPrimary}>
            Apply filters
          </button>
        </form>
        {list.items.length === 0 ? (
          <p style={styles.emptyState}>No notifications match.</p>
        ) : (
          <div className="table-scroll">
            <table style={styles.table}>
              <caption style={{ textAlign: 'left', fontSize: 13, marginBottom: 8 }}>
                {list.total} notification{list.total === 1 ? '' : 's'}, newest first.
              </caption>
              <thead>
                <tr>
                  {['Sent', 'Type', 'Title', 'Recipient', 'Read?'].map((h) => (
                    <th key={h} scope="col" style={styles.th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.items.map((n) => (
                  <tr key={n.id}>
                    <td style={styles.td}>{formatWhen(n.createdAt)}</td>
                    <td style={styles.td}>{n.type}</td>
                    <td style={styles.td}>{n.title}</td>
                    <td style={styles.td}>
                      {n.userName ?? 'Unnamed'}
                      {n.userRole ? ` (${ROLE_LABELS[n.userRole].toLowerCase()})` : ''}
                    </td>
                    <td style={styles.td}>{n.read ? 'Read' : 'Not read'}</td>
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
      </section>
    </div>
  );
}
