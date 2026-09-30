import { EMERGENCY_CONTACT_NAME_MAX, type EmergencyContactsResponse } from '@yatri/types';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { rideApi } from '../rideApi';
import { Announcer, ActionButton, Card, type UiProps } from './RideUi';

/**
 * The people who are sent a link to follow a trip if this person raises an SOS. Shared by both
 * apps. Removal asks in the page (a labelled second step) rather than in a system dialog, and every
 * result is announced. Yatri only stores the name and number the person types; it never reads the
 * phone's address book, and nobody is contacted until an SOS is actually raised.
 */
export function EmergencyContactsPanel(props: UiProps & { getAccessToken: () => Promise<string> }) {
  const { getAccessToken, colors, minTouchTarget } = props;
  const ui = { colors, minTouchTarget };
  const [data, setData] = useState<EmergencyContactsResponse | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [news, setNews] = useState<{ id: number; text: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await rideApi.emergencyContacts(await getAccessToken()));
    } catch {
      setError('Could not load your emergency contacts. Please try again.');
    }
  }, [getAccessToken]);
  useEffect(() => {
    void load();
  }, [load]);

  const say = (text: string) => setNews((n) => ({ id: (n?.id ?? 0) + 1, text }));
  const messageOf = (e: unknown) =>
    e instanceof Error ? e.message : 'That did not work. Please try again.';

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await rideApi.addEmergencyContact(
        await getAccessToken(),
        name.trim(),
        phone.trim(),
      );
      setName('');
      setPhone('');
      await load();
      say(`${c.name} added as an emergency contact.`);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string, who: string) => {
    setBusy(true);
    setError(null);
    try {
      await rideApi.removeEmergencyContact(await getAccessToken(), id);
      setRemoving(null);
      await load();
      say(`${who} removed.`);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const contacts = data?.contacts ?? [];
  const full = data !== null && contacts.length >= data.limit;
  const ready = name.trim().length > 0 && phone.trim().length > 0;
  return (
    <View style={styles.gap}>
      <Announcer {...ui} polite={news} />
      <Card {...ui} title="Emergency contacts">
        <Text style={{ color: colors.textSecondary }}>
          If you send an emergency alert during a ride, these people get a text with a link to
          follow that trip. They see the driver, vehicle and live location, not your name or number.
          Nobody is contacted unless you send an alert.
        </Text>
        {data ? (
          <Text accessibilityRole="text" style={{ color: colors.textPrimary, fontWeight: '600' }}>
            {contacts.length === 0
              ? 'You have no emergency contacts yet.'
              : `${contacts.length} of ${data.limit} emergency contacts.`}
          </Text>
        ) : null}
        {contacts.map((c) => (
          <View key={c.id} style={styles.gap} accessibilityRole="summary">
            <Text style={{ color: colors.textPrimary, fontSize: 17 }}>
              {c.name}, {c.phoneNumber}
            </Text>
            {removing === c.id ? (
              <>
                <Text style={{ color: colors.textSecondary }}>
                  {`Remove ${c.name}? They will no longer get a link if you send an alert.`}
                </Text>
                <ActionButton
                  {...ui}
                  label={`Yes, remove ${c.name}`}
                  tone="danger"
                  busy={busy}
                  onPress={() => void remove(c.id, c.name)}
                />
                <ActionButton {...ui} label="Keep contact" onPress={() => setRemoving(null)} />
              </>
            ) : (
              <ActionButton
                {...ui}
                label={`Remove ${c.name}`}
                tone="danger"
                disabled={busy}
                onPress={() => setRemoving(c.id)}
              />
            )}
          </View>
        ))}
      </Card>

      <Card {...ui} title="Add a contact">
        {full ? (
          <Text accessibilityRole="text" style={{ color: colors.textSecondary }}>
            {`You have reached the limit of ${data?.limit ?? ''} contacts. Remove one to add another.`}
          </Text>
        ) : (
          <>
            <TextInput
              value={name}
              onChangeText={setName}
              accessibilityLabel="Contact name"
              placeholder="Name"
              placeholderTextColor={colors.textSecondary}
              maxLength={EMERGENCY_CONTACT_NAME_MAX}
              autoComplete="name"
              style={[
                styles.input,
                {
                  minHeight: minTouchTarget,
                  color: colors.textPrimary,
                  borderColor: colors.border,
                },
              ]}
            />
            <TextInput
              value={phone}
              onChangeText={setPhone}
              accessibilityLabel="Contact phone number, with country code"
              placeholder="Phone, e.g. +9779812345678"
              placeholderTextColor={colors.textSecondary}
              keyboardType="phone-pad"
              autoComplete="tel"
              style={[
                styles.input,
                {
                  minHeight: minTouchTarget,
                  color: colors.textPrimary,
                  borderColor: colors.border,
                },
              ]}
            />
            <ActionButton
              {...ui}
              label="Add emergency contact"
              tone="primary"
              busy={busy}
              disabled={!ready}
              hint={ready ? undefined : 'Enter a name and a phone number'}
              onPress={() => void add()}
            />
          </>
        )}
        {error ? (
          <Text accessibilityRole="alert" style={{ color: colors.error }}>
            {error}
          </Text>
        ) : null}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { gap: 8 },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 16,
  },
});
