'use client';

import {
  CAMPAIGN_KINDS,
  CAMPAIGN_KIND_HAS_MESSAGE,
  CAMPAIGN_KIND_HAS_OFFER,
  CAMPAIGN_KIND_LABELS,
  OFFER_TYPES,
  OFFER_TYPE_LABELS,
  type CampaignInfo,
  type CampaignKind,
  type CampaignStatus,
} from '@yatri/types';
import { useActionState, useId, useState } from 'react';

import { styles } from '../drivers/styles';
import { Checkbox, Confirmed, Feedback, Field } from '../ui/FormParts';
import {
  adjustRewardsAction,
  campaignStatusAction,
  createCampaignAction,
  updateCampaignAction,
} from './actions';

const column = { display: 'flex', flexDirection: 'column', gap: 8 } as const;
const hint = { margin: 0, fontSize: 13, color: 'var(--color-text-secondary)' } as const;

/** `datetime-local` wants the administrator's own wall-clock time, no zone. */
const local = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * One form for creating and editing a campaign. It only collects the choices: the API checks them with the same rule
 * the dashboard's hints describe (campaignProblem), keeps the version and the reason, and decides.
 */
export function CampaignForm({ campaign }: { campaign?: CampaignInfo }) {
  const [state, action, pending] = useActionState(
    campaign ? updateCampaignAction : createCampaignAction,
    {},
  );
  const [kind, setKind] = useState<CampaignKind>(campaign?.kind ?? 'PROMO');
  const kindId = useId();
  const offerId = useId();
  const e = campaign?.eligibility ?? {};
  const o = campaign?.offer ?? null;
  const hasOffer = CAMPAIGN_KIND_HAS_OFFER[kind];
  const hasMessage = CAMPAIGN_KIND_HAS_MESSAGE[kind];
  return (
    <form action={action} style={column}>
      {campaign ? (
        <>
          <input type="hidden" name="id" value={campaign.id} />
          <input type="hidden" name="version" value={campaign.version} />
          <input type="hidden" name="kind" value={campaign.kind} />
        </>
      ) : (
        <>
          <label htmlFor={kindId} style={styles.label}>
            Kind of campaign
          </label>
          <select
            id={kindId}
            name="kind"
            value={kind}
            onChange={(ev) => setKind(ev.target.value as CampaignKind)}
            style={styles.select}
          >
            {CAMPAIGN_KINDS.map((k) => (
              <option key={k} value={k}>
                {CAMPAIGN_KIND_LABELS[k].label}
              </option>
            ))}
          </select>
        </>
      )}
      <p style={hint}>{CAMPAIGN_KIND_LABELS[kind].help}</p>

      <Field name="name" label="Name" defaultValue={campaign?.name} required />
      <Field
        name="description"
        label="Description (shown to riders)"
        defaultValue={campaign?.description}
      />
      {kind === 'PROMO' || kind === 'COUPON' ? (
        <Field
          name="code"
          label={
            kind === 'COUPON' ? 'Code (required)' : 'Code (leave empty to apply automatically)'
          }
          defaultValue={campaign?.code}
          hint="4 to 20 capital letters and digits."
        />
      ) : null}

      <fieldset style={{ ...column, border: '1px solid var(--color-border)', padding: 12 }}>
        <legend>When it runs</legend>
        <Field
          name="startsAt"
          type="datetime-local"
          label={kind === 'PUSH' ? 'Send at' : 'Starts (empty: when started)'}
          defaultValue={local(campaign?.startsAt ?? null)}
          required={kind === 'PUSH'}
        />
        {kind === 'PUSH' ? null : (
          <Field
            name="endsAt"
            type="datetime-local"
            label="Ends (empty: no end date)"
            defaultValue={local(campaign?.endsAt ?? null)}
          />
        )}
        <p style={hint}>
          A campaign only runs while it is Active and inside these dates. Starting, pausing and
          ending are separate steps on the campaign page.
        </p>
      </fieldset>

      <fieldset style={{ ...column, border: '1px solid var(--color-border)', padding: 12 }}>
        <legend>Who it is for</legend>
        {kind === 'FIRST_RIDE' ? (
          <input type="hidden" name="maxCompletedRides" value="0" />
        ) : (
          <Field
            name="maxCompletedRides"
            type="number"
            label="At most this many completed rides (0: first ride only)"
            defaultValue={e.maxCompletedRides}
          />
        )}
        <Field
          name="minCompletedRides"
          type="number"
          label="At least this many completed rides"
          defaultValue={e.minCompletedRides}
        />
        <Field
          name="newUserWithinDays"
          type="number"
          label="Accounts opened within this many days"
          defaultValue={e.newUserWithinDays}
        />
        <Field
          name="inactiveForDays"
          type="number"
          label={
            kind === 'RETENTION'
              ? 'Has not ridden for this many days (required)'
              : 'Has not ridden for this many days'
          }
          defaultValue={e.inactiveForDays}
          required={kind === 'RETENTION'}
        />
        {kind === 'PUSH' ? null : (
          <>
            <Field
              name="vehicleCategoryCodes"
              label="Vehicle type codes, comma separated (empty: all)"
              defaultValue={e.vehicleCategoryCodes?.join(', ')}
            />
            <Field
              name="minFareNpr"
              type="number"
              label="Smallest fare it applies to (NPR)"
              defaultValue={e.minFareNpr}
            />
          </>
        )}
      </fieldset>

      {hasOffer ? (
        <fieldset style={{ ...column, border: '1px solid var(--color-border)', padding: 12 }}>
          <legend>The offer</legend>
          <label htmlFor={offerId} style={styles.label}>
            Type of offer
          </label>
          <select
            id={offerId}
            name="offerType"
            defaultValue={o?.type ?? 'PERCENT_OFF'}
            style={styles.select}
          >
            {OFFER_TYPES.map((t) => (
              <option key={t} value={t}>
                {OFFER_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          <Field
            name="percent"
            type="number"
            label="Percent off (for a percent offer)"
            defaultValue={o?.percent}
          />
          <Field
            name="maxDiscountNpr"
            type="number"
            label="Most it can take off (NPR, optional)"
            defaultValue={o?.maxDiscountNpr}
          />
          <Field
            name="fixedNpr"
            type="number"
            label="Amount off (NPR, for a fixed offer)"
            defaultValue={o?.fixedNpr}
          />
          <Field
            name="points"
            type="number"
            label="Bonus points (for a bonus-points offer)"
            defaultValue={o?.points}
          />
          <Field
            name="multiplier"
            type="number"
            label="Points multiplier (for example 2 for double)"
            defaultValue={o?.multiplier}
          />
          <Checkbox
            name="stackable"
            label="May be used together with another offer that also allows it"
            checked={campaign?.stackable ?? false}
          />
          <p style={hint}>
            Money off a fare is paid by Yatri: the driver still earns the full fare.
          </p>
        </fieldset>
      ) : null}
      {kind === 'REFERRAL' ? (
        <Field
          name="referrerPoints"
          type="number"
          label="Points the person who invited earns when the new rider's first ride is done"
          defaultValue={campaign?.referrerPoints}
          required
        />
      ) : null}

      {hasMessage ? (
        <fieldset style={{ ...column, border: '1px solid var(--color-border)', padding: 12 }}>
          <legend>The message</legend>
          <Field
            name="messageTitle"
            label="Title"
            defaultValue={campaign?.message?.title}
            required
          />
          <Field name="messageBody" label="Text" defaultValue={campaign?.message?.body} required />
          <p style={hint}>
            Riders who have not turned on &quot;Offers and news&quot; are not sent it.
          </p>
        </fieldset>
      ) : null}

      {kind === 'PUSH' ? null : (
        <fieldset style={{ ...column, border: '1px solid var(--color-border)', padding: 12 }}>
          <legend>Limits</legend>
          <Field
            name="perUser"
            type="number"
            label="Times one rider may use it (empty: no limit)"
            defaultValue={campaign?.limits.perUser}
          />
          <Field
            name="total"
            type="number"
            label="Times it may be used in all (empty: no limit)"
            defaultValue={campaign?.limits.total}
          />
          {kind === 'REFERRAL' || kind === 'RETENTION' ? (
            <Field
              name="validDaysAfterGrant"
              type="number"
              label="Days a rider has to use the offer once they get it"
              defaultValue={campaign?.limits.validDaysAfterGrant}
            />
          ) : null}
        </fieldset>
      )}

      <Confirmed
        pending={pending}
        label={campaign ? 'Save the campaign' : 'Create the campaign'}
        consequence={
          campaign
            ? 'The changes apply from the next time the campaign is started.'
            : 'It starts as a draft: nothing happens until you start it.'
        }
      />
      <Feedback state={state} />
    </form>
  );
}

/** Start, pause or end a campaign. The API allows only the legal moves and keeps the reason. */
export function StatusForm({
  campaign,
  to,
  label,
  consequence,
}: {
  campaign: CampaignInfo;
  to: CampaignStatus;
  label: string;
  consequence: string;
}) {
  const [state, action, pending] = useActionState(campaignStatusAction, {});
  return (
    <form action={action} style={column} aria-label={`${label}: ${campaign.name}`}>
      <input type="hidden" name="id" value={campaign.id} />
      <input type="hidden" name="to" value={to} />
      <input type="hidden" name="version" value={campaign.version} />
      <Confirmed pending={pending} label={label} consequence={consequence} />
      <Feedback state={state} />
    </form>
  );
}

/** Correct a rider's reward points. The reason is kept in the ledger and the audit log. */
export function AdjustForm({ userId }: { userId: string }) {
  const [state, action, pending] = useActionState(adjustRewardsAction, {});
  return (
    <form action={action} style={column}>
      <input type="hidden" name="userId" value={userId} />
      <Field
        name="points"
        type="number"
        label="Points to add (positive) or take back (negative)"
        required
        hint="Whole points. A rider cannot go below zero."
      />
      <Confirmed
        pending={pending}
        label="Change the points"
        consequence="The rider's balance changes now, and the entry appears in their history."
      />
      <Feedback state={state} />
    </form>
  );
}
