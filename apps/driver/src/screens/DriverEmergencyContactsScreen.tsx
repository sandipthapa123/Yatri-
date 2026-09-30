import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '@yatri/mobile-auth';
import { EmergencyContactsPanel } from '@yatri/mobile-ride';
import { ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../navigation/RootNavigator';
import { useTheme } from '../theme/useTheme';

type Props = NativeStackScreenProps<RootStackParamList, 'DriverEmergencyContacts'>;

export function DriverEmergencyContactsScreen(_props: Props) {
  const theme = useTheme();
  const { getAccessToken } = useAuth();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={{ padding: 20 }} keyboardShouldPersistTaps="handled">
        <EmergencyContactsPanel
          getAccessToken={getAccessToken}
          colors={theme.colors}
          minTouchTarget={theme.minTouchTarget}
        />
      </ScrollView>
    </SafeAreaView>
  );
}
