import Link from 'next/link';
import {
  RISK_CATEGORY_LABELS,
  RISK_LEVELS,
  RISK_LEVEL_HELP,
  RISK_LEVEL_LABELS,
  formatWhen,
} from '@yatri/types';

import { getRiskOverview, listRiskUsersApi } from '../../../lib/apiClient';
import { loadOrDenied } from '../../../lib/access';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { NoAccess } from '../ui/NoAccess';
import { Pagination, withParams } from '../ui/Pagination';
import { SweepButton } from './Forms';
import { RiskNav, levelText } from './parts';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<{ level?: string; search?: string; page?: string }>;
}

/**
 * Who needs attention. The level is worked out by the server from the signals, any restriction and the account
 * status; this page only shows it, always in words. Nothing is suspended or banned by the system on its own.
 */
export default async function RiskPage({ searchParams }: PageProps) {
  const token = await requireAdminAccessToken();
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const level = RISK_LEVELS.find((l) => l === sp.level);
  const { data, denied } = await loadOrDenied(() =>
    Promise.all([
      getRiskOverview(token),
      listRiskUsersApi(token, {
        ...(level ? { level } : {}),
        ...(sp.search ? { search: sp.search } : {}),
        page,
        pageSize: PAGE_SIZE,
      }),
    ]),
  );
  if (denied || !data) return <NoAccess what="fraud and risk" />;
  const [overview, users] = data;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Fraud and risk</h1>
        <Link href="/" style={styles.backLink}>
          ← Dashboard
        </Link>
      </div>
      <RiskNav />

      <section aria-labelledby="sum-h" style={styles.section}>
        <h2 id="sum-h" style={styles.sectionTitle}>
          Summary
        </h2>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li>
            <Link href="/risk?level=REVIEW_REQUIRED">{overview.reviewRequired} need a review</Link>
          </li>
          <li>
            <Link href="/risk?level=RESTRICTED">{overview.restricted} restricted for now</Link>
          </li>
          <li>
            <Link href="/risk?level=SUSPENDED">{overview.suspended} suspended with signals</Link>
          </li>
          <li>
            <Link href="/risk/events?status=OPEN">{overview.openEvents} open signals</Link>,{' '}
            {overview.eventsLast24h} raised in the last day
          </li>
        </ul>
        <p style={{ margin: 0 }}>
          A signal is a reason to look, not proof. A person needs a review at {overview.reviewScore}{' '}
          points.{' '}
          {overview.autoRestrictScore > 0
            ? `Several different signals reaching ${overview.autoRestrictScore} points restrict an account for a short time. `
            : 'Nothing restricts an account unless a person does it. '}
          The system never suspends or bans anyone.
        </p>
        {overview.byCategory.length > 0 ? (
          <table style={styles.table}>
            <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>
              Open signals by kind
            </caption>
            <thead>
              <tr>
                <th scope="col" style={styles.th}>
                  Kind
                </th>
                <th scope="col" style={styles.th}>
                  Open signals
                </th>
              </tr>
            </thead>
            <tbody>
              {overview.byCategory.map((c) => (
                <tr key={c.category}>
                  <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                    <Link href={`/risk/events?status=OPEN&category=${c.category}`}>
                      {RISK_CATEGORY_LABELS[c.category]}
                    </Link>
                  </th>
                  <td style={styles.td}>{c.open}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <SweepButton />
      </section>

      <section aria-labelledby="people-h" style={styles.section}>
        <h2 id="people-h" style={styles.sectionTitle}>
          People with signals
        </h2>
        <form method="get" style={styles.filterForm} role="search" aria-label="Filter people">
          <div style={styles.field}>
            <label htmlFor="level" style={styles.label}>
              Level
            </label>
            <select id="level" name="level" defaultValue={level ?? ''} style={styles.select}>
              <option value="">All levels</option>
              {RISK_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {RISK_LEVEL_LABELS[l]}
                </option>
              ))}
            </select>
          </div>
          <div style={styles.field}>
            <label htmlFor="search" style={styles.label}>
              Name
            </label>
            <input id="search" name="search" defaultValue={sp.search ?? ''} style={styles.input} />
          </div>
          <button type="submit" style={styles.buttonSecondary}>
            Filter
          </button>
        </form>
        {level ? <p style={{ margin: 0 }}>{RISK_LEVEL_HELP[level]}</p> : null}
        {users.items.length === 0 ? (
          <p style={{ margin: 0 }}>Nobody matches.</p>
        ) : (
          <table style={styles.table}>
            <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>
              People with risk signals, most serious first
            </caption>
            <thead>
              <tr>
                {['Person', 'Role', 'Level', 'Score', 'Open signals', 'Last signal'].map((h) => (
                  <th key={h} scope="col" style={styles.th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.items.map((u) => (
                <tr key={u.userId}>
                  <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                    <Link href={`/risk/users/${u.userId}`}>{u.name ?? 'Unnamed person'}</Link>
                  </th>
                  <td style={styles.td}>{u.role.toLowerCase()}</td>
                  <td style={styles.td}>{levelText(u.level)}</td>
                  <td style={styles.td}>{u.score}</td>
                  <td style={styles.td}>{u.openEvents}</td>
                  <td style={styles.td}>
                    {u.lastEventAt ? formatWhen(u.lastEventAt) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={users.total}
          href={(p) =>
            withParams('/risk', { page: String(p), level: level ?? '', search: sp.search ?? '' })
          }
        />
      </section>
    </div>
  );
}
