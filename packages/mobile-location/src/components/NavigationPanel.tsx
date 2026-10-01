import {
  APPROACH_PHASE_LABELS,
  describeGuidance,
  formatDistance,
  formatDuration,
  nextStepSentence,
  type LiveTripSnapshot,
} from '@yatri/types';
import { useState } from 'react';
import { AccessibilityInfo, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useEffect } from 'react';

import type { NavigationState } from '../navigationController';
import type { MapColors } from './MapView';

/**
 * Directions for the driver, as text first. The next maneuver is a sentence ("In 300 meters, turn left onto New
 * Road."), the figures are plain facts, the whole route is a list of steps, and a route that may be out of date, an
 * estimate without a road route, or an estimate without live traffic says so in words. The map line is an extra.
 * Spoken updates are rare by design (a new route, a deviation, an approaching maneuver); the figures here are not live
 * regions, so they do not chatter with every GPS reading.
 */
export function NavigationPanel(props: {
  state: NavigationState;
  snapshot: LiveTripSnapshot | null;
  colors: MapColors & { background: string };
  minTouchTarget: number;
}) {
  const { state, snapshot, colors, minTouchTarget } = props;
  const [showSteps, setShowSteps] = useState(false);
  const g = state.guidance;
  const route = state.route;

  // iOS VoiceOver ignores live regions: speak the same sentence there.
  useEffect(() => {
    if (state.polite && Platform.OS === 'ios')
      AccessibilityInfo.announceForAccessibility(state.polite.text);
  }, [state.polite]);

  if (!snapshot || !g) return null;
  const targetName = g.target === 'PICKUP' ? snapshot.pickup.name : snapshot.destination.name;
  const next = nextStepSentence(g);

  return (
    <View style={[styles.box, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <View accessibilityRole="header" accessible>
        <Text style={[styles.heading, { color: colors.textPrimary }]}>
          {g.target === 'PICKUP' ? 'Directions to the pickup' : 'Directions to the destination'}
        </Text>
      </View>

      <View accessibilityLiveRegion="polite">
        <Text
          key={state.polite?.id ?? 0}
          style={{ color: colors.textPrimary, fontSize: 17, lineHeight: 24 }}
        >
          {state.polite?.text ?? ''}
        </Text>
      </View>

      {g.offRoute ? (
        <View accessibilityRole="alert">
          <Text style={{ color: colors.error, fontWeight: '700' }}>
            You are off the planned route. Finding a new route.
          </Text>
        </View>
      ) : null}
      {state.stale ? (
        <Text style={{ color: colors.error }}>
          Directions may be out of date: they could not be refreshed. They will update when you are
          back online.
        </Text>
      ) : null}

      <Text
        accessibilityRole="text"
        style={{ color: colors.textPrimary, fontSize: 20, fontWeight: '700' }}
      >
        {next ?? describeGuidance(g, targetName)}
      </Text>

      <View accessible accessibilityLabel={`Where you are: ${APPROACH_PHASE_LABELS[g.phase]}`}>
        <Text style={{ color: colors.textSecondary }}>{APPROACH_PHASE_LABELS[g.phase]}</Text>
      </View>
      <Fact
        colors={colors}
        label="Distance remaining"
        value={formatDistance(g.distanceRemainingMeters)}
      />
      <Fact
        colors={colors}
        label="Estimated arrival"
        value={g.etaSeconds === null ? 'Not available' : formatDuration(g.etaSeconds)}
      />
      <Text style={{ color: colors.textSecondary, fontSize: 14 }}>
        {g.basis === 'estimate'
          ? 'No road route is available, so these figures are a straight-line estimate and the directions point the way.'
          : g.trafficAware
            ? 'The estimate includes live traffic.'
            : 'The estimate does not include live traffic.'}
      </Text>

      {route && route.steps.length > 1 ? (
        <>
          <Pressable
            onPress={() => setShowSteps((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ expanded: showSteps }}
            accessibilityLabel={
              showSteps ? 'Hide all steps' : `Show all ${route.steps.length} steps`
            }
            style={[styles.button, { minHeight: minTouchTarget, borderColor: colors.border }]}
          >
            <Text style={{ color: colors.textPrimary, fontWeight: '600', fontSize: 16 }}>
              {showSteps ? 'Hide all steps' : `Show all ${route.steps.length} steps`}
            </Text>
          </Pressable>
          {showSteps ? (
            <View accessibilityRole="list">
              {route.steps.map((st, i) => (
                <Text
                  key={`${i}-${st.instruction}`}
                  style={{ color: colors.textPrimary, paddingVertical: 4 }}
                  accessibilityLabel={`Step ${i + 1}: ${st.instruction}${st.distanceMeters > 0 ? ` Then ${formatDistance(st.distanceMeters)}.` : ''}`}
                >
                  {`${i + 1}. ${st.instruction}${st.distanceMeters > 0 ? ` (${formatDistance(st.distanceMeters)})` : ''}`}
                </Text>
              ))}
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function Fact({ colors, label, value }: { colors: MapColors; label: string; value: string }) {
  return (
    <View accessible accessibilityLabel={`${label}: ${value}`} style={styles.fact}>
      <Text style={{ color: colors.textSecondary, flex: 1 }}>{label}</Text>
      <Text style={{ color: colors.textPrimary, fontWeight: '600' }}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderRadius: 10, padding: 14, gap: 8 },
  heading: { fontSize: 18, fontWeight: '700' },
  fact: { flexDirection: 'row', gap: 8, justifyContent: 'space-between' },
  button: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, justifyContent: 'center' },
});
