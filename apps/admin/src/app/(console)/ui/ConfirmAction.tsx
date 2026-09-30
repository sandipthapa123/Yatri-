'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';

import { styles } from '../drivers/styles';
import { useWhenDone } from './useWhenDone';

export interface ConfirmState {
  error?: string;
  done?: string;
}

/**
 * A destructive or financial action behind an in-page confirmation (never a browser dialog).
 *
 *  1. The button only OPENS the confirmation; nothing happens yet.
 *  2. The confirmation says exactly what will happen, asks for the reason (kept in the audit log),
 *     and has "Confirm" and "Go back". Focus moves into it when it opens and returns to the button
 *     when it closes, so a keyboard user is never lost. Escape goes back.
 *  3. The result is announced in a status region.
 */
export function ConfirmAction(props: {
  action: (prev: ConfirmState, formData: FormData) => Promise<ConfirmState>;
  hidden?: Record<string, string>;
  label: string;
  /** What will happen, in a sentence: shown in the confirmation. */
  consequence: string;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  reasonLabel?: string;
}) {
  const [state, action, pending] = useActionState(props.action, {});
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const reason = useRef<HTMLTextAreaElement>(null);
  const headingId = useId();
  const reasonId = useId();
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) reason.current?.focus();
    else if (wasOpen.current) opener.current?.focus();
    wasOpen.current = open;
  }, [open]);
  // A finished action closes the confirmation (the result stays visible in the status region).
  useWhenDone(
    state,
    (s) => !!s.done,
    () => setOpen(false),
  );

  const tone = props.tone === 'primary' ? styles.buttonPrimary : styles.buttonDanger;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {open ? (
        <form
          action={action}
          role="group"
          aria-labelledby={headingId}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          {Object.entries(props.hidden ?? {}).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <h3 id={headingId} style={{ margin: 0, fontSize: 16 }}>
            Are you sure? {props.consequence}
          </h3>
          <label htmlFor={reasonId} style={styles.label}>
            {props.reasonLabel ?? 'Reason (kept in the audit log)'}
          </label>
          <textarea
            id={reasonId}
            ref={reason}
            name="reason"
            required
            minLength={3}
            maxLength={300}
            style={styles.textarea}
          />
          <div style={styles.buttonRow}>
            <button type="submit" disabled={pending} style={tone}>
              {pending ? 'Working…' : props.confirmLabel}
            </button>
            <button type="button" onClick={() => setOpen(false)} style={styles.buttonSecondary}>
              Go back
            </button>
          </div>
        </form>
      ) : (
        <div style={styles.buttonRow}>
          <button ref={opener} type="button" onClick={() => setOpen(true)} style={tone}>
            {props.label}…
          </button>
        </div>
      )}
      <div role="status" aria-live="polite">
        {state.error ? <p style={styles.errorText}>{state.error}</p> : null}
        {state.done ? <p style={{ margin: 0, fontSize: 14 }}>{state.done}</p> : null}
      </div>
    </div>
  );
}
