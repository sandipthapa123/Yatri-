export default function Loading() {
  return (
    <main
      role="status"
      aria-live="polite"
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--color-text-secondary)',
      }}
    >
      Loading…
    </main>
  );
}
