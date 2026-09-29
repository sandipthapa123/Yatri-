import { useState } from 'react';
import { Linking, Platform, Text } from 'react-native';

import { mapsUrl } from '../rideText';
import { ActionButton, type UiProps } from './RideUi';

/**
 * Hands the pickup or destination — the coordinates the SERVER holds for this ride — to the driver's
 * maps app for turn-by-turn directions. Yatri shows distance, ETA and place names itself; navigation
 * is delegated so there is one location source (the presence feed) and no duplicate routing here.
 */
export function NavigateButton(
  props: UiProps & { target: { latitude: number; longitude: number }; label: string },
) {
  const [failed, setFailed] = useState(false);
  return (
    <>
      <ActionButton
        colors={props.colors}
        minTouchTarget={props.minTouchTarget}
        label={props.label}
        hint="Opens your maps app with directions"
        onPress={() => {
          setFailed(false);
          Linking.openURL(mapsUrl(props.target, props.label, Platform.OS)).catch(() =>
            setFailed(true),
          );
        }}
      />
      {failed ? (
        <Text accessibilityRole="alert" style={{ color: props.colors.error }}>
          No maps app could be opened. The distance and time above still update.
        </Text>
      ) : null}
    </>
  );
}
