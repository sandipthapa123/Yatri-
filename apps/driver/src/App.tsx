import { AuthProvider, useAuth } from '@yatri/mobile-auth';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ErrorBoundary } from '@yatri/mobile-ui';
import { ErrorScreen } from './screens/ErrorScreen';
import { RootNavigator } from './navigation/RootNavigator';
import { LoadingScreen } from './screens/LoadingScreen';
import { useTheme } from '@yatri/mobile-ui';

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
        <ErrorBoundary
          fallback={(error, reset) => <ErrorScreen message={error.message} onRetry={reset} />}
        >
          <AuthProvider role="DRIVER">
            <AppContent />
          </AuthProvider>
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
