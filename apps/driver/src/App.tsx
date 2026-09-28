import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { colors, spacing } from '@yatri/shared';

/**
 * Driver app foundation. Phase 1 scope: entry point, branding, and loading
 * state only — the driver experience (going online, accepting trips) is
 * built alongside ride booking in a later phase.
 */
function AppContent() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 400);
    return () => clearTimeout(timer);
  }, []);

  if (!ready) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator
          size="large"
          color={colors.secondary}
          accessibilityLabel="Loading Yatri Driver"
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
      <View accessible accessibilityRole="header" accessibilityLabel="Yatri Driver">
        <Text style={styles.wordmark}>Yatri Driver</Text>
      </View>
      <Text style={styles.subtitle} accessibilityRole="text">
        The driver app is coming in a future phase.
      </Text>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.xl,
  },
  wordmark: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.secondary,
  },
  subtitle: {
    fontSize: 15,
    color: colors.textSecondary,
    textAlign: 'center',
  },
});
