'use client';

import { Feedback } from '../ui/FormParts';

import { useActionState, useId } from 'react';

import { styles } from '../drivers/styles';
import { cancelRideAction } from './actions';

/** Cancel a live ride as an operator. Needs a written reason, which both people are shown. */
export function CancelRideForm({ tripId }: { tripId: string }) {
  const [state, action, pending] = useActionState(cancelRideAction, {});
  const id = useId();
  return (
    <form action={action} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <input type="hidden" name="tripId" value={tripId} />
      <label htmlFor={id} style={styles.label}>
        Reason for cancelling (shown to the passenger and the driver)
      </label>
      <textarea
        id={id}
        name="reason"
        required
        minLength={3}
        maxLength={300}
        style={styles.textarea}
      />
      <div style={styles.buttonRow}>
        <button type="submit" disabled={pending} style={styles.buttonDanger}>
          {pending ? 'Cancelling…' : 'Cancel this ride'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}
