'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main
      role="alert"
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 24,
        textAlign: 'center',
      }}
    >
      <h1 style={{ margin: 0 }}>Something went wrong</h1>
      <button
        type="button"
        onClick={reset}
        style={{
          minHeight: 44,
          padding: '0 20px',
          borderRadius: 999,
          border: 'none',
          background: 'var(--color-primary)',
          color: '#fff',
          fontSize: 16,
          cursor: 'pointer',
        }}
      >
        Try again
      </button>
    </main>
  );
}
