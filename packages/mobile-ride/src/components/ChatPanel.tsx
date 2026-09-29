import { CHAT_MAX_LENGTH, type TripRole } from '@yatri/types';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { ChatController, ChatEntry, ChatState, MessageStatus } from '../chatController';
import { formatClockTime } from '../rideText';
import { ActionButton, type UiProps } from './RideUi';

const STATUS_WORDS: Record<MessageStatus, string> = {
  sending: 'Sending',
  failed: 'Not sent',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
};

/** The spoken form of one entry: who, when, delivery state, then the words themselves. */
export function entryLabel(e: ChatEntry, role: TripRole): string {
  const time = formatClockTime(e.at);
  if (e.kind === 'system') return `Ride update${time ? `, ${time}` : ''}: ${e.text}`;
  const other = role === 'PASSENGER' ? 'Your driver' : 'The passenger';
  return e.mine
    ? `You${time ? `, ${time}` : ''}, ${STATUS_WORDS[e.status].toLowerCase()}: ${e.body}`
    : `${other}${time ? `, ${time}` : ''}: ${e.body}`;
}

/**
 * The trip conversation. Every line is one accessible element carrying who said it, when, and (for
 * your own) whether it was delivered or read — in words, not ticks or colours. New messages from the
 * other person are announced once, by RideRoom (which owns the announcement regions so they work
 * from any tab), not by re-reading the list.
 */
export function ChatPanel(
  props: UiProps & { state: ChatState; controller: ChatController | null; role: TripRole },
) {
  const { state, controller, role, colors, minTouchTarget } = props;
  const [draft, setDraft] = useState('');
  const scroller = useRef<ScrollView>(null);

  // Being on this panel means the other person's messages are being read.
  useEffect(() => {
    controller?.setOpen(true);
    return () => controller?.setOpen(false);
  }, [controller]);

  const count = state.entries.length;
  useEffect(() => {
    scroller.current?.scrollToEnd({ animated: false });
  }, [count]);

  const send = () => {
    const text = draft;
    if (!text.trim()) return;
    setDraft('');
    void controller?.send(text).then((ok) => {
      if (!ok) setDraft((d) => d || text); // give the words back if it could not even be queued
    });
  };

  return (
    <View style={styles.container}>
      {state.error ? (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {state.error}
        </Text>
      ) : null}

      <ScrollView
        ref={scroller}
        style={[styles.list, { borderColor: colors.border, backgroundColor: colors.surface }]}
        contentContainerStyle={{ padding: 10, gap: 8 }}
        accessibilityRole="list"
        accessibilityLabel="Conversation"
      >
        {!state.loaded ? (
          <Text style={{ color: colors.textSecondary }}>Loading the conversation.</Text>
        ) : count === 0 ? (
          <Text style={{ color: colors.textSecondary }}>
            No messages yet.
            {state.canSend ? ' Say hello.' : ''}
          </Text>
        ) : (
          state.entries.map((e) =>
            e.kind === 'system' ? (
              <Text
                key={e.key}
                accessible
                accessibilityLabel={entryLabel(e, role)}
                style={[styles.system, { color: colors.textSecondary }]}
              >
                {e.text}
              </Text>
            ) : (
              <View
                key={e.key}
                accessible
                accessibilityLabel={entryLabel(e, role)}
                style={[
                  styles.bubble,
                  e.mine ? styles.mine : styles.theirs,
                  {
                    backgroundColor: e.mine ? colors.primary : colors.background,
                    borderColor: e.mine ? colors.primary : colors.border,
                  },
                ]}
              >
                <Text
                  style={{ color: e.mine ? colors.textInverse : colors.textPrimary, fontSize: 16 }}
                >
                  {e.body}
                </Text>
                <Text
                  style={{
                    color: e.mine ? colors.textInverse : colors.textSecondary,
                    fontSize: 12,
                  }}
                >
                  {formatClockTime(e.at)}
                  {e.mine ? ` · ${STATUS_WORDS[e.status]}` : ''}
                </Text>
                {e.mine && e.status === 'failed' ? (
                  <ActionButton
                    colors={colors}
                    minTouchTarget={minTouchTarget}
                    label="Try sending again"
                    onPress={() => void controller?.retry(e.clientMessageId)}
                  />
                ) : null}
              </View>
            ),
          )
        )}
      </ScrollView>

      {state.canSend ? (
        <View style={styles.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Type a message"
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel="Message"
            accessibilityHint="Type a message to send"
            maxLength={CHAT_MAX_LENGTH}
            multiline
            style={[
              styles.input,
              {
                minHeight: minTouchTarget,
                color: colors.textPrimary,
                borderColor: colors.border,
                backgroundColor: colors.background,
              },
            ]}
          />
          <ActionButton
            colors={colors}
            minTouchTarget={minTouchTarget}
            label="Send"
            tone="primary"
            disabled={!draft.trim()}
            onPress={send}
          />
        </View>
      ) : state.loaded ? (
        <Text accessibilityRole="text" style={{ color: colors.textSecondary }}>
          {state.closedReason ?? 'Messages are closed.'}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 10 },
  list: { borderWidth: 1, borderRadius: 14, minHeight: 220, maxHeight: 420 },
  bubble: { borderWidth: 1, borderRadius: 14, padding: 10, gap: 2, maxWidth: '85%' },
  mine: { alignSelf: 'flex-end' },
  theirs: { alignSelf: 'flex-start' },
  system: { textAlign: 'center', fontSize: 13, fontStyle: 'italic' },
  composer: { gap: 8 },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 16,
  },
});
