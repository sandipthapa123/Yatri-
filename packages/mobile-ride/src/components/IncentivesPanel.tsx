import { formatNpr, type DriverIncentivesView } from '@yatri/types';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { rideApi } from '../rideApi';
import { ActionButton, Card, Fact, type UiProps } from './RideUi';

/**
 * The driver's bonuses: every rule that is on, in a sentence, with where the driver stands on it and what
 * they have earned. All of it comes from the server (rules, progress and awards); nothing is worked out
 * here. A bonus is stated as a record, separate from the cash fares the driver collects.
 */
export function IncentivesPanel(
  props: UiProps & { getAccessToken: () => Promise<string>; onBack: () => void },
) {
  const { colors, minTouchTarget, getAccessToken } = props;
  const ui = { colors, minTouchTarget };
  const [view, setView] = useState<DriverIncentivesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setView(await rideApi.incentives(await getAccessToken()));
      setError(null);
    } catch {
      setError('Could not load your bonuses. Please try again.');
    }
  }, [getAccessToken]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={[styles.h, { color: colors.textPrimary }]}>
        Your bonuses
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {`Problem: ${error}`}
        </Text>
      ) : null}
      {!view && !error ? (
        <Text style={{ color: colors.textSecondary }}>Loading your bonuses…</Text>
      ) : null}
      {view ? (
        <>
          <Fact {...ui} label="Earned so far" value={formatNpr(view.totalEarnedNpr)} />
          <Text style={{ color: colors.textSecondary }}>{view.note}</Text>
          {view.progress.length === 0 ? (
            <Text style={{ color: colors.textPrimary }}>There are no bonuses on right now.</Text>
          ) : null}
          {view.progress.map((p) => (
            <Card key={p.rule.id} {...ui} title={p.rule.name}>
              <Text style={{ color: colors.textPrimary }}>{p.text}</Text>
              <View accessible accessibilityLabel={p.status}>
                <Text style={{ color: colors.textPrimary, fontWeight: '700' }}>{p.status}</Text>
              </View>
            </Card>
          ))}
        </>
      ) : null}
      <ActionButton {...ui} label="Refresh" onPress={() => void load()} />
      <ActionButton {...ui} label="Back" onPress={props.onBack} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 12 },
  h: { fontSize: 24, fontWeight: '700' },
});
