import Link from 'next/link';
import {
  CAMPAIGN_KINDS,
  CAMPAIGN_KIND_LABELS,
  CAMPAIGN_PHASE_LABELS,
  CAMPAIGN_STATUSES,
  CAMPAIGN_STATUS_LABELS,
  describeOffer,
  type CampaignKind,
  type CampaignStatus,
} from '@yatri/types';

import { getGrowthAnalyticsApi, listCampaignsApi } from '../../../lib/apiClient';
import { loadOrDenied } from '../../../lib/access';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { NoAccess } from '../ui/NoAccess';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'not set');

/**
 * Campaigns: every promotion, coupon, first-ride offer, referral, win-back offer and message campaign in one list,
 * with what is live now and how it is doing. Filters are links, so they work without a script and with a keyboard.
 */
export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; status?: string }>;
}) {
  const q = await searchParams;
  const kind = (CAMPAIGN_KINDS as readonly string[]).includes(q.kind ?? '')
    ? (q.kind as CampaignKind)
    : undefined;
  const status = (CAMPAIGN_STATUSES as readonly string[]).includes(q.status ?? '')
    ? (q.status as CampaignStatus)
    : undefined;
  const token = await requireAdminAccessToken();
  const [list, analytics] = await Promise.all([
    loadOrDenied(() => listCampaignsApi(token, { kind, status })),
    loadOrDenied(() => getGrowthAnalyticsApi(token)),
  ]);
  if (list.denied || !list.data) return <NoAccess what="campaigns" />;
  const a = analytics.data;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Campaigns</h1>
        <Link href="/" style={styles.backLink}>
          ← Dashboard
        </Link>
      </div>
      <p style={{ margin: 0 }}>
        Offers and messages for riders. Everything a campaign does is decided by the server from
        what you set here; the apps only show it. Driver bonuses are set in{' '}
        <Link href="/operations">Demand, zones and pricing</Link> and are shown beside the figures
        below.
      </p>
      <p style={{ margin: 0 }}>
        <Link href="/campaigns/new">Create a campaign</Link> ·{' '}
        <Link href="/campaigns/rewards">Look up a rider&apos;s reward points</Link>
      </p>

      {a ? (
        <section aria-labelledby="figures-h" style={styles.section}>
          <h2 id="figures-h" style={styles.sectionTitle}>
            Figures: {a.rangeLabel}
          </h2>
          <ul>
            <li>Offers used on rides: {a.redemptions}</li>
            <li>Taken off fares (paid by Yatri): NPR {a.discountNpr}</li>
            <li>
              Reward points: {a.pointsIssued} earned, {a.pointsRedeemed} used, {a.pointsExpired}{' '}
              expired
            </li>
            <li>
              Invites: {a.referralsInvited} accepted, {a.referralsRewarded} with a first ride done
            </li>
            <li>Messages sent: {a.pushSent}</li>
            <li>
              Driver bonuses paid by the incentive rules: {a.driverIncentives.awards} bonuses, NPR{' '}
              {a.driverIncentives.bonusNpr}
            </li>
          </ul>
          {a.byCampaign.length > 0 ? (
            <table style={styles.table}>
              <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>
                Campaign figures
              </caption>
              <thead>
                <tr>
                  {['Campaign', 'Kind', 'Times used', 'Taken off (NPR)', 'Different riders'].map(
                    (h) => (
                      <th key={h} scope="col" style={styles.th}>
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {a.byCampaign.map((c) => (
                  <tr key={c.campaignId}>
                    <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                      <Link href={`/campaigns/${c.campaignId}`}>{c.name}</Link>
                    </th>
                    <td style={styles.td}>{CAMPAIGN_KIND_LABELS[c.kind].label}</td>
                    <td style={styles.td}>{c.redemptions}</td>
                    <td style={styles.td}>{c.discountNpr}</td>
                    <td style={styles.td}>{c.distinctRiders}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      ) : null}

      <nav aria-label="Filter campaigns" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <strong>Kind:</strong>
        <Link
          href={status ? `/campaigns?status=${status}` : '/campaigns'}
          aria-current={kind ? undefined : 'page'}
        >
          All
        </Link>
        {CAMPAIGN_KINDS.map((k) => (
          <Link
            key={k}
            href={`/campaigns?kind=${k}${status ? `&status=${status}` : ''}`}
            aria-current={kind === k ? 'page' : undefined}
          >
            {CAMPAIGN_KIND_LABELS[k].label}
          </Link>
        ))}
        <strong>Status:</strong>
        {CAMPAIGN_STATUSES.map((s) => (
          <Link
            key={s}
            href={`/campaigns?status=${s}${kind ? `&kind=${kind}` : ''}`}
            aria-current={status === s ? 'page' : undefined}
          >
            {CAMPAIGN_STATUS_LABELS[s]}
          </Link>
        ))}
      </nav>

      {list.data.length === 0 ? (
        <p style={{ margin: 0 }}>No campaigns match.</p>
      ) : (
        <table style={styles.table}>
          <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>
            Campaigns
          </caption>
          <thead>
            <tr>
              {['Campaign', 'Kind', 'State', 'Offer', 'From', 'Until', 'Times used'].map((h) => (
                <th key={h} scope="col" style={styles.th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.data.map((c) => (
              <tr key={c.id}>
                <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                  <Link href={`/campaigns/${c.id}`}>{c.name}</Link>
                  {c.code ? ` (code ${c.code})` : ''}
                </th>
                <td style={styles.td}>{CAMPAIGN_KIND_LABELS[c.kind].label}</td>
                <td style={styles.td}>{CAMPAIGN_PHASE_LABELS[c.phase]}</td>
                <td style={styles.td}>{c.offer ? describeOffer(c.offer) : 'A message'}</td>
                <td style={styles.td}>{when(c.startsAt)}</td>
                <td style={styles.td}>{when(c.endsAt)}</td>
                <td style={styles.td}>{c.redemptions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
