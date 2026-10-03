import { PAYOUT_STATUSES, PAYOUT_STATUS_LABELS, type PayoutStatus, formatWhen } from '@yatri/types';
import Link from 'next/link';

import { loadOrDenied } from '../../../lib/access';
import { listPayoutsApi } from '../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { NoAccess } from '../ui/NoAccess';
import { PrepareForm } from './Forms';

const when = (iso: string | null) => formatWhen(iso, { empty: 'not yet' });
const PAGE = 25;

/**
 * Driver payouts for online rides. What drivers are owed is decided by the server (the full fare of each online ride, after a
 * hold, less the share of a refund the platform setting puts on the driver). Cash rides never appear here. A payout is prepared,
 * then sent by staff, then confirmed paid by someone else with the bank or wallet reference. The account to pay is never in
 * this list. Filters and paging are links, so they work with a keyboard and without a script.
 */
export default async function PayoutsPage({ searchParams }: { searchParams: Promise<{ status?: string; offset?: string }> }) {
  const q = await searchParams;
  const status = (PAYOUT_STATUSES as readonly string[]).includes(q.status ?? '') ? (q.status as PayoutStatus) : undefined;
  const offset = Math.max(0, Number(q.offset) || 0);
  const token = await requireAdminAccessToken();
  const { data, denied } = await loadOrDenied(() => listPayoutsApi(token, { status, limit: PAGE, offset }));
  if (denied || !data) return <NoAccess what="driver payouts" />;
  const link = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ status, ...over })) if (v) p.set(k, String(v));
    return `/payouts${p.toString() ? `?${p}` : ''}`;
  };
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Driver payouts</h1>
        <Link href="/" style={styles.backLink}>
          ← Dashboard
        </Link>
      </div>
      <p style={{ margin: 0 }}>
        Money Yatri holds for drivers because riders paid online. Cash rides are not here: the driver was handed that cash.
      </p>
      <p role="status" style={{ margin: 0, fontWeight: 600 }}>
        NPR {data.readyNpr} is ready for {data.readyDrivers} {data.readyDrivers === 1 ? 'driver' : 'drivers'}. {data.total}{' '}
        {data.total === 1 ? 'payout matches' : 'payouts match'} this view.
      </p>
      <section aria-labelledby="prep-h" style={styles.section}>
        <h2 id="prep-h" style={styles.sectionTitle}>
          Prepare payouts
        </h2>
        <PrepareForm />
      </section>
      <nav aria-label="Filter payouts" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <strong>State:</strong>
        <Link href={link({ status: undefined })} aria-current={!status ? 'true' : undefined}>
          All
        </Link>
        {PAYOUT_STATUSES.map((s) => (
          <Link key={s} href={link({ status: s })} aria-current={status === s ? 'true' : undefined}>
            {PAYOUT_STATUS_LABELS[s]}
          </Link>
        ))}
      </nav>
      {data.items.length === 0 ? (
        <p>No payouts match.</p>
      ) : (
        <table style={styles.table}>
          <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>Driver payouts</caption>
          <thead>
            <tr>
              {['Driver', 'Amount (NPR)', 'Rides', 'State', 'Prepared', 'Paid'].map((h) => (
                <th key={h} scope="col" style={styles.th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.items.map((p) => (
              <tr key={p.id}>
                <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                  <Link href={`/payouts/${p.id}`}>{p.driverName ?? 'Unnamed driver'}</Link>
                </th>
                <td style={styles.td}>{p.amountNpr}</td>
                <td style={styles.td}>{p.rides}</td>
                <td style={styles.td}>{p.statusLabel}</td>
                <td style={styles.td}>{when(p.createdAt)}</td>
                <td style={styles.td}>{when(p.paidAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <nav aria-label="Pages" style={{ display: 'flex', gap: 12 }}>
        {offset > 0 ? <Link href={link({ offset: String(Math.max(0, offset - PAGE)) })}>Previous page</Link> : null}
        {offset + PAGE < data.total ? <Link href={link({ offset: String(offset + PAGE) })}>Next page</Link> : null}
      </nav>
    </div>
  );
}
