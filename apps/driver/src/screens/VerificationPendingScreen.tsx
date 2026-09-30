import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '@yatri/mobile-auth';
import { rideApi } from '@yatri/mobile-ride';
import type { DriverStatus } from '@yatri/types';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import * as driverApi from '../api/driverApi';
import { Logo } from '../components/Logo';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useTheme } from '@yatri/mobile-ui';

type Props = NativeStackScreenProps<RootStackParamList, 'VerificationPending'>;

const STATUS_COPY: Record<DriverStatus, { title: string; body: string }> = {
  NOT_STARTED: {
    title: 'Application not started',
    body: 'Complete your driver application to get verified.',
  },
  IN_PROGRESS: {
    title: 'Application in progress',
    body: 'Finish your application to submit it for review.',
  },
  SUBMITTED: {
    title: 'Application submitted',
    body: "We've received your application. An admin will begin reviewing it shortly.",
  },
  UNDER_REVIEW: {
    title: 'Application under review',
    body: "We're reviewing your information and documents. This usually takes 1–2 business days.",
  },
  VERIFIED: {
    title: "You're verified",
    body: 'Ride matching is coming in a later update — for now there are no rides to accept yet.',
  },
  REJECTED: {
    title: 'Application rejected',
    body: 'Review the reason below, then update and resubmit your application.',
  },
  SUSPENDED: {
    title: 'Account suspended',
    body: 'Your driver account has been suspended. Contact Yatri support for more information.',
  },
};

/**
 * A driver — even a fully VERIFIED one — cannot accept rides yet: ride
 * matching doesn't exist until a later phase. This screen fetches the
 * live status from the server on every focus (never the AuthContext's
 * cached `driverStatus`, which can go stale) so it's always accurate.
 */
export function VerificationPendingScreen({ navigation }: Props) {
  const theme = useTheme();
  const { getAccessToken, logout } = useAuth();
  const [status, setStatus] = useState<DriverStatus | null>(null);
  const [rejectionReason, setRejectionReason] = useState<string | null>(null);
  const [activeTripId, setActiveTripId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    setLoadError(undefined);
    try {
      const token = await getAccessToken();
      const progress = await driverApi.getOnboarding(token);
      if (progress.status === 'VERIFIED') {
        navigation.replace('DriverHome');
        return;
      }
      setStatus(progress.status);
      setRejectionReason(progress.rejectionReason);
      try {
        const trip = await rideApi.active(token);
        setActiveTripId(trip ? trip.id : null);
      } catch {
        /* optional entry point */
      }
    } catch {
      setLoadError('Could not load your verification status.');
    }
  }, [getAccessToken, navigation]);

  // React Navigation fires 'focus' on initial mount too, so this alone
  // covers both the first load and every time the driver returns here.
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      void load();
    });
    return unsubscribe;
  }, [navigation, load]);

  if (!status && !loadError) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator color={theme.colors.secondary} accessibilityLabel="Loading status" />
      </SafeAreaView>
    );
  }

  const copy = status
    ? STATUS_COPY[status]
    : { title: 'Status unavailable', body: loadError ?? '' };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Logo size="lg" />
      <View
        style={styles.body}
        accessible
        accessibilityRole="summary"
        accessibilityLabel={`Verification status: ${copy.title}. ${copy.body}`}
      >
        <Text style={[styles.statusLabel, { color: theme.colors.textSecondary }]}>
          Verification status
        </Text>
        <Text style={[styles.title, { color: theme.colors.textPrimary }]}>{copy.title}</Text>
        <Text style={[styles.message, { color: theme.colors.textSecondary }]}>{copy.body}</Text>
      </View>

      {status === 'REJECTED' && rejectionReason ? (
        <View
          style={[
            styles.reasonBox,
            { borderColor: theme.colors.error, backgroundColor: theme.colors.surface },
          ]}
          accessible
          accessibilityRole="alert"
        >
          <Text style={[styles.reasonTitle, { color: theme.colors.error }]}>Reason</Text>
          <Text style={{ color: theme.colors.textPrimary }}>{rejectionReason}</Text>
        </View>
      ) : null}

      {status === 'REJECTED' || status === 'NOT_STARTED' || status === 'IN_PROGRESS' ? (
        <Pressable
          onPress={() => navigation.replace('Onboarding')}
          accessibilityRole="button"
          accessibilityLabel={
            status === 'REJECTED' ? 'Update and resubmit application' : 'Continue application'
          }
          style={[
            styles.primaryButton,
            { backgroundColor: theme.colors.secondary, minHeight: theme.minTouchTarget },
          ]}
        >
          <Text style={{ color: theme.colors.textInverse, fontWeight: '700', fontSize: 16 }}>
            {status === 'REJECTED' ? 'Update and resubmit' : 'Continue application'}
          </Text>
        </Pressable>
      ) : null}

      {activeTripId ? (
        <Pressable
          onPress={() => navigation.navigate('DriverTrip', { tripId: activeTripId })}
          accessibilityRole="button"
          accessibilityLabel="Open active trip"
          style={[
            styles.primaryButton,
            { backgroundColor: theme.colors.primary, minHeight: theme.minTouchTarget },
          ]}
        >
          <Text style={{ color: theme.colors.textInverse, fontWeight: '700', fontSize: 16 }}>
            Open active trip
          </Text>
        </Pressable>
      ) : null}

      <Pressable
        onPress={() => navigation.navigate('DriverLocation')}
        accessibilityRole="button"
        accessibilityLabel="My location"
        style={[styles.signOutButton, { minHeight: theme.minTouchTarget }]}
      >
        <Text style={[styles.signOutText, { color: theme.colors.secondary }]}>My location</Text>
      </Pressable>

      <Pressable
        onPress={() => {
          void logout();
        }}
        accessibilityRole="button"
        accessibilityLabel="Sign out"
        style={[styles.signOutButton, { minHeight: theme.minTouchTarget }]}
      >
        <Text style={[styles.signOutText, { color: theme.colors.textSecondary }]}>Sign out</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
    paddingHorizontal: 32,
  },
  body: { alignItems: 'center', gap: 8 },
  statusLabel: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  title: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  message: { fontSize: 15, textAlign: 'center', lineHeight: 22 },
  reasonBox: { borderWidth: 1, borderRadius: 12, padding: 16, gap: 4, width: '100%' },
  reasonTitle: { fontSize: 14, fontWeight: '700' },
  primaryButton: {
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 999,
    paddingHorizontal: 24,
    width: '100%',
  },
  signOutButton: { justifyContent: 'center', paddingHorizontal: 12 },
  signOutText: { fontSize: 15, fontWeight: '600' },
});
