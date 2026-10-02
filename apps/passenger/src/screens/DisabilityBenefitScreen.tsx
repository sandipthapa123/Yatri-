import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { DisabilityBenefitCenter } from '@yatri/mobile-preferences';
import { useTheme } from '@yatri/mobile-ui';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../navigation/RootNavigator';

type Props = NativeStackScreenProps<RootStackParamList, 'DisabilityBenefit'>;

/**
 * Disability benefit verification: optional, private and announced. It is the shared DisabilityBenefitCenter; the server
 * decides every status and every benefit.
 */
export function DisabilityBenefitScreen({ navigation }: Props) {
  const theme = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={[styles.h, { color: theme.colors.textPrimary }]}>
          Disability benefit
        </Text>
        <DisabilityBenefitCenter
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
