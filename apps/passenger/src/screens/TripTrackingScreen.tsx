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

type Props = NativeStackScreenProps<RootStackParamList, 'TripTracking'>;

/**
 * Passenger's live trip. The driver's position, distance, ETA and road name
 * arrive over the realtime socket and update in place; sharing the
 * passenger's own location with the driver is opt-in, off by default, and
 * only available until the driver arrives.
 */
export function TripTrackingScreen({ navigation, route }: Props) {
  const theme = useTheme();
  const { getAccessToken } = useAuth();
  const { tripId } = route.params;
  const live = useLiveTrip(tripId, getAccessToken, 'PASSENGER');
  const [share, setShare] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = live.snapshot?.status ?? null;
  const active =
    status === 'DRIVER_EN_ROUTE' || status === 'DRIVER_ARRIVED' || status === 'IN_PROGRESS';
  const canShare = status === 'DRIVER_EN_ROUTE';
  const broadcast = useLocationBroadcast({
    client: live.client,
    kind: 'passenger_location',
    enabled: share && canShare,
  });
  const ended = live.connection === 'ended' || status === 'COMPLETED' || status === 'CANCELLED';

  const toggleShare = () => {
    if (share) live.client?.stopSharing();
    setShare(!share);
  };

  const cancel = () => {
    Alert.alert('Cancel this trip?', 'Your driver will be told the trip was cancelled.', [
      { text: 'Keep trip', style: 'cancel' },
      {
        text: 'Cancel trip',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await tripsApi.act(await getAccessToken(), tripId, 'cancel');
            } catch (e) {
              setError(
                e instanceof ApiError ? e.message : 'Could not cancel the trip. Please try again.',
              );
            }
          })();
        },
      },
    ]);
  };

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
          viewer="PASSENGER"
          colors={theme.colors}
          minTouchTarget={theme.minTouchTarget}
          notice={share && canShare ? BROADCAST_MESSAGES[broadcast.status] || null : null}
        >
          {error ? (
            <Text accessibilityRole="alert" style={{ color: theme.colors.error }}>
              {error}
            </Text>
          ) : null}

          {canShare ? (
            <Pressable
              onPress={toggleShare}
              accessibilityRole="switch"
              accessibilityState={{ checked: share }}
              accessibilityLabel="Share my location with the driver"
              accessibilityHint="Helps your driver find you. Stops automatically when the driver arrives."
              style={buttonStyle}
            >
              <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>
                {share
                  ? '✓ Sharing my location with the driver'
                  : 'Share my location with the driver'}
              </Text>
            </Pressable>
          ) : null}

          {active ? (
            <Pressable
              onPress={cancel}
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
              accessibilityLabel="Back to home"
              style={buttonStyle}
            >
              <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>
                Back to home
              </Text>
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
