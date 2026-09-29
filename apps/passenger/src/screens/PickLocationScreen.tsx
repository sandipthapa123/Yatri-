import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '@yatri/mobile-auth';
import { LocationPicker, savedPlacesApi } from '@yatri/mobile-location';
import type { SavedPlace } from '@yatri/types';
import { useEffect, useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../navigation/RootNavigator';
import { useTripLocations } from '../state/TripLocations';
import { useTheme } from '../theme/useTheme';

type Props = NativeStackScreenProps<RootStackParamList, 'PickLocation'>;

export function PickLocationScreen({ navigation, route }: Props) {
  const { purpose } = route.params;
  const theme = useTheme();
  const { getAccessToken } = useAuth();
  const { pickup, destination, setPickup, setDestination } = useTripLocations();
  const [saved, setSaved] = useState<SavedPlace[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await savedPlacesApi.list(await getAccessToken());
        if (!cancelled) setSaved(list);
      } catch {
        /* saved places are a convenience; search still works */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getAccessToken]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <LocationPicker
        purpose={purpose}
        getAccessToken={getAccessToken}
        savedPlaces={saved}
        initial={purpose === 'pickup' ? pickup : destination}
        colors={theme.colors}
        minTouchTarget={theme.minTouchTarget}
        onCancel={() => navigation.goBack()}
        onConfirm={(place) => {
          if (purpose === 'pickup') setPickup(place);
          else setDestination(place);
          navigation.goBack();
        }}
      />
    </SafeAreaView>
  );
}
