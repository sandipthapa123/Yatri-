import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { useTheme } from '@yatri/mobile-ui';

interface FormFieldProps extends Omit<TextInputProps, 'style' | 'placeholderTextColor'> {
  label: string;
  errorMessage?: string;
  hint?: string;
  required?: boolean;
}

function slugify(label: string): string {
  return label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

/**
 * One labeled TextInput. Error text is folded into accessibilityLabel so a
 * screen reader announces field + error together, not as a separate,
 * easy-to-miss element (same pattern as PhoneNumberInput in mobile-auth).
 */
export function FormField({ label, errorMessage, hint, required, ...inputProps }: FormFieldProps) {
  const theme = useTheme();
  const id = `field-${slugify(label)}`;
  const accessibleLabel = errorMessage
    ? `${label}. ${errorMessage}`
    : required
      ? `${label}, required`
      : label;

  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.colors.textPrimary }]} nativeID={id}>
        {label}
        {required ? ' *' : ''}
      </Text>
      {hint ? (
        <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>{hint}</Text>
      ) : null}
      <TextInput
        placeholderTextColor={theme.colors.textSecondary}
        style={[
          styles.input,
          {
            color: theme.colors.textPrimary,
            borderColor: errorMessage ? theme.colors.error : theme.colors.border,
            backgroundColor: theme.colors.surface,
            minHeight: theme.minTouchTarget,
          },
        ]}
        accessibilityLabel={accessibleLabel}
        accessibilityLabelledBy={id}
        {...inputProps}
      />
      {errorMessage ? (
        <Text style={[styles.error, { color: theme.colors.error }]} accessibilityRole="alert">
          {errorMessage}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  label: { fontSize: 15, fontWeight: '600' },
  hint: { fontSize: 12 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 16, fontSize: 16 },
  error: { fontSize: 13 },
});
