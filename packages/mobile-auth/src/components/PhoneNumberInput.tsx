import { StyleSheet, Text, TextInput, View } from 'react-native';

const COUNTRY_CODE = '+977';

export interface PhoneNumberInputProps {
  /** Local digits only (no country code) — the caller composes the E.164 value. */
  value: string;
  onChangeValue: (localDigits: string) => void;
  errorMessage?: string;
  colors: {
    textPrimary: string;
    textSecondary: string;
    border: string;
    error: string;
    surface: string;
  };
}

/** Full E.164 phone number for the given local digits, or null if incomplete. */
export function toE164(localDigits: string): string | null {
  const digits = localDigits.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 10 ? `${COUNTRY_CODE}${digits}` : null;
}

/**
 * A single labeled input, not a custom multi-segment widget — segmented
 * phone/code inputs are a common source of screen-reader focus bugs.
 * Error text is linked via accessibilityLabel so VoiceOver/TalkBack read it
 * together with the field, not as a separate, easy-to-miss element.
 */
export function PhoneNumberInput({
  value,
  onChangeValue,
  errorMessage,
  colors,
}: PhoneNumberInputProps) {
  const label = 'Phone number';
  const accessibleLabel = errorMessage ? `${label}. ${errorMessage}` : label;

  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: colors.textPrimary }]} nativeID="phone-input-label">
        {label}
      </Text>
      <View
        style={[
          styles.row,
          {
            borderColor: errorMessage ? colors.error : colors.border,
            backgroundColor: colors.surface,
          },
        ]}
      >
        <Text style={[styles.prefix, { color: colors.textSecondary }]}>{COUNTRY_CODE}</Text>
        <TextInput
          value={value}
          onChangeText={(text) => onChangeValue(text.replace(/\D/g, '').slice(0, 10))}
          keyboardType="phone-pad"
          textContentType="telephoneNumber"
          autoComplete="tel"
          inputMode="tel"
          maxLength={10}
          placeholder="9800000000"
          placeholderTextColor={colors.textSecondary}
          style={[styles.input, { color: colors.textPrimary }]}
          accessibilityLabel={accessibleLabel}
          accessibilityLabelledBy="phone-input-label"
          accessibilityHint="Enter your 10 digit mobile number"
        />
      </View>
      {errorMessage ? (
        <Text style={[styles.error, { color: colors.error }]} accessibilityRole="alert">
          {errorMessage}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 8 },
  label: { fontSize: 15, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    minHeight: 48,
  },
  prefix: { fontSize: 16, marginRight: 8 },
  input: { flex: 1, fontSize: 16, minHeight: 44, paddingVertical: 0 },
  error: { fontSize: 13 },
});
