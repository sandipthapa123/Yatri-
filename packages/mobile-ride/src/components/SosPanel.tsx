import { describeSosStatus, OPEN_SOS_STATES } from '@yatri/types';
import { useUiPreferences } from '@yatri/mobile-ui';
import { useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { useFocusWhen } from '../hooks';
import type { SosController, SosState } from '../sosController';
import { ActionButton, Announcer, Card, type UiProps } from './RideUi';

const FALLBACK_NUMBER = '100';

/**
 * Emergency help during a ride, for either person. It is a labelled control (never colour alone),
 * reachable in the normal reading and tab order, and asks once before sending so a stray touch
 * cannot raise an alarm. Everything after that comes from the server: the alert, who has seen it,
 * whether contacts were told. Calling the emergency number is always one press away, and is what
 * the screen points to whenever the alert itself cannot be sent.
 * The other person on the ride is never told: the alert goes to this person and the safety team.
 */
export function SosPanel(props: UiProps & { state: SosState; controller: SosController | null }) {
  const { state, controller, colors, minTouchTarget } = props;
  const ui = { colors, minTouchTarget };
  const { confirmBeforeSos } = useUiPreferences(); // the person's choice; on unless they turned it off
  const [confirming, setConfirming] = useState(false);
  // When the confirmation replaces the SOS button, the screen reader goes to its question.
  const questionRef = useFocusWhen(confirming);
  const sos = state.sos;
  const open = sos !== null && OPEN_SOS_STATES.includes(sos.status);
  const number = sos?.emergencyNumber ?? FALLBACK_NUMBER;
  const call = () => void Linking.openURL(`tel:${number}`).catch(() => undefined);

  return (
    <Card {...ui} title="Emergency help">
      {/* Critical news is read out at once, from whichever tab is showing. */}
      <Announcer {...ui} assertive={state.assertive} />

      {open && sos ? (
        <>
          <Text accessibilityRole="text" style={[styles.status, { color: colors.textPrimary }]}>
            {describeSosStatus(sos)}
          </Text>
          <ActionButton
            {...ui}
            label={`Call emergency services (${number})`}
            tone="primary"
            onPress={call}
          />
          <ActionButton
            {...ui}
            label="I am safe: cancel the alert"
            busy={state.busy === 'cancelling'}
            disabled={state.busy !== null}
            onPress={() => void controller?.cancel()}
          />
        </>
      ) : confirming ? (
        <View style={styles.group}>
          <Text
            ref={questionRef}
            accessibilityRole="header"
            style={{ color: colors.textPrimary, fontWeight: '700' }}
          >
            Send an emergency alert?
          </Text>
          <Text style={{ color: colors.textSecondary }}>
            The Yatri safety team will be alerted with your ride and your location, and your
            emergency contacts will get a link to follow the trip. The other person on the ride is
            not told.
          </Text>
          <ActionButton
            {...ui}
            label="Send emergency alert now"
            tone="danger"
            busy={state.busy === 'sending'}
            disabled={state.busy !== null}
            onPress={() => {
              void controller?.raise().then(() => setConfirming(false));
            }}
          />
          <ActionButton
            {...ui}
            label="Not now"
            disabled={state.busy !== null}
            onPress={() => setConfirming(false)}
          />
        </View>
      ) : (
        <>
          {sos ? (
            <Text accessibilityRole="text" style={{ color: colors.textSecondary }}>
              {describeSosStatus(sos)}
            </Text>
          ) : null}
          <ActionButton
            {...ui}
            label="Emergency SOS"
            hint={
              confirmBeforeSos
                ? 'Asks you to confirm, then alerts the Yatri safety team'
                : 'Alerts the Yatri safety team straight away'
            }
            tone="danger"
            disabled={!controller}
            onPress={() => (confirmBeforeSos ? setConfirming(true) : void controller?.raise())}
          />
        </>
      )}

      {state.error ? (
        <View style={styles.group}>
          <Text accessibilityRole="alert" style={{ color: colors.error, fontWeight: '600' }}>
            {state.error}
          </Text>
          {!open ? (
            <ActionButton {...ui} label={`Call emergency services (${number})`} onPress={call} />
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  status: { fontSize: 17, fontWeight: '600' },
});
