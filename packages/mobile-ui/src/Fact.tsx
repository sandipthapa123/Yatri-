import { Text, View } from 'react-native';

import { useUiPreferences } from './uiPreferences';

/** A label and its value, read together by a screen reader ("Fare: NPR 240"), and sized by the person's text-size choice. */
export function Fact(props: {
  colors: { textPrimary: string; textSecondary: string };
  label: string;
  value: string;
}) {
  const { colors } = props;
  const { fontScale } = useUiPreferences();
  return (
    <View
      accessible
      accessibilityLabel={`${props.label}: ${props.value}`}
      style={{ paddingVertical: 4 }}
    >
      <Text style={{ color: colors.textSecondary, fontSize: 13 * fontScale }}>{props.label}</Text>
      <Text style={{ color: colors.textPrimary, fontSize: 17 * fontScale, fontWeight: '600' }}>
        {props.value}
      </Text>
    </View>
  );
}

/** Something went wrong, in words that start with "Problem", announced the moment it appears. The one way a form says so. */
export function Problem(props: { text: string; color: string }) {
  return (
    <Text accessibilityRole="alert" style={{ color: props.color, fontWeight: '600' }}>
      {`Problem: ${props.text}`}
    </Text>
  );
}
