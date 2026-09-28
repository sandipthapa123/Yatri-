import { useAuth } from '@yatri/mobile-auth';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { APP_TAGLINE } from '@yatri/shared';

import { Logo } from '../components/Logo';
import { useTheme } from '../theme/useTheme';

function greeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function HomeScreen() {
  const theme = useTheme();
  const { user, logout } = useAuth();
  const timeGreeting = greeting(new Date().getHours());
  const name = user?.fullName?.trim();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <ScrollView contentContainerStyle={styles.content} accessibilityRole="none">
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
          accessible
          accessibilityRole="summary"
          accessibilityLabel="Where to. Ride booking is coming soon."
        >
          <Text style={[styles.searchLabel, { color: theme.colors.textPrimary }]}>Where to?</Text>
          <View
            style={[
              styles.searchInputPlaceholder,
              { borderColor: theme.colors.border, minHeight: theme.minTouchTarget },
            ]}
          >
            <Text style={{ color: theme.colors.textSecondary }}>Enter a destination</Text>
          </View>
          <Text style={[styles.comingSoon, { color: theme.colors.textSecondary }]}>
            Ride booking is coming soon.
          </Text>
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
  signOutButton: {
    alignSelf: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  signOutText: {
    fontSize: 15,
    fontWeight: '600',
  },
});
