import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@yatri/mobile-ui';

interface LogoProps {
  size?: 'md' | 'lg';
}

/** Text-based "Yatri Driver" wordmark, using the driver app's blue accent. */
export function Logo({ size = 'md' }: LogoProps) {
  const theme = useTheme();
  const fontSize = size === 'lg' ? theme.typography.size.xxl : theme.typography.size.xl;

  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel="Yatri Driver"
      style={styles.container}
    >
      <Text style={[styles.text, { color: theme.colors.secondary, fontSize }]}>Yatri Driver</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center' },
  text: { fontWeight: '800', letterSpacing: 0.5 },
});
