import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ApiError, useAuth } from '@yatri/mobile-auth';
import {
  BROADCAST_MESSAGES,
  LiveTripView,
  tripsApi,
  useLiveTrip,
  useLocationBroadcast,
} from '@yatri/mobile-location';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../navigation/RootNavigator';
import { useTheme } from '../theme/useTheme';

type Props = NativeStackScreenProps<RootStackParamList, 'DriverTrip'>;

type Action = 'arrived' | 'start' | 'complete' | 'cancel';

/**
 * Driver's active trip. While the trip is active the phone's GPS is sent to
 * the trip (foreground only) and the passenger sees it live. Sharing stops
 * the moment the trip ends or this screen closes.
 */
export function DriverTripScreen({ navigation, route }: Props) {
  const theme = useTheme();
  const { getAccessToken } = useAuth();
  const { tripId } = route.params;
  const live = useLiveTrip(tripId, getAccessToken, 'DRIVER');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const status = live.snapshot?.status ?? null;
  const active =
    status === 'DRIVER_EN_ROUTE' || status === 'DRIVER_ARRIVED' || status === 'IN_PROGRESS';
  const broadcast = useLocationBroadcast({
    client: live.client,
    kind: 'driver_location',
    enabled: active,
  });
  const ended = live.connection === 'ended' || status === 'COMPLETED' || status === 'CANCELLED';

  const run = async (action: Action) => {
    setBusy(true);
    setError(null);
    try {
      await tripsApi.act(await getAccessToken(), tripId, action);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const confirmCancel = () =>
    Alert.alert('Cancel this trip?', 'The passenger will be told the trip was cancelled.', [
      { text: 'Keep trip', style: 'cancel' },
      { text: 'Cancel trip', style: 'destructive', onPress: () => void run('cancel') },
    ]);

  const next: { action: Action; label: string } | null =
    status === 'DRIVER_EN_ROUTE'
      ? { action: 'arrived', label: 'I have arrived at the pickup' }
      : status === 'DRIVER_ARRIVED'
        ? { action: 'start', label: 'Start trip' }
        : status === 'IN_PROGRESS'
          ? { action: 'complete', label: 'Complete trip' }
          : null;

  const buttonStyle = [
    styles.button,
    {
      minHeight: theme.minTouchTarget,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
    },
  ];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={styles.content}>
        <LiveTripView
          live={live}
          viewer="DRIVER"
          colors={theme.colors}
          minTouchTarget={theme.minTouchTarget}
          notice={active ? BROADCAST_MESSAGES[broadcast.status] || null : null}
        >
          {error ? (
            <Text accessibilityRole="alert" style={{ color: theme.colors.error }}>
              {error}
            </Text>
          ) : null}

          {next ? (
            <Pressable
              onPress={() => void run(next.action)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={next.label}
              accessibilityState={{ disabled: busy }}
              style={[
                buttonStyle,
                { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
              ]}
            >
              <Text style={{ color: theme.colors.textInverse, fontWeight: '700', fontSize: 16 }}>
                {next.label}
              </Text>
            </Pressable>
          ) : null}

          {active ? (
            <Pressable
              onPress={confirmCancel}
              accessibilityRole="button"
              accessibilityLabel="Cancel trip"
              style={[buttonStyle, { borderColor: theme.colors.error }]}
            >
              <Text style={{ color: theme.colors.error, fontWeight: '600' }}>Cancel trip</Text>
            </Pressable>
          ) : null}

          {ended ? (
            <Pressable
              onPress={() => navigation.popToTop()}
              accessibilityRole="button"
              accessibilityLabel="Back"
              style={buttonStyle}
            >
              <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>Back</Text>
            </Pressable>
          ) : null}
        </LiveTripView>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 14 },
  button: {
    borderWidth: 1,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
});
