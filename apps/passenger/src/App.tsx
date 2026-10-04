import { AuthProvider, useAuth } from '@yatri/mobile-auth';
import { ConnectivityBanner } from '@yatri/mobile-ride';
import { PreferencesProvider } from '@yatri/mobile-preferences';
import { unregisterPush, usePushRegistration } from '@yatri/mobile-support';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { View } from 'react-native';

import { ErrorBoundary, LoadingView, StartupErrorView } from '@yatri/mobile-ui';
import { RootNavigator } from './navigation/RootNavigator';
import { BRAND } from './brand';
import { TripLocationsProvider } from './state/TripLocations';
import { useTheme } from '@yatri/mobile-ui';

function AppContent() {
  const { status, getAccessToken } = useAuth();
  usePushRegistration({ status, getAccessToken });
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  if (status === 'loading') return <LoadingView {...BRAND} />;

  return (
    <>
      <StatusBar style={theme.isDark ? 'light' : 'dark'} />
      <View style={{ flex: 1 }}>
        <ConnectivityBanner colors={theme.colors} topInset={insets.top} />
        <RootNavigator />
      </View>
    </>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ErrorBoundary
          fallback={(error, reset) => (
            <StartupErrorView {...BRAND} message={error.message} onRetry={reset} />
          )}
        >
          <AuthProvider role="PASSENGER" onBeforeLogout={unregisterPush}>
            <PreferencesProvider>
              <TripLocationsProvider>
                <AppContent />
              </TripLocationsProvider>
            </PreferencesProvider>
          </AuthProvider>
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
