import { useEffect } from 'react';
import { AccessibilityInfo, ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTheme } from './useTheme';
import { Wordmark, type WordmarkProps } from './Wordmark';

/** Who the app is, for the screens shown before anything else: its wordmark words (also its spoken name) and its accent. */
export type AppIdentity = Pick<WordmarkProps, 'label' | 'tone'>;

/**
 * Shown while the app starts. The platform's activity indicator (it respects reduced motion by design), not a custom spinner;
 * one accessible progress element, so a screen reader hears it once.
 */
export function LoadingView({ label, tone }: AppIdentity) {
  const theme = useTheme();
  return (
    <SafeAreaView style={[styles.loading, { backgroundColor: theme.colors.background }]}>
      <Wordmark label={label} tone={tone} />
      <View style={styles.status} accessible accessibilityRole="progressbar" accessibilityLabel={`Loading ${label}`}>
        <ActivityIndicator size="large" color={theme.colors[tone]} />
        <Text style={[styles.label, { color: theme.colors.textSecondary }]}>Getting things ready…</Text>
      </View>
    </SafeAreaView>
  );
}

/**
 * Shown when the app could not start. The failure is announced once (a screen reader would otherwise lose the race against the
 * layout change) and there is one clear way out: try again.
 */
export function StartupErrorView({ label, tone, message, onRetry }: AppIdentity & { message?: string; onRetry: () => void }) {
  const theme = useTheme();
  const description = message ?? `Something went wrong while starting ${label}.`;

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(description);
  }, [description]);

  return (
    <SafeAreaView style={[styles.error, { backgroundColor: theme.colors.background }]}>
      <Wordmark label={label} tone={tone} />
      <View style={styles.body} accessible accessibilityRole="alert">
        <Text style={[styles.title, { color: theme.colors.textPrimary }]}>We hit a problem</Text>
        <Text style={[styles.message, { color: theme.colors.textSecondary }]}>{description}</Text>
      </View>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Try again"
        accessibilityHint="Retries starting the app"
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: pressed ? theme.colors.primaryDark : theme.colors[tone], minHeight: theme.minTouchTarget },
        ]}
      >
        <Text style={[styles.buttonText, { color: theme.colors.textInverse }]}>Try again</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 32 },
  status: { alignItems: 'center', gap: 12 },
  label: { fontSize: 16 },
  error: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24, paddingHorizontal: 32 },
  body: { alignItems: 'center', gap: 8 },
  title: { fontSize: 20, fontWeight: '700' },
  message: { fontSize: 15, textAlign: 'center' },
  button: { paddingHorizontal: 24, justifyContent: 'center', alignItems: 'center', borderRadius: 999 },
  buttonText: { fontSize: 16, fontWeight: '600' },
});
