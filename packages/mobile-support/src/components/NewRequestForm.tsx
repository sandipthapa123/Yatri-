import { Problem } from '@yatri/mobile-ui';
import {
  TICKET_BODY_MAX,
  TICKET_SUBJECT_MAX,
  type SupportCategory,
  type TicketInfo,
} from '@yatri/types';
import { ApiError } from '@yatri/mobile-auth';
import { ActionButton, Announcer, Card, type UiProps } from '@yatri/mobile-ride';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { useNews, usePolled } from '../hooks';
import { supportApi } from '../supportApi';
import { checkNewTicket, offeredCategories, type FieldErrors } from '../supportText';

/**
 * Ask for help. The categories come from the server (an administrator edits them), and for a problem
 * with a ride the ride is named by the screen that opened this, never typed. Problems are shown beside
 * the field they belong to AND announced once, so nothing depends on seeing a red box.
 */
export function NewRequestForm(
  props: UiProps & {
    getAccessToken: () => Promise<string>;
    /** Set when this is about a ride. */
    tripId?: string | null;
    onCreated: (ticket: TicketInfo) => void;
    onCancel: () => void;
    emergencyNumber?: string;
  },
) {
  const { colors, minTouchTarget } = props;
  const ui = { colors, minTouchTarget };
  const tripId = props.tripId ?? null;
  const [news, say] = useNews();
  const cats = usePolled<SupportCategory[]>(
    async () => supportApi.categories(await props.getAccessToken()),
    null,
  );
  const [code, setCode] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const offered = offeredCategories(cats.data ?? [], tripId);
  const chosen = offered.find((c) => c.code === code) ?? null;

  const send = async () => {
    const found = checkNewTicket({ categoryCode: code, subject, body, tripId }, chosen);
    setErrors(found);
    const first = Object.values(found)[0];
    if (first) {
      say(`Please fix this before sending: ${first}`);
      return;
    }
    setSending(true);
    setFailure(null);
    try {
      const ticket = await supportApi.create(await props.getAccessToken(), {
        categoryCode: code as string,
        subject: subject.trim(),
        body: body.trim(),
        ...(tripId ? { tripId } : {}),
      });
      say(`Your request ${ticket.number} was sent.`);
      props.onCreated(ticket);
    } catch (e) {
      const text = e instanceof ApiError ? e.message : 'That did not send. Please try again.';
      setFailure(text);
      say(text);
    } finally {
      setSending(false);
    }
  };

  const showsSafety = chosen?.code === 'RIDE_SAFETY';
  return (
    <Card {...ui} title={tripId ? 'Report a problem with this ride' : 'Ask for help'} focusOnMount>
      <Announcer {...ui} polite={news} />
      {tripId ? (
        <Text style={{ color: colors.textSecondary }}>
          This is about the ride you chose. Our team will look at that ride and get back to you
          here.
        </Text>
      ) : null}
      {cats.loading ? <Text style={{ color: colors.textSecondary }}>Loading the list…</Text> : null}
      {cats.error ? (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {cats.error}
        </Text>
      ) : null}
      <Text accessibilityRole="header" style={[styles.label, { color: colors.textPrimary }]}>
        What is it about?
      </Text>
      <View accessibilityRole="radiogroup" style={styles.group}>
        {offered.map((c) => (
          <ActionButton
            key={c.code}
            {...ui}
            role="radio"
            selected={code === c.code}
            label={c.label}
            hint={c.help}
            onPress={() => setCode(c.code)}
          />
        ))}
      </View>
      {chosen ? <Text style={{ color: colors.textSecondary }}>{chosen.help}</Text> : null}
      {showsSafety ? (
        <Text accessibilityRole="alert" style={{ color: colors.textPrimary, fontWeight: '700' }}>
          {`If you are in danger now, use Emergency SOS or call ${props.emergencyNumber ?? '100'} first. This request is read afterwards.`}
        </Text>
      ) : null}
      {errors.category ? <Problem text={errors.category} color={colors.error} /> : null}
      {errors.ride ? <Problem text={errors.ride} color={colors.error} /> : null}

      <Text style={[styles.label, { color: colors.textPrimary }]}>Title</Text>
      <TextInput
        value={subject}
        onChangeText={setSubject}
        placeholder="A few words"
        placeholderTextColor={colors.textSecondary}
        accessibilityLabel="Title of your request"
        maxLength={TICKET_SUBJECT_MAX}
        style={[
          styles.input,
          { minHeight: minTouchTarget, color: colors.textPrimary, borderColor: colors.border },
        ]}
      />
      {errors.subject ? <Problem text={errors.subject} color={colors.error} /> : null}

      <Text style={[styles.label, { color: colors.textPrimary }]}>What happened?</Text>
      <TextInput
        value={body}
        onChangeText={setBody}
        placeholder="Tell us what happened"
        placeholderTextColor={colors.textSecondary}
        accessibilityLabel="Describe what happened"
        maxLength={TICKET_BODY_MAX}
        multiline
        style={[
          styles.input,
          { minHeight: minTouchTarget * 3, color: colors.textPrimary, borderColor: colors.border },
        ]}
      />
      {errors.body ? <Problem text={errors.body} color={colors.error} /> : null}
      <Text style={{ color: colors.textSecondary }}>
        You can add photos or screenshots after you send this, from the conversation.
      </Text>

      {failure ? <Problem text={failure} color={colors.error} /> : null}
      <ActionButton
        {...ui}
        label="Send request"
        tone="primary"
        busy={sending}
        onPress={() => void send()}
      />
      <ActionButton {...ui} label="Cancel" onPress={props.onCancel} />
    </Card>
  );
}

/** A problem with a field, in words (the colour is only a second cue). */
const styles = StyleSheet.create({
  group: { gap: 8 },
  label: { fontSize: 16, fontWeight: '700' },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 16,
  },
});
