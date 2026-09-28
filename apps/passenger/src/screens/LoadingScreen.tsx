import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Logo } from '../components/Logo';
import { useTheme } from '../theme/useTheme';

/**
 * Shown while the app bootstraps. Uses the platform ActivityIndicator
 * (respects reduce-motion by design) rather than a custom spinner, and
 * announces itself once to screen readers instead of repeating on every
 * re-render.
 */
export function LoadingScreen() {
  const theme = useTheme();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Logo />
      <View
        style={styles.status}
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel="Loading Yatri"
      >
        <ActivityIndicator size="large" color={theme.colors.primary} />
        <Text style={[styles.label, { color: theme.colors.textSecondary }]}>
          Getting things ready…
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 32,
  },
  status: {
    alignItems: 'center',
    gap: 12,
  },
  label: {
    fontSize: 16,
  },
});
