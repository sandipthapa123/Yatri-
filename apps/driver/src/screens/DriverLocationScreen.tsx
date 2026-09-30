import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '@yatri/mobile-auth';
import {
  driverLocationApi,
  formatAccuracy,
  formatCoordinates,
  ISSUE_MESSAGES,
  locationApi,
  useCurrentLocation,
  YatriMap,
} from '@yatri/mobile-location';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../navigation/RootNavigator';
import { useTheme } from '@yatri/mobile-ui';

type Props = NativeStackScreenProps<RootStackParamList, 'DriverLocation'>;

/**
 * Phase 4 driver location foundation: the driver can grant permission, see
 * where the phone thinks they are, and — only when they choose — send that
 * one position to Yatri. There is deliberately no background or continuous
 * tracking here; live broadcasting arrives with ride tracking.
 */
export function DriverLocationScreen({ navigation }: Props) {
  const theme = useTheme();
  const { getAccessToken } = useAuth();
  const current = useCurrentLocation();
  const [placeName, setPlaceName] = useState<string | null>(null);
  const [placeNote, setPlaceNote] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fix = current.state.status === 'success' ? current.state.fix : null;
  const issue = current.state.status === 'error' ? ISSUE_MESSAGES[current.state.issue] : null;

  const locate = async () => {
    setError(null);
    setShared(false);
    setMessage('');
    setPlaceName(null);
    setPlaceNote(null);
    const result = await current.request();
    if (!result) return;
    setMessage('Location found. Looking up the place name.');
    try {
      const r = await locationApi.reverseGeocode(await getAccessToken(), result);
      setPlaceName(r.formattedAddress);
      setMessage(`Your current location: ${r.formattedAddress}.`);
    } catch {
      setPlaceNote('The place name is temporarily unavailable. Your coordinates are shown below.');
      setMessage('Location found. The place name is temporarily unavailable.');
    }
  };

  const share = async () => {
    if (!fix) return;
    setBusy(true);
    setError(null);
    try {
      await driverLocationApi.share(await getAccessToken(), {
        latitude: fix.latitude,
        longitude: fix.longitude,
        accuracyMeters: fix.accuracyMeters,
      });
      setShared(true);
      setMessage('Your location was sent to Yatri.');
    } catch {
      setError('Could not send your location. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      await driverLocationApi.clear(await getAccessToken());
      setShared(false);
      setMessage('Your shared location was removed from Yatri.');
    } catch {
      setError('Could not remove your location. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const button = (text: string, onPress: () => void, primary = false, disabled = false) => (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={text}
      accessibilityState={{ disabled }}
      style={[
        styles.button,
        {
          minHeight: theme.minTouchTarget,
          backgroundColor: primary ? theme.colors.primary : theme.colors.surface,
          borderColor: primary ? theme.colors.primary : theme.colors.border,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <Text
        style={{
          color: primary ? theme.colors.textInverse : theme.colors.textPrimary,
          fontWeight: '600',
          fontSize: 16,
        }}
      >
        {text}
      </Text>
    </Pressable>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text
          accessibilityRole="header"
          style={[styles.heading, { color: theme.colors.textPrimary }]}
        >
          My location
        </Text>
        <Text style={{ color: theme.colors.textSecondary, lineHeight: 22 }}>
          Yatri asks for your location only when you tap the button below. It is not tracked in the
          background, and nothing is sent to Yatri until you choose to share it.
        </Text>

        <Text
          accessibilityLiveRegion="polite"
          style={{ color: theme.colors.textSecondary, minHeight: 20 }}
        >
          {message}
        </Text>

        {button(
          current.state.status === 'locating'
            ? 'Finding your location…'
            : 'Get my current location',
          () => void locate(),
          true,
          current.state.status === 'locating',
        )}
        {current.state.status === 'locating' ? (
          <ActivityIndicator
            color={theme.colors.primary}
            accessibilityLabel="Finding your location"
          />
        ) : null}

        {issue ? (
          <View accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.gap}>
            <Text style={{ color: theme.colors.error, fontWeight: '700', fontSize: 16 }}>
              {issue.title}
            </Text>
            <Text style={{ color: theme.colors.textPrimary }}>{issue.body}</Text>
            {current.state.status === 'error' && current.state.issue === 'blocked'
              ? button('Open phone settings', current.openSettings)
              : null}
          </View>
        ) : null}

        {fix ? (
          <View
            accessible
            accessibilityRole="summary"
            accessibilityLabel={`Current location. ${placeName ?? 'Place name unavailable'}. ${formatCoordinates(fix.latitude, fix.longitude)}. ${formatAccuracy(fix.accuracyMeters) ?? ''}`}
            style={[
              styles.card,
              { borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
            ]}
          >
            <Text style={{ color: theme.colors.textSecondary }}>Current location</Text>
            <Text style={{ color: theme.colors.textPrimary, fontWeight: '700', fontSize: 18 }}>
              {placeName ?? 'Place name unavailable'}
            </Text>
            {placeNote ? (
              <Text style={{ color: theme.colors.textSecondary }}>{placeNote}</Text>
            ) : null}
            <Text style={{ color: theme.colors.textPrimary }}>
              {formatCoordinates(fix.latitude, fix.longitude)}
            </Text>
            {formatAccuracy(fix.accuracyMeters) ? (
              <Text style={{ color: theme.colors.textSecondary }}>
                {formatAccuracy(fix.accuracyMeters)}
              </Text>
            ) : null}
          </View>
        ) : null}

        {fix ? (
          <YatriMap
            center={fix}
            markers={[
              {
                id: 'me',
                latitude: fix.latitude,
                longitude: fix.longitude,
                glyph: 'Y',
                label: 'You',
              },
            ]}
            colors={theme.colors}
            minTouchTarget={theme.minTouchTarget}
          />
        ) : null}

        {error ? (
          <View accessibilityRole="alert" accessibilityLiveRegion="assertive">
            <Text style={{ color: theme.colors.error }}>{error}</Text>
          </View>
        ) : null}

        {fix
          ? button(
              busy ? 'Sending…' : 'Send this location to Yatri',
              () => void share(),
              false,
              busy,
            )
          : null}
        {shared ? button('Remove my shared location', () => void clear(), false, busy) : null}
        {button('Back', () => navigation.goBack())}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 14 },
  heading: { fontSize: 24, fontWeight: '700' },
  gap: { gap: 8 },
  card: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 4 },
  button: {
    borderWidth: 1,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
});
