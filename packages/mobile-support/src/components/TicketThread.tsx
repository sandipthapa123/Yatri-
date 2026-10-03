import {
  TICKET_BODY_MAX,
  TICKET_STATUS_LABELS,
  type AttachmentInfo,
  type TicketDetail,
  type TicketMessageInfo,
  formatWhen,
} from '@yatri/types';
import { ApiError, type PickedFile } from '@yatri/mobile-auth';
import { ActionButton, Announcer, Card, Fact, type UiProps } from '@yatri/mobile-ride';
import { useState } from 'react';
import { Linking, StyleSheet, Text, TextInput, View } from 'react-native';

import { useNews, usePolled } from '../hooks';
import { supportApi } from '../supportApi';
import { fileSizeText } from '../supportText';
import { RefundSection } from './RefundSection';

const POLL_MS = 30_000;

/**
 * One request: its status in words, the conversation in order (who said it is WRITTEN, never colour or
 * side alone), files, a reply box, adding a photo or document, asking for a refund (ride problems) and
 * closing it once resolved. The server decides what is possible: `canReply`, `canClose` and
 * `canRequestRefund` are shown, never worked out here. While open it re-checks every half minute and
 * says politely when the status changed or support replied.
 */
export function TicketThread(
  props: UiProps & {
    getAccessToken: () => Promise<string>;
    ticketId: string;
    /** Opens the device's photo/document chooser; null when cancelled. */
    pickFile: () => Promise<PickedFile | null>;
    onBack: () => void;
  },
) {
  const { colors, minTouchTarget } = props;
  const ui = { colors, minTouchTarget };
  const [news, say] = useNews();
  const { data, error, loading, reload } = usePolled<TicketDetail>(
    async () => supportApi.ticket(await props.getAccessToken(), props.ticketId),
    POLL_MS,
    (next, previous) => {
      if (!previous) return;
      const support = (d: TicketDetail) => d.messages.filter((m) => m.from === 'SUPPORT').length;
      if (next.status !== previous.status) say(next.statusText);
      else if (support(next) > support(previous))
        say('Support replied. The new message is at the end.');
    },
  );
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  const act = async (work: (token: string) => Promise<void>, done: string) => {
    setBusy(true);
    setFailure(null);
    try {
      await work(await props.getAccessToken());
      await reload();
      say(done);
    } catch (e) {
      const message = e instanceof ApiError ? e.message : 'That did not work. Please try again.';
      setFailure(message);
      say(message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <View style={styles.container}>
        <Announcer {...ui} polite={news} />
        {loading ? (
          <Text style={{ color: colors.textSecondary }} accessibilityRole="text">
            Loading this request…
          </Text>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={{ color: colors.error }}>
            {error}
          </Text>
        ) : null}
        <ActionButton {...ui} label="Back to my requests" onPress={props.onBack} />
      </View>
    );
  }

  const openFile = (a: AttachmentInfo) =>
    act(async (token) => {
      const { url } = await supportApi.fileUrl(token, a.id);
      await Linking.openURL(url);
    }, `Opening ${a.filename}.`);

  return (
    <View style={styles.container}>
      <Announcer {...ui} polite={news} />
      <Card {...ui} title={`Request ${data.number}: ${data.subject}`}>
        <Fact {...ui} label="Status" value={TICKET_STATUS_LABELS[data.status]} />
        <Text style={{ color: colors.textPrimary }} accessibilityRole="text">
          {data.statusText}
        </Text>
        <Fact {...ui} label="About" value={data.categoryLabel} />
        {data.resolution ? (
          <Fact
            {...ui}
            label={
              data.isDispute && data.outcome
                ? `Decision (${data.outcome === 'UPHELD' ? 'in your favour' : 'not upheld'})`
                : 'What we decided'
            }
            value={data.resolution}
          />
        ) : null}
      </Card>

      <Card {...ui} title="Conversation">
        {data.messages.map((m) => (
          <Message
            key={m.id}
            message={m}
            colors={colors}
            minTouchTarget={minTouchTarget}
            onOpenFile={(a) => void openFile(a)}
            busy={busy}
          />
        ))}
      </Card>

      {data.refund || data.canRequestRefund ? (
        <RefundSection
          {...ui}
          getAccessToken={props.getAccessToken}
          ticket={data}
          onChanged={async (message) => {
            await reload();
            say(message);
          }}
        />
      ) : null}

      {failure ? (
        <Text accessibilityRole="alert" style={{ color: colors.error, fontWeight: '600' }}>
          {`Problem: ${failure}`}
        </Text>
      ) : null}

      {data.canReply ? (
        <Card
          {...ui}
          title={data.status === 'RESOLVED' ? 'Not solved? Reply to reopen it' : 'Reply'}
        >
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Write a message"
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel="Your reply"
            maxLength={TICKET_BODY_MAX}
            multiline
            style={[
              styles.input,
              {
                minHeight: minTouchTarget * 2,
                color: colors.textPrimary,
                borderColor: colors.border,
              },
            ]}
          />
          <ActionButton
            {...ui}
            label="Send reply"
            tone="primary"
            busy={busy}
            disabled={text.trim().length === 0}
            hint={text.trim().length === 0 ? 'Write a message first' : undefined}
            onPress={() =>
              void act(async (token) => {
                await supportApi.reply(token, props.ticketId, text.trim());
                setText('');
              }, 'Your reply was sent.')
            }
          />
          <ActionButton
            {...ui}
            label="Add a photo, screenshot or document"
            hint={`You can add ${data.attachmentsLeft} more ${data.attachmentsLeft === 1 ? 'file' : 'files'}. Photos and PDFs only.`}
            disabled={data.attachmentsLeft === 0 || busy}
            onPress={() =>
              void act(async (token) => {
                const file = await props.pickFile();
                if (file)
                  await supportApi.attach(token, props.ticketId, file, text.trim() || undefined);
                if (file) setText('');
              }, 'Your file was added.')
            }
          />
          {data.attachmentsLeft === 0 ? (
            <Text style={{ color: colors.textSecondary }}>
              This request already has the most files it can hold.
            </Text>
          ) : null}
        </Card>
      ) : null}

      {data.canClose ? (
        confirmClose ? (
          <Card {...ui} title="Close this request?" focusOnMount>
            <Text style={{ color: colors.textPrimary }}>
              Closing means you are happy with how it ended. You can start a new request any time.
            </Text>
            <ActionButton
              {...ui}
              label="Yes, close it"
              tone="primary"
              busy={busy}
              onPress={() =>
                void act(async (token) => {
                  await supportApi.close(token, props.ticketId);
                  setConfirmClose(false);
                }, `Request ${data.number} is closed.`)
              }
            />
            <ActionButton {...ui} label="No, keep it open" onPress={() => setConfirmClose(false)} />
          </Card>
        ) : (
          <ActionButton {...ui} label="Close this request" onPress={() => setConfirmClose(true)} />
        )
      ) : null}

      <ActionButton {...ui} label="Back to my requests" onPress={props.onBack} />
    </View>
  );
}

function Message(props: {
  message: TicketMessageInfo;
  colors: UiProps['colors'];
  minTouchTarget: number;
  busy: boolean;
  onOpenFile: (a: AttachmentInfo) => void;
}) {
  const { message: m, colors } = props;
  const who = m.from === 'YOU' ? 'You' : m.from === 'SUPPORT' ? 'Support' : 'Update';
  return (
    <View style={[styles.message, { borderColor: colors.border }]}>
      {/* The words are one stop for a screen reader; the file buttons stay separate, reachable controls. */}
      <View accessible accessibilityLabel={`${who}, ${formatWhen(m.createdAt)}. ${m.body}`}>
        <Text
          style={{ color: colors.textSecondary, fontSize: 13 }}
        >{`${who} · ${formatWhen(m.createdAt)}`}</Text>
        <Text style={{ color: colors.textPrimary, fontSize: 16 }}>{m.body}</Text>
      </View>
      {m.attachments.map((a) => (
        <ActionButton
          key={a.id}
          colors={colors}
          minTouchTarget={props.minTouchTarget}
          label={`Open ${a.filename} (${fileSizeText(a.sizeBytes)})`}
          disabled={props.busy}
          onPress={() => props.onOpenFile(a)}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  message: { borderLeftWidth: 3, paddingLeft: 10, paddingVertical: 4, gap: 2 },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 16,
  },
});
