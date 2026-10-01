import { ApiError } from '@yatri/mobile-auth';
import {
  ACCESSIBILITY_NOTE_MAX,
  COMMUNICATION_LABELS,
  COMMUNICATION_PREFERENCES,
  PICKUP_INSTRUCTION_CODES,
  PICKUP_INSTRUCTION_LABELS,
  describeAccessibilityForDriver,
  hasAccessibilityContent,
  type CommunicationPreference,
  type PickupInstructionCode,
  type TripRole,
  type TripSummary,
} from '@yatri/types';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { PICKUP_SAVED_NEWS, profileSummary } from '../accessibilityText';
import { rideApi } from '../rideApi';
import { ChoiceRadios, ChoiceSwitches } from './AccessibilityChoices';
import { ActionButton, Announcer, Card, type UiProps } from './RideUi';

const COMM = COMMUNICATION_PREFERENCES.map((c) => ({
  value: c,
  label: COMMUNICATION_LABELS[c].label,
  help: COMMUNICATION_LABELS[c].help,
}));
const PICKUP = PICKUP_INSTRUCTION_CODES.map((c) => ({
  value: c,
  label: PICKUP_INSTRUCTION_LABELS[c].label,
}));
const CHANGEABLE = ['SEARCHING', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'];

/**
 * A ride's accessibility details. The driver reads what the passenger needs, as sentences (never a diagnosis); the
 * passenger sees what they gave for this ride and can change how to reach them and where to meet until the ride starts,
 * and the driver is told. The details are only ever in this card: not in the chat, a notification or the event feed.
 */
export function AccessibilityRideCard(
  props: UiProps & {
    trip: TripSummary;
    role: TripRole;
    getAccessToken: () => Promise<string>;
    onChanged: () => void;
  },
) {
  const { trip, role, colors, getAccessToken } = props;
  const ui = { colors, minTouchTarget: props.minTouchTarget };
  const a = trip.accessibility;
  const [editing, setEditing] = useState(false);
  const [communication, setCommunication] = useState<CommunicationPreference>(
    a?.communication ?? 'ANY',
  );
  const [pickup, setPickup] = useState<PickupInstructionCode[]>(a?.pickupInstructions ?? []);
  const [note, setNote] = useState(a?.pickupNote ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [news, setNews] = useState<{ id: number; text: string } | null>(null);

  if (!a || !hasAccessibilityContent(a)) return null;

  if (role === 'DRIVER') {
    return (
      <Card {...ui} title="Passenger's accessibility needs">
        {describeAccessibilityForDriver(a).map((line) => (
          <Text key={line} style={{ color: colors.textPrimary, fontSize: 16 }}>
            {line}
          </Text>
        ))}
      </Card>
    );
  }

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await rideApi.updatePickupAccessibility(await getAccessToken(), trip.id, {
        communication,
        pickupInstructions: pickup,
        pickupNote: note.trim() || null,
      });
      setEditing(false);
      setNews((n) => ({ id: (n?.id ?? 0) + 1, text: PICKUP_SAVED_NEWS }));
      props.onChanged();
    } catch (e) {
      setProblem(
        e instanceof ApiError
          ? e.message
          : 'That did not save. Please check your connection and try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card {...ui} title="Your accessibility details for this ride">
      <Announcer {...ui} polite={news} />
      <Text accessibilityRole="text" style={{ color: colors.textPrimary }}>
        {profileSummary(a)}
      </Text>
      <Text style={{ color: colors.textSecondary, fontSize: 14 }}>
        Only you and your driver can see this.
      </Text>
      {problem ? (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {`Problem: ${problem}`}
        </Text>
      ) : null}
      {CHANGEABLE.includes(trip.status) ? (
        editing ? (
          <View style={styles.form}>
            <ChoiceRadios
              {...ui}
              legend="How my driver may reach me"
              choices={COMM}
              value={communication}
              onChange={setCommunication}
              disabled={busy}
            />
            <ChoiceSwitches
              {...ui}
              legend="Pickup instructions"
              choices={PICKUP}
              selected={pickup}
              onChange={setPickup}
              disabled={busy}
            />
            <Text style={{ color: colors.textPrimary }}>Pickup note (optional)</Text>
            <TextInput
              accessibilityLabel="Pickup note, optional"
              value={note}
              onChangeText={setNote}
              maxLength={ACCESSIBILITY_NOTE_MAX}
              multiline
              style={[styles.input, { color: colors.textPrimary, borderColor: colors.border }]}
            />
            <ActionButton
              {...ui}
              label="Save and tell my driver"
              tone="primary"
              busy={busy}
              onPress={() => void save()}
            />
            <ActionButton
              {...ui}
              label="Cancel"
              disabled={busy}
              onPress={() => setEditing(false)}
            />
          </View>
        ) : (
          <ActionButton
            {...ui}
            label="Change pickup instructions"
            hint="Opens the form. Your driver is told when you save."
            onPress={() => setEditing(true)}
          />
        )
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  form: { gap: 10 },
  input: { borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 48, fontSize: 16 },
});
