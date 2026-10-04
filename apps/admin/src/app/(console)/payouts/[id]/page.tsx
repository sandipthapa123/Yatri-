import { PAYOUT_ACCOUNT_LABELS, maskedAccount, formatWhen } from '@yatri/types';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { loadOrDenied } from '../../../../lib/access';
import { ApiError, getPayoutApi } from '../../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../drivers/styles';
import { NoAccess } from '../../ui/NoAccess';
import { ShowAccountForm, StepForm } from '../Forms';

const when = (iso: string | null) => formatWhen(iso, { empty: 'not yet' });

/**
 * One payout: its state, the rides in it, who prepared and who confirmed it, the steps allowed now, and (only after it is asked
 * for, and recorded) the account to pay. The steps come from the server's list, so one that is not legal is not offered.
 */
export default async function PayoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = await requireAdminAccessToken();
  const found = await loadOrDenied(() => getPayoutApi(token, id)).catch((e) => {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  });
  if (found.denied || !found.data) return <NoAccess what="this payout" />;
  const p = found.data;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>
          Payout of NPR {p.amountNpr} to {p.driverName ?? 'a driver'}
        </h1>
        <Link href="/payouts" style={styles.backLink}>
          ← Payouts
        </Link>
      </div>
      <section aria-labelledby="sum-h" style={styles.section}>
        <h2 id="sum-h" style={styles.sectionTitle}>
          The payout
        </h2>
        <ul>
          <li>State: {p.statusLabel}</li>
          <li>
            Amount: NPR {p.amountNpr} for {p.rides} {p.rides === 1 ? 'ride' : 'rides'}
          </li>
          <li>
            Pay to: {PAYOUT_ACCOUNT_LABELS[p.accountKind].label}, {p.accountHolder},{' '}
            {maskedAccount(p.accountLast4)}
          </li>
          <li>
            Prepared: {when(p.createdAt)} by {p.createdByName ?? 'an administrator'}
          </li>
          {p.paidAt ? (
            <li>
              Paid: {when(p.paidAt)}, reference {p.reference ?? 'not recorded'}
            </li>
          ) : null}
          {p.failedReason ? <li>Last problem: {p.failedReason}</li> : null}
        </ul>
      </section>
      <section aria-labelledby="acc-h" style={styles.section}>
        <h2 id="acc-h" style={styles.sectionTitle}>
          The account to pay
        </h2>
        <ShowAccountForm id={p.id} />
      </section>
      <section aria-labelledby="steps-h" style={styles.section}>
        <h2 id="steps-h" style={styles.sectionTitle}>
          Next steps
        </h2>
        {p.allowedNext.length === 0 ? (
          <p>No step can be taken from this state.</p>
        ) : (
          p.allowedNext.map((to) => (
            <details key={to} style={{ marginBottom: 8 }}>
              <summary>
                {
                  {
                    PENDING: 'Prepare',
                    PROCESSING: 'Mark as being sent',
                    PAID: 'Record as paid',
                    FAILED: 'Record as failed',
                    CANCELLED: 'Cancel the payout',
                  }[to]
                }
              </summary>
              <StepForm detail={p} to={to} />
            </details>
          ))
        )}
      </section>
      <section aria-labelledby="items-h" style={styles.section}>
        <h2 id="items-h" style={styles.sectionTitle}>
          Rides in this payout
        </h2>
        {p.items.length === 0 ? (
          <p>None (a cancelled payout lets go of its rides).</p>
        ) : (
          <ul>
            {p.items.map((i) => (
              <li key={i.tripId}>
                <Link href={`/rides/${i.tripId}`}>Ride</Link>: NPR {i.amountNpr}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
