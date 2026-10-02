import Link from 'next/link';
import { LEDGER_KIND_LABELS } from '@yatri/types';

import { getUserRewardsApi } from '../../../../lib/apiClient';
import { loadOrDenied } from '../../../../lib/access';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../drivers/styles';
import { NoAccess } from '../../ui/NoAccess';
import { AdjustForm } from '../Forms';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One rider's reward points and history, for answering "why is my balance this?" and correcting a mistake. */
export default async function RewardsLookupPage({
  searchParams,
}: {
  searchParams: Promise<{ userId?: string }>;
}) {
  const { userId } = await searchParams;
  const token = await requireAdminAccessToken();
  const valid = userId && UUID.test(userId) ? userId : null;
  const result = valid ? await loadOrDenied(() => getUserRewardsApi(token, valid)) : null;
  if (result?.denied) return <NoAccess what="reward points" />;
  const r = result?.data ?? null;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>A rider&apos;s reward points</h1>
        <Link href="/campaigns" style={styles.backLink}>
          ← Campaigns
        </Link>
      </div>
      <form method="get" style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
        <div>
          <label htmlFor="userId" style={styles.label}>
            Rider ID
          </label>
          <input id="userId" name="userId" defaultValue={userId ?? ''} style={styles.input} />
        </div>
        <button type="submit" style={styles.buttonSecondary}>
          Look up
        </button>
      </form>
      {userId && !valid ? <p role="alert">That is not a rider ID.</p> : null}
      {valid && !r ? <p role="alert">No rider was found with that ID.</p> : null}
      {r ? (
        <>
          <p role="status" style={{ margin: 0, fontWeight: 600 }}>
            {r.name ?? 'Rider'} has {r.balance} reward points.
          </p>
          <section aria-labelledby="hist-h" style={styles.section}>
            <h2 id="hist-h" style={styles.sectionTitle}>
              History
            </h2>
            <table style={styles.table}>
              <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>
                Reward points history
              </caption>
              <thead>
                <tr>
                  {['What', 'Points', 'Why', 'When'].map((h) => (
                    <th key={h} scope="col" style={styles.th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.items.map((i) => (
                  <tr key={i.id}>
                    <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                      {LEDGER_KIND_LABELS[i.kind]}
                    </th>
                    <td style={styles.td}>{i.points > 0 ? `+${i.points}` : i.points}</td>
                    <td style={styles.td}>{i.description}</td>
                    <td style={styles.td}>{new Date(i.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section aria-labelledby="adj-h" style={styles.section}>
            <h2 id="adj-h" style={styles.sectionTitle}>
              Correct the points
            </h2>
            <AdjustForm userId={r.userId} />
          </section>
        </>
      ) : null}
    </div>
  );
}
