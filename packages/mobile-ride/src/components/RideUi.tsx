import { useUiPreferences } from '@yatri/mobile-ui';
import { type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useFocusWhen, useSpeakOnIos } from '../hooks';

/** The theme tokens the ride UI needs (both apps' theme objects satisfy this). */
export interface RideColors {
  background: string;
  surface: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  textInverse: string;
  primary: string;
  error: string;
  success: string;
}

export interface UiProps {
  colors: RideColors;
  minTouchTarget: number;
}

/**
 * A button that never depends on colour alone: the label says what it does, `busy` and
 * `disabled` are exposed to assistive tech, and the touch target meets the minimum.
 */
export function ActionButton(
  props: UiProps & {
    label: string;
    onPress: () => void;
    tone?: 'primary' | 'neutral' | 'danger';
    disabled?: boolean;
    busy?: boolean;
    hint?: string;
    /** Extra words for screen readers only (e.g. unread count). */
    accessibilityLabel?: string;
    selected?: boolean;
    role?: 'button' | 'tab' | 'radio' | 'switch';
  },
) {
  const { colors, minTouchTarget, tone = 'neutral', disabled, busy } = props;
  const { fontScale } = useUiPreferences();
  const bg = tone === 'primary' ? colors.primary : colors.surface;
  const fg =
    tone === 'primary' ? colors.textInverse : tone === 'danger' ? colors.error : colors.textPrimary;
  const border =
    tone === 'danger' ? colors.error : tone === 'primary' ? colors.primary : colors.border;
  return (
    <Pressable
      onPress={props.onPress}
      disabled={disabled || busy}
      accessibilityRole={props.role ?? 'button'}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.hint}
      accessibilityState={{ disabled: !!disabled, busy: !!busy, selected: props.selected }}
      style={({ pressed }) => [
        styles.button,
        {
          minHeight: minTouchTarget,
          backgroundColor: bg,
          borderColor: props.selected ? colors.primary : border,
          borderWidth: props.selected ? 2 : 1,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        },
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : null}
      <Text style={{ color: fg, fontWeight: '600', fontSize: 16 * fontScale }}>{props.label}</Text>
    </Pressable>
  );
}

/**
 * Live regions for one controller's spoken messages: polite for routine news, assertive for
 * what needs attention now. Always mounted so the region exists before its text changes; the
 * text is also visible, so it works without a screen reader.
 */
export function Announcer(
  props: UiProps & {
    polite?: { id: number; text: string } | null;
    assertive?: { id: number; text: string } | null;
  },
) {
  const { colors, polite, assertive } = props;
  const { fontScale } = useUiPreferences();
  useSpeakOnIos(polite ?? null);
  useSpeakOnIos(assertive ?? null);
  return (
    <>
      <View accessibilityLiveRegion="assertive" accessibilityRole="alert">
        {assertive ? (
          <Text
            key={assertive.id}
            style={[
              styles.banner,
              { color: colors.textPrimary, borderColor: colors.primary, fontSize: 17 * fontScale },
            ]}
          >
            {assertive.text}
          </Text>
        ) : null}
      </View>
      <View accessibilityLiveRegion="polite">
        {polite ? (
          <Text key={polite.id} style={{ color: colors.textPrimary, fontSize: 16 * fontScale }}>
            {polite.text}
          </Text>
        ) : null}
      </View>
    </>
  );
}

/** A titled group. `focusOnMount` moves the screen reader to the title when the card appears (a form or confirmation that replaced other content). */
export function Card(
  props: UiProps & { title?: string; children: ReactNode; focusOnMount?: boolean },
) {
  const { colors } = props;
  const { fontScale } = useUiPreferences();
  const titleRef = useFocusWhen(!!props.focusOnMount);
  return (
    <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      {props.title ? (
        <Text
          ref={titleRef}
          accessibilityRole="header"
          style={[styles.cardTitle, { color: colors.textPrimary, fontSize: 18 * fontScale }]}
        >
          {props.title}
        </Text>
      ) : null}
      {props.children}
    </View>
  );
}

/** A label/value pair read as one sentence ("Fare: NPR 320"). */
export function Fact(props: UiProps & { label: string; value: string }) {
  const { colors } = props;
  const { fontScale } = useUiPreferences();
  return (
    <View accessible accessibilityLabel={`${props.label}: ${props.value}`} style={styles.fact}>
      <Text style={{ color: colors.textSecondary, fontSize: 13 * fontScale }}>{props.label}</Text>
      <Text style={{ color: colors.textPrimary, fontSize: 17 * fontScale, fontWeight: '600' }}>
        {props.value}
      </Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  button: {
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  banner: { borderWidth: 2, borderRadius: 12, padding: 12, fontSize: 17, fontWeight: '700' },
  card: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 8 },
  cardTitle: { fontSize: 18, fontWeight: '700' },
  fact: { paddingVertical: 4 },
});
