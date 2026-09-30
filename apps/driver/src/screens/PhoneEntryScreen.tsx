import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ApiError, PhoneNumberInput, toE164, useAuth } from '@yatri/mobile-auth';
import { useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Logo } from '../components/Logo';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useTheme } from '@yatri/mobile-ui';

type Props = NativeStackScreenProps<RootStackParamList, 'PhoneEntry'>;

function friendlyErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'RATE_LIMITED') {
      const retryAfter = err.details?.retryAfterSeconds;
      return typeof retryAfter === 'number'
        ? `Too many requests. Try again in ${retryAfter} seconds.`
        : 'Too many requests. Please try again later.';
    }
    if (err.code === 'VALIDATION_ERROR') return 'Enter a valid phone number.';
    return err.message;
  }
  return 'Something went wrong. Please check your connection and try again.';
}

export function PhoneEntryScreen({ navigation }: Props) {
  const theme = useTheme();
  const { requestOtp } = useAuth();
  const [localDigits, setLocalDigits] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  const phoneNumber = toE164(localDigits);

  async function handleSubmit() {
    if (!phoneNumber) {
      const message = 'Enter a valid 10 digit phone number.';
      setErrorMessage(message);
      AccessibilityInfo.announceForAccessibility(message);
      return;
    }
    setSubmitting(true);
    setErrorMessage(undefined);
    try {
      await requestOtp(phoneNumber);
      navigation.navigate('OtpVerification', { phoneNumber });
    } catch (err) {
      const message = friendlyErrorMessage(err);
      setErrorMessage(message);
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={styles.header}>
        <Logo />
        <Text
          style={[styles.subtitle, { color: theme.colors.textSecondary }]}
          accessibilityRole="text"
        >
          We’ll text you a code to sign in or create your driver account.
        </Text>
      </View>

      <PhoneNumberInput
        value={localDigits}
        onChangeValue={setLocalDigits}
        errorMessage={errorMessage}
        colors={theme.colors}
      />

      <Pressable
        onPress={handleSubmit}
        disabled={submitting}
        accessibilityRole="button"
        accessibilityLabel={submitting ? 'Sending code' : 'Send code'}
        accessibilityState={{ busy: submitting, disabled: submitting }}
        style={({ pressed }) => [
          styles.button,
          {
            backgroundColor: pressed ? theme.colors.primaryDark : theme.colors.secondary,
            minHeight: theme.minTouchTarget,
            opacity: submitting ? 0.7 : 1,
          },
        ]}
      >
        <Text style={[styles.buttonText, { color: theme.colors.textInverse }]}>
          {submitting ? 'Sending…' : 'Send code'}
        </Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 24, justifyContent: 'center' },
  header: { alignItems: 'center', gap: 12, marginBottom: 8 },
  subtitle: { fontSize: 15, textAlign: 'center' },
  button: { justifyContent: 'center', alignItems: 'center', borderRadius: 999 },
  buttonText: { fontSize: 17, fontWeight: '700' },
});
