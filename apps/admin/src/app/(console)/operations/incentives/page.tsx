import Link from 'next/link';
import { INCENTIVE_KIND_LABELS, describeIncentive, formatNpr } from '@yatri/types';

import {
  getOperationOptions,
  listIncentiveAwards,
  listIncentiveRules,
} from '../../../../lib/apiClient';
import { loadOrDenied } from '../../../../lib/access';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../drivers/styles';
import { NoAccess } from '../../ui/NoAccess';
import { Pagination, withParams } from '../../ui/Pagination';
import { IncentiveForm } from '../Forms';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<{ page?: string }>;
}

/**
 * Driver incentives: the rules, and the record of every bonus earned. A bonus is calculated once, when a
 * ride completes, and recorded once; it never changes a fare or a payment, and it is not paid from here:
 * the awards list is what finance pays from.
 */
export default async function IncentivesPage({ searchParams }: PageProps) {
  const token = await requireAdminAccessToken();
  const page = Math.max(1, Number((await searchParams).page) || 1);
  const { data, denied } = await loadOrDenied(async () => ({
    rules: await listIncentiveRules(token),
    options: await getOperationOptions(token),
    awards: await listIncentiveAwards(token, { page, pageSize: PAGE_SIZE }),
  }));
  if (denied || !data) return <NoAccess what="driver incentives" />;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Driver incentives</h1>
        <Link href="/operations" style={styles.backLink}>
          ← Demand, zones and pricing
        </Link>
      </div>

      {data.rules.length === 0 ? <p style={{ margin: 0 }}>No bonus rules yet.</p> : null}
      {data.rules.map((r) => (
        <section key={r.id} aria-label={r.name} style={styles.section}>
          <p style={{ margin: 0 }}>
            <strong>{r.name}</strong> · {INCENTIVE_KIND_LABELS[r.kind]} ·{' '}
            {r.isActive ? 'in use' : 'not in use'}
          </p>
          <p style={{ margin: 0 }}>{describeIncentive(r)}</p>
          <IncentiveForm rule={r} options={data.options} />
        </section>
      ))}
      <section aria-labelledby="new-h" style={styles.section}>
        <h2 id="new-h" style={styles.sectionTitle}>
          Add a bonus
        </h2>
        <IncentiveForm options={data.options} />
      </section>

      <section aria-labelledby="aw-h" style={styles.section}>
        <h2 id="aw-h" style={styles.sectionTitle}>
          Bonuses earned
        </h2>
        <p style={{ margin: 0 }}>
          {data.awards.total} award{data.awards.total === 1 ? '' : 's'},{' '}
          {formatNpr(data.awards.totalAwardedNpr)} in total.
        </p>
        {data.awards.items.length === 0 ? (
          <p style={{ margin: 0 }}>Nothing has been earned yet.</p>
        ) : (
          <table style={styles.table}>
            <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>
              Bonuses earned
            </caption>
            <thead>
              <tr>
                {['When', 'Driver', 'Bonus', 'For', 'Amount'].map((h) => (
                  <th key={h} scope="col" style={styles.th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.awards.items.map((a) => (
                <tr key={a.id}>
                  <td style={styles.td}>{new Date(a.createdAt).toLocaleString()}</td>
                  <td style={styles.td}>{a.driverName ?? 'Unnamed'}</td>
                  <td style={styles.td}>{a.ruleName}</td>
                  <td style={styles.td}>
                    {a.tripId ? (
                      <Link href={`/rides/${a.tripId}`}>One ride</Link>
                    ) : (
                      `Period ${a.periodKey}`
                    )}
                  </td>
                  <td style={styles.td}>{formatNpr(a.amountNpr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={data.awards.total}
          href={(p) => withParams('/operations/incentives', { page: String(p) })}
        />
      </section>
    </div>
  );
}
