import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '@yatri/mobile-auth';
import { useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BRAND } from '../brand';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useTheme, Wordmark } from '@yatri/mobile-ui';

type Props = NativeStackScreenProps<RootStackParamList, 'ProfileSetup'>;

export function ProfileSetupScreen({ navigation }: Props) {
  const theme = useTheme();
  const { updateProfile } = useAuth();
  const [fullName, setFullName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  async function handleSave() {
    const trimmed = fullName.trim();
    if (trimmed.length === 0) {
      setErrorMessage('Enter your name to continue.');
      AccessibilityInfo.announceForAccessibility('Enter your name to continue.');
      return;
    }
    setSubmitting(true);
    setErrorMessage(undefined);
    try {
      await updateProfile({ fullName: trimmed });
      navigation.replace('Home');
    } catch {
      const message = 'Could not save your profile. Please try again.';
      setErrorMessage(message);
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={styles.header}>
        <Wordmark {...BRAND} />
        <Text style={[styles.title, { color: theme.colors.textPrimary }]}>Welcome to Yatri</Text>
        <Text
          style={[styles.subtitle, { color: theme.colors.textSecondary }]}
          accessibilityRole="text"
        >
          What should we call you?
        </Text>
      </View>

      <View style={styles.field}>
        <Text
          style={[styles.label, { color: theme.colors.textPrimary }]}
          nativeID="full-name-label"
        >
          Full name
        </Text>
        <TextInput
          value={fullName}
          onChangeText={setFullName}
          autoComplete="name"
          textContentType="name"
          autoCapitalize="words"
          placeholder="Your full name"
          placeholderTextColor={theme.colors.textSecondary}
          style={[
            styles.input,
            {
              color: theme.colors.textPrimary,
              borderColor: errorMessage ? theme.colors.error : theme.colors.border,
              backgroundColor: theme.colors.surface,
            },
          ]}
          accessibilityLabel={errorMessage ? `Full name. ${errorMessage}` : 'Full name'}
          accessibilityLabelledBy="full-name-label"
        />
        {errorMessage ? (
          <Text style={[styles.error, { color: theme.colors.error }]} accessibilityRole="alert">
            {errorMessage}
          </Text>
        ) : null}
      </View>

      <Pressable
        onPress={handleSave}
        disabled={submitting}
        accessibilityRole="button"
        accessibilityLabel={submitting ? 'Saving' : 'Continue'}
        accessibilityState={{ busy: submitting, disabled: submitting }}
        style={({ pressed }) => [
          styles.button,
          {
            backgroundColor: pressed ? theme.colors.primaryDark : theme.colors.primary,
            minHeight: theme.minTouchTarget,
            opacity: submitting ? 0.7 : 1,
          },
        ]}
      >
        <Text style={[styles.buttonText, { color: theme.colors.textInverse }]}>
          {submitting ? 'Saving…' : 'Continue'}
        </Text>
      </Pressable>

      <Pressable
        onPress={() => navigation.replace('Home')}
        accessibilityRole="button"
        accessibilityLabel="Skip for now"
        style={styles.skipButton}
      >
        <Text style={[styles.skipText, { color: theme.colors.textSecondary }]}>Skip for now</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 20, justifyContent: 'center' },
  header: { alignItems: 'center', gap: 8, marginBottom: 8 },
  title: { fontSize: 22, fontWeight: '700' },
  subtitle: { fontSize: 15, textAlign: 'center' },
  field: { gap: 8 },
  label: { fontSize: 15, fontWeight: '600' },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 16, minHeight: 48, fontSize: 16 },
  error: { fontSize: 13 },
  button: { justifyContent: 'center', alignItems: 'center', borderRadius: 999 },
  buttonText: { fontSize: 17, fontWeight: '700' },
  skipButton: {
    alignSelf: 'center',
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  skipText: { fontSize: 15, fontWeight: '600' },
});
