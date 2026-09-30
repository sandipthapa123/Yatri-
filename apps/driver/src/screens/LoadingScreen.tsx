import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Logo } from '../components/Logo';
import { useTheme } from '@yatri/mobile-ui';

export function LoadingScreen() {
  const theme = useTheme();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Logo />
      <View
        style={styles.status}
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel="Loading Yatri Driver"
      >
        <ActivityIndicator size="large" color={theme.colors.secondary} />
        <Text style={[styles.label, { color: theme.colors.textSecondary }]}>
          Getting things ready…
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 32 },
  status: { alignItems: 'center', gap: 12 },
  label: { fontSize: 16 },
});
