import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '@yatri/mobile-auth';
import { IncentivesPanel } from '@yatri/mobile-ride';
import { useTheme } from '@yatri/mobile-ui';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../navigation/RootNavigator';

type Props = NativeStackScreenProps<RootStackParamList, 'Incentives'>;

/** The driver's bonuses: the shared panel, fed by the server's rules and award records. */
export function IncentivesScreen({ navigation }: Props) {
  const theme = useTheme();
  const { getAccessToken } = useAuth();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <IncentivesPanel
        getAccessToken={getAccessToken}
        colors={theme.colors}
        minTouchTarget={theme.minTouchTarget}
        onBack={() => navigation.goBack()}
      />
    </SafeAreaView>
  );
}
