import { AuthProvider, useAuth } from '@yatri/mobile-auth';
import { ConnectivityBanner } from '@yatri/mobile-ride';
import { PreferencesProvider } from '@yatri/mobile-preferences';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { View } from 'react-native';

import { ErrorBoundary } from '@yatri/mobile-ui';
import { ErrorScreen } from './screens/ErrorScreen';
import { RootNavigator } from './navigation/RootNavigator';
import { LoadingScreen } from './screens/LoadingScreen';
import { TripLocationsProvider } from './state/TripLocations';
import { useTheme } from '@yatri/mobile-ui';

function AppContent() {
  const { status } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  if (status === 'loading') return <LoadingScreen />;

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
          fallback={(error, reset) => <ErrorScreen message={error.message} onRetry={reset} />}
        >
          <AuthProvider role="PASSENGER">
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
