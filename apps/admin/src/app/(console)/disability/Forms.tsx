'use client';

import {
  DISABILITY_ADMIN_ACTION_LABELS,
  type AdminDisabilityDetail,
  type DisabilityAdminAction,
} from '@yatri/types';
import { useActionState } from 'react';

import { styles } from '../drivers/styles';
import { Confirmed, Feedback } from '../ui/FormParts';
import { disabilityDecisionAction, openDisabilityDocumentAction } from './actions';

const column = { display: 'flex', flexDirection: 'column', gap: 8 } as const;

/**
 * One decision on a verification, through the shared two-step confirmation (the sentence says what will happen, focus moves
 * to it, Escape goes back). The "reason" box is the reason, the correction message or the approval note, depending on the
 * action; what is written for a rejection, a correction or a revocation is shown to the rider. When the card is also on
 * another account, approving needs the reviewer to say they looked. The result is announced; a problem starts with Problem.
 */
export function DecisionForm({
  detail,
  action,
}: {
  detail: AdminDisabilityDetail;
  action: DisabilityAdminAction;
}) {
  const [state, run, pending] = useActionState(disabilityDecisionAction, {});
  const words = DISABILITY_ADMIN_ACTION_LABELS[action];
  const shown = words.needs === 'none' ? '' : ' What you write below is shown to the rider.';
  return (
    <form action={run} style={column} aria-label={`${words.label}: ${detail.userName ?? 'this rider'}`}>
      <input type="hidden" name="id" value={detail.id} />
      <input type="hidden" name="action" value={action} />
      {action === 'approve' && detail.duplicateCount > 0 ? (
        <label>
          <input type="checkbox" name="acknowledgeDuplicate" /> I have looked at the {detail.duplicateCount} other{' '}
          {detail.duplicateCount === 1 ? 'account' : 'accounts'} with this card number
        </label>
      ) : null}
      <Confirmed pending={pending} label={words.label} consequence={`${words.consequence}${shown}`} />
      <Feedback state={state} />
    </form>
  );
}

export function OpenDocumentForm({ id, name }: { id: string; name: string }) {
  const [state, run, pending] = useActionState(openDisabilityDocumentAction, {});
  return (
    <form action={run} style={column} aria-label="Open the card document">
      <input type="hidden" name="id" value={id} />
      <p style={{ margin: 0 }}>
        Opens {name} through a link that works for a few minutes. Opening it is recorded.
      </p>
      <div style={styles.buttonRow}>
        <button type="submit" disabled={pending} style={styles.buttonSecondary}>
          {pending ? 'Opening…' : 'Open the document'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}
