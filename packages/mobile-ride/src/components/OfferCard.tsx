import { formatDistance, formatDuration, formatNpr } from '@yatri/types';
import { StyleSheet, Text, View } from 'react-native';

import { useNow } from '../hooks';
import { offerSecondsLeft, type OfferController, type OfferState } from '../offerController';
import { ActionButton, Announcer, Card, Fact, type UiProps } from './RideUi';

/**
 * A ride request offered to the driver. The whole request is text (pickup, destination, distances,
 * fare, time left); the countdown is shown but not announced every second — the request is
 * announced once when it arrives (assertively), and its outcome once when it closes. The server
 * decides when the offer expires; the number here is only a courtesy.
 */
export function OfferCard(
  props: UiProps & {
    state: OfferState;
    controller: OfferController | null;
    onAccepted: (tripId: string) => void;
  },
) {
  const { state, controller, colors, minTouchTarget } = props;
  const ui = { colors, minTouchTarget };
  const { offer } = state;
  const now = useNow(1000, !!offer);
  const left = offer && state.receivedAtMs ? offerSecondsLeft(offer, state.receivedAtMs, now) : 0;

  return (
    <View style={styles.container}>
      <Announcer {...ui} polite={state.polite} assertive={state.assertive} />
      {state.error ? (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {state.error}
        </Text>
      ) : null}
      {offer ? (
        <Card {...ui} title="New ride request">
          <Fact
            {...ui}
            label="Pickup"
            value={`${offer.pickup.name}, ${formatDistance(offer.pickupDistanceMeters)} from you`}
          />
          <Fact
            {...ui}
            label="Destination"
            value={`${offer.destination.name}, ${formatDistance(offer.tripDistanceMeters)} trip`}
          />
          <Fact {...ui} label="Fare" value={formatNpr(offer.fareEstimateNpr)} />
          <Fact
            {...ui}
            label="Time to respond"
            value={left > 0 ? formatDuration(left) : 'Expired'}
          />
          <ActionButton
            {...ui}
            label="Accept ride"
            tone="primary"
            busy={state.responding}
            disabled={left <= 0}
            onPress={() => {
              void controller?.accept().then((trip) => trip && props.onAccepted(trip.id));
            }}
          />
          <ActionButton
            {...ui}
            label="Decline"
            disabled={state.responding}
            onPress={() => void controller?.decline()}
          />
        </Card>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({ container: { gap: 12 } });
