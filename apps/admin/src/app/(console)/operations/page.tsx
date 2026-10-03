import Link from 'next/link';
import { describeHeatCell, ZONE_KIND_LABELS, type HeatmapData, formatWhen } from '@yatri/types';

import { getHeatmap } from '../../../lib/apiClient';
import { loadOrDenied } from '../../../lib/access';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { AutoRefresh } from '../rides/AutoRefresh';
import { NoAccess } from '../ui/NoAccess';

const CELL = 44;

/**
 * A picture of where requests and available drivers are, made of squares. The picture is only one way to
 * read it: the same squares are listed in words below it, and each square prints its own numbers. Counts
 * under the privacy minimum are never drawn or listed as numbers.
 */
function HeatGrid({ map }: { map: HeatmapData }) {
  if (map.cells.length === 0) return null;
  const rows = map.cells.map((c) => c.row);
  const cols = map.cells.map((c) => c.col);
  const minRow = Math.min(...rows);
  const maxRow = Math.max(...rows);
  const minCol = Math.min(...cols);
  const maxCol = Math.max(...cols);
  const width = (maxCol - minCol + 1) * CELL;
  const height = (maxRow - minRow + 1) * CELL;
  const peak = Math.max(1, ...map.cells.map((c) => c.requests ?? 0));
  const summary = `Map of ${map.cells.length} squares of about ${map.cellMeters} metres, north at the top. The squares are also listed in words below.`;
  return (
    <svg
      role="img"
      aria-label={summary}
      viewBox={`0 0 ${width} ${height}`}
      style={{
        maxWidth: '100%',
        width: Math.min(width, 640),
        border: '1px solid var(--color-border)',
      }}
    >
      <title>{summary}</title>
      {map.cells.map((c) => {
        const x = (c.col - minCol) * CELL;
        const y = (maxRow - c.row) * CELL; // north is up
        const strength = (c.requests ?? 0) / peak;
        return (
          <g key={`${c.row}:${c.col}`} aria-hidden="true">
            <rect
              x={x}
              y={y}
              width={CELL}
              height={CELL}
              fill="#0b5cab"
              fillOpacity={0.12 + 0.7 * strength}
              stroke="#0b5cab"
              strokeWidth={1}
            />
            <text x={x + 4} y={y + 16} fontSize={11} fill="#111">
              {`R ${c.requests ?? '<' + map.minCount}`}
            </text>
            <text x={x + 4} y={y + 34} fontSize={11} fill="#111">
              {`D ${c.drivers ?? '<' + map.minCount}`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Demand against supply right now, for the whole service and each zone, and what pricing is doing. */
export default async function OperationsPage() {
  const token = await requireAdminAccessToken();
  const { data: map, denied } = await loadOrDenied(() => getHeatmap(token));
  if (denied || !map) return <NoAccess what="the operations overview" />;

  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Demand, zones and pricing</h1>
        <Link href="/" style={styles.backLink}>
          ← Dashboard
        </Link>
      </div>
      <nav aria-label="Operations sections" style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <Link href="/operations/zones">Service zones</Link>
        <Link href="/operations/pricing">Pricing rules</Link>
        <Link href="/operations/incentives">Driver incentives</Link>
        <Link href="/settings">Dispatch and driver limits (Settings)</Link>
      </nav>
      <AutoRefresh seconds={30} />

      <section aria-labelledby="zone-h" style={styles.section}>
        <h2 id="zone-h" style={styles.sectionTitle}>
          Demand and supply by zone
        </h2>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
          Requests in the last {map.windowMinutes} minutes against drivers who are online, fresh and
          free for a ride right now. Ratio is requests per available driver. The multiplier is the
          highest one pricing gives in that zone at this moment.
        </p>
        <table style={styles.table}>
          <caption style={{ textAlign: 'left', position: 'absolute', left: -9999 }}>
            Demand and supply by zone
          </caption>
          <thead>
            <tr>
              {['Zone', 'Kind', 'Requests', 'Available drivers', 'Ratio', 'Price multiplier'].map(
                (h) => (
                  <th key={h} scope="col" style={styles.th}>
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {map.zones.map((z) => (
              <tr key={z.zoneId ?? 'all'}>
                <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                  {z.zoneName}
                </th>
                <td style={styles.td}>{z.kind ? ZONE_KIND_LABELS[z.kind] : 'All of it'}</td>
                <td style={styles.td}>{z.requests}</td>
                <td style={styles.td}>{z.availableDrivers}</td>
                <td style={styles.td}>{z.ratio}</td>
                <td style={styles.td}>
                  {z.surgeMultiplier > 1
                    ? `${z.surgeMultiplier} times (higher demand pricing)`
                    : 'Normal'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="map-h" style={styles.section}>
        <h2 id="map-h" style={styles.sectionTitle}>
          Where requests and drivers are
        </h2>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
          Squares of about {map.cellMeters} metres. R is requests and D is available drivers. A
          count below {map.minCount} is shown as &quot;fewer than {map.minCount}&quot; and quiet
          squares are left out, so no single driver or rider can be picked out. No driver position
          on this page is exact.
        </p>
        <HeatGrid map={map} />
        <h3 style={{ margin: 0, fontSize: 16 }}>The same squares in words</h3>
        {map.cells.length === 0 ? (
          <p style={{ margin: 0 }}>Nothing to show: no square has enough requests or drivers.</p>
        ) : (
          <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
            {map.cells.map((c) => (
              <li key={`${c.row}:${c.col}`}>{describeHeatCell(c, map.minCount)}</li>
            ))}
          </ol>
        )}
        <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-secondary)' }}>
          Generated {formatWhen(map.generatedAt, { style: 'time' })}.
        </p>
      </section>
    </div>
  );
}
