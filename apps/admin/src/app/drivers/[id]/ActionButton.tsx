'use client';

import { useActionState, useCallback } from 'react';

import { styles } from '../styles';
import type { ActionState } from './actions';
import { useActionGuard } from './ActionGuard';

interface Props {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  fields: Record<string, string>;
  label: string;
  pendingLabel?: string;
  variant?: 'primary' | 'secondary' | 'danger';
}

/** A one-click server action (approve document/vehicle, verify driver) with an inline error on failure — no dialog needed since it takes no input. */
export function ActionButton({ action, fields, label, pendingLabel, variant = 'primary' }: Props) {
  const { busy, guard } = useActionGuard();
  const guardedAction = useCallback(
    (prev: ActionState, formData: FormData) => guard(() => action(prev, formData), prev),
    [action, guard],
  );
  const [state, formAction, isPending] = useActionState(guardedAction, {});
  const disabled = isPending || busy;
  const buttonStyle =
    variant === 'danger'
      ? styles.buttonDanger
      : variant === 'secondary'
        ? styles.buttonSecondary
        : styles.buttonPrimary;

  return (
    <form action={formAction} style={{ display: 'inline-flex', flexDirection: 'column', gap: 6 }}>
      {Object.entries(fields).map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      <button
        type="submit"
        disabled={disabled}
        aria-busy={isPending}
        style={{ ...buttonStyle, opacity: disabled ? 0.6 : 1 }}
      >
        {isPending ? (pendingLabel ?? 'Working…') : label}
      </button>
      {state.error ? (
        <div role="alert">
          <p style={styles.errorText}>{state.error}</p>
          {state.missingRequirements && state.missingRequirements.length > 0 ? (
            <ul style={styles.missingList}>
              {state.missingRequirements.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
