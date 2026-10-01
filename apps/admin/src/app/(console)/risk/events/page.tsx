import Link from 'next/link';
import {
  RISK_CATEGORIES,
  RISK_CATEGORY_LABELS,
  RISK_EVENT_STATUSES,
  RISK_EVENT_STATUS_LABELS,
} from '@yatri/types';

import { listRiskEvents } from '../../../../lib/apiClient';
import { loadOrDenied } from '../../../../lib/access';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../drivers/styles';
import { NoAccess } from '../../ui/NoAccess';
import { Pagination, withParams } from '../../ui/Pagination';
import { EventsTable, RiskNav } from '../parts';

const PAGE_SIZE = 25;

interface PageProps {
  searchParams: Promise<{ status?: string; category?: string; page?: string }>;
}

/** Every risk signal, newest first, filtered by status and kind. */
export default async function RiskEventsPage({ searchParams }: PageProps) {
  const token = await requireAdminAccessToken();
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const status = RISK_EVENT_STATUSES.find((s) => s === sp.status);
  const category = RISK_CATEGORIES.find((c) => c === sp.category);
  const { data, denied } = await loadOrDenied(() =>
    listRiskEvents(token, {
      ...(status ? { status } : {}),
      ...(category ? { category } : {}),
      page,
      pageSize: PAGE_SIZE,
    }),
  );
  if (denied || !data) return <NoAccess what="risk signals" />;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Risk signals</h1>
        <Link href="/risk" style={styles.backLink}>
          ← Overview
        </Link>
      </div>
      <RiskNav />
      <form method="get" style={styles.filterForm} role="search" aria-label="Filter signals">
        <div style={styles.field}>
          <label htmlFor="status" style={styles.label}>
            Status
          </label>
          <select id="status" name="status" defaultValue={status ?? ''} style={styles.select}>
            <option value="">Any status</option>
            {RISK_EVENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {RISK_EVENT_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.field}>
          <label htmlFor="category" style={styles.label}>
            Kind
          </label>
          <select id="category" name="category" defaultValue={category ?? ''} style={styles.select}>
            <option value="">Any kind</option>
            {RISK_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {RISK_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" style={styles.buttonSecondary}>
          Filter
        </button>
      </form>
      <p style={{ margin: 0 }}>{data.total} signals.</p>
      <EventsTable events={data.items} label="Risk signals, newest first" />
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={data.total}
        href={(p) =>
          withParams('/risk/events', {
            page: String(p),
            status: status ?? '',
            category: category ?? '',
          })
        }
      />
    </div>
  );
}
