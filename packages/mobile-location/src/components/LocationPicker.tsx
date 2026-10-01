import type { PlaceSummary, SavedPlace } from '@yatri/types';
import { useEffect, useMemo, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  findNodeHandle,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { describeResult, describeResultCount, formatAccuracy, formatCoordinates } from '../format';
import { reverseGeocode, searchPlaces } from '../locationApi';
import { ISSUE_MESSAGES, isPoorAccuracy } from '../permissions';
import { SearchController, type SearchState } from '../searchController';
import { useCurrentLocation } from '../useCurrentLocation';
import { YatriMap, type MapColors } from './MapView';

export interface SelectedPlace {
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  city: string | null;
  province: string | null;
  country: string | null;
  source: 'current' | 'search' | 'saved' | 'recent' | 'map';
  accuracyMeters?: number | null;
}

export interface LocationPickerProps {
  /** Drives the wording: "pickup", "destination" or a neutral "place". */
  purpose: 'pickup' | 'destination' | 'place';
  getAccessToken: () => Promise<string>;
  onConfirm: (place: SelectedPlace) => void;
  onCancel?: () => void;
  savedPlaces?: SavedPlace[];
  /** Places the person recently went to (from the server; only offered when they have not hidden them). */
  recentPlaces?: Array<{
    name: string | null;
    address: string;
    latitude: number;
    longitude: number;
  }>;
  initial?: SelectedPlace | null;
  /** Default: true for pickup. */
  allowCurrentLocation?: boolean;
  /** Optional visual map. Never required to finish selection. */
  showMap?: boolean;
  colors: MapColors & { background: string; textInverse: string };
  minTouchTarget: number;
}

const NOUN = { pickup: 'Pickup', destination: 'Destination', place: 'Place' } as const;
const DEFAULT_CENTER = { latitude: 27.7172, longitude: 85.324 }; // Kathmandu; only a starting view, not a service limit

/** Polite announcement that also works on iOS, where live regions are unreliable. */
function announce(message: string) {
  if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(message);
}

function fromSummary(p: PlaceSummary, source: SelectedPlace['source']): SelectedPlace {
  return {
    name: p.name,
    address: p.address,
    latitude: p.latitude,
    longitude: p.longitude,
    city: p.city,
    province: p.province,
    country: p.country,
    source,
  };
}

export function LocationPicker({
  purpose,
  getAccessToken,
  onConfirm,
  onCancel,
  savedPlaces = [],
  recentPlaces = [],
  initial = null,
  allowCurrentLocation = purpose === 'pickup',
  showMap = true,
  colors,
  minTouchTarget,
}: LocationPickerProps) {
  const noun = NOUN[purpose];
  const [text, setText] = useState('');
  const [search, setSearch] = useState<SearchState<PlaceSummary>>({ status: 'idle' });
  const [draft, setDraft] = useState<SelectedPlace | null>(initial);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const gps = useCurrentLocation();
  const [summaryNode, setSummaryNode] = useState<View | null>(null);
  const [focusTick, setFocusTick] = useState(0);

  const say = setNotice;

  // Debounced, cancellable, cached search. Recreated only if the token getter changes.
  const searchController = useMemo(
    () =>
      new SearchController<PlaceSummary>({
        fetcher: async (query, signal) =>
          searchPlaces(await getAccessToken(), query, { limit: 6, signal }),
        onState: setSearch,
      }),
    [getAccessToken],
  );
  useEffect(() => () => searchController.dispose(), [searchController]);

  // What the polite live region says: the latest selection/lookup notice, else the search state.
  const searchText =
    search.status === 'success'
      ? describeResultCount(search.results.length, search.query)
      : search.status === 'loading'
        ? 'Searching…'
        : '';
  const status = notice || searchText;
  useEffect(() => {
    // iOS VoiceOver ignores live regions, so speak changes explicitly (never the transient "Searching…").
    if (status && status !== 'Searching…') announce(status);
  }, [status]);

  // After a selection, move the screen reader onto the summary so the choice is read out.
  useEffect(() => {
    if (focusTick === 0 || !summaryNode) return;
    const t = setTimeout(() => {
      const handle = findNodeHandle(summaryNode);
      if (handle) AccessibilityInfo.setAccessibilityFocus(handle);
    }, 150);
    return () => clearTimeout(t);
  }, [focusTick, summaryNode]);

  const choose = (place: SelectedPlace) => {
    setDraft(place);
    setError(null);
    setMapOpen(false);
    say(
      `${noun} selected: ${place.name}${place.address ? `, ${place.address}` : ''}. Latitude and longitude are available to the system.`,
    );
    setFocusTick((t) => t + 1);
  };

  /** Coordinates -> a place with a human-readable name (falls back gracefully). */
  const resolvePoint = async (
    point: { latitude: number; longitude: number },
    source: 'current' | 'map',
    accuracyMeters?: number | null,
  ) => {
    setResolving(true);
    setError(null);
    say('Finding the address for this spot…');
    try {
      const r = await reverseGeocode(await getAccessToken(), point);
      choose({
        name: r.name,
        address: r.address,
        latitude: point.latitude,
        longitude: point.longitude,
        city: r.city,
        province: r.province,
        country: r.country,
        source,
        accuracyMeters,
      });
    } catch {
      // The coordinates are still valid; keep them with an honest label.
      choose({
        name: source === 'current' ? 'Current location' : 'Selected point on map',
        address: 'Address temporarily unavailable',
        latitude: point.latitude,
        longitude: point.longitude,
        city: null,
        province: null,
        country: null,
        source,
        accuracyMeters,
      });
    } finally {
      setResolving(false);
    }
  };

  const locateMe = async () => {
    setError(null);
    const fix = await gps.request();
    if (fix) await resolvePoint(fix, 'current', fix.accuracyMeters);
  };

  const issue = gps.state.status === 'error' ? ISSUE_MESSAGES[gps.state.issue] : null;
  const canOpenSettings = gps.state.status === 'error' && gps.state.issue === 'blocked';

  const results = search.status === 'success' ? search.results : [];
  const mapCenter = draft ?? DEFAULT_CENTER;
  const markers = useMemo(
    () =>
      draft
        ? [
            {
              id: 'sel',
              latitude: draft.latitude,
              longitude: draft.longitude,
              glyph: purpose === 'destination' ? 'D' : 'P',
              label: draft.name,
            },
          ]
        : [],
    [draft, purpose],
  );

  const btn = (
    label: string,
    onPress: () => void,
    opts: { primary?: boolean; hint?: string; disabled?: boolean } = {},
  ) => (
    <Pressable
      onPress={onPress}
      disabled={opts.disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={opts.hint}
      accessibilityState={{ disabled: !!opts.disabled }}
      style={[
        styles.button,
        {
          minHeight: minTouchTarget,
          backgroundColor: opts.primary ? colors.primary : colors.surface,
          borderColor: opts.primary ? colors.primary : colors.border,
          opacity: opts.disabled ? 0.5 : 1,
        },
      ]}
    >
      <Text
        style={{
          color: opts.primary ? colors.textInverse : colors.textPrimary,
          fontWeight: '600',
          fontSize: 16,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: colors.background }}
    >
      <Text accessibilityRole="header" style={[styles.heading, { color: colors.textPrimary }]}>
        Choose {noun.toLowerCase()}
      </Text>

      {/* Polite status region: result counts, progress, selection. Not a toast; always in the tree. */}
      <Text
        accessibilityLiveRegion="polite"
        accessibilityRole="text"
        style={[styles.status, { color: colors.textSecondary }]}
      >
        {status}
      </Text>

      {error ? (
        <View accessibilityRole="alert" accessibilityLiveRegion="assertive">
          <Text style={{ color: colors.error }}>{error}</Text>
        </View>
      ) : null}

      {allowCurrentLocation ? (
        <View style={styles.section}>
          <Text style={[styles.body, { color: colors.textSecondary }]}>
            Yatri uses your phone’s location once, to set your pickup point. It is not tracked in
            the background.
          </Text>
          {btn(
            gps.state.status === 'locating' ? 'Finding your location…' : 'Use current location',
            () => void locateMe(),
            { disabled: gps.state.status === 'locating' || resolving },
          )}
          {gps.state.status === 'locating' ? (
            <ActivityIndicator color={colors.primary} accessibilityLabel="Finding your location" />
          ) : null}
          {issue ? (
            <View
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              style={styles.issue}
            >
              <Text style={[styles.issueTitle, { color: colors.error }]}>{issue.title}</Text>
              <Text style={{ color: colors.textPrimary }}>{issue.body}</Text>
              {canOpenSettings ? btn('Open phone settings', gps.openSettings) : null}
              {!canOpenSettings ? btn('Try again', () => void locateMe()) : null}
            </View>
          ) : null}
        </View>
      ) : null}

      <View style={styles.section}>
        <Text nativeID="place-search-label" style={[styles.label, { color: colors.textPrimary }]}>
          Search for a {noun.toLowerCase()}
        </Text>
        <TextInput
          value={text}
          onChangeText={(t) => {
            setText(t);
            setNotice('');
            searchController.setQuery(t);
          }}
          onSubmitEditing={() => searchController.searchNow(text)}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          accessibilityLabel={`Search for a ${noun.toLowerCase()}`}
          accessibilityHint="Type a place name, landmark or address in English or Nepali. Results appear below."
          placeholder="e.g. Thamel, Patan Durbar Square, थमेल"
          placeholderTextColor={colors.textSecondary}
          style={[
            styles.input,
            {
              minHeight: minTouchTarget,
              borderColor: colors.border,
              color: colors.textPrimary,
              backgroundColor: colors.surface,
            },
          ]}
        />

        {search.status === 'too-short' ? (
          <Text style={{ color: colors.textSecondary }}>Type at least 2 characters to search.</Text>
        ) : null}
        {search.status === 'loading' ? (
          <ActivityIndicator color={colors.primary} accessibilityLabel="Searching" />
        ) : null}
        {search.status === 'error' ? (
          <View accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.issue}>
            <Text style={{ color: colors.error }}>
              We could not search right now. Check your connection and try again, or use a saved
              place.
            </Text>
            {btn('Try search again', () => searchController.searchNow(text))}
          </View>
        ) : null}

        {results.length > 0 ? (
          <View accessibilityRole="list" style={styles.list}>
            {results.map((place, i) => (
              <Pressable
                key={`${place.latitude},${place.longitude},${place.name}`}
                onPress={() => choose(fromSummary(place, 'search'))}
                accessibilityRole="button"
                accessibilityLabel={describeResult(place, i, results.length)}
                accessibilityHint={`Selects this place as your ${noun.toLowerCase()}`}
                style={[
                  styles.result,
                  {
                    minHeight: minTouchTarget,
                    borderColor: colors.border,
                    backgroundColor: colors.surface,
                  },
                ]}
              >
                <Text style={[styles.resultName, { color: colors.textPrimary }]}>{place.name}</Text>
                {place.address ? (
                  <Text style={{ color: colors.textSecondary }}>{place.address}</Text>
                ) : null}
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>

      {recentPlaces.length > 0 ? (
        <View style={styles.section}>
          <Text accessibilityRole="header" style={[styles.label, { color: colors.textPrimary }]}>
            Recent destinations
          </Text>
          {recentPlaces.map((p) => (
            <Pressable
              key={`${p.latitude},${p.longitude}`}
              onPress={() =>
                choose({
                  name: p.name ?? p.address,
                  address: p.address,
                  latitude: p.latitude,
                  longitude: p.longitude,
                  city: null,
                  province: null,
                  country: null,
                  source: 'recent',
                })
              }
              accessibilityRole="button"
              accessibilityLabel={`Recent: ${p.name ?? p.address}. ${p.address}`}
              accessibilityHint={`Selects this recent place as your ${noun.toLowerCase()}`}
              style={[
                styles.result,
                {
                  minHeight: minTouchTarget,
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                },
              ]}
            >
              <Text style={[styles.resultName, { color: colors.textPrimary }]}>
                {p.name ?? p.address}
              </Text>
              <Text style={{ color: colors.textSecondary }}>{p.address}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {savedPlaces.length > 0 ? (
        <View style={styles.section}>
          <Text accessibilityRole="header" style={[styles.label, { color: colors.textPrimary }]}>
            Saved places
          </Text>
          {savedPlaces.map((p) => (
            <Pressable
              key={p.id}
              onPress={() =>
                choose({
                  name: p.label ?? p.name,
                  address: p.address,
                  latitude: p.latitude,
                  longitude: p.longitude,
                  city: p.city,
                  province: p.province,
                  country: p.country,
                  source: 'saved',
                })
              }
              accessibilityRole="button"
              accessibilityLabel={`${p.kind === 'FAVOURITE' ? 'Favourite' : p.kind === 'HOME' ? 'Home' : 'Work'}: ${p.name}. ${p.address}`}
              accessibilityHint={`Selects this saved place as your ${noun.toLowerCase()}`}
              style={[
                styles.result,
                {
                  minHeight: minTouchTarget,
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                },
              ]}
            >
              <Text style={[styles.resultName, { color: colors.textPrimary }]}>{p.name}</Text>
              <Text style={{ color: colors.textSecondary }}>{p.address}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {showMap ? (
        <View style={styles.section}>
          {btn(mapOpen ? 'Hide map' : 'Choose on map (optional)', () => setMapOpen((o) => !o), {
            hint: 'Optional. You can finish without using the map.',
          })}
          {mapOpen ? (
            <>
              <Text style={{ color: colors.textSecondary }}>
                Tap the map to drop a point. The address is read out once it is found.
              </Text>
              <YatriMap
                center={mapCenter}
                markers={markers}
                onPick={(pt) => void resolvePoint(pt, 'map')}
                colors={colors}
                minTouchTarget={minTouchTarget}
              />
            </>
          ) : null}
        </View>
      ) : null}

      {draft ? (
        <View
          ref={setSummaryNode}
          accessible
          accessibilityRole="summary"
          accessibilityLabel={`${noun} selected: ${draft.name}${draft.address ? `, ${draft.address}` : ''}. ${formatAccuracy(draft.accuracyMeters) ?? ''}`}
          style={[styles.summary, { borderColor: colors.primary, backgroundColor: colors.surface }]}
        >
          <Text style={{ color: colors.textSecondary }}>{noun} selected</Text>
          <Text style={[styles.resultName, { color: colors.textPrimary }]}>{draft.name}</Text>
          {draft.address ? (
            <Text style={{ color: colors.textPrimary }}>{draft.address}</Text>
          ) : null}
          <Text style={{ color: colors.textSecondary }}>
            {formatCoordinates(draft.latitude, draft.longitude)}
          </Text>
          {draft.source === 'current' && isPoorAccuracy(draft.accuracyMeters) ? (
            <Text style={{ color: colors.error }}>
              {formatAccuracy(draft.accuracyMeters) ?? 'Location accuracy is unknown.'} This may be
              off. Confirm it, or search for a more precise place.
            </Text>
          ) : formatAccuracy(draft.accuracyMeters) ? (
            <Text style={{ color: colors.textSecondary }}>
              {formatAccuracy(draft.accuracyMeters)}
            </Text>
          ) : null}
        </View>
      ) : null}

      <View style={styles.section}>
        {btn(`Confirm ${noun.toLowerCase()}`, () => draft && onConfirm(draft), {
          primary: true,
          disabled: !draft || resolving,
          hint: draft ? undefined : `Choose a ${noun.toLowerCase()} first`,
        })}
        {onCancel ? btn('Cancel', onCancel) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 20 },
  heading: { fontSize: 24, fontWeight: '700' },
  status: { minHeight: 20, fontSize: 14 },
  section: { gap: 10 },
  body: { fontSize: 15, lineHeight: 22 },
  label: { fontSize: 17, fontWeight: '600' },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, fontSize: 16 },
  list: { gap: 8 },
  result: { borderWidth: 1, borderRadius: 12, padding: 12, justifyContent: 'center', gap: 2 },
  resultName: { fontSize: 17, fontWeight: '600' },
  button: {
    borderWidth: 1,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  issue: { gap: 8 },
  issueTitle: { fontSize: 16, fontWeight: '700' },
  summary: { borderWidth: 2, borderRadius: 14, padding: 14, gap: 4 },
});
