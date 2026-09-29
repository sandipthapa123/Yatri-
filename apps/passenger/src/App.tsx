import { AuthProvider, useAuth } from '@yatri/mobile-auth';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ErrorBoundary } from './components/ErrorBoundary';
import { RootNavigator } from './navigation/RootNavigator';
import { LoadingScreen } from './screens/LoadingScreen';
import { TripLocationsProvider } from './state/TripLocations';
import { useTheme } from './theme/useTheme';

function AppContent() {
  const { status } = useAuth();
  const theme = useTheme();

  if (status === 'loading') return <LoadingScreen />;

  return (
    <>
      <StatusBar style={theme.isDark ? 'light' : 'dark'} />
      <RootNavigator />
    </>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ErrorBoundary>
          <AuthProvider role="PASSENGER">
            <TripLocationsProvider>
              <AppContent />
            </TripLocationsProvider>
          </AuthProvider>
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
