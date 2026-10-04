import Link from 'next/link';
import {
  describePayment,
  formatNpr,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUSES,
  type PaymentMethod,
  formatWhen,
} from '@yatri/types';

import { getFinanceSummary, listAdminPayments, listDriverEarnings } from '../../../lib/apiClient';
import { loadOrDenied } from '../../../lib/access';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { NoAccess } from '../ui/NoAccess';
import { Pagination, withParams } from '../ui/Pagination';
import { RangeFilter, rangeParamsOf } from '../ui/RangeFilter';
import { SortableTh } from '../ui/SortLink';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<{
    range?: string;
    from?: string;
    to?: string;
    status?: string;
    search?: string;
    sort?: string;
    esort?: string;
    page?: string;
  }>;
}

const oneOf = (v: string | undefined, allowed: readonly string[]) =>
  v && allowed.includes(v) ? v : undefined;

/**
 * Money, read-only: payments, what was collected, and what each driver earned. Yatri takes cash and
 * holds none, so there are no wallets or payouts; the summary says so rather than showing empty
 * tables. Every visit is written to the audit log.
 */
export default async function PaymentsPage({ searchParams }: PageProps) {
  const token = await requireAdminAccessToken();
  const sp = await searchParams;
  const range = rangeParamsOf(sp);
  const status = oneOf(sp.status, PAYMENT_STATUSES);
  const search = sp.search?.trim() || undefined;
  const sort = oneOf(sp.sort, ['newest', 'oldest', 'amount']) ?? 'newest';
  const esort = oneOf(sp.esort, ['earned', 'rides', 'name']) ?? 'earned';
  const page = Math.max(1, Number(sp.page) || 1);

  const { data, denied } = await loadOrDenied(async () => {
    const [summary, payments, earnings] = await Promise.all([
      getFinanceSummary(token, range),
      listAdminPayments(token, { ...range, status, search, sort, page, pageSize: PAGE_SIZE }),
      listDriverEarnings(token, { ...range, sort: esort, pageSize: 10 }),
    ]);
    return { summary, payments, earnings };
  });
  if (denied || !data) return <NoAccess what="financial data" />;
  const { summary, payments, earnings } = data;
  const keep = { status, search, sort, esort };
  const href = (over: Record<string, string | undefined>) =>
    withParams('/payments', { ...range, ...keep, ...over });

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>Payments and earnings</h1>
      <RangeFilter
        range={sp.range}
        from={sp.from}
        to={sp.to}
        defaultPreset="30d"
        keep={keep}
        resolved={summary.range}
      />

      <section aria-labelledby="sum-h" style={styles.section}>
        <h2 id="sum-h" style={styles.sectionTitle}>
          Summary
        </h2>
        <dl style={styles.definitionList}>
          <dt style={styles.dt}>Fares of completed rides</dt>
          <dd style={styles.dd}>{formatNpr(summary.grossFaresNpr)}</dd>
          <dt style={styles.dt}>Payments confirmed as received (cash and online)</dt>
          <dd style={styles.dd}>{formatNpr(summary.collectedNpr)}</dd>
          <dt style={styles.dt}>Not yet confirmed</dt>
          <dd style={styles.dd}>{formatNpr(summary.outstandingNpr)}</dd>
          <dt style={styles.dt}>Cancellation fees recorded</dt>
          <dd style={styles.dd}>{formatNpr(summary.cancellationFeesNpr)}</dd>
          {PAYMENT_STATUSES.map((s) => (
            <div key={s} style={{ display: 'contents' }}>
              <dt style={styles.dt}>Payments: {PAYMENT_STATUS_LABELS[s]}</dt>
              <dd style={styles.dd}>
                {summary.byStatus[s].count} ({formatNpr(summary.byStatus[s].amountNpr)})
              </dd>
            </div>
          ))}
          <dt style={styles.dt}>Wallets</dt>
          <dd style={styles.dd}>{summary.wallets.reason}</dd>
          <dt style={styles.dt}>Online payments collected</dt>
          <dd style={styles.dd}>{formatNpr(summary.onlineCollectedNpr)}</dd>
          <dt style={styles.dt}>Online payments refunded</dt>
          <dd style={styles.dd}>{formatNpr(summary.onlineRefundedNpr)}</dd>
          <dt style={styles.dt}>Owed to drivers and ready to pay out</dt>
          <dd style={styles.dd}>{formatNpr(summary.payouts.readyNpr)}</dd>
          <dt style={styles.dt}>In a payout being prepared or sent</dt>
          <dd style={styles.dd}>{formatNpr(summary.payouts.inPayoutNpr)}</dd>
          <dt style={styles.dt}>Paid out to drivers</dt>
          <dd style={styles.dd}>
            {formatNpr(summary.payouts.paidNpr)}. <Link href="/payouts">Driver payouts</Link>
          </dd>
        </dl>
      </section>

      <section aria-labelledby="earn-h" style={styles.section}>
        <h2 id="earn-h" style={styles.sectionTitle}>
          Driver earnings (top 10)
        </h2>
        {earnings.items.length === 0 ? (
          <p style={styles.emptyState}>No completed rides in this period.</p>
        ) : (
          <div className="table-scroll">
            <table style={styles.table}>
              <caption style={{ textAlign: 'left', fontSize: 13, marginBottom: 8 }}>
                {earnings.total} driver{earnings.total === 1 ? '' : 's'} earned in this period.
              </caption>
              <thead>
                <tr>
                  <SortableTh
                    label="Driver"
                    sortKey="name"
                    current={esort}
                    style={styles.th}
                    href={(s) => href({ esort: s })}
                  />
                  <SortableTh
                    label="Rides"
                    sortKey="rides"
                    current={esort}
                    style={styles.th}
                    href={(s) => href({ esort: s })}
                  />
                  <SortableTh
                    label="Earned"
                    sortKey="earned"
                    current={esort}
                    style={styles.th}
                    href={(s) => href({ esort: s })}
                  />
                  <th scope="col" style={styles.th}>
                    Payments confirmed
                  </th>
                  <th scope="col" style={styles.th}>
                    Not yet confirmed
                  </th>
                </tr>
              </thead>
              <tbody>
                {earnings.items.map((e) => (
                  <tr key={e.driverId}>
                    <td style={styles.td}>
                      <Link href={`/users/${e.driverId}`} style={styles.rowLink}>
                        {e.driverName ?? 'Unnamed'}
                      </Link>
                    </td>
                    <td style={styles.td}>{e.rides}</td>
                    <td style={styles.td}>{formatNpr(e.earnedNpr)}</td>
                    <td style={styles.td}>{formatNpr(e.collectedNpr)}</td>
                    <td style={styles.td}>{formatNpr(e.outstandingNpr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="pay-h" style={styles.section}>
        <h2 id="pay-h" style={styles.sectionTitle}>
          Payments
        </h2>
        <form method="get" style={styles.filterForm} role="search" aria-label="Filter payments">
          {Object.entries(range).map(([k, v]) =>
            v ? <input key={k} type="hidden" name={k} value={v} /> : null,
          )}
          <input type="hidden" name="esort" value={esort} />
          <div style={styles.field}>
            <label htmlFor="search" style={styles.label}>
              Search by passenger or driver name or phone
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
              Payment status
            </label>
            <select id="status" name="status" defaultValue={status ?? ''} style={styles.select}>
              <option value="">All</option>
              {PAYMENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PAYMENT_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div style={styles.field}>
            <label htmlFor="sort" style={styles.label}>
              Sort by
            </label>
            <select id="sort" name="sort" defaultValue={sort} style={styles.select}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="amount">Largest amount first</option>
            </select>
          </div>
          <button type="submit" style={styles.buttonPrimary}>
            Apply filters
          </button>
        </form>
        {payments.items.length === 0 ? (
          <p style={styles.emptyState}>No payments match.</p>
        ) : (
          <div className="table-scroll">
            <table style={styles.table}>
              <caption style={{ textAlign: 'left', fontSize: 13, marginBottom: 8 }}>
                {payments.total} payment{payments.total === 1 ? '' : 's'}.
              </caption>
              <thead>
                <tr>
                  {['Created', 'Ride', 'Passenger', 'Driver', 'Amount', 'Status', 'Paid'].map(
                    (h) => (
                      <th key={h} scope="col" style={styles.th}>
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {payments.items.map((p) => (
                  <tr key={p.id}>
                    <td style={styles.td}>{formatWhen(p.createdAt)}</td>
                    <td style={styles.td}>
                      <Link href={`/rides/${p.tripId}`} style={styles.rowLink}>
                        Open the ride
                      </Link>
                    </td>
                    <td style={styles.td}>{p.passengerName ?? 'Unnamed'}</td>
                    <td style={styles.td}>{p.driverName ?? '—'}</td>
                    <td style={styles.td}>{formatNpr(p.amountNpr)}</td>
                    <td style={styles.td}>
                      {describePayment(p.method as PaymentMethod, p.status)}
                    </td>
                    <td style={styles.td}>{p.paidAt ? formatWhen(p.paidAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={payments.total}
          href={(p) => href({ page: String(p) })}
        />
      </section>
    </div>
  );
}
