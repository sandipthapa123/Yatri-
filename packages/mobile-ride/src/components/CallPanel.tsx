import { formatElapsed, type TripRole } from '@yatri/types';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { CallController, CallUiState } from '../callController';
import { describeQuality } from '../callQuality';
import { useNow } from '../hooks';
import { getRtcView } from '../webrtcAdapter';
import { ActionButton, Card, type UiProps } from './RideUi';

const PHASE_TEXT: Record<CallUiState['phase'], string> = {
  idle: 'No call in progress.',
  calling: 'Calling…',
  incoming: 'Incoming call.',
  connecting: 'Connecting…',
  connected: 'On a call.',
  ended: 'Call ended.',
};

/**
 * Talk to the other person on this ride — by role ("your driver"), never by phone number.
 * Every state has words; controls are labelled buttons/switches; the call's news is announced
 * by RideRoom (one region for every tab), so the timer and quality read-outs are NOT live regions
 * (they would chatter every second).
 */
export function CallPanel(
  props: UiProps & {
    state: CallUiState;
    controller: CallController | null;
    role: TripRole;
    /** Calls are possible while a driver is assigned and the ride is live. */
    canCall: boolean;
  },
) {
  const { state, controller, role, canCall, colors, minTouchTarget } = props;
  const other = role === 'PASSENGER' ? 'your driver' : 'the passenger';
  const ui = { colors, minTouchTarget };
  const { phase, call } = state;
  const live =
    phase === 'calling' || phase === 'incoming' || phase === 'connecting' || phase === 'connected';

  // Timer from when THIS device saw the call connect (a display value, not a record).
  const connectedAt = useRef<number | null>(null);
  const [, force] = useState(0);
  useEffect(() => {
    if (phase === 'connected') {
      connectedAt.current ??= Date.now();
      force((n) => n + 1);
    } else connectedAt.current = null;
  }, [phase]);
  const now = useNow(1000, phase === 'connected');
  const seconds = connectedAt.current
    ? Math.max(0, Math.floor((now - connectedAt.current) / 1000))
    : 0;

  const RtcView = state.remoteStreamUrl ? getRtcView() : null;
  const isVideo = call?.kind === 'VIDEO';

  return (
    <View style={styles.container}>
      {state.error ? (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {state.error}
        </Text>
      ) : null}

      <Card {...ui} title="Call">
        <Text style={{ color: colors.textPrimary, fontSize: 17 }} accessibilityRole="text">
          {live ? PHASE_TEXT[phase] : PHASE_TEXT[phase === 'ended' ? 'ended' : 'idle']}{' '}
          {live ? `With ${other}.` : ''}
        </Text>

        {phase === 'connected' ? (
          <>
            <Text
              accessible
              accessibilityLabel={`Call time ${formatElapsed(seconds)}`}
              style={{ color: colors.textSecondary }}
            >
              {formatElapsed(seconds)}
            </Text>
            {state.quality ? (
              <Text accessible style={{ color: colors.textPrimary }}>
                {describeQuality(state.quality, isVideo)}
              </Text>
            ) : null}
            {state.media === 'reconnecting' ? (
              <Text style={{ color: colors.error }}>Connection interrupted. Reconnecting.</Text>
            ) : null}
          </>
        ) : null}

        {RtcView && isVideo ? (
          <RtcView
            streamURL={state.remoteStreamUrl}
            style={styles.video}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        ) : null}
        {isVideo && state.videoPausedByApp ? (
          <Text style={{ color: colors.textSecondary }}>Video is paused. Audio continues.</Text>
        ) : null}

        {phase === 'incoming' ? (
          <View style={styles.row}>
            <ActionButton
              {...ui}
              label="Answer"
              tone="primary"
              onPress={() => controller?.answer()}
            />
            <ActionButton
              {...ui}
              label="Decline"
              tone="danger"
              onPress={() => controller?.decline()}
            />
          </View>
        ) : null}

        {phase === 'calling' || phase === 'connecting' ? (
          <ActionButton
            {...ui}
            label={phase === 'calling' ? 'Cancel call' : 'End call'}
            tone="danger"
            onPress={() => controller?.hangUp()}
          />
        ) : null}

        {phase === 'connected' ? (
          <View style={styles.controls}>
            <ActionButton
              {...ui}
              role="switch"
              label={state.muted ? 'Microphone is muted' : 'Mute microphone'}
              selected={state.muted}
              onPress={() => controller?.setMuted(!state.muted)}
            />
            <ActionButton
              {...ui}
              role="switch"
              label={state.speaker ? 'Speaker is on' : 'Use speaker'}
              selected={state.speaker}
              onPress={() => controller?.setSpeaker(!state.speaker)}
            />
            {isVideo ? (
              <ActionButton
                {...ui}
                role="switch"
                label={state.cameraOn ? 'Turn camera off' : 'Turn camera on'}
                selected={state.cameraOn}
                onPress={() => controller?.setCamera(!state.cameraOn)}
              />
            ) : null}
            <ActionButton
              {...ui}
              label="End call"
              tone="danger"
              onPress={() => controller?.hangUp()}
            />
          </View>
        ) : null}

        {!live ? (
          !canCall ? (
            <Text style={{ color: colors.textSecondary }}>
              You can call once a driver is assigned, until the ride ends.
            </Text>
          ) : !state.mediaSupported ? (
            <Text style={{ color: colors.textSecondary }}>
              Calling needs the full Yatri build, which this version does not include. You can still
              use chat.
            </Text>
          ) : (
            <View style={styles.row}>
              <ActionButton
                {...ui}
                label={`Call ${other}`}
                tone="primary"
                onPress={() => controller?.startCall('AUDIO')}
              />
              <ActionButton
                {...ui}
                label={`Video call ${other}`}
                onPress={() => controller?.startCall('VIDEO')}
              />
            </View>
          )
        ) : null}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  row: { gap: 10 },
  controls: { gap: 10 },
  video: { width: '100%', height: 220, borderRadius: 12, backgroundColor: '#000' },
});
