import { ApiError, useAuth } from '@yatri/mobile-auth';
import {
  AccessibilityProfilePanel,
  ActionButton,
  Announcer,
  Card,
  type UiProps,
} from '@yatri/mobile-ride';
import { useNews, usePolled } from '@yatri/mobile-support';
import type { DeviceSession, PreferenceDef, PreferenceRole, PreferenceValue } from '@yatri/types';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { usePreferences } from '../PreferencesProvider';
import { preferencesApi } from '../preferencesApi';
import { savedNews, settingsSections, valueWords } from '../preferencesText';

/** Places in the app that already own a part of "my account"; the settings screen links to them, never copies them. */
export interface SettingsLinks {
  onSavedPlaces?: () => void;
  onTrustedContacts?: () => void;
  onPrivacyAndData?: () => void;
  onHelp?: () => void;
  /** Drivers: the screen where they declare the accessibility features of their vehicles. */
  onVehicleFeatures?: () => void;
}

/**
 * Settings, for a passenger or a driver. Every row is drawn from the one definition table (@yatri/types), so a
 * setting added there appears here, in the right group, for the right role, with its words and its choices, and
 * nothing is listed twice. Choices are radio groups, switches say "on" or "off" in words, a saved change is
 * announced, and a refusal or a conflict with another device is read out and shown as text.
 */
export function SettingsCenter(
  props: UiProps & { role: PreferenceRole; links: SettingsLinks; onExit: () => void },
) {
  const { colors, minTouchTarget } = props;
  const ui = { colors, minTouchTarget };
  const prefs = usePreferences();
  const { getAccessToken } = useAuth();
  const [news, say] = useNews();
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const change = async (def: PreferenceDef, value: PreferenceValue) => {
    setBusy(def.key);
    setProblem(null);
    try {
      await prefs.save(def.key, value);
      say(savedNews(def, value === null ? (prefs.data?.defaults[def.key] ?? null) : value));
    } catch (e) {
      const text = e instanceof Error ? e.message : 'That did not save. Please try again.';
      setProblem(text);
      say(text);
    } finally {
      setBusy(null);
    }
  };

  const data = prefs.data;
  return (
    <View style={styles.container}>
      <Announcer {...ui} polite={news} />
      {prefs.loading && !data ? (
        <Text style={{ color: colors.textSecondary }}>Loading your settings…</Text>
      ) : null}
      {prefs.loadError ? (
        <View style={styles.group}>
          <Text accessibilityRole="alert" style={{ color: colors.error }}>
            {`Problem: ${prefs.loadError}`}
          </Text>
          <ActionButton {...ui} label="Try again" onPress={() => void prefs.reload()} />
        </View>
      ) : null}
      {problem ? (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {`Problem: ${problem}`}
        </Text>
      ) : null}

      {data
        ? settingsSections(props.role).map((section) => (
            <Card key={section.group} {...ui} title={section.label}>
              {section.defs.map((def) => (
                <SettingRow
                  key={def.key}
                  {...ui}
                  def={def}
                  value={data.values[def.key] ?? null}
                  isDefault={!data.overridden.includes(def.key)}
                  vehicleOptions={data.vehicleOptions}
                  busy={busy === def.key}
                  onChange={(v) => void change(def, v)}
                />
              ))}
              {section.group === 'accessibility' && props.role === 'PASSENGER' ? (
                <AccessibilityProfilePanel {...ui} getAccessToken={getAccessToken} />
              ) : null}
              {section.group === 'accessibility' &&
              props.role === 'DRIVER' &&
              props.links.onVehicleFeatures ? (
                <ActionButton
                  {...ui}
                  label="Vehicle accessibility features"
                  hint="Say which accessibility features your vehicles have"
                  onPress={props.links.onVehicleFeatures}
                />
              ) : null}
              {section.group === 'safety' && props.links.onTrustedContacts ? (
                <ActionButton
                  {...ui}
                  label="Trusted contacts"
                  hint="The people told if you send an emergency alert"
                  onPress={props.links.onTrustedContacts}
                />
              ) : null}
              {section.group === 'rides' && props.links.onSavedPlaces ? (
                <ActionButton
                  {...ui}
                  label="Saved and favourite places"
                  onPress={props.links.onSavedPlaces}
                />
              ) : null}
              {section.group === 'privacy' ? (
                <RecentPlacesControl {...ui} role={props.role} say={say} />
              ) : null}
              {section.group === 'privacy' && props.links.onPrivacyAndData ? (
                <ActionButton
                  {...ui}
                  label="Privacy and my data"
                  hint="Ask for a copy of your data or to delete your account"
                  onPress={props.links.onPrivacyAndData}
                />
              ) : null}
            </Card>
          ))
        : null}

      <DevicesCard {...ui} say={say} />
      {props.links.onHelp ? (
        <ActionButton {...ui} label="Help and support" onPress={props.links.onHelp} />
      ) : null}
      <ActionButton {...ui} label="Back" onPress={props.onExit} />
    </View>
  );
}

function SettingRow(
  props: UiProps & {
    def: PreferenceDef;
    value: PreferenceValue;
    isDefault: boolean;
    vehicleOptions: Array<{ code: string; label: string }>;
    busy: boolean;
    onChange: (v: PreferenceValue) => void;
  },
) {
  const { def, colors } = props;
  const ui = { colors: props.colors, minTouchTarget: props.minTouchTarget };
  const now = valueWords(def, props.value);
  const header = (
    <>
      <Text accessibilityRole="header" style={[styles.label, { color: colors.textPrimary }]}>
        {def.label}
      </Text>
      <Text style={{ color: colors.textSecondary, fontSize: 14 }}>{def.help}</Text>
    </>
  );
  if (def.kind === 'boolean') {
    const on = props.value === true;
    return (
      <View style={styles.group}>
        <Text style={{ color: colors.textSecondary, fontSize: 14 }}>{def.help}</Text>
        <ActionButton
          {...ui}
          role="switch"
          selected={on}
          busy={props.busy}
          label={`${def.label}: ${on ? 'On' : 'Off'}`}
          hint={
            props.isDefault
              ? 'Using the standard setting. Double tap to change.'
              : 'Double tap to change.'
          }
          onPress={() => props.onChange(!on)}
        />
      </View>
    );
  }
  const options =
    def.key === 'defaultVehicle'
      ? [
          { value: '', label: 'No preference' },
          ...props.vehicleOptions.map((o) => ({ value: o.code, label: o.label })),
        ]
      : (def.options ?? []);
  return (
    <View style={styles.group}>
      {header}
      <Text
        style={{ color: colors.textPrimary }}
        accessibilityRole="text"
      >{`Now: ${now}${props.isDefault ? ' (standard)' : ''}`}</Text>
      <View accessibilityRole="radiogroup" style={styles.group}>
        {options.map((o) => {
          const unavailable = 'available' in o && o.available === false;
          const selected = (props.value ?? '') === o.value;
          return (
            <ActionButton
              key={o.value || 'none'}
              {...ui}
              role="radio"
              selected={selected}
              disabled={unavailable || props.busy}
              label={unavailable ? o.label : o.label}
              hint={unavailable ? 'Not available yet' : undefined}
              onPress={() => props.onChange(o.value === '' ? null : o.value)}
            />
          );
        })}
      </View>
    </View>
  );
}

/** Hide or clear what the app suggests from recent rides. The toggle is a setting above; clearing is an action. */
function RecentPlacesControl(
  props: UiProps & { role: PreferenceRole; say: (t: string | null) => void },
) {
  const { getAccessToken } = useAuth();
  const [busy, setBusy] = useState(false);
  if (props.role !== 'PASSENGER') return null;
  const clear = async () => {
    setBusy(true);
    try {
      await preferencesApi.clearRecentPlaces(await getAccessToken());
      props.say('Recent destinations cleared. Your ride history is unchanged.');
    } catch (e) {
      props.say(e instanceof ApiError ? e.message : 'That did not work. Please try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <ActionButton
      colors={props.colors}
      minTouchTarget={props.minTouchTarget}
      label="Clear my recent destinations"
      hint="Stops showing places from past rides. Your ride history stays."
      busy={busy}
      onPress={() => void clear()}
    />
  );
}

/** The devices signed in as this person, with a way to sign one out, or every other one. */
function DevicesCard(props: UiProps & { say: (t: string | null) => void }) {
  const { colors } = props;
  const ui = { colors: props.colors, minTouchTarget: props.minTouchTarget };
  const { getAccessToken } = useAuth();
  const list = usePolled<DeviceSession[]>(
    async () => preferencesApi.devices(await getAccessToken()),
    null,
  );
  const [busy, setBusy] = useState(false);

  const act = async (work: (t: string) => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work(await getAccessToken());
      props.say(done);
      await list.reload();
    } catch (e) {
      props.say(e instanceof ApiError ? e.message : 'That did not work. Please try again.');
    } finally {
      setBusy(false);
    }
  };
  const others = (list.data ?? []).filter((d) => !d.current);
  return (
    <Card {...ui} title="Devices">
      <Text style={{ color: colors.textSecondary }}>
        These are the phones signed in to your account. Sign out any you do not recognise.
      </Text>
      {list.loading ? <Text style={{ color: colors.textSecondary }}>Loading…</Text> : null}
      {list.error ? (
        <Text
          accessibilityRole="alert"
          style={{ color: colors.error }}
        >{`Problem: ${list.error}`}</Text>
      ) : null}
      {list.data?.map((d) => (
        <View key={d.id} style={styles.group}>
          <Text style={{ color: colors.textPrimary }} accessibilityRole="text">
            {`${d.deviceLabel ?? 'A device'}${d.current ? ', this phone' : ''}. Signed in ${new Date(d.signedInAt).toLocaleDateString()}${d.lastUsedAt ? `, last used ${new Date(d.lastUsedAt).toLocaleString()}` : ''}.`}
          </Text>
          {!d.current ? (
            <ActionButton
              {...ui}
              label={`Sign out ${d.deviceLabel ?? 'this device'}`}
              disabled={busy}
              onPress={() =>
                void act(
                  (t) => preferencesApi.signOutDevice(t, d.id),
                  'That device was signed out.',
                )
              }
            />
          ) : null}
        </View>
      ))}
      {others.length > 1 ? (
        <ActionButton
          {...ui}
          label="Sign out every other device"
          tone="danger"
          disabled={busy}
          onPress={() =>
            void act((t) => preferencesApi.signOutOthers(t), 'Every other device was signed out.')
          }
        />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  group: { gap: 8 },
  label: { fontSize: 16, fontWeight: '700' },
});
