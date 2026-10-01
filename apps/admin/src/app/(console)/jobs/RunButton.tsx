'use client';

import { useActionState } from 'react';

import { styles } from '../drivers/styles';
import { Feedback } from '../ui/FormParts';
import { runJobAction } from './actions';

/** Runs one background job now. The button names the job, so a screen reader hears which one. */
export function RunJobButton({ name, label }: { name: string; label: string }) {
  const [state, action, pending] = useActionState(runJobAction, {});
  return (
    <form action={action}>
      <input type="hidden" name="name" value={name} />
      <button type="submit" disabled={pending} style={styles.buttonSecondary}>
        {pending ? 'Running…' : `Run ${label} now`}
      </button>
      <Feedback state={state} />
    </form>
  );
}
