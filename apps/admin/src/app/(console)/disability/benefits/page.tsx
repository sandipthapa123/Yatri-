import { CAMPAIGN_STATUS_LABELS, formatWhen } from '@yatri/types';
import Link from 'next/link';

import { loadOrDenied } from '../../../../lib/access';
import { disabilityBenefitsOverviewApi } from '../../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../drivers/styles';
import { NoAccess } from '../../ui/NoAccess';

const when = (iso: string) => formatWhen(iso);
const RULE_WORDS: Record<string, string> = {
  DISABILITY_BENEFIT_BURST: 'The benefit was used on many rides in one day',
  DISABILITY_DUPLICATE_CARD: 'The card number is also on another account',
  DISABILITY_REPEATED_SUBMISSIONS: 'The application was sent many times in a month',
};

/**
 * Disability benefits, from the side of the people who run them: the benefit policies (ordinary campaigns of the
 * disability-benefit kind, edited in Campaigns) with how much each has been used, the accessible-ride service options, and the
 * things that look unusual for a person to review. Counts and references only: no card, no document, no identity.
 */
export default async function DisabilityBenefitsPage() {
  const token = await requireAdminAccessToken();
  const { data, denied } = await loadOrDenied(() => disabilityBenefitsOverviewApi(token));
  if (denied || !data) return <NoAccess what="disability benefits" />;
  const o = data.serviceOptions;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Disability benefits</h1>
        <Link href="/disability" style={styles.backLink}>
          ← Applications
        </Link>
      </div>
      <p style={{ margin: 0 }}>
        Who is eligible is decided only by the verification workspace. What a benefit is worth, where and how often it applies, and
        whether it combines with other offers are set in <Link href="/campaigns">Campaigns</Link> (choose the kind &quot;Disability
        benefit&quot;). Every change there is recorded.
      </p>
      <p role="status" style={{ margin: 0, fontWeight: 600 }}>
        {data.waitingForReview} {data.waitingForReview === 1 ? 'application is' : 'applications are'} waiting for a person.{' '}
        {data.toReview.length === 0 ? 'Nothing unusual is waiting for review.' : `${data.toReview.length} unusual ${data.toReview.length === 1 ? 'thing needs' : 'things need'} a look.`}
      </p>

      <section aria-labelledby="pol-h" style={styles.section}>
        <h2 id="pol-h" style={styles.sectionTitle}>
          Benefit policies
        </h2>
        {data.policies.length === 0 ? (
          <p>
            No disability benefit has been set up yet, so verified riders get no discount. <Link href="/campaigns/new">Create one</Link>.
          </p>
        ) : (
          <table style={styles.table}>
            <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>Disability benefit policies</caption>
            <thead>
              <tr>
                {['Policy', 'State', 'Times used', 'Taken off fares (NPR)', 'Different riders'].map((h) => (
                  <th key={h} scope="col" style={styles.th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.policies.map((p) => (
                <tr key={p.campaignId}>
                  <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                    <Link href={`/campaigns/${p.campaignId}`}>{p.name}</Link>
                  </th>
                  <td style={styles.td}>{CAMPAIGN_STATUS_LABELS[p.status]}</td>
                  <td style={styles.td}>{p.uses}</td>
                  <td style={styles.td}>{p.discountNpr}</td>
                  <td style={styles.td}>{p.distinctRiders}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="opt-h" style={styles.section}>
        <h2 id="opt-h" style={styles.sectionTitle}>
          Accessible ride services
        </h2>
        <ul>
          <li>Verification of disability benefits: {o.verificationEnabled ? 'switched on' : 'switched off (no benefit applies)'}.</li>
          <li>Official card check: {o.officialCheckOffered ? 'offered (if a service is connected)' : 'not offered'}.</li>
          <li>Extra boarding time: {o.extraBoardingSeconds} seconds added to the free waiting time and to the no-show wait, for riders who need it.</li>
          <li>Accessible vehicle priority: requests that need a vehicle feature search {o.accessibleSearchRadiusBonusPercent}% farther.</li>
        </ul>
        <p>
          These are platform settings: change them in <Link href="/settings">Settings</Link>, under &quot;Disability benefits and accessible
          rides&quot;. Wheelchair-accessible vehicles are approved in <Link href="/accessibility">Accessible rides</Link>.
        </p>
      </section>

      <section aria-labelledby="rev-h" style={styles.section}>
        <h2 id="rev-h" style={styles.sectionTitle}>
          To review
        </h2>
        {data.toReview.length === 0 ? (
          <p>Nothing unusual is waiting.</p>
        ) : (
          <ul>
            {data.toReview.map((r) => (
              <li key={r.riskEventId}>
                {when(r.at)}: {RULE_WORDS[r.rule] ?? r.rule} ({r.userName ?? 'unnamed rider'}, {r.points} points). It is a reason to look, not a verdict:{' '}
                <Link href={`/risk`}>open it in Fraud and risk</Link>.
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
