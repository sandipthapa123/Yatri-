import { StyleSheet, Text, View } from 'react-native';

import { ActionButton, type UiProps } from './RideUi';

export interface Choice<T extends string> {
  value: T;
  label: string;
  help?: string;
}

/**
 * A group of independent yes/no choices (several can be on). Each is a switch whose label says its state in words
 * ("I travel with a service animal: On"), so nothing depends on colour or on a check mark.
 */
export function ChoiceSwitches<T extends string>(
  props: UiProps & {
    legend: string;
    choices: ReadonlyArray<Choice<T>>;
    selected: readonly T[];
    onChange: (next: T[]) => void;
    disabled?: boolean;
  },
) {
  const { colors, legend, choices, selected, disabled } = props;
  const ui = { colors: props.colors, minTouchTarget: props.minTouchTarget };
  const toggle = (v: T) =>
    props.onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  return (
    <View style={styles.group}>
      <Text accessibilityRole="header" style={[styles.legend, { color: colors.textPrimary }]}>
        {legend}
      </Text>
      {choices.map((c) => {
        const on = selected.includes(c.value);
        return (
          <View key={c.value} style={styles.item}>
            <ActionButton
              {...ui}
              role="switch"
              selected={on}
              disabled={disabled}
              label={`${c.label}: ${on ? 'On' : 'Off'}`}
              hint={c.help}
              onPress={() => toggle(c.value)}
            />
            {c.help ? (
              <Text style={{ color: colors.textSecondary, fontSize: 14 }}>{c.help}</Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** A group where exactly one choice is on. */
export function ChoiceRadios<T extends string>(
  props: UiProps & {
    legend: string;
    choices: ReadonlyArray<Choice<T>>;
    value: T;
    onChange: (next: T) => void;
    disabled?: boolean;
  },
) {
  const { colors, legend, choices, value, disabled } = props;
  const ui = { colors: props.colors, minTouchTarget: props.minTouchTarget };
  return (
    <View style={styles.group}>
      <Text accessibilityRole="header" style={[styles.legend, { color: colors.textPrimary }]}>
        {legend}
      </Text>
      <View accessibilityRole="radiogroup" style={styles.group}>
        {choices.map((c) => (
          <View key={c.value} style={styles.item}>
            <ActionButton
              {...ui}
              role="radio"
              selected={value === c.value}
              disabled={disabled}
              label={c.label}
              hint={c.help}
              onPress={() => props.onChange(c.value)}
            />
            {c.help ? (
              <Text style={{ color: colors.textSecondary, fontSize: 14 }}>{c.help}</Text>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  item: { gap: 4 },
  legend: { fontSize: 17, fontWeight: '700' },
});
