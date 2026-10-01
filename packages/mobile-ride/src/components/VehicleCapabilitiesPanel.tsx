import { ApiError } from '@yatri/mobile-auth';
import type { VehicleCapability } from '@yatri/types';
import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { capabilitySavedNews, capabilityWords } from '../accessibilityText';
import { rideApi } from '../rideApi';
import { ChoiceSwitches } from './AccessibilityChoices';
import { ActionButton, Announcer, Card, type UiProps } from './RideUi';

/**
 * A driver says which accessibility features one of their vehicles has. Some features need an administrator to check the
 * vehicle first: they show "Waiting for approval" and only count for matching once approved, so a driver cannot claim a
 * feature that is checked. Each feature's state is in words; a saved change and a refusal are announced.
 */
export function VehicleCapabilitiesPanel(
  props: UiProps & {
    vehicleId: string;
    vehicleLabel: string;
    getAccessToken: () => Promise<string>;
  },
) {
  const { colors, vehicleId, vehicleLabel, getAccessToken } = props;
  const ui = { colors, minTouchTarget: props.minTouchTarget };
  const [caps, setCaps] = useState<VehicleCapability[] | null>(null);
  const [declared, setDeclared] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [news, setNews] = useState<{ id: number; text: string } | null>(null);
  const say = (text: string) => setNews((n) => ({ id: (n?.id ?? 0) + 1, text }));

  const adopt = useCallback((c: VehicleCapability[]) => {
    setCaps(c);
    setDeclared(c.filter((x) => x.status !== null).map((x) => x.code));
  }, []);

  const load = useCallback(async () => {
    try {
      adopt((await rideApi.vehicleCapabilities(await getAccessToken(), vehicleId)).capabilities);
      setProblem(null);
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'The features could not be loaded.');
    }
  }, [adopt, getAccessToken, vehicleId]);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const res = await rideApi.declareVehicleCapabilities(await getAccessToken(), vehicleId, {
        declared,
      });
      adopt(res.capabilities);
      say(capabilitySavedNews(res.capabilities));
    } catch (e) {
      const text = e instanceof ApiError ? e.message : 'That did not save. Please try again.';
      setProblem(text);
      say(text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card {...ui} title={`Accessibility features: ${vehicleLabel}`}>
      <Announcer {...ui} polite={news} />
      <Text style={{ color: colors.textPrimary }}>
        Tick what this vehicle really has. Passengers who need a feature are only offered vehicles
        that have it, and some features are checked by Yatri before they count.
      </Text>
      {problem ? (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {`Problem: ${problem}`}
        </Text>
      ) : null}
      {caps ? (
        <>
          <ChoiceSwitches
            {...ui}
            legend="Features of this vehicle"
            choices={caps.map((c) => ({ value: c.code, label: c.label, help: c.help }))}
            selected={declared}
            onChange={setDeclared}
            disabled={busy}
          />
          <View>
            {caps
              .filter((c) => c.status !== null)
              .map((c) => (
                <Text key={c.code} accessibilityRole="text" style={{ color: colors.textPrimary }}>
                  {`${c.label}: ${capabilityWords(c)}`}
                </Text>
              ))}
          </View>
          <ActionButton
            {...ui}
            label="Save features"
            tone="primary"
            busy={busy}
            onPress={() => void save()}
          />
        </>
      ) : (
        <Text style={{ color: colors.textSecondary }}>Loading the features…</Text>
      )}
    </Card>
  );
}
