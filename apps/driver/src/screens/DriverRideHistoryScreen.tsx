import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '@yatri/mobile-auth';
import { HistoryList } from '@yatri/mobile-ride';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../navigation/RootNavigator';
import { useTheme } from '../theme/useTheme';

type Props = NativeStackScreenProps<RootStackParamList, 'DriverRideHistory'>;

export function DriverRideHistoryScreen({ navigation }: Props) {
  const theme = useTheme();
  const { getAccessToken } = useAuth();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <HistoryList
        role="DRIVER"
        getAccessToken={getAccessToken}
        colors={theme.colors}
        minTouchTarget={theme.minTouchTarget}
        onOpen={(tripId) => navigation.navigate('DriverTrip', { tripId })}
      />
    </SafeAreaView>
  );
}
