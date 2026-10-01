import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { SettingsCenter } from '@yatri/mobile-preferences';
import { useTheme } from '@yatri/mobile-ui';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../navigation/RootNavigator';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

/**
 * Settings: appearance, language, accessibility, notifications, privacy, safety, ride defaults and devices.
 * It is the shared SettingsCenter, drawn from the one preference definitions; saved places and trusted contacts
 * keep their own screens and are linked, not copied.
 */
export function SettingsScreen({ navigation }: Props) {
  const theme = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={[styles.h, { color: theme.colors.textPrimary }]}>
          Settings
        </Text>
        <SettingsCenter
          role="PASSENGER"
          colors={theme.colors}
          minTouchTarget={theme.minTouchTarget}
          links={{
            onSavedPlaces: () => navigation.navigate('SavedPlaces'),
            onTrustedContacts: () => navigation.navigate('EmergencyContacts'),
            onPrivacyAndData: () => navigation.navigate('Support'),
            onHelp: () => navigation.navigate('Support'),
          }}
          onExit={() => navigation.goBack()}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 14 },
  h: { fontSize: 24, fontWeight: '700' },
});
