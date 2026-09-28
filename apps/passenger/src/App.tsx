import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ErrorBoundary } from './components/ErrorBoundary';
import { useAppBootstrap } from './hooks/useAppBootstrap';
import { RootNavigator } from './navigation/RootNavigator';
import { ErrorScreen } from './screens/ErrorScreen';
import { LoadingScreen } from './screens/LoadingScreen';
import { useTheme } from './theme/useTheme';

function AppContent() {
  const { status, error, retry } = useAppBootstrap();
  const theme = useTheme();

  if (status === 'loading') return <LoadingScreen />;
  if (status === 'error') return <ErrorScreen message={error?.message} onRetry={retry} />;

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
          <AppContent />
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
