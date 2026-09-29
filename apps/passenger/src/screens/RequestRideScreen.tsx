import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ApiError, useAuth } from '@yatri/mobile-auth';
import { ActionButton, Card, Fact, rideApi } from '@yatri/mobile-ride';
import {
  formatDistance,
  formatElapsed,
  formatNpr,
  type FareEstimateResponse,
  type TripRequestBody,
} from '@yatri/types';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../navigation/RootNavigator';
import { useTripLocations } from '../state/TripLocations';
import { useTheme } from '../theme/useTheme';

type Props = NativeStackScreenProps<RootStackParamList, 'RequestRide'>;

interface Result {
  key: string;
  estimate: FareEstimateResponse | null;
  error: string | null;
}

/**
 * Review the fare, then ask for a ride. The fare is calculated by the server from the two places
 * (this screen never computes a price), and the request that follows is priced again by the
 * server, so what is shown here is an estimate, not a promise. Everything is text.
 */
export function RequestRideScreen({ navigation }: Props) {
  const theme = useTheme();
  const { getAccessToken } = useAuth();
  const { pickup, destination } = useTripLocations();
  const [result, setResult] = useState<Result | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  const body: TripRequestBody | null = useMemo(
    () =>
      pickup && destination
        ? {
            pickup: {
              latitude: pickup.latitude,
              longitude: pickup.longitude,
              address: pickup.address || pickup.name,
              name: pickup.name,
            },
            destination: {
              latitude: destination.latitude,
              longitude: destination.longitude,
              address: destination.address || destination.name,
              name: destination.name,
            },
          }
        : null,
    [pickup, destination],
  );
  const key = body ? `${JSON.stringify(body)}#${attempt}` : '';

  useEffect(() => {
    if (!body) return;
    let cancelled = false;
    void (async () => {
      try {
        const estimate = await rideApi.estimate(await getAccessToken(), body);
        if (!cancelled) setResult({ key, estimate, error: null });
      } catch (e) {
        if (!cancelled) {
          setResult({
            key,
            estimate: null,
            error: e instanceof ApiError ? e.message : 'Could not get the fare. Please try again.',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [body, key, getAccessToken]);

  // The answer for the current places, or "still loading" when it is for an older request.
  const current = result && result.key === key ? result : null;
  const estimate = current?.estimate ?? null;
  const loading = !!body && !current;
  const error = requestError ?? current?.error ?? null;

  const request = async () => {
    if (!body || requesting) return;
    setRequesting(true);
    setRequestError(null);
    try {
      const trip = await rideApi.request(await getAccessToken(), body);
      navigation.replace('TripTracking', { tripId: trip.id });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TRIP_ALREADY_ACTIVE') {
        try {
          const active = await rideApi.active(await getAccessToken());
          if (active) {
            navigation.replace('TripTracking', { tripId: active.id });
            return;
          }
        } catch {
          /* fall through to the message */
        }
      }
      setRequestError(
        e instanceof ApiError ? e.message : 'Could not request the ride. Please try again.',
      );
    } finally {
      setRequesting(false);
    }
  };

  const ui = { colors: theme.colors, minTouchTarget: theme.minTouchTarget };
  const fare = estimate?.fare;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={[styles.h, { color: theme.colors.textPrimary }]}>
          Your ride
        </Text>

        {!body ? (
          <Text style={{ color: theme.colors.textPrimary }}>
            Choose a pickup and a destination on the home screen first.
          </Text>
        ) : (
          <>
            <Card {...ui} title="Trip">
              <Fact {...ui} label="Pickup" value={pickup?.name ?? ''} />
              <Fact {...ui} label="Destination" value={destination?.name ?? ''} />
            </Card>

            <View accessibilityLiveRegion="polite">
              {loading ? (
                <Text style={{ color: theme.colors.textSecondary }}>Getting your fare.</Text>
              ) : null}
              {error ? (
                <Text accessibilityRole="alert" style={{ color: theme.colors.error }}>
                  {error}
                </Text>
              ) : null}
            </View>

            {fare && estimate ? (
              <Card {...ui} title="Estimated fare">
                <Fact {...ui} label="Estimated fare" value={formatNpr(fare.totalNpr)} />
                <Fact {...ui} label="Distance" value={formatDistance(fare.distanceMeters)} />
                <Text style={{ color: theme.colors.textSecondary }}>
                  {fare.routeBased
                    ? 'Based on the road route.'
                    : 'Based on the straight-line distance, so the real fare may differ a little.'}
                  {fare.minimumFareApplied ? ' The minimum fare applies.' : ''}
                </Text>
                <Text style={{ color: theme.colors.textSecondary }}>
                  If your driver waits for you, the first{' '}
                  {formatElapsed(estimate.waitingRule.freeSeconds)} are free, then{' '}
                  {formatNpr(estimate.waitingRule.perMinuteNpr)} for each minute. You pay your
                  driver in cash.
                </Text>
              </Card>
            ) : null}

            <ActionButton
              {...ui}
              label="Request ride"
              tone="primary"
              busy={requesting}
              disabled={!estimate}
              hint="Looks for a nearby driver"
              onPress={() => void request()}
            />
            {current?.error && !estimate ? (
              <ActionButton
                {...ui}
                label="Try again"
                onPress={() => {
                  setRequestError(null);
                  setAttempt((n) => n + 1);
                }}
              />
            ) : null}
          </>
        )}
        <ActionButton {...ui} label="Back" onPress={() => navigation.goBack()} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 14 },
  h: { fontSize: 24, fontWeight: '700' },
});
