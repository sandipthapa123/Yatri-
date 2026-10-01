import type { UiProps } from '@yatri/mobile-ride';
import { StyleSheet, Text, TextInput, View } from 'react-native';

/** A visible label above an input that screen readers also announce; the error, if any, is read with it. */
export function Field(
  props: UiProps & {
    label: string;
    value: string;
    onChangeText: (v: string) => void;
    error?: string | null;
    keyboardType?: 'default' | 'number-pad' | 'email-address';
    multiline?: boolean;
    maxLength?: number;
    hint?: string;
  },
) {
  const { colors, minTouchTarget } = props;
  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: colors.textPrimary }]}>{props.label}</Text>
      {props.hint ? (
        <Text style={{ color: colors.textSecondary, fontSize: 13 }}>{props.hint}</Text>
      ) : null}
      <TextInput
        value={props.value}
        onChangeText={props.onChangeText}
        accessibilityLabel={props.error ? `${props.label}. ${props.error}` : props.label}
        keyboardType={props.keyboardType ?? 'default'}
        autoCapitalize={props.keyboardType === 'email-address' ? 'none' : 'sentences'}
        multiline={props.multiline}
        maxLength={props.maxLength}
        placeholderTextColor={colors.textSecondary}
        style={[
          styles.input,
          {
            minHeight: props.multiline ? minTouchTarget * 2 : minTouchTarget,
            color: colors.textPrimary,
            borderColor: props.error ? colors.error : colors.border,
          },
        ]}
      />
      {props.error ? (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {props.error}
        </Text>
      ) : null}
    </View>
  );
}

/** A problem shown as text with the role alert, so it is announced and not only coloured. */
export function Problem(props: { text: string; color: string }) {
  return (
    <Text accessibilityRole="alert" style={{ color: props.color }}>
      {`Problem: ${props.text}`}
    </Text>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 4 },
  label: { fontSize: 15, fontWeight: '600' },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, fontSize: 16 },
});
