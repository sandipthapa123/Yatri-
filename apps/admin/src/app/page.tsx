import { APP_NAME } from '@yatri/shared';

export default function DashboardPage() {
  return (
    <main
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
      <h1 style={{ color: 'var(--color-primary)', fontSize: 32, margin: 0 }}>{APP_NAME} Admin</h1>
      <p style={{ color: 'var(--color-text-secondary)', maxWidth: 420, margin: 0 }}>
        The operations dashboard foundation is set up. Fleet, trip, and payout views ship in a later
        phase.
      </p>
    </main>
  );
}
