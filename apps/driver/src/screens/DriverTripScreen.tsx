import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '@yatri/mobile-auth';
import { RideRoom } from '@yatri/mobile-ride';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../navigation/RootNavigator';
import { useTheme } from '@yatri/mobile-ui';

type Props = NativeStackScreenProps<RootStackParamList, 'DriverTrip'>;

/**
 * The driver's ride: arrive, wait, start, end, get paid, rate. It is the shared RideRoom, the same
 * one the passenger sees, so both sides always agree on the state of the ride. The driver's GPS
 * is NOT sent from here: presence (the Go online screen) is the one location path, and the server
 * feeds it into the active ride.
 */
export function DriverTripScreen({ navigation, route }: Props) {
  const theme = useTheme();
  const { getAccessToken } = useAuth();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <RideRoom
        tripId={route.params.tripId}
        role="DRIVER"
        getAccessToken={getAccessToken}
        colors={theme.colors}
        minTouchTarget={theme.minTouchTarget}
        onExit={() => navigation.popToTop()}
        onReportProblem={(tripId) => navigation.navigate('Support', { tripId })}
      />
    </SafeAreaView>
  );
}
