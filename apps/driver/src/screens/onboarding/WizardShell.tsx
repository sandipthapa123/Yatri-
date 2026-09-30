import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTheme } from '@yatri/mobile-ui';

interface WizardShellProps {
  stepNumber: number;
  totalSteps: number;
  title: string;
  subtitle?: string;
  onBack?: () => void;
  onContinue: () => void;
  continueLabel?: string;
  continueDisabled?: boolean;
  continueBusy?: boolean;
  errorMessage?: string;
  children: ReactNode;
}

/**
 * Shared shell for every onboarding step: consistent progress text (never
 * color-only — always read as "Step N of M"), heading, scrollable body, and
 * a Back/Continue footer. Keeping this in one place means every step gets
 * the same accessible structure and focus order for free.
 */
export function WizardShell({
  stepNumber,
  totalSteps,
  title,
  subtitle,
  onBack,
  onContinue,
  continueLabel = 'Continue',
  continueDisabled = false,
  continueBusy = false,
  errorMessage,
  children,
}: WizardShellProps) {
  const theme = useTheme();
  const progressLabel = `Step ${stepNumber} of ${totalSteps}: ${title}`;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text
          style={[styles.progress, { color: theme.colors.textSecondary }]}
          accessibilityRole="text"
        >
          {progressLabel}
        </Text>
        <Text
          style={[styles.title, { color: theme.colors.textPrimary }]}
          accessibilityRole="header"
        >
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>{subtitle}</Text>
        ) : null}

        <View style={styles.body}>{children}</View>

        {errorMessage ? (
          <Text style={[styles.error, { color: theme.colors.error }]} accessibilityRole="alert">
            {errorMessage}
          </Text>
        ) : null}

        <View style={styles.footer}>
          {onBack ? (
            <Pressable
              onPress={onBack}
              accessibilityRole="button"
              accessibilityLabel="Back"
              style={[styles.backButton, { minHeight: theme.minTouchTarget }]}
            >
              <Text style={[styles.backText, { color: theme.colors.textSecondary }]}>Back</Text>
            </Pressable>
          ) : (
            <View />
          )}

          <Pressable
            onPress={onContinue}
            disabled={continueDisabled || continueBusy}
            accessibilityRole="button"
            accessibilityLabel={continueBusy ? 'Saving' : continueLabel}
            accessibilityState={{ busy: continueBusy, disabled: continueDisabled || continueBusy }}
            style={[
              styles.continueButton,
              {
                backgroundColor: theme.colors.secondary,
                minHeight: theme.minTouchTarget,
                opacity: continueDisabled || continueBusy ? 0.6 : 1,
              },
            ]}
          >
            <Text style={[styles.continueText, { color: theme.colors.textInverse }]}>
              {continueBusy ? 'Saving…' : continueLabel}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 24, gap: 16, flexGrow: 1 },
  progress: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  title: { fontSize: 22, fontWeight: '700' },
  subtitle: { fontSize: 15, lineHeight: 21 },
  body: { gap: 16, marginTop: 8 },
  error: { fontSize: 14 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 24,
    gap: 12,
  },
  backButton: { justifyContent: 'center', paddingHorizontal: 8 },
  backText: { fontSize: 16, fontWeight: '600' },
  continueButton: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 999,
    paddingHorizontal: 24,
  },
  continueText: { fontSize: 17, fontWeight: '700' },
});
