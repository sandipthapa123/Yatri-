import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '@yatri/mobile-auth';
import { LocationPicker, savedPlacesApi, useStartCenter } from '@yatri/mobile-location';
import { preferencesApi } from '@yatri/mobile-preferences';
import type { RecentPlace, SavedPlace } from '@yatri/types';
import { useEffect, useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../navigation/RootNavigator';
import { useTripLocations } from '../state/TripLocations';
import { useTheme } from '@yatri/mobile-ui';

type Props = NativeStackScreenProps<RootStackParamList, 'PickLocation'>;

export function PickLocationScreen({ navigation, route }: Props) {
  const { purpose } = route.params;
  const theme = useTheme();
  const { getAccessToken } = useAuth();
  const { pickup, destination, setPickup, setDestination } = useTripLocations();
  const [saved, setSaved] = useState<SavedPlace[]>([]);
  const [recent, setRecent] = useState<RecentPlace[]>([]);
  const startCenter = useStartCenter();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await savedPlacesApi.list(await getAccessToken());
        if (!cancelled) setSaved(list);
      } catch {
        /* saved places are a convenience; search still works */
      }
      try {
        // Recent destinations are for choosing where to go; the server leaves them out if the person hid them.
        const r =
          purpose === 'destination'
            ? await preferencesApi.recentPlaces(await getAccessToken())
            : null;
        if (!cancelled && r) setRecent(r.items);
      } catch {
        /* a convenience too */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getAccessToken, purpose]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <LocationPicker
        purpose={purpose}
        getAccessToken={getAccessToken}
        savedPlaces={saved}
        recentPlaces={recent}
        startCenter={startCenter}
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
