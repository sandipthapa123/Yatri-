import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ApiError, OtpInput, useAuth } from '@yatri/mobile-auth';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Logo } from '../components/Logo';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useTheme } from '../theme/useTheme';

type Props = NativeStackScreenProps<RootStackParamList, 'OtpVerification'>;

const OTP_LENGTH = 6;

function friendlyErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'OTP_LOCKED') return 'Too many incorrect attempts. Request a new code.';
    if (err.code === 'INVALID_OTP') return 'That code is incorrect or has expired.';
    if (err.code === 'RATE_LIMITED') return 'Too many attempts. Please wait and try again.';
    return err.message;
  }
  return 'Something went wrong. Please check your connection and try again.';
}

export function OtpVerificationScreen({ route }: Props) {
  const { phoneNumber } = route.params;
  const theme = useTheme();
  const { requestOtp, verifyOtp } = useAuth();

  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [cooldown, setCooldown] = useState(0);
  const [devOtp, setDevOtp] = useState<string | undefined>(undefined);
  const announcedOnMount = useRef(false);

  useEffect(() => {
    if (!announcedOnMount.current) {
      announcedOnMount.current = true;
      AccessibilityInfo.announceForAccessibility(
        `A ${OTP_LENGTH} digit code was sent to your phone.`,
      );
    }
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const handleVerify = useCallback(async () => {
    if (code.length < 4) return;
    setSubmitting(true);
    setErrorMessage(undefined);
    try {
      await verifyOtp(phoneNumber, code);
    } catch (err) {
      const message = friendlyErrorMessage(err);
      setErrorMessage(message);
      setCode('');
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      setSubmitting(false);
    }
  }, [code, phoneNumber, verifyOtp]);

  const handleResend = useCallback(async () => {
    setResending(true);
    setErrorMessage(undefined);
    try {
      const result = await requestOtp(phoneNumber);
      setCooldown(result.resendAvailableInSeconds);
      setDevOtp(result.devOtp);
      AccessibilityInfo.announceForAccessibility('A new code was sent.');
    } catch (err) {
      const message = friendlyErrorMessage(err);
      setErrorMessage(message);
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      setResending(false);
    }
  }, [phoneNumber, requestOtp]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={styles.header}>
        <Logo />
        <Text
          style={[styles.subtitle, { color: theme.colors.textSecondary }]}
          accessibilityRole="text"
        >
          Enter the {OTP_LENGTH} digit code we sent to {phoneNumber}.
        </Text>
        {devOtp ? (
          <Text
            style={[styles.devBanner, { color: theme.colors.warning }]}
            accessibilityLabel={`Development mode code: ${devOtp}`}
          >
            Dev mode code: {devOtp}
          </Text>
        ) : null}
      </View>

      <OtpInput
        value={code}
        onChangeValue={setCode}
        length={OTP_LENGTH}
        errorMessage={errorMessage}
        colors={theme.colors}
      />

      <Pressable
        onPress={handleVerify}
        disabled={submitting || code.length < 4}
        accessibilityRole="button"
        accessibilityLabel={submitting ? 'Verifying' : 'Verify code'}
        accessibilityState={{ busy: submitting, disabled: submitting || code.length < 4 }}
        style={({ pressed }) => [
          styles.button,
          {
            backgroundColor: pressed ? theme.colors.primaryDark : theme.colors.secondary,
            minHeight: theme.minTouchTarget,
            opacity: submitting || code.length < 4 ? 0.6 : 1,
          },
        ]}
      >
        <Text style={[styles.buttonText, { color: theme.colors.textInverse }]}>
          {submitting ? 'Verifying…' : 'Verify code'}
        </Text>
      </Pressable>

      <Pressable
        onPress={handleResend}
        disabled={cooldown > 0 || resending}
        accessibilityRole="button"
        accessibilityLabel={
          cooldown > 0 ? `Resend code available in ${cooldown} seconds` : 'Resend code'
        }
        accessibilityState={{ disabled: cooldown > 0 || resending }}
        style={styles.resendButton}
      >
        <Text style={[styles.resendText, { color: theme.colors.secondary }]}>
          {cooldown > 0 ? `Resend code in ${cooldown}s` : resending ? 'Resending…' : 'Resend code'}
        </Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 24, justifyContent: 'center' },
  header: { alignItems: 'center', gap: 12, marginBottom: 8 },
  subtitle: { fontSize: 15, textAlign: 'center' },
  devBanner: { fontSize: 13, fontWeight: '700' },
  button: { justifyContent: 'center', alignItems: 'center', borderRadius: 999 },
  buttonText: { fontSize: 17, fontWeight: '700' },
  resendButton: {
    alignSelf: 'center',
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  resendText: { fontSize: 15, fontWeight: '600' },
});
