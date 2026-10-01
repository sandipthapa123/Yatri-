import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '@yatri/mobile-auth';
import {
  describePresence,
  LOCATION_STATUS_HELP,
  LOCATION_STATUS_TEXT,
  locationStatusKey,
  useDriverPresence,
} from '@yatri/mobile-location';
import { OfferCard, rideApi, useDriverOffers, useResyncOnReturn } from '@yatri/mobile-ride';
import { useCallback, useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../navigation/RootNavigator';
import { useTheme } from '@yatri/mobile-ui';

type Props = NativeStackScreenProps<RootStackParamList, 'DriverHome'>;

const AGE_TICK_MS = 5000;

/**
 * The driver's main screen: one obvious action (GO ONLINE / GO OFFLINE), the
 * current status in words, and just enough location detail to trust it. All of
 * it is text with a role and a label; state changes are announced through a
 * polite/assertive live region pair so a screen-reader user never has to look
 * at a map (there is none here).
 */
export function DriverHomeScreen({ navigation }: Props) {
  const theme = useTheme();
  const { getAccessToken } = useAuth();
  const { state, goOnline, goOffline, socket } = useDriverPresence(getAccessToken);
  // Offers arrive on the presence socket (one socket, no second connection).
  const offers = useDriverOffers(socket, getAccessToken);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [activeTripId, setActiveTripId] = useState<string | null>(null);

  // "Last update N seconds ago" stays truthful without being a live region.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), AGE_TICK_MS);
    return () => clearInterval(t);
  }, []);

  const check = useCallback(() => {
    void (async () => {
      try {
        const t = await rideApi.active(await getAccessToken());
        setActiveTripId(t ? t.id : null);
      } catch {
        /* optional entry point */
      }
    })();
  }, [getAccessToken]);
  useEffect(() => {
    check();
    return navigation.addListener('focus', check);
  }, [navigation, check]);
  // Back from the background, or the connection returned: ask the server again rather than trust the screen.
  useResyncOnReturn(check);

  const announcement = state.announcement;
  useEffect(() => {
    // iOS VoiceOver ignores live regions, so speak explicitly there; elsewhere the live region speaks.
    if (announcement && Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(announcement.text);
    }
  }, [announcement]);

  const online = state.phase === 'online';
  const changing = state.phase === 'going-online' || state.phase === 'going-offline';
  const key = locationStatusKey(state);
  const rows = describePresence(state, nowMs);
  const statusWord =
    state.phase === 'online'
      ? 'ONLINE'
      : state.phase === 'offline'
        ? 'OFFLINE'
        : state.phase === 'going-online'
          ? 'GOING ONLINE…'
          : 'GOING OFFLINE…';
  const eligibility = state.serverStatus?.eligibility;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={styles.content}>
        <View accessibilityRole="header" accessible>
          <Text style={[styles.status, { color: theme.colors.textPrimary }]}>
            {online ? '● ' : '○ '}
            {statusWord}
          </Text>
        </View>

        {/* Live regions: always mounted so the region exists before its text changes. */}
        <View accessibilityLiveRegion="assertive" accessibilityRole="alert">
          {announcement?.assertive ? (
            <Text
              key={announcement.id}
              style={[
                styles.banner,
                { color: theme.colors.textPrimary, borderColor: theme.colors.primary },
              ]}
            >
              {announcement.text}
            </Text>
          ) : null}
        </View>
        <View accessibilityLiveRegion="polite">
          {announcement && !announcement.assertive ? (
            <Text key={announcement.id} style={{ color: theme.colors.textPrimary, fontSize: 16 }}>
              {announcement.text}
            </Text>
          ) : null}
        </View>

        <OfferCard
          colors={theme.colors}
          minTouchTarget={theme.minTouchTarget}
          state={offers.state}
          controller={offers.controller}
          onAccepted={(tripId) => navigation.navigate('DriverTrip', { tripId })}
        />

        <View
          accessibilityRole="list"
          style={[
            styles.card,
            { borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
          ]}
        >
          {rows.map((line) => (
            <View key={line} accessible accessibilityLabel={line} style={styles.row}>
              <Text style={{ color: theme.colors.textPrimary, fontSize: 16 }}>{line}</Text>
            </View>
          ))}
          {state.phase === 'online' ? (
            <View accessible accessibilityLabel={LOCATION_STATUS_HELP[key]} style={styles.row}>
              <Text style={{ color: theme.colors.textSecondary }}>{LOCATION_STATUS_HELP[key]}</Text>
            </View>
          ) : (
            <View accessible style={styles.row}>
              <Text style={{ color: theme.colors.textSecondary }}>
                {LOCATION_STATUS_TEXT[key]}. {LOCATION_STATUS_HELP[key]}
              </Text>
            </View>
          )}
        </View>

        {state.problem ? (
          <View
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            style={[
              styles.card,
              { borderColor: theme.colors.error, backgroundColor: theme.colors.surface },
            ]}
          >
            <Text style={{ color: theme.colors.error, fontWeight: '700' }}>
              {state.problem.message}
            </Text>
            {(state.problem.reasons ?? []).map((r) => (
              <Text key={r} style={{ color: theme.colors.textPrimary }}>
                • {r}
              </Text>
            ))}
          </View>
        ) : null}

        {!online && !changing && eligibility && !eligibility.eligible && !state.problem ? (
          <View
            style={[
              styles.card,
              { borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
            ]}
          >
            <Text style={{ color: theme.colors.textPrimary, fontWeight: '700' }}>
              You cannot go online yet
            </Text>
            {eligibility.reasons.map((r) => (
              <Text key={r} style={{ color: theme.colors.textPrimary }}>
                • {r}
              </Text>
            ))}
          </View>
        ) : null}

        <Pressable
          onPress={online ? goOffline : goOnline}
          disabled={changing}
          accessibilityRole="button"
          accessibilityLabel={online ? 'Go offline' : 'Go online'}
          accessibilityHint={
            online
              ? 'Stops sharing your location and removes you from availability.'
              : 'Checks your location, then makes you available to Yatri.'
          }
          accessibilityState={{ disabled: changing, busy: changing }}
          style={[
            styles.primary,
            {
              minHeight: 64,
              backgroundColor: online ? theme.colors.surface : theme.colors.primary,
              borderColor: theme.colors.primary,
              opacity: changing ? 0.6 : 1,
            },
          ]}
        >
          <Text
            style={{
              color: online ? theme.colors.primary : theme.colors.textInverse,
              fontSize: 20,
              fontWeight: '800',
            }}
          >
            {changing ? 'PLEASE WAIT…' : online ? 'GO OFFLINE' : 'GO ONLINE'}
          </Text>
        </Pressable>

        {state.permission === 'blocked' ? (
          <Pressable
            onPress={() => void Linking.openSettings()}
            accessibilityRole="button"
            accessibilityLabel="Open phone settings"
            style={[
              styles.secondary,
              { minHeight: theme.minTouchTarget, borderColor: theme.colors.border },
            ]}
          >
            <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>
              Open phone settings
            </Text>
          </Pressable>
        ) : null}

        {activeTripId ? (
          <Pressable
            onPress={() => navigation.navigate('DriverTrip', { tripId: activeTripId })}
            accessibilityRole="button"
            accessibilityLabel="Open active trip"
            style={[
              styles.secondary,
              { minHeight: theme.minTouchTarget, borderColor: theme.colors.primary },
            ]}
          >
            <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>
              Open active trip
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => navigation.navigate('DriverRideHistory')}
          accessibilityRole="button"
          accessibilityLabel="Your rides"
          style={[
            styles.secondary,
            { minHeight: theme.minTouchTarget, borderColor: theme.colors.border },
          ]}
        >
          <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>Your rides</Text>
        </Pressable>
        <Pressable
          onPress={() => navigation.navigate('DriverEmergencyContacts')}
          accessibilityRole="button"
          accessibilityLabel="Emergency contacts"
          style={[
            styles.secondary,
            { minHeight: theme.minTouchTarget, borderColor: theme.colors.border },
          ]}
        >
          <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>
            Emergency contacts
          </Text>
        </Pressable>
        <Pressable
          onPress={() => navigation.navigate('Incentives')}
          accessibilityRole="button"
          accessibilityLabel="Your bonuses"
          style={[
            styles.secondary,
            { minHeight: theme.minTouchTarget, borderColor: theme.colors.border },
          ]}
        >
          <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>Your bonuses</Text>
        </Pressable>
        <Pressable
          onPress={() => navigation.navigate('Settings')}
          accessibilityRole="button"
          accessibilityLabel="Settings"
          accessibilityHint="Appearance, accessibility, notifications, safety and devices"
          style={[
            styles.secondary,
            { minHeight: theme.minTouchTarget, borderColor: theme.colors.border },
          ]}
        >
          <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>Settings</Text>
        </Pressable>
        <Pressable
          onPress={() => navigation.navigate('Support')}
          accessibilityRole="button"
          accessibilityLabel="Help and support"
          style={[
            styles.secondary,
            { minHeight: theme.minTouchTarget, borderColor: theme.colors.border },
          ]}
        >
          <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>
            Help and support
          </Text>
        </Pressable>
        <Pressable
          onPress={() => navigation.navigate('DriverLocation')}
          accessibilityRole="button"
          accessibilityLabel="My location"
          style={[
            styles.secondary,
            { minHeight: theme.minTouchTarget, borderColor: theme.colors.border },
          ]}
        >
          <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>My location</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 14 },
  status: { fontSize: 34, fontWeight: '800' },
  banner: { borderWidth: 2, borderRadius: 12, padding: 12, fontSize: 17, fontWeight: '700' },
  card: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 6 },
  row: { paddingVertical: 4, minHeight: 32, justifyContent: 'center' },
  primary: {
    borderWidth: 2,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  secondary: {
    borderWidth: 1,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
});
