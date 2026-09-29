import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '@yatri/mobile-auth';
import { formatDistance, locationApi, tripsApi } from '@yatri/mobile-location';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { APP_TAGLINE } from '@yatri/shared';

import { Logo } from '../components/Logo';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useTripLocations } from '../state/TripLocations';
import { useTheme } from '../theme/useTheme';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

function greeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function HomeScreen({ navigation }: Props) {
  const theme = useTheme();
  const { user, getAccessToken } = useAuth();
  const { pickup, destination } = useTripLocations();
  const [activeTripId, setActiveTripId] = useState<string | null>(null);

  // Is there a trip in progress? Checked whenever this screen regains focus.
  useEffect(() => {
    const check = () => {
      void (async () => {
        try {
          const t = await tripsApi.active(await getAccessToken());
          setActiveTripId(t ? t.id : null);
        } catch {
          /* optional entry point */
        }
      })();
    };
    check();
    return navigation.addListener('focus', check);
  }, [navigation, getAccessToken]);

  const [result, setResult] = useState<{ key: string; text: string } | null>(null);
  const key =
    pickup && destination
      ? `${pickup.latitude},${pickup.longitude}>${destination.latitude},${destination.longitude}`
      : null;
  const distance = key && result?.key === key ? result.text : null;

  // Distance is computed by the backend from the two chosen coordinates (never on the device).
  useEffect(() => {
    if (!pickup || !destination || !key) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await locationApi.calculateDistance(await getAccessToken(), pickup, destination);
        if (!cancelled) {
          setResult({
            key,
            text: `Straight-line distance from pickup to destination: ${formatDistance(r.distanceMeters)}.`,
          });
        }
      } catch {
        /* the distance line is optional */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pickup, destination, key, getAccessToken]);
  const timeGreeting = greeting(new Date().getHours());
  const name = user?.fullName?.trim();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <ScrollView contentContainerStyle={styles.content} accessibilityRole="none">
        <View style={styles.topBar}>
          <Pressable
            onPress={() => navigation.navigate('Profile')}
            accessibilityRole="button"
            accessibilityLabel="Open profile"
            style={[styles.profileLink, { minHeight: theme.minTouchTarget }]}
          >
            <Text style={[styles.profileLinkText, { color: theme.colors.primary }]}>Profile</Text>
          </Pressable>
        </View>

        <View style={styles.header}>
          <Logo size="lg" />
          <Text
            style={[styles.greeting, { color: theme.colors.textPrimary }]}
            accessibilityRole="text"
          >
            {name ? `${timeGreeting}, ${name}` : timeGreeting}
          </Text>
          <Text style={[styles.tagline, { color: theme.colors.textSecondary }]}>{APP_TAGLINE}</Text>
        </View>

        <View
          style={[
            styles.searchCard,
            { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
          ]}
        >
          {activeTripId ? (
            <Pressable
              onPress={() => navigation.navigate('TripTracking', { tripId: activeTripId })}
              accessibilityRole="button"
              accessibilityLabel="Open live trip status"
              style={[
                styles.searchInputPlaceholder,
                {
                  borderColor: theme.colors.primary,
                  borderWidth: 2,
                  minHeight: theme.minTouchTarget + 16,
                },
              ]}
            >
              <Text style={{ color: theme.colors.textPrimary, fontWeight: '700' }}>
                You have a trip in progress
              </Text>
              <Text style={{ color: theme.colors.textSecondary }}>Open live trip status</Text>
            </Pressable>
          ) : null}
          <Text
            accessibilityRole="header"
            style={[styles.searchLabel, { color: theme.colors.textPrimary }]}
          >
            Plan your trip
          </Text>
          {(
            [
              ['Pickup', pickup, 'pickup'],
              ['Destination', destination, 'destination'],
            ] as const
          ).map(([title, place, purpose]) => (
            <Pressable
              key={purpose}
              onPress={() => navigation.navigate('PickLocation', { purpose })}
              accessibilityRole="button"
              accessibilityLabel={
                place
                  ? `${title}: ${place.name}${place.address ? `, ${place.address}` : ''}. Double tap to change.`
                  : `${title}: not chosen. Double tap to choose.`
              }
              style={[
                styles.searchInputPlaceholder,
                { borderColor: theme.colors.border, minHeight: theme.minTouchTarget + 16 },
              ]}
            >
              <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>{title}</Text>
              <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>
                {place ? place.name : purpose === 'pickup' ? 'Choose pickup' : 'Where to?'}
              </Text>
              {place?.address ? (
                <Text style={{ color: theme.colors.textSecondary }}>{place.address}</Text>
              ) : null}
            </Pressable>
          ))}

          {distance ? (
            <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.textPrimary }}>
              {distance}
            </Text>
          ) : null}

          <Pressable
            onPress={() => navigation.navigate('SavedPlaces')}
            accessibilityRole="button"
            accessibilityLabel="Saved places"
            style={[styles.profileLink, { minHeight: theme.minTouchTarget }]}
          >
            <Text style={[styles.profileLinkText, { color: theme.colors.primary }]}>
              Saved places
            </Text>
          </Pressable>
          <Text style={[styles.comingSoon, { color: theme.colors.textSecondary }]}>
            Ride booking is coming soon.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    padding: 24,
    gap: 32,
  },
  header: {
    alignItems: 'center',
    gap: 8,
    marginTop: 24,
  },
  greeting: {
    fontSize: 22,
    fontWeight: '700',
  },
  tagline: {
    fontSize: 15,
    textAlign: 'center',
  },
  searchCard: {
    borderRadius: 20,
    borderWidth: 1,
    padding: 20,
    gap: 12,
  },
  searchLabel: {
    fontSize: 17,
    fontWeight: '600',
  },
  searchInputPlaceholder: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  comingSoon: {
    fontSize: 13,
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  profileLink: {
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  profileLinkText: {
    fontSize: 15,
    fontWeight: '600',
  },
});
