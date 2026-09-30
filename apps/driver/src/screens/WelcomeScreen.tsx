import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Logo } from '../components/Logo';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useTheme } from '@yatri/mobile-ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Welcome'>;

export function WelcomeScreen({ navigation }: Props) {
  const theme = useTheme();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={styles.header}>
        <Logo size="lg" />
        <Text style={[styles.tagline, { color: theme.colors.textSecondary }]}>
          Earn on your own schedule, driving with Yatri.
        </Text>
      </View>

      <Pressable
        onPress={() => navigation.navigate('PhoneEntry')}
        accessibilityRole="button"
        accessibilityLabel="Get started"
        accessibilityHint="Continue to sign in with your phone number"
        style={({ pressed }) => [
          styles.button,
          {
            backgroundColor: pressed ? theme.colors.primaryDark : theme.colors.secondary,
            minHeight: theme.minTouchTarget,
          },
        ]}
      >
        <Text style={[styles.buttonText, { color: theme.colors.textInverse }]}>Get started</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 64,
    paddingHorizontal: 32,
  },
  header: { alignItems: 'center', gap: 12, marginTop: 48 },
  tagline: { fontSize: 16, textAlign: 'center' },
  button: {
    alignSelf: 'stretch',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 999,
  },
  buttonText: { fontSize: 17, fontWeight: '700' },
});
