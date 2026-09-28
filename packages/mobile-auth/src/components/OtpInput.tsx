import { forwardRef } from 'react';
import { StyleSheet, Text, TextInput, View, type TextInput as RNTextInput } from 'react-native';

export interface OtpInputProps {
  value: string;
  onChangeValue: (code: string) => void;
  length: number;
  errorMessage?: string;
  colors: {
    textPrimary: string;
    textSecondary: string;
    border: string;
    error: string;
    surface: string;
  };
}

/**
 * A single numeric field, deliberately not a row of per-digit boxes.
 * Segmented OTP widgets move focus between many small inputs as you type,
 * which is a well-known screen-reader pain point (VoiceOver/TalkBack lose
 * track of position, or announce every box individually). One field with
 * textContentType="oneTimeCode" / autoComplete="sms-otp" both reads
 * cleanly and lets iOS/Android autofill the code from the SMS.
 */
export const OtpInput = forwardRef<RNTextInput, OtpInputProps>(function OtpInput(
  { value, onChangeValue, length, errorMessage, colors },
  ref,
) {
  const label = 'Verification code';
  const accessibleLabel = errorMessage ? `${label}. ${errorMessage}` : label;

  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: colors.textPrimary }]} nativeID="otp-input-label">
        {label}
      </Text>
      <TextInput
        ref={ref}
        value={value}
        onChangeText={(text) => onChangeValue(text.replace(/\D/g, '').slice(0, length))}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="sms-otp"
        inputMode="numeric"
        maxLength={length}
        placeholder={'0'.repeat(length)}
        placeholderTextColor={colors.textSecondary}
        style={[
          styles.input,
          {
            color: colors.textPrimary,
            borderColor: errorMessage ? colors.error : colors.border,
            backgroundColor: colors.surface,
          },
        ]}
        accessibilityLabel={accessibleLabel}
        accessibilityLabelledBy="otp-input-label"
        accessibilityHint={`Enter the ${length} digit code sent by SMS`}
      />
      {errorMessage ? (
        <Text style={[styles.error, { color: colors.error }]} accessibilityRole="alert">
          {errorMessage}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { gap: 8 },
  label: { fontSize: 15, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    minHeight: 48,
    fontSize: 20,
    letterSpacing: 4,
  },
  error: { fontSize: 13 },
});
