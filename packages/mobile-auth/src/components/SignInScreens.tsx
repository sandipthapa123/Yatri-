import { useTheme, Wordmark, type WordmarkProps } from '@yatri/mobile-ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiError } from '../apiClient';
import { useAuth } from '../AuthContext';
import { OtpInput } from './OtpInput';
import { PhoneNumberInput, toE164 } from './PhoneNumberInput';

/**
 * Signing in with a phone number: welcome, phone number, code. The ONE implementation for both apps; an app supplies only who it
 * is (its wordmark, accent and words) and where each step goes next. Every outcome is spoken to a screen reader, and the
 * figures (how long the code is, how long to wait before another) come from the server.
 */
export interface SignInIdentity extends Pick<WordmarkProps, 'label' | 'tone'> {
  /** The line under the wordmark on the welcome screen. */
  tagline: string;
  /** What the phone number screen says it is for. */
  phonePrompt: string;
}

const UNREACHABLE = 'Something went wrong. Please check your connection and try again.';

function useAccent(tone: SignInIdentity['tone']) {
  const theme = useTheme();
  return { theme, accent: theme.colors[tone] };
}

function PrimaryButton(props: {
  label: string;
  busyLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  hint?: string;
  tone: SignInIdentity['tone'];
  onPress: () => void;
}) {
  const { theme, accent } = useAccent(props.tone);
  const off = !!props.busy || !!props.disabled;
  const label = props.busy && props.busyLabel ? props.busyLabel : props.label;
  return (
    <Pressable
      onPress={props.onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={props.hint}
      accessibilityState={{ busy: !!props.busy, disabled: off }}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: pressed ? theme.colors.primaryDark : accent,
          minHeight: theme.minTouchTarget,
          opacity: off ? 0.65 : 1,
        },
      ]}
    >
      <Text style={[styles.buttonText, { color: theme.colors.textInverse }]}>
        {props.busy && props.busyLabel ? `${props.busyLabel}…` : props.label}
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------- welcome

export function WelcomeView({ identity, onGetStarted }: { identity: SignInIdentity; onGetStarted: () => void }) {
  const theme = useTheme();
  return (
    <SafeAreaView style={[styles.welcome, { backgroundColor: theme.colors.background }]}>
      <View style={styles.welcomeHeader}>
        <Wordmark label={identity.label} tone={identity.tone} size="lg" />
        <Text style={[styles.tagline, { color: theme.colors.textSecondary }]}>{identity.tagline}</Text>
      </View>
      <View style={styles.stretch}>
        <PrimaryButton
          label="Get started"
          hint="Continue to sign in with your phone number"
          tone={identity.tone}
          onPress={onGetStarted}
        />
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------- phone number

function phoneErrorMessage(err: unknown): string {
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
  return UNREACHABLE;
}

export function PhoneEntryView({
  identity,
  onCodeSent,
}: {
  identity: SignInIdentity;
  /** The code was sent: go to the code screen with the number and the code's length. */
  onCodeSent: (phoneNumber: string, codeLength: number) => void;
}) {
  const theme = useTheme();
  const { requestOtp } = useAuth();
  const [localDigits, setLocalDigits] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const phoneNumber = toE164(localDigits);

  async function handleSubmit() {
    const fail = (message: string) => {
      setErrorMessage(message);
      AccessibilityInfo.announceForAccessibility(message);
    };
    if (!phoneNumber) return fail('Enter a valid 10 digit phone number.');
    setSubmitting(true);
    setErrorMessage(undefined);
    try {
      const sent = await requestOtp(phoneNumber);
      onCodeSent(phoneNumber, sent.codeLength);
    } catch (err) {
      fail(phoneErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={[styles.form, { backgroundColor: theme.colors.background }]}>
      <View style={styles.formHeader}>
        <Wordmark label={identity.label} tone={identity.tone} />
        <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]} accessibilityRole="text">
          {identity.phonePrompt}
        </Text>
      </View>
      <PhoneNumberInput
        value={localDigits}
        onChangeValue={setLocalDigits}
        errorMessage={errorMessage}
        colors={theme.colors}
      />
      <PrimaryButton
        label="Send code"
        busyLabel="Sending code"
        busy={submitting}
        tone={identity.tone}
        onPress={handleSubmit}
      />
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------- the code

function codeErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'OTP_LOCKED') return 'Too many incorrect attempts. Request a new code.';
    if (err.code === 'INVALID_OTP') return 'That code is incorrect or has expired.';
    if (err.code === 'RATE_LIMITED') return 'Too many attempts. Please wait and try again.';
    return err.message;
  }
  return UNREACHABLE;
}

/**
 * Enter the code. Nothing navigates on success: verifying flips the sign-in state to "authenticated" and each app's navigator
 * swaps to its signed-in screens on its own.
 */
export function OtpVerificationView({
  identity,
  phoneNumber,
  codeLength,
}: {
  identity: SignInIdentity;
  phoneNumber: string;
  codeLength: number;
}) {
  const theme = useTheme();
  const { requestOtp, verifyOtp } = useAuth();
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [cooldown, setCooldown] = useState(0);
  const [devOtp, setDevOtp] = useState<string | undefined>(undefined);
  const announcedOnMount = useRef(false);
  const complete = code.length === codeLength;

  useEffect(() => {
    if (announcedOnMount.current) return;
    announcedOnMount.current = true;
    AccessibilityInfo.announceForAccessibility(`A ${codeLength} digit code was sent to your phone.`);
  }, [codeLength]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const handleVerify = useCallback(async () => {
    if (!complete) return;
    setSubmitting(true);
    setErrorMessage(undefined);
    try {
      await verifyOtp(phoneNumber, code);
    } catch (err) {
      const message = codeErrorMessage(err);
      setErrorMessage(message);
      setCode('');
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      setSubmitting(false);
    }
  }, [code, complete, phoneNumber, verifyOtp]);

  const handleResend = useCallback(async () => {
    setResending(true);
    setErrorMessage(undefined);
    try {
      const result = await requestOtp(phoneNumber);
      setCooldown(result.resendAvailableInSeconds);
      setDevOtp(result.devOtp);
      AccessibilityInfo.announceForAccessibility('A new code was sent.');
    } catch (err) {
      const message = codeErrorMessage(err);
      setErrorMessage(message);
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      setResending(false);
    }
  }, [phoneNumber, requestOtp]);

  return (
    <SafeAreaView style={[styles.form, { backgroundColor: theme.colors.background }]}>
      <View style={styles.formHeader}>
        <Wordmark label={identity.label} tone={identity.tone} />
        <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]} accessibilityRole="text">
          Enter the {codeLength} digit code we sent to {phoneNumber}.
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
        length={codeLength}
        errorMessage={errorMessage}
        colors={theme.colors}
      />
      <PrimaryButton
        label="Verify code"
        busyLabel="Verifying code"
        busy={submitting}
        disabled={!complete}
        tone={identity.tone}
        onPress={handleVerify}
      />
      <Pressable
        onPress={handleResend}
        disabled={cooldown > 0 || resending}
        accessibilityRole="button"
        accessibilityLabel={cooldown > 0 ? `Resend code available in ${cooldown} seconds` : 'Resend code'}
        accessibilityState={{ disabled: cooldown > 0 || resending }}
        style={[styles.resendButton, { minHeight: theme.minTouchTarget }]}
      >
        <Text style={[styles.resendText, { color: theme.colors.secondary }]}>
          {cooldown > 0 ? `Resend code in ${cooldown}s` : resending ? 'Resending…' : 'Resend code'}
        </Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  welcome: {
    flex: 1,
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 64,
    paddingHorizontal: 32,
  },
  welcomeHeader: { alignItems: 'center', gap: 12, marginTop: 48 },
  tagline: { fontSize: 16, textAlign: 'center' },
  stretch: { alignSelf: 'stretch' },
  form: { flex: 1, padding: 24, gap: 24, justifyContent: 'center' },
  formHeader: { alignItems: 'center', gap: 12, marginBottom: 8 },
  subtitle: { fontSize: 15, textAlign: 'center' },
  devBanner: { fontSize: 13, fontWeight: '700' },
  button: { justifyContent: 'center', alignItems: 'center', borderRadius: 999 },
  buttonText: { fontSize: 17, fontWeight: '700' },
  resendButton: { alignSelf: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  resendText: { fontSize: 15, fontWeight: '600' },
});

// ---------------------------------------------------------------- bound to an app's navigation

/** The route names and parameters both apps give the sign-in steps. */
export type SignInRoutes = {
  Welcome: undefined;
  PhoneEntry: undefined;
  OtpVerification: { phoneNumber: string; codeLength: number };
};

interface Navigates {
  navigate(name: 'PhoneEntry'): void;
  navigate(name: 'OtpVerification', params: SignInRoutes['OtpVerification']): void;
}

/**
 * The three sign-in screens, ready to register with an app's stack navigator. Built once per app, at start-up, from that app's
 * identity; the app writes no screen of its own.
 */
export function createSignInScreens(identity: SignInIdentity) {
  function WelcomeScreen({ navigation }: { navigation: Navigates }) {
    return <WelcomeView identity={identity} onGetStarted={() => navigation.navigate('PhoneEntry')} />;
  }
  function PhoneEntryScreen({ navigation }: { navigation: Navigates }) {
    return (
      <PhoneEntryView
        identity={identity}
        onCodeSent={(phoneNumber, codeLength) => navigation.navigate('OtpVerification', { phoneNumber, codeLength })}
      />
    );
  }
  function OtpVerificationScreen({ route }: { route: { params: SignInRoutes['OtpVerification'] } }) {
    return <OtpVerificationView identity={identity} {...route.params} />;
  }
  return { WelcomeScreen, PhoneEntryScreen, OtpVerificationScreen };
}
