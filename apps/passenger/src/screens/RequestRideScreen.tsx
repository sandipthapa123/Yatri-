import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ApiError, useAuth } from '@yatri/mobile-auth';
import {
  BusinessBookingPanel,
  bookingNews,
  submitBusinessBooking,
  type BusinessChoice,
} from '@yatri/mobile-business';
import { usePreferences } from '@yatri/mobile-preferences';
import { ActionButton, CategoryPicker, Card, Fact, rideApi } from '@yatri/mobile-ride';
import {
  describeSurge,
  formatDistance,
  formatDuration,
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
import { useTheme } from '@yatri/mobile-ui';

type Props = NativeStackScreenProps<RootStackParamList, 'RequestRide'>;

interface Result {
  key: string;
  estimate: FareEstimateResponse | null;
  error: string | null;
}

/**
 * Choose a vehicle type, review the fare, then ask for a ride. Distance, duration and every fare
 * come from the server (this screen never computes a price), and the request that follows is priced
 * again by the server, so what is shown here is an estimate, not a promise. Everything is text.
 */
export function RequestRideScreen({ navigation }: Props) {
  const theme = useTheme();
  const { getAccessToken } = useAuth();
  const { pickup, destination } = useTripLocations();
  const [result, setResult] = useState<Result | null>(null);
  const [attempt, setAttempt] = useState(0);
  const preferred = usePreferences().data?.values.defaultVehicle;
  const [chosen, setChosen] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [business, setBusiness] = useState<BusinessChoice | null>(null);
  const [businessNews, setBusinessNews] = useState<string | null>(null);

  const places = useMemo(
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
  const key = places ? `${JSON.stringify(places)}#${attempt}` : '';

  // One estimate for the two places: it prices EVERY category, so choosing a type needs no request.
  useEffect(() => {
    if (!places) return;
    let cancelled = false;
    void (async () => {
      try {
        const estimate = await rideApi.estimate(await getAccessToken(), places);
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
  }, [places, key, getAccessToken]);

  const current = result && result.key === key ? result : null;
  const estimate = current?.estimate ?? null;
  const loading = !!places && !current;
  const error = requestError ?? current?.error ?? null;

  // Until the passenger chooses, suggest the first type that has a driver nearby.
  const options = estimate?.categories ?? [];
  // The person's preferred type is the first suggestion when it is on offer here and has a driver nearby.
  const preferredOption = options.find((o) => o.code === preferred && o.available);
  const selectedCode =
    chosen && options.some((o) => o.code === chosen)
      ? chosen
      : (preferredOption ?? options.find((o) => o.available) ?? options[0])?.code;
  const selected = options.find((o) => o.code === selectedCode) ?? null;

  const request = async () => {
    if (!places || !selectedCode || requesting) return;
    setRequesting(true);
    setRequestError(null);
    // The rider confirms the total they were shown; if demand pricing moved, the server says so.
    const body: TripRequestBody = {
      ...places,
      vehicleCategory: selectedCode,
      confirmedTotalNpr: selected?.fare.totalNpr,
    };
    try {
      if (business) {
        // A business ride: the organization's rules are applied by the server, which answers with a ride
        // (followed here when it is for this person), a refusal in words, or a request waiting for approval.
        const result = await submitBusinessBooking(await getAccessToken(), business, body);
        if (result.outcome === 'REQUESTED' && !business.passengerId && result.tripId) {
          navigation.replace('TripTracking', { tripId: result.tripId });
          return;
        }
        setBusinessNews(bookingNews(result, business.passengerName, !business.passengerId));
        return;
      }
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
      if (e instanceof ApiError && e.code === 'FARE_CHANGED') {
        // Show the new fare (a fresh estimate) and ask again: nothing was requested.
        setAttempt((n) => n + 1);
      }
      setRequestError(
        e instanceof ApiError ? e.message : 'Could not request the ride. Please try again.',
      );
    } finally {
      setRequesting(false);
    }
  };

  const ui = { colors: theme.colors, minTouchTarget: theme.minTouchTarget };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={[styles.h, { color: theme.colors.textPrimary }]}>
          Your ride
        </Text>

        {!places ? (
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

            {estimate && selected && selectedCode ? (
              <>
                <Card {...ui} title="Vehicle type">
                  <CategoryPicker
                    {...ui}
                    options={options}
                    selected={selectedCode}
                    onSelect={setChosen}
                  />
                </Card>

                <Card {...ui} title="Estimate">
                  <Fact {...ui} label="Estimated fare" value={formatNpr(selected.fare.totalNpr)} />
                  {selected.fare.surgeMultiplier > 1 ? (
                    <View accessible accessibilityRole="alert">
                      <Text style={{ color: theme.colors.textPrimary, fontWeight: '700' }}>
                        {describeSurge(
                          selected.fare.surgeMultiplier,
                          selected.fare.surgeLabel,
                          selected.fare.surgeNpr,
                        )}
                      </Text>
                      <Text style={{ color: theme.colors.textSecondary }}>
                        {`Normal fare ${formatNpr(selected.fare.totalNpr - selected.fare.surgeNpr)} plus ${formatNpr(selected.fare.surgeNpr)} for higher demand.`}
                      </Text>
                    </View>
                  ) : null}
                  {estimate.notices.map((n) => (
                    <Text key={n} style={{ color: theme.colors.textPrimary }}>
                      {n}
                    </Text>
                  ))}
                  <Fact
                    {...ui}
                    label="Distance"
                    value={formatDistance(selected.fare.distanceMeters)}
                  />
                  {selected.fare.durationSeconds !== null ? (
                    <Fact
                      {...ui}
                      label="Estimated time"
                      value={formatDuration(selected.fare.durationSeconds)}
                    />
                  ) : null}
                  <Text style={{ color: theme.colors.textSecondary }}>
                    {selected.fare.routeBased
                      ? 'Based on the road route.'
                      : 'Based on the straight-line distance, so the real fare may differ a little.'}
                    {selected.fare.minimumFareApplied ? ' The minimum fare applies.' : ''}
                  </Text>
                  <Text style={{ color: theme.colors.textSecondary }}>
                    If your driver waits for you, the first{' '}
                    {formatElapsed(estimate.waitingRule.freeSeconds)} are free, then{' '}
                    {formatNpr(estimate.waitingRule.perMinuteNpr)} for each minute. You pay your
                    driver in cash{business ? ' unless your organization pays' : ''}.
                  </Text>
                </Card>
              </>
            ) : null}

            <BusinessBookingPanel
              {...ui}
              getAccessToken={getAccessToken}
              request={
                places && selectedCode && selected
                  ? {
                      ...places,
                      vehicleCategory: selectedCode,
                      confirmedTotalNpr: selected.fare.totalNpr,
                    }
                  : null
              }
              onChange={setBusiness}
            />
            {businessNews ? (
              <View accessibilityLiveRegion="polite" accessibilityRole="alert">
                <Text style={{ color: theme.colors.textPrimary, fontWeight: '700' }}>
                  {businessNews}
                </Text>
              </View>
            ) : null}

            <ActionButton
              {...ui}
              label={
                selected
                  ? `${business ? 'Book' : 'Request'} ${selected.label} for ${formatNpr(selected.fare.totalNpr)}`
                  : 'Request ride'
              }
              tone="primary"
              busy={requesting}
              disabled={!selected || business?.preview?.outcome === 'DENIED' || !!businessNews}
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
