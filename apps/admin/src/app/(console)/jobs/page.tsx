import Link from 'next/link';

import { listJobsApi } from '../../../lib/apiClient';
import { loadOrDenied } from '../../../lib/access';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { NoAccess } from '../ui/NoAccess';
import { RunJobButton } from './RunButton';

/**
 * Everything Yatri does on a timer, in one list: when each job last ran and how it ended. A job that failed or is
 * running late says so in words (not only a colour). Running one by hand needs the settings permission; the API checks.
 */
export default async function JobsPage() {
  const token = await requireAdminAccessToken();
  const { data: jobs, denied } = await loadOrDenied(() => listJobsApi(token));
  if (denied || !jobs) return <NoAccess what="background jobs" />;
  const unhealthy = jobs.filter((j) => !j.healthy).length;
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Background jobs</h1>
        <Link href="/" style={styles.backLink}>
          ← Dashboard
        </Link>
      </div>
      <p style={{ margin: 0 }}>
        These run by themselves: ending expired rides, taking silent drivers offline, retrying
        notifications, checking payments and dates. Each runs once at a time however many servers
        there are.
      </p>
      <p role="status" style={{ margin: 0, fontWeight: 600 }}>
        {unhealthy === 0
          ? 'All jobs are running as expected.'
          : `${unhealthy} job${unhealthy === 1 ? ' needs' : 's need'} attention.`}
      </p>
      <table style={styles.table}>
        <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>
          Background jobs
        </caption>
        <thead>
          <tr>
            {['Job', 'What it does', 'Runs every', 'State', 'Last result', 'Run now'].map((h) => (
              <th key={h} scope="col" style={styles.th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.name}>
              <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                {j.label}
              </th>
              <td style={styles.td}>{j.help}</td>
              <td style={styles.td}>
                {j.everySeconds < 120
                  ? `${j.everySeconds} seconds`
                  : `${Math.round(j.everySeconds / 60)} minutes`}
              </td>
              <td style={styles.td}>
                {j.healthy ? 'OK: ' : 'Needs attention: '}
                {j.statusText}
              </td>
              <td style={styles.td}>
                {j.lastRun?.error ??
                  (j.lastRun?.result ? JSON.stringify(j.lastRun.result) : 'No result recorded')}
              </td>
              <td style={styles.td}>
                <RunJobButton name={j.name} label={j.label} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
