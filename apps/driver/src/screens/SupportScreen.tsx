import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '@yatri/mobile-auth';
import { useTheme } from '@yatri/mobile-ui';
import { SupportCenter } from '@yatri/mobile-support';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../navigation/RootNavigator';

type Props = NativeStackScreenProps<RootStackParamList, 'Support'>;

/**
 * Help and support: requests, a problem with a ride (when opened from one), conversations, refunds
 * and privacy. It is the shared SupportCenter, the same one the passenger app shows.
 */
export function SupportScreen({ navigation, route }: Props) {
  const theme = useTheme();
  const { getAccessToken } = useAuth();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <SupportCenter
        getAccessToken={getAccessToken}
        colors={theme.colors}
        minTouchTarget={theme.minTouchTarget}
        tripId={route.params?.tripId ?? null}
        ticketId={route.params?.ticketId ?? null}
        onExit={() => navigation.goBack()}
      />
    </SafeAreaView>
  );
}
