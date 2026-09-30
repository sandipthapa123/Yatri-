/** Shown inside the console shell while a page loads, so the menu stays put and is announced politely. */
export default function ConsoleLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{ padding: 24, color: 'var(--color-text-secondary)' }}
    >
      Loading…
    </div>
  );
}
