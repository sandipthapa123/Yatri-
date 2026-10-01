import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CITY_STATUS_LABELS, RANGE_PRESET_LABELS, formatNpr, type RangePreset } from '@yatri/types';

import { ApiError, getCityAnalyticsApi, getCityApi } from '../../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../drivers/styles';
import { AuditTrail } from '../../safety/AuditTrail';
import {
  CategoriesForm,
  DocumentsForm,
  HoursForm,
  PaymentsForm,
  ProfileForm,
  SettingsForm,
  CityStatusForm,
  ZonesForm,
} from '../Forms';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string }>;
}

const RANGES: RangePreset[] = ['today', '7d', '30d', '90d'];
const caption = { textAlign: 'left', position: 'absolute', left: -9999 } as const;

/**
 * One city: its status and hours, boundary, vehicle types, payment options, fare, waiting and cancellation values,
 * driver requirements, and how it is doing. Every part is its own form with a stated reason and a version check, and
 * everything not set here is the platform value.
 */
export default async function CityPage({ params, searchParams }: PageProps) {
  const token = await requireAdminAccessToken();
  const { id } = await params;
  const sp = await searchParams;
  const range = RANGES.find((r) => r === sp.range) ?? '30d';
  let city;
  try {
    city = await getCityApi(token, id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const stats = await getCityAnalyticsApi(token, id, range).catch(() => null);
  const section = (key: string, title: string, body: React.ReactNode) => (
    <section aria-labelledby={`${key}-h`} style={styles.section}>
      <h2 id={`${key}-h`} style={styles.sectionTitle}>
        {title}
      </h2>
      {body}
    </section>
  );
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>{city.name}</h1>
        <Link href="/cities" style={styles.backLink}>
          ← Cities
        </Link>
      </div>

      {section(
        'sum',
        'Summary',
        <>
          <p style={{ margin: 0 }}>
            <strong>{CITY_STATUS_LABELS[city.status]}.</strong>{' '}
            {city.openNow ? 'Taking rides now.' : (city.closedReason ?? 'Not taking rides now.')}{' '}
            {city.provinceName} province. Hours: {city.hoursText}.
          </p>
          <CityStatusForm city={city} />
        </>,
      )}

      {section(
        'stats',
        'How it is doing',
        stats ? (
          <>
            <nav aria-label="Range" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {RANGES.map((r) => (
                <Link
                  key={r}
                  href={`/cities/${id}?range=${r}`}
                  aria-current={r === range ? 'true' : undefined}
                >
                  {RANGE_PRESET_LABELS[r]}
                </Link>
              ))}
            </nav>
            <p style={{ margin: 0 }}>
              {stats.range.label}: {stats.rides} rides, {stats.completed} completed,{' '}
              {stats.cancelled} cancelled, {stats.noDrivers} found no driver. Completion{' '}
              {stats.completionRatePercent === null
                ? 'not known yet'
                : `${stats.completionRatePercent}%`}
              . Fares {formatNpr(stats.grossFaresNpr)}. {stats.driversOnlineNow} drivers online now.
            </p>
            {stats.byCategory.length > 0 ? (
              <table style={styles.table}>
                <caption style={caption}>Rides by vehicle type in {city.name}</caption>
                <thead>
                  <tr>
                    {['Vehicle type', 'Rides', 'Fares'].map((h) => (
                      <th key={h} scope="col" style={styles.th}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stats.byCategory.map((c) => (
                    <tr key={c.code ?? 'none'}>
                      <th scope="row" style={{ ...styles.td, textAlign: 'left' }}>
                        {c.label ?? 'Unknown'}
                      </th>
                      <td style={styles.td}>{c.rides}</td>
                      <td style={styles.td}>{formatNpr(c.grossNpr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </>
        ) : (
          <p style={{ margin: 0 }}>The figures could not be loaded.</p>
        ),
      )}

      {section('zones', 'Boundary (service areas)', <ZonesForm city={city} />)}
      {section('hours', 'Opening hours', <HoursForm city={city} />)}
      {section('cats', 'Vehicle types', <CategoriesForm city={city} />)}
      {section('settings', 'Fares, waiting and cancellation', <SettingsForm city={city} />)}
      {section('pay', 'Payment options', <PaymentsForm city={city} />)}
      {section('docs', 'Driver requirements', <DocumentsForm city={city} />)}
      {section('profile', 'Details', <ProfileForm city={city} />)}
      <AuditTrail entries={city.audit} />
    </div>
  );
}
