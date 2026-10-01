import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '@yatri/mobile-auth';
import { BusinessCenter } from '@yatri/mobile-business';
import { useTheme } from '@yatri/mobile-ui';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../navigation/RootNavigator';

type Props = NativeStackScreenProps<RootStackParamList, 'Business'>;

/**
 * Business rides: the organizations you belong to, and for each the parts your role allows (rides, approvals,
 * members, rules, statements, usage). It is the shared BusinessCenter; the server decides what you may do.
 */
export function BusinessScreen({ navigation }: Props) {
  const theme = useTheme();
  const { getAccessToken } = useAuth();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={[styles.h, { color: theme.colors.textPrimary }]}>
          Business rides
        </Text>
        <BusinessCenter
          getAccessToken={getAccessToken}
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
