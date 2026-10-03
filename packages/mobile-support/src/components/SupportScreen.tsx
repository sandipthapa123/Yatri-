import { useAuth } from '@yatri/mobile-auth';
import { useTheme } from '@yatri/mobile-ui';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SupportCenter } from './SupportCenter';

/** The route both apps give the support screen: optionally opened from a ride or a request. */
export type SupportRoute = { Support: { tripId?: string; ticketId?: string } | undefined };

/**
 * Help and support as a screen: requests, a problem with a ride (when opened from one), conversations, refunds and privacy.
 * The same screen in both apps; register it with the app's stack navigator under the name "Support".
 */
export function SupportScreen({
  navigation,
  route,
}: {
  navigation: { goBack(): void };
  route: { params?: SupportRoute['Support'] };
}) {
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
