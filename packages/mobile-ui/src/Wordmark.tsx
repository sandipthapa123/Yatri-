import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from './useTheme';

export interface WordmarkProps {
  /** The words of the mark, which are also what a screen reader says (for example "Yatri" or "Yatri Driver"). */
  label: string;
  /** Which theme accent it is drawn in: each app has its own. */
  tone: 'primary' | 'secondary';
  size?: 'md' | 'lg';
}

/**
 * The Yatri wordmark, drawn as text rather than an image: it scales with the system font size, needs no alt text, and is
 * announced as a heading. The one implementation for every app; an app supplies only its words and its accent.
 */
export function Wordmark({ label, tone, size = 'md' }: WordmarkProps) {
  const theme = useTheme();
  const fontSize = size === 'lg' ? theme.typography.size.xxl : theme.typography.size.xl;
  return (
    <View accessible accessibilityRole="header" accessibilityLabel={label} style={styles.container}>
      <Text style={[styles.text, { color: theme.colors[tone], fontSize }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center' },
  text: { fontWeight: '800', letterSpacing: 0.5 },
});
