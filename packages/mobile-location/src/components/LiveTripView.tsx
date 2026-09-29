import type { LiveTripSnapshot } from '@yatri/types';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, Text, View } from 'react-native';

import type { LiveTripState, SpokenMessage } from '../liveTripController';
import { summaryRows, type Viewer } from '../tripText';
import { YatriMap, type MapColors, type MapMarker } from './MapView';

export interface LiveTripViewProps {
  live: LiveTripState;
  viewer: Viewer;
  colors: MapColors & { background: string };
  minTouchTarget: number;
  /** Trip actions (arrived / start / cancel …) rendered after the status. */
  children?: ReactNode;
  /** Extra notice shown near the top, e.g. location-sharing problems. */
  notice?: string | null;
}

const AGE_TICK_MS = 5000;

/** Speak on iOS, where live regions are unreliable; other platforms use the live-region Text. */
function useSpoken(message: SpokenMessage | null) {
  useEffect(() => {
    if (message && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(message.text);
  }, [message]);
}

/**
 * The trip, described. The map is one optional, screen-reader-hidden
 * picture; "Live trip status" is the real interface: a header, two
 * announcement regions (polite for routine changes, assertive for genuinely
 * important ones), and a structured list that carries every fact the map
 * shows — distance, the three kinds of time, place, status, pickup,
 * destination, accuracy, and how old the last update is.
 */
export function LiveTripView({
  live,
  viewer,
  colors,
  minTouchTarget,
  children,
  notice,
}: LiveTripViewProps) {
  const { snapshot, receivedAtMs, polite, assertive, connection, connectionNotice } = live;
  useSpoken(polite);
  useSpoken(assertive);
  useSpoken(connectionNotice ? { id: -1, text: connectionNotice } : null);

  // Age the "last update" locally so it stays truthful between pushes — without a request and
  // without putting a ticking number inside a live region.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), AGE_TICK_MS);
    return () => clearInterval(t);
  }, []);

  const aged: LiveTripSnapshot | null = useMemo(() => {
    if (!snapshot) return null;
    const extra = receivedAtMs ? Math.max(0, Math.round((nowMs - receivedAtMs) / 1000)) : 0;
    const bump = (p: LiveTripSnapshot['driver']) =>
      p
        ? {
            ...p,
            ageSeconds: p.ageSeconds + extra,
            freshness:
              p.ageSeconds + extra > 60
                ? ('lost' as const)
                : p.ageSeconds + extra > 15
                  ? ('stale' as const)
                  : p.freshness,
          }
        : p;
    return { ...snapshot, driver: bump(snapshot.driver), passenger: bump(snapshot.passenger) };
  }, [snapshot, receivedAtMs, nowMs]);

  const rows = aged ? summaryRows(aged, viewer) : [];

  const markers: MapMarker[] = useMemo(() => {
    if (!snapshot) return [];
    const m: MapMarker[] = [
      {
        id: 'pickup',
        latitude: snapshot.pickup.latitude,
        longitude: snapshot.pickup.longitude,
        glyph: 'P',
        label: `Pickup: ${snapshot.pickup.name}`,
      },
      {
        id: 'dest',
        latitude: snapshot.destination.latitude,
        longitude: snapshot.destination.longitude,
        glyph: 'X',
        label: `Destination: ${snapshot.destination.name}`,
      },
    ];
    if (snapshot.driver) {
      m.push({
        id: 'driver',
        latitude: snapshot.driver.latitude,
        longitude: snapshot.driver.longitude,
        glyph: 'D',
        label: 'Driver',
      });
    }
    if (snapshot.passenger) {
      m.push({
        id: 'passenger',
        latitude: snapshot.passenger.latitude,
        longitude: snapshot.passenger.longitude,
        glyph: viewer === 'PASSENGER' ? 'Y' : 'R',
        label: viewer === 'PASSENGER' ? 'You' : 'Rider',
      });
    }
    return m;
  }, [snapshot, viewer]);

  const center = snapshot?.driver ?? snapshot?.pickup ?? null;

  return (
    <View style={styles.container}>
      <View accessibilityRole="header" accessible>
        <Text style={[styles.heading, { color: colors.textPrimary }]}>Live trip status</Text>
      </View>

      {/* Important changes: assertive. Always mounted so the region exists before its text changes. */}
      <View accessibilityLiveRegion="assertive" accessibilityRole="alert">
        {assertive ? (
          <Text
            key={assertive.id}
            style={[styles.banner, { color: colors.textPrimary, borderColor: colors.primary }]}
          >
            {assertive.text}
          </Text>
        ) : null}
      </View>

      {/* Routine changes: polite, rate limited by the announcement policy. */}
      <View accessibilityLiveRegion="polite">
        <Text
          key={polite?.id ?? 0}
          style={{ color: colors.textPrimary, fontSize: 17, lineHeight: 24 }}
        >
          {polite?.text ?? (snapshot ? '' : 'Waiting for the trip status.')}
        </Text>
      </View>

      <View accessibilityLiveRegion="polite">
        <Text
          style={{ color: connection === 'reconnecting' ? colors.error : colors.textSecondary }}
        >
          {connectionNotice}
        </Text>
      </View>
      {notice ? (
        <View accessibilityRole="alert" accessibilityLiveRegion="polite">
          <Text style={{ color: colors.error }}>{notice}</Text>
        </View>
      ) : null}

      {/* The full journey as text — complete even if the map cannot be used at all. */}
      <View
        accessibilityRole="list"
        style={[styles.list, { borderColor: colors.border, backgroundColor: colors.surface }]}
      >
        {rows.length === 0 ? (
          <Text style={{ color: colors.textSecondary }}>No live information yet.</Text>
        ) : (
          rows.map((r) => (
            <View
              key={r.label}
              accessible
              accessibilityLabel={`${r.label}: ${r.value}`}
              style={[styles.row, { minHeight: minTouchTarget - 8 }]}
            >
              <Text style={[styles.label, { color: colors.textSecondary }]}>{r.label}</Text>
              <Text style={[styles.value, { color: colors.textPrimary }]}>{r.value}</Text>
            </View>
          ))
        )}
      </View>

      {children}

      {center ? (
        <View style={styles.map}>
          <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
            Map (a visual extra; everything above is available as text)
          </Text>
          <YatriMap
            center={center}
            markers={markers}
            colors={colors}
            minTouchTarget={minTouchTarget}
            zoom={15}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 14 },
  heading: { fontSize: 22, fontWeight: '700' },
  banner: { borderWidth: 2, borderRadius: 12, padding: 12, fontSize: 17, fontWeight: '700' },
  list: { borderWidth: 1, borderRadius: 14, padding: 10, gap: 2 },
  row: { paddingVertical: 6, justifyContent: 'center' },
  label: { fontSize: 13 },
  value: { fontSize: 17, fontWeight: '600' },
  map: { gap: 6 },
});
