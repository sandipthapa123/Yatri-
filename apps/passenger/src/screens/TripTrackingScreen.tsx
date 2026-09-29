import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '@yatri/mobile-auth';
import { RideRoom } from '@yatri/mobile-ride';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../navigation/RootNavigator';
import { useTheme } from '../theme/useTheme';

type Props = NativeStackScreenProps<RootStackParamList, 'TripTracking'>;

/**
 * The passenger's ride, from "looking for a driver" to rating. All of it — live location, the
 * waiting timer, chat, calls, cancel, payment, rating, reporting a problem — is the shared
 * RideRoom, so the passenger and driver apps can never disagree about what a ride looks like.
 */
export function TripTrackingScreen({ navigation, route }: Props) {
  const theme = useTheme();
  const { getAccessToken } = useAuth();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <RideRoom
        tripId={route.params.tripId}
        role="PASSENGER"
        getAccessToken={getAccessToken}
        colors={theme.colors}
        minTouchTarget={theme.minTouchTarget}
        onExit={() => navigation.popToTop()}
      />
    </SafeAreaView>
  );
}
