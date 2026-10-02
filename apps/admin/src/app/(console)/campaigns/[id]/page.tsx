import Link from 'next/link';
import {
  CAMPAIGN_KIND_LABELS,
  CAMPAIGN_PHASE_LABELS,
  CAMPAIGN_STATUS_LABELS,
  CAMPAIGN_TRANSITIONS,
  describeConditions,
  describeCampaignOffer,
} from '@yatri/types';
import { notFound } from 'next/navigation';

import { ApiError, getCampaignApi, listCampaignRedemptionsApi } from '../../../../lib/apiClient';
import { loadOrDenied } from '../../../../lib/access';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../drivers/styles';
import { NoAccess } from '../../ui/NoAccess';
import { CampaignForm, CampaignStatusForm } from '../Forms';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'not set');

/** One campaign: what it does, its state, the moves allowed now, how it has been used, and (when not running) its editor. */
export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = await requireAdminAccessToken();
  const found = await loadOrDenied(() => getCampaignApi(token, id)).catch((e) => {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  });
  if (found.denied || !found.data) return <NoAccess what="this campaign" />;
  const c = found.data;
  const redemptions = (await loadOrDenied(() => listCampaignRedemptionsApi(token, id))).data ?? [];
  const moves = CAMPAIGN_TRANSITIONS[c.status];
  const editable = c.status === 'DRAFT' || c.status === 'PAUSED';
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>{c.name}</h1>
        <Link href="/campaigns" style={styles.backLink}>
          ← Campaigns
        </Link>
      </div>

      <section aria-labelledby="summary-h" style={styles.section}>
        <h2 id="summary-h" style={styles.sectionTitle}>
          What it does
        </h2>
        <ul>
          <li>Kind: {CAMPAIGN_KIND_LABELS[c.kind].label}</li>
          <li>
            State: {CAMPAIGN_STATUS_LABELS[c.status]}. {CAMPAIGN_PHASE_LABELS[c.phase]}.
          </li>
          {c.code ? <li>Code: {c.code}</li> : null}
          <li>Offer: {c.offer ? describeCampaignOffer(c.offer) : 'a message only'}</li>
          {c.referrerPoints !== null ? (
            <li>The person who invited earns {c.referrerPoints} points</li>
          ) : null}
          <li>Starts: {when(c.startsAt)}</li>
          <li>Ends: {when(c.endsAt)}</li>
          {c.message ? (
            <li>
              Message: &quot;{c.message.title}&quot;, {c.message.body}
              {c.sentAt ? ` Sent ${when(c.sentAt)}.` : ' Not sent yet.'}
            </li>
          ) : null}
          {describeConditions(c.eligibility, c.limits).map((line) => (
            <li key={line}>{line}</li>
          ))}
          {c.limits.total !== null ? <li>Can be used {c.limits.total} times in all.</li> : null}
          <li>Used so far: {c.redemptions}</li>
        </ul>
      </section>

      {moves.length > 0 ? (
        <section aria-labelledby="moves-h" style={styles.section}>
          <h2 id="moves-h" style={styles.sectionTitle}>
            Start, pause or end
          </h2>
          {moves.includes('ACTIVE') ? (
            <CampaignStatusForm
              campaign={c}
              to="ACTIVE"
              label={c.status === 'PAUSED' ? 'Resume the campaign' : 'Start the campaign'}
              consequence="Riders the campaign fits can start using it straight away, within its dates and limits."
            />
          ) : null}
          {moves.includes('PAUSED') ? (
            <CampaignStatusForm
              campaign={c}
              to="PAUSED"
              label="Pause the campaign"
              consequence="No new ride can use it. Rides already holding it keep it."
            />
          ) : null}
          {moves.includes('ENDED') ? (
            <CampaignStatusForm
              campaign={c}
              to="ENDED"
              label="End the campaign"
              consequence="It cannot be started again. Rides already holding it keep it."
            />
          ) : null}
        </section>
      ) : null}

      {editable ? (
        <section aria-labelledby="edit-h" style={styles.section}>
          <h2 id="edit-h" style={styles.sectionTitle}>
            Change it
          </h2>
          <CampaignForm campaign={c} />
        </section>
      ) : c.status === 'ACTIVE' ? (
        <p style={{ margin: 0 }}>
          A running campaign cannot be changed. Pause it first, then change it.
        </p>
      ) : null}

      <section aria-labelledby="use-h" style={styles.section}>
        <h2 id="use-h" style={styles.sectionTitle}>
          Who used it
        </h2>
        {redemptions.length === 0 ? (
          <p style={{ margin: 0 }}>Nobody has used it yet.</p>
        ) : (
          <table style={styles.table}>
            <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>
              Uses of this campaign
            </caption>
            <thead>
              <tr>
                {['Rider', 'State', 'Taken off (NPR)', 'Bonus points', 'When'].map((h) => (
                  <th key={h} scope="col" style={styles.th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {redemptions.map((r) => (
                <tr key={r.id}>
                  <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                    <Link href={`/campaigns/rewards?userId=${r.userId}`}>
                      {r.userName ?? 'Rider'}
                    </Link>
                  </th>
                  <td style={styles.td}>
                    {
                      {
                        RESERVED: 'Held for a ride in progress',
                        APPLIED: 'Used',
                        VOID: 'Not used (the ride did not happen)',
                      }[r.status]
                    }
                  </td>
                  <td style={styles.td}>{r.discountNpr}</td>
                  <td style={styles.td}>{r.bonusPoints}</td>
                  <td style={styles.td}>{when(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
