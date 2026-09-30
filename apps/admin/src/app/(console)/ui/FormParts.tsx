'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { styles } from '../drivers/styles';

const column = { display: 'flex', flexDirection: 'column', gap: 8 } as const;

/** The result of an action, in a status region so it is announced; problems start with the word Problem. */
export function Feedback({ state }: { state: { error?: string; done?: string } }) {
  return (
    <div role="status" aria-live="polite">
      {state.error ? <p style={styles.errorText}>Problem: {state.error}</p> : null}
      {state.done ? <p style={{ margin: 0, fontSize: 14 }}>{state.done}</p> : null}
    </div>
  );
}

/**
 * A change that affects real riders or drivers is confirmed in the page first: the sentence says what it
 * will do, focus moves to it, and Escape goes back. The reason is kept in the audit log.
 */
export function Confirmed({
  pending,
  consequence,
  label,
  children,
}: {
  pending: boolean;
  consequence: string;
  label: string;
  children?: ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const reasonId = useId();
  useEffect(() => {
    if (confirming) heading.current?.focus();
  }, [confirming]);
  return (
    <>
      {children}
      <label htmlFor={reasonId} style={styles.label}>
        Reason (kept in the audit log)
      </label>
      <input
        id={reasonId}
        name="reason"
        required
        minLength={3}
        maxLength={300}
        style={styles.input}
      />
      {confirming ? (
        <div
          role="group"
          aria-label="Confirm this change"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setConfirming(false);
          }}
          style={column}
        >
          <h4 ref={heading} tabIndex={-1} style={{ margin: 0, fontSize: 16 }}>
            Are you sure? {consequence}
          </h4>
          <div style={styles.buttonRow}>
            <button type="submit" disabled={pending} style={styles.buttonDanger}>
              {pending ? 'Saving…' : 'Yes, save it'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              style={styles.buttonSecondary}
            >
              Go back
            </button>
          </div>
        </div>
      ) : (
        <div style={styles.buttonRow}>
          <button type="button" onClick={() => setConfirming(true)} style={styles.buttonPrimary}>
            {label}…
          </button>
        </div>
      )}
    </>
  );
}

export function Checkbox({
  name,
  label,
  checked,
}: {
  name: string;
  label: string;
  checked: boolean;
}) {
  return (
    <label>
      <input type="checkbox" name={name} defaultChecked={checked} /> {label}
    </label>
  );
}

export function Select({
  name,
  label,
  value,
  blank,
  items,
}: {
  name: string;
  label: string;
  value: string | null;
  blank: string;
  items: Array<{ id: string; label: string }>;
}) {
  const id = useId();
  return (
    <>
      <label htmlFor={id} style={styles.label}>
        {label}
      </label>
      <select id={id} name={name} defaultValue={value ?? ''} style={styles.select}>
        <option value="">{blank}</option>
        {items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.label}
          </option>
        ))}
      </select>
    </>
  );
}

export function Field({
  name,
  label,
  defaultValue,
  type = 'text',
  required = false,
  hint,
}: {
  name: string;
  label: string;
  defaultValue?: string | number | null;
  type?: string;
  required?: boolean;
  hint?: string;
}) {
  const id = useId();
  return (
    <>
      <label htmlFor={id} style={styles.label}>
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue ?? ''}
        aria-describedby={hint ? `${id}-h` : undefined}
        style={styles.input}
      />
      {hint ? (
        <p id={`${id}-h`} style={{ margin: 0, fontSize: 13, color: 'var(--color-text-secondary)' }}>
          {hint}
        </p>
      ) : null}
    </>
  );
}
