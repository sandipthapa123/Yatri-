import { ApiError } from '@yatri/mobile-auth';
import {
  ACCESSIBILITY_NOTE_MAX,
  COMMUNICATION_LABELS,
  COMMUNICATION_PREFERENCES,
  PASSENGER_NEEDS,
  PICKUP_INSTRUCTION_CODES,
  PICKUP_INSTRUCTION_LABELS,
  type AccessibilityProfile,
  type CommunicationPreference,
  type PassengerNeedCode,
  type PickupInstructionCode,
} from '@yatri/types';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput } from 'react-native';

import { profileSummary } from '../accessibilityText';
import { rideApi } from '../rideApi';
import { ChoiceRadios, ChoiceSwitches } from './AccessibilityChoices';
import { ActionButton, Announcer, Card, type UiProps } from './RideUi';

const NEEDS = PASSENGER_NEEDS.map((n) => ({ value: n.code, label: n.label, help: n.help }));
const COMM = COMMUNICATION_PREFERENCES.map((c) => ({
  value: c,
  label: COMMUNICATION_LABELS[c].label,
  help: COMMUNICATION_LABELS[c].help,
}));
const PICKUP = PICKUP_INSTRUCTION_CODES.map((c) => ({
  value: c,
  label: PICKUP_INSTRUCTION_LABELS[c].label,
}));

/**
 * The passenger's own accessibility needs, in their settings: what they choose to say, how they want to be reached, and
 * their usual pickup instructions. Nothing is filled in for them or guessed; it starts empty. It is the starting point of
 * each ride they request (the request screen says so), shown to the driver only once one is assigned. A save names the
 * version it was based on, so a change made on another device is never silently overwritten.
 */
export function AccessibilityProfilePanel(
  props: UiProps & { getAccessToken: () => Promise<string> },
) {
  const { colors, getAccessToken } = props;
  const ui = { colors, minTouchTarget: props.minTouchTarget };
  const [saved, setSaved] = useState<AccessibilityProfile | null>(null);
  const [needs, setNeeds] = useState<PassengerNeedCode[]>([]);
  const [communication, setCommunication] = useState<CommunicationPreference>('ANY');
  const [pickup, setPickup] = useState<PickupInstructionCode[]>([]);
  const [pickupNote, setPickupNote] = useState('');
  const [otherNote, setOtherNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [news, setNews] = useState<{ id: number; text: string } | null>(null);
  const say = (text: string) => setNews((n) => ({ id: (n?.id ?? 0) + 1, text }));

  const adopt = useCallback((p: AccessibilityProfile) => {
    setSaved(p);
    setNeeds(p.needs);
    setCommunication(p.communication);
    setPickup(p.pickupInstructions);
    setPickupNote(p.pickupNote ?? '');
    setOtherNote(p.otherNote ?? '');
  }, []);

  const load = useCallback(async () => {
    try {
      adopt(await rideApi.accessibilityProfile(await getAccessToken()));
      setProblem(null);
    } catch (e) {
      setProblem(
        e instanceof ApiError ? e.message : 'Your accessibility settings could not be loaded.',
      );
    }
  }, [adopt, getAccessToken]);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const next = await rideApi.saveAccessibilityProfile(await getAccessToken(), {
        needs,
        communication,
        pickupInstructions: pickup,
        pickupNote: pickupNote.trim() || null,
        otherNote: otherNote.trim() || null,
        version: saved?.version ?? 0,
      });
      adopt(next);
      say('Saved. These are now used for the rides you request.');
    } catch (e) {
      const text =
        e instanceof ApiError
          ? e.message
          : 'That did not save. Please check your connection and try again.';
      setProblem(text);
      say(text);
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card {...ui} title="Accessibility needs for rides">
      <Announcer {...ui} polite={news} />
      <Text style={{ color: colors.textPrimary }}>
        Tell us only what you want us to know. It is private: your driver sees it only once they are
        assigned to your ride, and it is never shared with anyone else.
      </Text>
      {saved ? (
        <Text accessibilityRole="text" style={{ color: colors.textPrimary }}>
          {`Now: ${profileSummary(saved)}`}
        </Text>
      ) : null}
      {problem ? (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {`Problem: ${problem}`}
        </Text>
      ) : null}
      <ChoiceSwitches
        {...ui}
        legend="What I need"
        choices={NEEDS}
        selected={needs}
        onChange={setNeeds}
        disabled={busy}
      />
      <Text style={{ color: colors.textPrimary }}>Anything else about your needs (optional)</Text>
      <TextInput
        accessibilityLabel="Anything else about your needs, optional"
        value={otherNote}
        onChangeText={setOtherNote}
        maxLength={ACCESSIBILITY_NOTE_MAX}
        multiline
        style={[styles.input, { color: colors.textPrimary, borderColor: colors.border }]}
      />
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
        legend="Usual pickup instructions"
        choices={PICKUP}
        selected={pickup}
        onChange={setPickup}
        disabled={busy}
      />
      <Text style={{ color: colors.textPrimary }}>Pickup note (optional)</Text>
      <TextInput
        accessibilityLabel="Pickup note, optional. For example: blue gate on the left."
        value={pickupNote}
        onChangeText={setPickupNote}
        maxLength={ACCESSIBILITY_NOTE_MAX}
        multiline
        style={[styles.input, { color: colors.textPrimary, borderColor: colors.border }]}
      />
      <ActionButton
        {...ui}
        label="Save accessibility needs"
        tone="primary"
        busy={busy}
        onPress={() => void save()}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 48, fontSize: 16 },
});
