'use client';

import { useActionState, useId } from 'react';

import { styles } from '../drivers/styles';
import { cancelRideAction, type RideActionState } from './actions';

function Feedback({ state }: { state: RideActionState }) {
  return (
    <div role="status" aria-live="polite">
      {state.error ? <p style={styles.errorText}>{state.error}</p> : null}
      {state.done ? <p style={{ margin: 0, fontSize: 14 }}>{state.done}</p> : null}
    </div>
  );
}

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
