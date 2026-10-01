'use client';

import { type OrgStatus } from '@yatri/types';
import { useActionState } from 'react';

import { styles } from '../drivers/styles';
import { Confirmed, Feedback, Field } from '../ui/FormParts';
import { issueAction, moveAction, paidAction, voidAction } from './actions';

const column = { display: 'flex', flexDirection: 'column', gap: 8 } as const;

/** Suspend or reactivate. A suspension stops new bookings; it never touches rides under way or money owed. */
export function MoveForm({ organizationId, to }: { organizationId: string; to: OrgStatus }) {
  const [state, action, pending] = useActionState(moveAction, {});
  return (
    <form action={action} style={column}>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="to" value={to} />
      <Confirmed
        pending={pending}
        label={to === 'SUSPENDED' ? 'Suspend this organization' : 'Reactivate this organization'}
        consequence={
          to === 'SUSPENDED'
            ? 'New business rides and approvals stop, and waiting approvals are withdrawn. Rides under way and statements are unchanged. The owners are told.'
            : 'Business rides can be booked again. The owners are told.'
        }
      />
      <Feedback state={state} />
    </form>
  );
}

/** Issue the statements for a finished month (leave it blank for last month). Running it again issues nothing new. */
export function IssueForm() {
  const [state, action, pending] = useActionState(issueAction, {});
  return (
    <form action={action} style={column}>
      <Field
        name="periodKey"
        label="Month to bill (for example 2026-09)"
        hint="Leave blank for last month. A month that is not over cannot be billed, and a month already billed is skipped."
      />
      <div style={styles.buttonRow}>
        <button type="submit" disabled={pending} style={styles.buttonPrimary}>
          {pending ? 'Issuing…' : 'Issue statements'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

/** Record that the organization paid. The amount must be the exact total; all its rides become paid together. */
export function PaidForm({ statementId, totalNpr }: { statementId: string; totalNpr: number }) {
  const [state, action, pending] = useActionState(paidAction, {});
  return (
    <form action={action} style={column}>
      <input type="hidden" name="statementId" value={statementId} />
      <Field
        name="receivedNpr"
        label="Amount received (NPR)"
        type="number"
        defaultValue={totalNpr}
        required
        hint="It must equal the statement total exactly."
      />
      <Field name="reference" label="Bank or payment reference" required />
      <Confirmed
        pending={pending}
        label="Record as paid"
        consequence="Every ride on this statement becomes paid. Recording the same payment again changes nothing."
      />
      <Feedback state={state} />
    </form>
  );
}

export function VoidForm({ statementId }: { statementId: string }) {
  const [state, action, pending] = useActionState(voidAction, {});
  return (
    <form action={action} style={column}>
      <input type="hidden" name="statementId" value={statementId} />
      <Confirmed
        pending={pending}
        label="Cancel this statement"
        consequence="Its rides go back to being unbilled and appear on the next statement. A paid statement cannot be cancelled."
      />
      <Feedback state={state} />
    </form>
  );
}
