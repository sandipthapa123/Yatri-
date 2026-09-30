'use client';

import { useActionState, useCallback, useEffect, useId, useRef } from 'react';

import { styles } from '../styles';
import type { ActionState } from './actions';
import { useActionGuard } from './ActionGuard';

interface Props {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  fields: Record<string, string>;
  triggerLabel: string;
  dialogTitle: string;
  submitLabel: string;
  variant?: 'primary' | 'danger';
}

/**
 * A native <dialog> for actions that require a reason (reject/suspend). The
 * browser handles focus trapping and Escape-to-close for free, which is
 * more reliably accessible than a hand-rolled modal.
 */
export function ReasonDialogForm({
  action,
  fields,
  triggerLabel,
  dialogTitle,
  submitLabel,
  variant = 'danger',
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { busy, guard } = useActionGuard();
  const guardedAction = useCallback(
    (prev: ActionState, formData: FormData) => guard(() => action(prev, formData), prev),
    [action, guard],
  );
  const [state, formAction, isPending] = useActionState(guardedAction, {});
  const wasPending = useRef(false);
  const reactId = useId();
  const titleId = `${reactId}-title`;
  const reasonId = `${reactId}-reason`;
  const errorId = `${reactId}-error`;

  useEffect(() => {
    // Close the dialog once a submission succeeds (the action returned no error).
    if (wasPending.current && !isPending && !state.error) {
      dialogRef.current?.close();
    }
    wasPending.current = isPending;
  }, [isPending, state.error]);

  const buttonStyle = variant === 'danger' ? styles.buttonDanger : styles.buttonPrimary;

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        disabled={busy}
        style={{ ...styles.buttonSecondary, opacity: busy ? 0.6 : 1 }}
      >
        {triggerLabel}
      </button>
      <dialog ref={dialogRef} style={styles.dialog} aria-labelledby={titleId}>
        <form action={formAction} style={styles.dialogBody}>
          <h2 id={titleId} style={{ margin: 0, fontSize: 18 }}>
            {dialogTitle}
          </h2>
          {Object.entries(fields).map(([key, value]) => (
            <input key={key} type="hidden" name={key} value={value} />
          ))}
          <label htmlFor={reasonId} style={styles.label}>
            Reason
          </label>
          <textarea
            id={reasonId}
            name="reason"
            required
            minLength={5}
            maxLength={1000}
            style={styles.textarea}
            aria-describedby={state.error ? errorId : undefined}
            aria-invalid={state.error ? true : undefined}
          />
          {state.error ? (
            <p id={errorId} role="alert" style={styles.errorText}>
              {state.error}
            </p>
          ) : null}
          <div style={styles.buttonRow}>
            <button
              type="submit"
              disabled={isPending || busy}
              aria-busy={isPending}
              style={{ ...buttonStyle, opacity: isPending || busy ? 0.7 : 1 }}
            >
              {isPending ? 'Submitting…' : submitLabel}
            </button>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              style={styles.buttonSecondary}
            >
              Cancel
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
