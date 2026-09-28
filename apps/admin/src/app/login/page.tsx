'use client';

import { useActionState, useEffect, useRef, type CSSProperties } from 'react';
import { APP_NAME } from '@yatri/shared';

import { loginAction, type LoginFormState } from './actions';

const initialState: LoginFormState = {};

export default function LoginPage() {
  const [state, formAction, isPending] = useActionState(loginAction, initialState);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (state.error) errorRef.current?.focus();
  }, [state.error]);

  return (
    <main style={styles.main}>
      <form action={formAction} style={styles.card} noValidate>
        <h1 style={styles.title}>{APP_NAME} Admin</h1>
        <p style={styles.subtitle}>Sign in to manage the platform.</p>

        {state.error ? (
          <p
            ref={errorRef}
            role="alert"
            tabIndex={-1}
            style={styles.formError}
            aria-live="assertive"
          >
            {state.error}
          </p>
        ) : null}

        <div style={styles.field}>
          <label htmlFor="email" style={styles.label}>
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            aria-invalid={state.fieldErrors?.email ? true : undefined}
            aria-describedby={state.fieldErrors?.email ? 'email-error' : undefined}
            style={styles.input}
          />
          {state.fieldErrors?.email ? (
            <p id="email-error" role="alert" style={styles.fieldError}>
              {state.fieldErrors.email}
            </p>
          ) : null}
        </div>

        <div style={styles.field}>
          <label htmlFor="password" style={styles.label}>
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            aria-invalid={state.fieldErrors?.password ? true : undefined}
            aria-describedby={state.fieldErrors?.password ? 'password-error' : undefined}
            style={styles.input}
          />
          {state.fieldErrors?.password ? (
            <p id="password-error" role="alert" style={styles.fieldError}>
              {state.fieldErrors.password}
            </p>
          ) : null}
        </div>

        <button
          type="submit"
          disabled={isPending}
          aria-busy={isPending}
          style={{ ...styles.button, opacity: isPending ? 0.7 : 1 }}
        >
          {isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

const styles: Record<string, CSSProperties> = {
  main: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    padding: 32,
    borderRadius: 16,
    border: '1px solid var(--color-border)',
    background: 'var(--color-surface)',
  },
  title: { margin: 0, fontSize: 24, color: 'var(--color-primary)' },
  subtitle: { margin: '0 0 8px', color: 'var(--color-text-secondary)', fontSize: 14 },
  formError: {
    margin: 0,
    padding: '10px 12px',
    borderRadius: 8,
    background: '#fdecea',
    color: '#8a1c1c',
    fontSize: 14,
  },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' },
  input: {
    minHeight: 44,
    padding: '0 12px',
    borderRadius: 8,
    border: '1px solid var(--color-border)',
    fontSize: 16,
  },
  fieldError: { margin: 0, fontSize: 13, color: '#b3261e' },
  button: {
    minHeight: 44,
    borderRadius: 999,
    border: 'none',
    background: 'var(--color-primary)',
    color: '#fff',
    fontSize: 16,
    fontWeight: 700,
    cursor: 'pointer',
    marginTop: 8,
  },
};
