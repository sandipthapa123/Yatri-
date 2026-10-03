import Link from 'next/link';
import { TICKET_STATUSES, TICKET_STATUS_LABELS, formatWhen } from '@yatri/types';

import { getSupportConfig, listAdminTickets } from '../../../lib/apiClient';
import { loadOrDenied } from '../../../lib/access';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { NoAccess } from '../ui/NoAccess';
import { Pagination, withParams } from '../ui/Pagination';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

const at = (iso: string) => formatWhen(iso);

/**
 * The support queue: every ticket and ride problem, the most urgent and oldest unresolved first. Filters
 * and search work without scripts (a plain form), and each row says its state in words, never by colour.
 * What an administrator sees here is decided by the API from their permissions.
 */
export default async function SupportQueuePage({ searchParams }: PageProps) {
  const token = await requireAdminAccessToken();
  const sp = await searchParams;
  const status = (TICKET_STATUSES as readonly string[]).includes(sp.status ?? '')
    ? sp.status
    : undefined;
  const group = ['open', 'awaiting', 'finished'].includes(sp.group ?? '') ? sp.group : undefined;
  const kind = sp.kind === 'dispute' || sp.kind === 'general' ? sp.kind : undefined;
  const overdue = sp.overdue === 'true' ? 'true' : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const params = {
    status,
    group,
    kind,
    overdue,
    priority: sp.priority || undefined,
    category: sp.category || undefined,
    assigned: sp.assigned || undefined,
    search: sp.search?.trim() || undefined,
  };

  const { data, denied } = await loadOrDenied(async () => {
    const [list, config] = await Promise.all([
      listAdminTickets(token, { ...params, page, pageSize: PAGE_SIZE }),
      // Priorities and categories are data; a viewer without settings access just gets no choices.
      getSupportConfig(token).catch(() => ({ categories: [], priorities: [] })),
    ]);
    return { list, config };
  });
  if (denied || !data) return <NoAccess what="support tickets" />;
  const { list, config } = data;
  const href = (p: number) => withParams('/support', { ...params, page: String(p) });

  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Support</h1>
        <Link href="/" style={styles.backLink}>
          ← Dashboard
        </Link>
      </div>

      <form
        method="get"
        style={styles.filterForm}
        role="search"
        aria-label="Filter support tickets"
      >
        <div style={styles.field}>
          <label htmlFor="search" style={styles.label}>
            Search (number, title, name or phone)
          </label>
          <input
            id="search"
            name="search"
            defaultValue={params.search ?? ''}
            style={styles.input}
          />
        </div>
        <div style={styles.field}>
          <label htmlFor="group" style={styles.label}>
            Show
          </label>
          <select id="group" name="group" defaultValue={group ?? ''} style={styles.select}>
            <option value="">Everything</option>
            <option value="open">Not yet resolved</option>
            <option value="awaiting">Waiting on us</option>
            <option value="finished">Resolved or closed</option>
          </select>
        </div>
        <div style={styles.field}>
          <label htmlFor="status" style={styles.label}>
            Status
          </label>
          <select id="status" name="status" defaultValue={status ?? ''} style={styles.select}>
            <option value="">Any</option>
            {TICKET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {TICKET_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.field}>
          <label htmlFor="kind" style={styles.label}>
            Kind
          </label>
          <select id="kind" name="kind" defaultValue={kind ?? ''} style={styles.select}>
            <option value="">All</option>
            <option value="dispute">Ride problems</option>
            <option value="general">General requests</option>
          </select>
        </div>
        <div style={styles.field}>
          <label htmlFor="priority" style={styles.label}>
            Priority
          </label>
          <select
            id="priority"
            name="priority"
            defaultValue={params.priority ?? ''}
            style={styles.select}
          >
            <option value="">Any</option>
            {config.priorities.map((p) => (
              <option key={p.code} value={p.code}>
                {p.label}
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
            <option value="">Any</option>
            {config.categories.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.field}>
          <label htmlFor="assigned" style={styles.label}>
            Assigned
          </label>
          <select
            id="assigned"
            name="assigned"
            defaultValue={params.assigned ?? ''}
            style={styles.select}
          >
            <option value="">Anyone</option>
            <option value="me">To me</option>
            <option value="none">Nobody</option>
          </select>
        </div>
        <div style={styles.field}>
          <label htmlFor="overdue" style={styles.label}>
            Late answers
          </label>
          <select id="overdue" name="overdue" defaultValue={overdue ?? ''} style={styles.select}>
            <option value="">All</option>
            <option value="true">Only late ones</option>
          </select>
        </div>
        <button type="submit" style={styles.buttonPrimary}>
          Apply filters
        </button>
      </form>

      {list.items.length === 0 ? (
        <p style={styles.emptyState}>No tickets match.</p>
      ) : (
        <>
          <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
            {list.total} ticket{list.total === 1 ? '' : 's'}, most urgent first
          </p>
          <table style={styles.table}>
            <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>
              Support tickets
            </caption>
            <thead>
              <tr>
                {[
                  'Number',
                  'Title',
                  'Person',
                  'Status',
                  'Priority',
                  'Assigned',
                  'Answer due',
                  'Opened',
                ].map((h) => (
                  <th key={h} scope="col" style={styles.th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.items.map((t) => (
                <tr key={t.id}>
                  <td style={styles.td}>#{t.number}</td>
                  <td style={styles.td}>
                    <Link href={`/support/${t.id}`}>{t.subject}</Link>
                    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                      {t.isDispute ? 'Ride problem: ' : ''}
                      {t.categoryLabel}
                    </div>
                  </td>
                  <td style={styles.td}>
                    {t.requesterName ?? 'Unnamed'} ({t.requesterRole.toLowerCase()})
                  </td>
                  <td style={styles.td}>{TICKET_STATUS_LABELS[t.status]}</td>
                  <td style={styles.td}>
                    {t.priorityLabel}
                    {t.escalationLevel > 0 ? ` (escalated ${t.escalationLevel}×)` : ''}
                  </td>
                  <td style={styles.td}>{t.assignedToName ?? 'Nobody'}</td>
                  <td style={styles.td}>
                    {t.responseDueAt
                      ? t.overdue
                        ? `Late: was due ${at(t.responseDueAt)}`
                        : at(t.responseDueAt)
                      : '—'}
                  </td>
                  <td style={styles.td}>{at(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <Pagination page={page} pageSize={PAGE_SIZE} total={list.total} href={href} />
    </div>
  );
}
