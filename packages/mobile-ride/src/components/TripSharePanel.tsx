import type { ShareInfo } from '@yatri/types';
import { useCallback, useEffect, useState } from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';

import { formatClockTime } from '../rideText';
import { rideApi } from '../rideApi';
import { ActionButton, Card, type UiProps } from './RideUi';

/**
 * Share this ride with someone you trust. The link is handed to the phone's own share sheet — the
 * person picks the contact there, so Yatri never sees or stores a phone number. The link is shown
 * once (it cannot be fetched again); active links are listed with a way to stop each. Starting and
 * stopping are ride events, so they are announced by the ride screen (from the events), not here.
 */
export function TripSharePanel(
  props: UiProps & { tripId: string; getAccessToken: () => Promise<string> },
) {
  const { tripId, getAccessToken, colors, minTouchTarget } = props;
  const ui = { colors, minTouchTarget };
  const [shares, setShares] = useState<ShareInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setShares(await rideApi.shares(await getAccessToken(), tripId));
    } catch {
      /* the panel still lets the passenger start a share */
    }
  }, [tripId, getAccessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await rideApi.createShare(await getAccessToken(), tripId);
      await load();
      // The OS share sheet: the passenger chooses who receives it.
      await Share.share({
        message: `Follow my Yatri ride live: ${created.url}`,
      }).catch(() => undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start sharing. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const stop = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await rideApi.stopShare(await getAccessToken(), tripId, id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not stop sharing. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const active = shares.filter((s) => s.active);
  return (
    <Card {...ui} title="Share this trip">
      <Text style={{ color: colors.textSecondary }}>
        Someone you trust can follow your driver, vehicle, location and arrival time until the ride
        ends. They do not need the app.
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error}
        </Text>
      ) : null}
      <ActionButton
        {...ui}
        label="Share with a trusted contact"
        tone="primary"
        busy={busy}
        onPress={() => void start()}
      />
      {active.length > 0 ? (
        <View style={styles.list} accessibilityRole="list">
          <Text style={{ color: colors.textPrimary, fontWeight: '600' }}>
            {active.length === 1
              ? 'This trip is shared with 1 link.'
              : `This trip is shared with ${active.length} links.`}
          </Text>
          {active.map((s, i) => (
            <ActionButton
              key={s.id}
              {...ui}
              label={`Stop sharing link ${i + 1}`}
              accessibilityLabel={`Stop sharing link ${i + 1}, created at ${formatClockTime(s.createdAt)}`}
              tone="danger"
              disabled={busy}
              onPress={() => void stop(s.id)}
            />
          ))}
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({ list: { gap: 8 } });
