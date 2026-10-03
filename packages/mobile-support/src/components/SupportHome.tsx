import { TICKET_STATUS_LABELS, type TicketInfo, formatWhen } from '@yatri/types';
import { ActionButton, Announcer, Card, type UiProps } from '@yatri/mobile-ride';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useNews, usePolled } from '../hooks';
import { supportApi } from '../supportApi';
import { statusNews } from '../supportText';

const POLL_MS = 60_000;

/**
 * The person's support requests: newest activity first, each with its status WRITTEN OUT (never colour
 * alone) and when it last changed. While the screen is open it re-checks every minute and, when a request
 * has changed, says so politely (the same sentence the notification carried).
 */
export function SupportHome(
  props: UiProps & {
    getAccessToken: () => Promise<string>;
    onNew: () => void;
    onOpen: (ticketId: string) => void;
    onPrivacy: () => void;
  },
) {
  const { colors, minTouchTarget } = props;
  const ui = { colors, minTouchTarget };
  const [news, say] = useNews();
  const { data, error, loading, reload } = usePolled<TicketInfo[]>(
    async () => supportApi.tickets(await props.getAccessToken()),
    POLL_MS,
    (next, previous) => {
      if (previous) say(statusNews(previous, next));
    },
  );

  return (
    <View style={styles.container}>
      <Announcer {...ui} polite={news} />
      <ActionButton {...ui} label="Ask for help" tone="primary" onPress={props.onNew} />
      <ActionButton {...ui} label="Privacy and my data" onPress={props.onPrivacy} />
      <Card {...ui} title="Your requests">
        {loading ? (
          <Text style={{ color: colors.textSecondary }} accessibilityRole="text">
            Loading your requests…
          </Text>
        ) : null}
        {error ? (
          <>
            <Text accessibilityRole="alert" style={{ color: colors.error }}>
              {error}
            </Text>
            <ActionButton {...ui} label="Try again" onPress={() => void reload()} />
          </>
        ) : null}
        {data && data.length === 0 ? (
          <Text style={{ color: colors.textSecondary }} accessibilityRole="text">
            You have no requests. Use Ask for help when you need us.
          </Text>
        ) : null}
        {data?.map((t) => (
          <Pressable
            key={t.id}
            accessibilityRole="button"
            accessibilityLabel={`Request ${t.number}, ${t.subject}. ${TICKET_STATUS_LABELS[t.status]}. Last change ${formatWhen(t.updatedAt)}.`}
            accessibilityHint="Opens the conversation"
            onPress={() => props.onOpen(t.id)}
            style={[styles.row, { borderColor: colors.border, minHeight: minTouchTarget }]}
          >
            <Text style={{ color: colors.textPrimary, fontWeight: '600', fontSize: 16 }}>
              {`#${t.number}  ${t.subject}`}
            </Text>
            <Text style={{ color: colors.textPrimary }}>
              {`${t.categoryLabel} · ${TICKET_STATUS_LABELS[t.status]}`}
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
              {`Last change ${formatWhen(t.updatedAt)}`}
            </Text>
          </Pressable>
        ))}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  row: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 2 },
});
