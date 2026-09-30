import { formatDuration, formatNpr, type RideCategoryOption } from '@yatri/types';
import { StyleSheet, Text, View } from 'react-native';

import { ActionButton, type UiProps } from './RideUi';

/** One option as a single sentence, so a screen reader reads it as one thing. */
export function categoryLabel(o: RideCategoryOption, selected: boolean): string {
  const time =
    o.fare.durationSeconds === null ? '' : `, about ${formatDuration(o.fare.durationSeconds)}`;
  const surge = o.fare.surgeMultiplier > 1 ? ', higher demand pricing' : '';
  return `${o.label}, ${formatNpr(o.fare.totalNpr)}${surge}${time}. ${
    o.available ? 'Available now.' : 'None available near you right now.'
  }${selected ? ' Selected.' : ''}`;
}

/**
 * Choose the vehicle type. A radio group: the label carries name, fare, time and availability in
 * words (availability is never colour alone). A category with no driver nearby can still be chosen —
 * a driver may come online — but the row says so plainly. Fares are the server's numbers.
 */
export function CategoryPicker(
  props: UiProps & {
    options: RideCategoryOption[];
    selected: string;
    onSelect: (code: string) => void;
  },
) {
  const { options, selected, colors, minTouchTarget } = props;
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Vehicle type" style={styles.group}>
      {options.map((o) => (
        <ActionButton
          key={o.code}
          colors={colors}
          minTouchTarget={minTouchTarget}
          role="radio"
          selected={o.code === selected}
          label={o.label}
          accessibilityLabel={categoryLabel(o, o.code === selected)}
          onPress={() => props.onSelect(o.code)}
        />
      ))}
      {options.map((o) =>
        o.code === selected ? (
          <Text key={o.code} style={{ color: colors.textSecondary }}>
            {o.available
              ? 'Drivers are available near you.'
              : 'No driver is nearby right now. You can still request; we will keep looking.'}
          </Text>
        ) : null,
      )}
    </View>
  );
}

const styles = StyleSheet.create({ group: { gap: 8 } });
