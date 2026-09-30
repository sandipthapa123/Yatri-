import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ApiError, useAuth } from '@yatri/mobile-auth';
import { LocationPicker, savedPlacesApi, type SelectedPlace } from '@yatri/mobile-location';
import type { SavedPlace, SavedPlaceKind } from '@yatri/types';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../navigation/RootNavigator';
import { useTheme } from '@yatri/mobile-ui';

type Props = NativeStackScreenProps<RootStackParamList, 'SavedPlaces'>;

const KIND_LABEL: Record<SavedPlaceKind, string> = {
  HOME: 'Home',
  WORK: 'Work',
  FAVOURITE: 'Favourite',
};

type Mode =
  | { type: 'list' }
  | { type: 'pick'; editing: SavedPlace | null }
  | { type: 'details'; editing: SavedPlace | null; location: SelectedPlace | null };

export function SavedPlacesScreen({ navigation }: Props) {
  const theme = useTheme();
  const { getAccessToken } = useAuth();
  const [places, setPlaces] = useState<SavedPlace[] | null>(null);
  const [mode, setMode] = useState<Mode>({ type: 'list' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<SavedPlaceKind>('FAVOURITE');

  const [reloadTick, setReloadTick] = useState(0);
  const load = useCallback(async () => setReloadTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await savedPlacesApi.list(await getAccessToken());
        if (cancelled) return;
        setPlaces(list);
        setError(null);
      } catch {
        if (cancelled) return;
        setError('Could not load your saved places. Check your connection and try again.');
        setPlaces((prev) => prev ?? []);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getAccessToken, reloadTick]);

  const startDetails = (editing: SavedPlace | null, location: SelectedPlace | null) => {
    setName(editing?.name ?? location?.name ?? '');
    setLabel(editing?.label ?? '');
    setKind(editing?.kind ?? 'FAVOURITE');
    setError(null);
    setMode({ type: 'details', editing, location });
  };

  const save = async () => {
    if (mode.type !== 'details') return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Enter a name for this place.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = await getAccessToken();
      const loc = mode.location;
      const locationFields = loc
        ? {
            latitude: loc.latitude,
            longitude: loc.longitude,
            address: loc.address,
            city: loc.city,
            province: loc.province,
            country: loc.country,
          }
        : {};
      if (mode.editing) {
        await savedPlacesApi.update(token, mode.editing.id, {
          name: trimmed,
          kind,
          label: label.trim() || null,
          ...locationFields,
        });
      } else if (loc) {
        await savedPlacesApi.create(token, {
          name: trimmed,
          kind,
          label: label.trim() || null,
          latitude: loc.latitude,
          longitude: loc.longitude,
          address: loc.address,
          city: loc.city,
          province: loc.province,
          country: loc.country,
        });
      }
      await load();
      setMode({ type: 'list' });
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? e.message
          : 'Could not save this place. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = (p: SavedPlace) => {
    Alert.alert(`Delete ${p.name}?`, 'This removes it from your saved places.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await savedPlacesApi.remove(await getAccessToken(), p.id);
              await load();
            } catch {
              setError('Could not delete this place. Please try again.');
            }
          })();
        },
      },
    ]);
  };

  const inputStyle = [
    styles.input,
    {
      minHeight: theme.minTouchTarget,
      borderColor: theme.colors.border,
      color: theme.colors.textPrimary,
      backgroundColor: theme.colors.surface,
    },
  ];

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
        }}
      >
        {text}
      </Text>
    </Pressable>
  );

  if (mode.type === 'pick') {
    const editing = mode.editing;
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <LocationPicker
          purpose="place"
          getAccessToken={getAccessToken}
          allowCurrentLocation
          colors={theme.colors}
          minTouchTarget={theme.minTouchTarget}
          initial={
            editing
              ? {
                  name: editing.name,
                  address: editing.address,
                  latitude: editing.latitude,
                  longitude: editing.longitude,
                  city: editing.city,
                  province: editing.province,
                  country: editing.country,
                  source: 'saved',
                }
              : null
          }
          onCancel={() => (editing ? startDetails(editing, null) : setMode({ type: 'list' }))}
          onConfirm={(loc) => startDetails(editing, loc)}
        />
      </SafeAreaView>
    );
  }

  if (mode.type === 'details') {
    const address = mode.location?.address ?? mode.editing?.address ?? '';
    const placeName = mode.location?.name ?? mode.editing?.name ?? '';
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text
            accessibilityRole="header"
            style={[styles.heading, { color: theme.colors.textPrimary }]}
          >
            {mode.editing ? 'Edit saved place' : 'Save this place'}
          </Text>
          <View accessible accessibilityRole="summary" style={styles.block}>
            <Text style={{ color: theme.colors.textSecondary }}>Location</Text>
            <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>{placeName}</Text>
            <Text style={{ color: theme.colors.textPrimary }}>{address}</Text>
          </View>
          {button('Change location', () => setMode({ type: 'pick', editing: mode.editing }))}

          <Text style={[styles.label, { color: theme.colors.textPrimary }]}>Type</Text>
          <View accessibilityRole="radiogroup" style={styles.row}>
            {(Object.keys(KIND_LABEL) as SavedPlaceKind[]).map((k) => (
              <Pressable
                key={k}
                onPress={() => setKind(k)}
                accessibilityRole="radio"
                accessibilityState={{ selected: kind === k, checked: kind === k }}
                accessibilityLabel={KIND_LABEL[k]}
                style={[
                  styles.radio,
                  {
                    minHeight: theme.minTouchTarget,
                    borderColor: kind === k ? theme.colors.primary : theme.colors.border,
                    // Selection is shown by border weight AND a tick, never colour alone.
                    borderWidth: kind === k ? 3 : 1,
                  },
                ]}
              >
                <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>
                  {kind === k ? '✓ ' : ''}
                  {KIND_LABEL[k]}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={[styles.label, { color: theme.colors.textPrimary }]}>Name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            maxLength={80}
            accessibilityLabel="Name"
            style={inputStyle}
          />
          <Text style={[styles.label, { color: theme.colors.textPrimary }]}>
            Custom label (optional)
          </Text>
          <TextInput
            value={label}
            onChangeText={setLabel}
            maxLength={80}
            accessibilityLabel="Custom label, optional"
            style={inputStyle}
          />
          {error ? (
            <View accessibilityRole="alert" accessibilityLiveRegion="assertive">
              <Text style={{ color: theme.colors.error }}>{error}</Text>
            </View>
          ) : null}
          {button(
            busy ? 'Saving…' : 'Save place',
            () => void save(),
            true,
            busy || (!mode.editing && !mode.location),
          )}
          {button('Cancel', () => setMode({ type: 'list' }))}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text
          accessibilityRole="header"
          style={[styles.heading, { color: theme.colors.textPrimary }]}
        >
          Saved places
        </Text>
        {error ? (
          <View accessibilityRole="alert" accessibilityLiveRegion="assertive">
            <Text style={{ color: theme.colors.error }}>{error}</Text>
          </View>
        ) : null}
        {places === null ? (
          <ActivityIndicator
            color={theme.colors.primary}
            accessibilityLabel="Loading saved places"
          />
        ) : places.length === 0 ? (
          <Text style={{ color: theme.colors.textSecondary }}>
            You have no saved places yet. Add Home, Work or a favourite to pick it quickly later.
          </Text>
        ) : (
          places.map((p) => (
            <View
              key={p.id}
              style={[
                styles.block,
                { borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
              ]}
            >
              <View
                accessible
                accessibilityLabel={`${KIND_LABEL[p.kind]}: ${p.name}${p.label ? `, ${p.label}` : ''}. ${p.address}`}
              >
                <Text style={{ color: theme.colors.textSecondary }}>{KIND_LABEL[p.kind]}</Text>
                <Text style={{ color: theme.colors.textPrimary, fontWeight: '700', fontSize: 17 }}>
                  {p.name}
                </Text>
                {p.label ? (
                  <Text style={{ color: theme.colors.textPrimary }}>{p.label}</Text>
                ) : null}
                <Text style={{ color: theme.colors.textSecondary }}>{p.address}</Text>
              </View>
              <View style={styles.row}>
                <Pressable
                  onPress={() => startDetails(p, null)}
                  accessibilityRole="button"
                  accessibilityLabel={`Edit ${p.name}`}
                  style={[
                    styles.small,
                    { minHeight: theme.minTouchTarget, borderColor: theme.colors.border },
                  ]}
                >
                  <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>Edit</Text>
                </Pressable>
                <Pressable
                  onPress={() => remove(p)}
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${p.name}`}
                  style={[
                    styles.small,
                    { minHeight: theme.minTouchTarget, borderColor: theme.colors.error },
                  ]}
                >
                  <Text style={{ color: theme.colors.error, fontWeight: '600' }}>Delete</Text>
                </Pressable>
              </View>
            </View>
          ))
        )}
        {button('Add a saved place', () => setMode({ type: 'pick', editing: null }), true)}
        {button('Back', () => navigation.goBack())}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 14 },
  heading: { fontSize: 24, fontWeight: '700' },
  label: { fontSize: 16, fontWeight: '600' },
  block: { borderWidth: 1, borderColor: 'transparent', borderRadius: 14, padding: 14, gap: 8 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  radio: { borderRadius: 10, paddingHorizontal: 14, justifyContent: 'center' },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, fontSize: 16 },
  button: {
    borderWidth: 1,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  small: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 18, justifyContent: 'center' },
});
