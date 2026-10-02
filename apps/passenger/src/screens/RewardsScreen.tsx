import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RewardsCenter } from '@yatri/mobile-preferences';
import { useTheme } from '@yatri/mobile-ui';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../navigation/RootNavigator';

type Props = NativeStackScreenProps<RootStackParamList, 'Rewards'>;

/**
 * Offers and rewards: your reward points and their history, the offers you can use, a promo code, and your invite code.
 * It is the shared RewardsCenter; the server decides every offer, amount and rule.
 */
export function RewardsScreen({ navigation }: Props) {
  const theme = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={[styles.h, { color: theme.colors.textPrimary }]}>
          Offers and rewards
        </Text>
        <RewardsCenter
          colors={theme.colors}
          minTouchTarget={theme.minTouchTarget}
          onExit={() => navigation.goBack()}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 14 },
  h: { fontSize: 24, fontWeight: '700' },
});
