import { useEffect } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Logo } from '../components/Logo';
import { useTheme } from '@yatri/mobile-ui';

interface ErrorScreenProps {
  message?: string;
  onRetry: () => void;
}

export function ErrorScreen({ message, onRetry }: ErrorScreenProps) {
  const theme = useTheme();
  const description = message ?? 'Something went wrong while starting Yatri Driver.';

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(description);
  }, [description]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Logo />
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
          {
            backgroundColor: pressed ? theme.colors.primaryDark : theme.colors.secondary,
            minHeight: theme.minTouchTarget,
          },
        ]}
      >
        <Text style={[styles.buttonText, { color: theme.colors.textInverse }]}>Try again</Text>
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
  title: { fontSize: 20, fontWeight: '700' },
  message: { fontSize: 15, textAlign: 'center' },
  button: {
    paddingHorizontal: 24,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 999,
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
});
