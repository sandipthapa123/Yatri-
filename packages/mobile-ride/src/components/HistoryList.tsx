import { formatNpr, type TripRole, type TripSummary } from '@yatri/types';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { outcomeText } from '../rideActions';
import { formatDateTime } from '../rideText';
import { rideApi } from '../rideApi';
import { ActionButton, type UiProps } from './RideUi';

const PAGE = 20;

/** One history row as a single sentence group, so a screen reader reads it as one item. */
export function historyLabel(t: TripSummary, role: TripRole): string {
  const money =
    t.status === 'COMPLETED' && t.fare
      ? ` Fare ${formatNpr(t.fare.finalNpr ?? t.fare.estimateNpr)}.${t.paymentStatus === 'PAID' ? ' Paid.' : ''}`
      : '';
  return `${formatDateTime(t.requestedAt)}. ${t.pickup.name} to ${t.destination.name}. ${outcomeText(t, role)}${money}`;
}

/** The person's past rides, newest first, fetched a page at a time from the server. */
export function HistoryList(
  props: UiProps & {
    role: TripRole;
    getAccessToken: () => Promise<string>;
    onOpen: (tripId: string) => void;
  },
) {
  const { role, getAccessToken, colors, minTouchTarget } = props;
  const [items, setItems] = useState<TripSummary[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (page: number) => {
      setLoading(true);
      setError(null);
      try {
        const r = await rideApi.history(await getAccessToken(), page, PAGE);
        setItems((prev) => (page === 1 ? r.items : [...prev, ...r.items]));
        setTotal(r.total);
      } catch {
        setError('Could not load your rides.');
      } finally {
        setLoading(false);
      }
    },
    [getAccessToken],
  );
  useEffect(() => {
    void load(1);
  }, [load]);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={[styles.h, { color: colors.textPrimary }]}>
        Your rides
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error}
        </Text>
      ) : null}
      {total === 0 ? (
        <Text style={{ color: colors.textSecondary }}>You have no past rides yet.</Text>
      ) : null}
      <View accessibilityRole="list" style={styles.list}>
        {items.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => props.onOpen(t.id)}
            accessibilityRole="button"
            accessibilityLabel={historyLabel(t, role)}
            accessibilityHint="Opens this ride"
            style={[
              styles.row,
              {
                minHeight: minTouchTarget,
                borderColor: colors.border,
                backgroundColor: colors.surface,
              },
            ]}
          >
            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
              {formatDateTime(t.requestedAt)}
            </Text>
            <Text style={{ color: colors.textPrimary, fontWeight: '600', fontSize: 16 }}>
              {t.pickup.name} to {t.destination.name}
            </Text>
            <Text style={{ color: colors.textPrimary }}>{outcomeText(t, role)}</Text>
            {t.status === 'COMPLETED' && t.fare ? (
              <Text style={{ color: colors.textSecondary }}>
                {formatNpr(t.fare.finalNpr ?? t.fare.estimateNpr)}
                {t.paymentStatus === 'PAID' ? ' · Paid' : ''}
              </Text>
            ) : null}
          </Pressable>
        ))}
      </View>
      {loading ? <ActivityIndicator accessibilityLabel="Loading rides" /> : null}
      {total !== null && items.length < total && !loading ? (
        <ActionButton
          colors={colors}
          minTouchTarget={minTouchTarget}
          label="Show more rides"
          onPress={() => void load(Math.floor(items.length / PAGE) + 1)}
        />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 12 },
  h: { fontSize: 22, fontWeight: '700' },
  list: { gap: 10 },
  row: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 2 },
});
