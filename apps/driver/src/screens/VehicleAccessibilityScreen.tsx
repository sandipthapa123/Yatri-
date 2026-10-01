import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ApiError, useAuth } from '@yatri/mobile-auth';
import { ActionButton, VehicleCapabilitiesPanel } from '@yatri/mobile-ride';
import { useTheme } from '@yatri/mobile-ui';
import type { Vehicle } from '@yatri/types';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { listVehicles } from '../api/driverApi';
import type { RootStackParamList } from '../navigation/RootNavigator';

type Props = NativeStackScreenProps<RootStackParamList, 'VehicleAccessibility'>;

/**
 * The accessibility features of the driver's own vehicles. The features that need Yatri to check the vehicle wait for an
 * administrator; the matching system only offers a passenger who needs one a vehicle that has it approved.
 */
export function VehicleAccessibilityScreen({ navigation }: Props) {
  const theme = useTheme();
  const { getAccessToken } = useAuth();
  const ui = { colors: theme.colors, minTouchTarget: theme.minTouchTarget };
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const v = await listVehicles(await getAccessToken());
        if (!cancelled) setVehicles(v);
      } catch (e) {
        if (!cancelled) {
          setProblem(e instanceof ApiError ? e.message : 'Your vehicles could not be loaded.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getAccessToken]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={[styles.h, { color: theme.colors.textPrimary }]}>
          Vehicle accessibility features
        </Text>
        {problem ? (
          <Text accessibilityRole="alert" style={{ color: theme.colors.error }}>
            {`Problem: ${problem}`}
          </Text>
        ) : null}
        {vehicles === null && !problem ? (
          <Text style={{ color: theme.colors.textSecondary }}>Loading your vehicles…</Text>
        ) : null}
        {vehicles?.length === 0 ? (
          <Text style={{ color: theme.colors.textPrimary }}>
            You have no vehicle yet. Add one first, then come back here.
          </Text>
        ) : null}
        {vehicles?.map((v) => (
          <VehicleCapabilitiesPanel
            key={v.id}
            {...ui}
            vehicleId={v.id}
            vehicleLabel={`${v.color} ${v.make} ${v.model}, ${v.registrationNumber}`}
            getAccessToken={getAccessToken}
          />
        ))}
        <ActionButton {...ui} label="Back" onPress={() => navigation.goBack()} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 14 },
  h: { fontSize: 24, fontWeight: '700' },
});
