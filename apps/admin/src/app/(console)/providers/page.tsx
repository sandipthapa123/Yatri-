import { formatWhen } from '@yatri/types';
import Link from 'next/link';

import { loadOrDenied } from '../../../lib/access';
import { providersApi } from '../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { NoAccess } from '../ui/NoAccess';

/**
 * The outside services Yatri depends on, and whether each one is working. Status only: the name of the service, a state in
 * words, today's counts and the kind of the last failure. There are no keys, accounts, addresses or vendor messages on this
 * screen, because none of them ever reach the browser. Each state is a sentence, never only a colour.
 */
export default async function ProvidersPage() {
  const token = await requireAdminAccessToken();
  const { data, denied } = await loadOrDenied(() => providersApi(token));
  if (denied || !data) return <NoAccess what="service provider status" />;
  const trouble = data.items.filter(
    (i) => i.state === 'DOWN' || i.state === 'DEGRADED' || i.state === 'NOT_CONFIGURED',
  ).length;
  const unchecked = data.items.filter(
    (i) => i.state === 'SIMULATED' || i.state === 'UNVERIFIED',
  ).length;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Service providers</h1>
        <Link href="/" style={styles.backLink}>
          ← Dashboard
        </Link>
      </div>
      <p style={{ margin: 0 }}>
        Environment: <strong>{data.environment.toLowerCase()}</strong>. Which service fills each
        need is set by the server&apos;s configuration, not here. This page only shows how they are
        doing.
      </p>
      <p role="status" style={{ margin: 0, fontWeight: 600 }}>
        {data.problems.length === 0 && trouble === 0
          ? `No service is reporting a problem.${unchecked > 0 ? ` ${unchecked} ${unchecked === 1 ? 'is a development stand-in or has' : 'are development stand-ins or have'} not been checked yet.` : ''}`
          : `${data.problems.length + trouble} thing${data.problems.length + trouble === 1 ? ' needs' : 's need'} attention.`}
      </p>
      {data.problems.length > 0 && (
        <section aria-labelledby="provider-problems">
          <h2 id="provider-problems" style={{ fontSize: 18, margin: '8px 0' }}>
            Configuration problems
          </h2>
          <ul>
            {data.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </section>
      )}
      <table style={styles.table}>
        <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>
          Service providers
        </caption>
        <thead>
          <tr>
            {[
              'Service',
              'Provider',
              'State',
              'Last checked',
              'Calls today',
              'Failed today',
              'Last problem',
            ].map((h) => (
              <th key={h} scope="col" style={styles.th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.items.map((i) => (
            <tr key={i.capability}>
              <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                {i.label}
                <div style={{ fontWeight: 400, fontSize: 13 }}>{i.help}</div>
              </th>
              <td style={styles.td}>{i.provider}</td>
              <td style={styles.td}>
                {i.state === 'UP'
                  ? 'OK: '
                  : i.state === 'SIMULATED' || i.state === 'UNVERIFIED'
                    ? 'Note: '
                    : 'Needs attention: '}
                {i.stateText}
              </td>
              <td style={styles.td}>
                {i.checkedAt ? formatWhen(i.checkedAt) : 'Not checked'}
                {i.latencyMs !== null ? ` (${i.latencyMs} ms)` : ''}
              </td>
              <td style={styles.td}>{i.callsToday}</td>
              <td style={styles.td}>{i.failuresToday}</td>
              <td style={styles.td}>
                {i.lastFailureKind ? i.lastFailureKind.toLowerCase().replace(/_/g, ' ') : 'None'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
