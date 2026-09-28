import { useAuth } from '@yatri/mobile-auth';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Logo } from '../components/Logo';
import { useTheme } from '../theme/useTheme';

const STATUS_COPY: Record<string, { title: string; body: string }> = {
  PENDING_VERIFICATION: {
    title: 'Verification pending',
    body: "We're reviewing your account. You'll be notified as soon as you're verified and can start accepting rides. This usually takes 1–2 business days.",
  },
  VERIFIED: {
    title: "You're verified",
    body: 'Ride matching is coming in a later update — for now there are no rides to accept yet.',
  },
  SUSPENDED: {
    title: 'Account suspended',
    body: 'Your driver account has been suspended. Contact Yatri support for more information.',
  },
  REJECTED: {
    title: 'Verification unsuccessful',
    body: 'We were unable to verify your account. Contact Yatri support if you believe this is a mistake.',
  },
};

/**
 * A driver — even a fully VERIFIED one — cannot accept rides yet: ride
 * matching doesn't exist until a later phase. This screen exists so that
 * is never ambiguous to the driver, whatever their verification status.
 */
export function VerificationPendingScreen() {
  const theme = useTheme();
  const { driverStatus, logout } = useAuth();
  const copy =
    STATUS_COPY[driverStatus ?? 'PENDING_VERIFICATION'] ?? STATUS_COPY.PENDING_VERIFICATION!;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Logo size="lg" />
      <View
        style={styles.body}
        accessible
        accessibilityRole="summary"
        accessibilityLabel={`${copy.title}. ${copy.body}`}
      >
        <Text style={[styles.title, { color: theme.colors.textPrimary }]}>{copy.title}</Text>
        <Text style={[styles.message, { color: theme.colors.textSecondary }]}>{copy.body}</Text>
      </View>

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
    gap: 32,
    paddingHorizontal: 32,
  },
  body: { alignItems: 'center', gap: 12 },
  title: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  message: { fontSize: 15, textAlign: 'center', lineHeight: 22 },
  signOutButton: { justifyContent: 'center', paddingHorizontal: 12 },
  signOutText: { fontSize: 15, fontWeight: '600' },
});
