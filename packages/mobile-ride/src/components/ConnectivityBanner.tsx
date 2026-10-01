import { connectivity } from '@yatri/mobile-auth';
import { RECOVERED_NOTICE_MS, connectivityNotice } from '@yatri/mobile-location';
import { useUiPreferences } from '@yatri/mobile-ui';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useNow, useSpeakOnIos } from '../hooks';
import type { RideColors } from './RideUi';

/**
 * Says, in words, when the phone cannot reach Yatri and that what is on screen may be out of date; and when it is back.
 * One banner for the whole app (mounted once at the root), fed by the one connectivity monitor that every request
 * reports to. It is not colour alone (it is a sentence), the change is announced once politely (not every second), and
 * it never decides anything about a ride: the server does, and the apps re-fetch its state on reconnect.
 */
export function ConnectivityBanner({
  colors,
  topInset = 0,
}: {
  colors: RideColors;
  /** The device's top safe-area inset, so the banner clears the status bar when it is shown above the screens. */
  topInset?: number;
}) {
  const { fontScale } = useUiPreferences();
  const state = useSyncExternalStore(
    connectivity.subscribe,
    connectivity.getState,
    connectivity.getState,
  );
  const recentlyRecovered =
    state.recoveredAt !== null && Date.now() - state.recoveredAt < RECOVERED_NOTICE_MS + 5000;
  // Re-render a few times a minute so "last updated" stays honest and "back online" goes away by itself.
  useNow(5000, state.status === 'offline' || recentlyRecovered);
  const notice = connectivityNotice(state, Date.now());

  // Announce each change of kind once.
  const [spoken, setSpoken] = useState<{ id: number; text: string } | null>(null);
  const lastKind = useRef(notice.kind);
  const counter = useRef(0);
  useEffect(() => {
    if (lastKind.current === notice.kind) return;
    lastKind.current = notice.kind;
    if (notice.kind === 'none') return;
    counter.current += 1;
    setSpoken({ id: counter.current, text: `${notice.title} ${notice.detail}` });
  }, [notice.kind, notice.title, notice.detail]);
  useSpeakOnIos(spoken);

  if (notice.kind === 'none') return <View accessibilityLiveRegion="polite" />;
  // Only the title is a live region: the detail carries "last updated N seconds ago", which would otherwise be read out
  // again every time it changes.
  return (
    <View style={{ paddingTop: topInset, backgroundColor: colors.background }}>
      <View
        style={[
          styles.bar,
          {
            borderColor: notice.kind === 'offline' ? colors.error : colors.primary,
            backgroundColor: colors.surface,
          },
        ]}
      >
        <View accessibilityLiveRegion="polite">
          <Text style={[styles.title, { color: colors.textPrimary, fontSize: 16 * fontScale }]}>
            {notice.title}
          </Text>
        </View>
        <Text style={{ color: colors.textPrimary, fontSize: 14 * fontScale }}>{notice.detail}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { borderWidth: 2, borderRadius: 8, padding: 10, marginHorizontal: 12, marginVertical: 6 },
  title: { fontWeight: '700' },
});
