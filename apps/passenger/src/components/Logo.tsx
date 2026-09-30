import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@yatri/mobile-ui';

interface LogoProps {
  size?: 'md' | 'lg';
}

/**
 * Text-based Yatri wordmark. Rendered as a heading for accessibility, not an
 * image, so it scales with the system font size and needs no alt text.
 */
export function Logo({ size = 'md' }: LogoProps) {
  const theme = useTheme();
  const fontSize = size === 'lg' ? theme.typography.size.xxl : theme.typography.size.xl;

  return (
    <View accessible accessibilityRole="header" accessibilityLabel="Yatri" style={styles.container}>
      <Text style={[styles.text, { color: theme.colors.primary, fontSize }]}>Yatri</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
  },
  text: {
    fontWeight: '800',
    letterSpacing: 0.5,
  },
});
