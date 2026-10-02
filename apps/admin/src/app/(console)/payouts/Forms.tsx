'use client';

import type { AdminPayoutDetail, PayoutStatus } from '@yatri/types';
import { useActionState } from 'react';

import { styles } from '../drivers/styles';
import { Confirmed, Feedback } from '../ui/FormParts';
import { payoutStepAction, preparePayoutsAction, showAccountAction } from './actions';

const column = { display: 'flex', flexDirection: 'column', gap: 8 } as const;

const STEP_WORDS: Record<PayoutStatus, { label: string; consequence: string }> = {
  PENDING: { label: 'Prepare', consequence: '' },
  PROCESSING: { label: 'Mark as being sent', consequence: 'The payout is marked as being sent. Send the money to the account shown, then record it as paid.' },
  PAID: { label: 'Record as paid', consequence: 'The payout is marked paid with the reference you enter below, and the driver is told. This cannot be undone. Someone other than the person who prepared it must do this.' },
  FAILED: { label: 'Record as failed', consequence: 'The payout is marked failed with your reason, and the driver is told. It can be tried again or cancelled.' },
  CANCELLED: { label: 'Cancel the payout', consequence: 'The payout is cancelled and its rides go back to the driver’s balance, to be paid in a later payout.' },
};

/** Prepare payouts for every driver who is ready (through the shared two-step confirmation), and say what happened. */
export function PrepareForm() {
  const [state, run, pending] = useActionState(preparePayoutsAction, {});
  return (
    <form action={run} style={column} aria-label="Prepare payouts">
      <Confirmed
        pending={pending}
        label="Prepare payouts for everyone who is ready"
        consequence="A payout is prepared for each driver who has a payout account and at least the smallest amount ready. Nothing is sent yet: each payout still has to be sent and then confirmed by someone else."
      />
      <Feedback state={state} />
    </form>
  );
}

/** One step of a payout. The text box is the reference (when paid) or the reason (when failed) and is required for those. */
export function StepForm({ detail, to }: { detail: AdminPayoutDetail; to: PayoutStatus }) {
  const [state, run, pending] = useActionState(payoutStepAction, {});
  const words = STEP_WORDS[to];
  const extra = to === 'PAID' ? ' What you write below is the bank or wallet reference of the payment you sent.' : to === 'FAILED' ? ' What you write below is the reason.' : '';
  return (
    <form action={run} style={column} aria-label={`${words.label}: payout of NPR ${detail.amountNpr}`}>
      <input type="hidden" name="id" value={detail.id} />
      <input type="hidden" name="to" value={to} />
      <Confirmed pending={pending} label={words.label} consequence={`${words.consequence}${extra}`} />
      <Feedback state={state} />
    </form>
  );
}

/** Show the account to pay. The number appears in the page only after this is pressed, and the API records that it was. */
export function ShowAccountForm({ id }: { id: string }) {
  const [state, run, pending] = useActionState(showAccountAction, {});
  return (
    <form action={run} style={column} aria-label="Show the account to pay">
      <input type="hidden" name="id" value={id} />
      <p style={{ margin: 0 }}>Showing the full account number is recorded in the audit log.</p>
      <div style={styles.buttonRow}>
        <button type="submit" disabled={pending} style={styles.buttonSecondary}>
          {pending ? 'Opening…' : 'Show the account to pay'}
        </button>
      </div>
      <div role="status" aria-live="polite">
        {state.error ? <p style={styles.errorText}>Problem: {state.error}</p> : null}
        {state.account ? (
          <ul>
            <li>Where: {state.account.kindLabel}</li>
            <li>Name on the account: {state.account.holder}</li>
            <li>
              Account number: <strong>{state.account.number}</strong>
            </li>
          </ul>
        ) : null}
      </div>
    </form>
  );
}

