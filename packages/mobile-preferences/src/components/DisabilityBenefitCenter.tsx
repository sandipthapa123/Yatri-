import { formatWhen } from '@yatri/types';
import { ApiError, useAuth } from '@yatri/mobile-auth';
import { ActionButton, Announcer, Card, type UiProps } from '@yatri/mobile-ride';
import { pickEvidenceFile, useNews, usePolled } from '@yatri/mobile-support';
import type { DisabilityMethod, DisabilityVerificationView } from '@yatri/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { disabilityApi } from '../disabilityApi';
import {
  CONSENT_SENTENCE,
  OPTIONAL_TEXT,
  cardLines,
  driverSharingLine,
  expiryLine,
  nextStepLine,
  submitHint,
} from '../disabilityText';

const problem = (e: unknown) =>
  e instanceof ApiError ? e.message : 'That did not work. Please check your connection and try again.';

/**
 * Disability benefit verification, for a rider, on one screen. It is voluntary and says so first. The server decides every
 * status; this screen shows the sentence the server gave, announces it when it changes, and sends intentions (opt in, save
 * details, add a document, send, withdraw). It never sets a status. Every part is a heading with plain sentences, every
 * field has a label, and nothing depends on colour. The card number is typed once, sent, and not kept on the phone.
 */
export function DisabilityBenefitCenter(props: UiProps & { onExit: () => void }) {
  const { colors, minTouchTarget } = props;
  const ui = { colors, minTouchTarget };
  const { getAccessToken } = useAuth();
  const [news, say] = useNews();
  const state = usePolled(async () => disabilityApi.get(await getAccessToken()), 30_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [number, setNumber] = useState('');
  const [authority, setAuthority] = useState('');
  const [issue, setIssue] = useState('');
  const [expiry, setExpiry] = useState('');
  const [method, setMethod] = useState<DisabilityMethod>('MANUAL');
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);

  const v = state.data;
  const last = useRef<string | null>(null);
  // Announce a change of status (also when staff decide while the screen is open).
  useEffect(() => {
    if (!v) return;
    if (last.current !== null && last.current !== v.status) say(v.statusText);
    last.current = v.status;
  }, [v, say]);

  const run = useCallback(
    async (label: string, work: (token: string) => Promise<DisabilityVerificationView>, done?: (next: DisabilityVerificationView) => void) => {
      setBusy(label);
      setError(null);
      try {
        const next = await work(await getAccessToken());
        say(next.statusText);
        last.current = next.status;
        done?.(next);
        void state.reload();
      } catch (e) {
        setError(problem(e));
        say(problem(e));
      } finally {
        setBusy(null);
      }
    },
    [getAccessToken, say, state],
  );

  const saveDetails = () =>
    run('save', (t) =>
      disabilityApi.saveDetails(t, {
        ...(number.trim() ? { cardNumber: number.trim() } : {}),
        ...(authority.trim() ? { issuingAuthority: authority.trim() } : {}),
        ...(issue.trim() ? { issueDate: issue.trim() } : {}),
        ...(expiry.trim() ? { expiryDate: expiry.trim() } : {}),
        method,
      }),
    );

  const pickDocument = async () => {
    const file = await pickEvidenceFile();
    if (!file) return;
    await run('document', (t) => disabilityApi.uploadDocument(t, file));
  };

  const send = () =>
    run('submit', (t) => disabilityApi.submit(t, method === 'OFFICIAL_API' && number.trim() ? number.trim() : undefined), () => setNumber(''));

  if (state.error && !v) {
    return (
      <Text accessibilityRole="alert" style={{ color: colors.error }}>{`Problem: ${state.error}`}</Text>
    );
  }
  if (!v) return <Text style={{ color: colors.textSecondary }}>Loading…</Text>;

  const editable = v.canEdit;
  const hint = submitHint(v);
  const expiryText = expiryLine(v);

  return (
    <View style={styles.container}>
      <Announcer {...ui} polite={news} />

      <Card {...ui} title="Disability benefit">
        <Text accessibilityRole="text" style={{ color: colors.textPrimary, fontSize: 18, fontWeight: '700' }}>
          {v.statusText}
        </Text>
        <Text style={{ color: colors.textPrimary }}>{`Status: ${v.statusLabel}. ${nextStepLine(v)}`}</Text>
        {v.message ? <Text style={{ color: colors.textPrimary }}>{`Message from the reviewer: ${v.message}`}</Text> : null}
        {expiryText ? <Text style={{ color: colors.textPrimary }}>{expiryText}</Text> : null}
        <Text style={{ color: colors.textSecondary }}>{v.benefit.text}</Text>
        {!v.enabled ? (
          <Text accessibilityRole="alert" style={{ color: colors.error }}>
            Disability benefit verification is not available right now.
          </Text>
        ) : null}
        <Text style={{ color: colors.textSecondary }}>{OPTIONAL_TEXT}</Text>
      </Card>

      {v.enabled && v.canOptIn ? (
        <Card {...ui} title="Consent">
          <Text style={{ color: colors.textPrimary }}>
            To check your disability identity card we need your card number, who issued it, its dates and a photo or PDF of
            it. We keep only the last four characters of the number.
          </Text>
          <ActionButton
            {...ui}
            label={agreed ? 'I agree (selected). Select to undo.' : CONSENT_SENTENCE(v.consent.title)}
            tone={agreed ? 'primary' : 'neutral'}
            onPress={() => setAgreed((a) => !a)}
          />
          {v.methods.map((m) => (
            <ActionButton
              key={m.method}
              {...ui}
              label={`${method === m.method ? 'Selected: ' : ''}${m.label}${m.available ? '' : ` (not available: ${m.unavailableReason ?? ''})`}`}
              hint={m.help}
              tone={method === m.method ? 'primary' : 'neutral'}
              disabled={!m.available}
              onPress={() => setMethod(m.method)}
            />
          ))}
          <ActionButton
            {...ui}
            label="Start my application"
            busy={busy === 'optin'}
            disabled={!agreed}
            tone="primary"
            onPress={() => void run('optin', (t) => disabilityApi.optIn(t, v.consent.version, method))}
          />
          {!agreed ? <Text style={{ color: colors.textSecondary }}>Select &quot;I agree&quot; to continue.</Text> : null}
        </Card>
      ) : null}

      {v.consent.given ? (
        <Card {...ui} title="Your card">
          {cardLines(v).map((l) => (
            <Text key={l} accessibilityRole="text" style={{ color: colors.textPrimary }}>
              {l}
            </Text>
          ))}
          {editable ? (
            <>
              <Text style={{ color: colors.textPrimary, fontWeight: '600' }}>Card number</Text>
              <TextInput
                accessibilityLabel="Disability identity card number"
                value={number}
                onChangeText={setNumber}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={40}
                style={[styles.input, { color: colors.textPrimary, borderColor: colors.border }]}
              />
              <Text style={{ color: colors.textPrimary, fontWeight: '600' }}>Who issued the card</Text>
              <TextInput
                accessibilityLabel="Who issued the card"
                value={authority}
                onChangeText={setAuthority}
                maxLength={120}
                style={[styles.input, { color: colors.textPrimary, borderColor: colors.border }]}
              />
              <Text style={{ color: colors.textPrimary, fontWeight: '600' }}>Issue date, as year-month-day</Text>
              <TextInput
                accessibilityLabel="Issue date, year, month, day"
                value={issue}
                onChangeText={setIssue}
                placeholder="2022-04-30"
                keyboardType="numbers-and-punctuation"
                maxLength={10}
                style={[styles.input, { color: colors.textPrimary, borderColor: colors.border }]}
              />
              <Text style={{ color: colors.textPrimary, fontWeight: '600' }}>Expiry date, as year-month-day</Text>
              <TextInput
                accessibilityLabel="Expiry date, year, month, day"
                value={expiry}
                onChangeText={setExpiry}
                placeholder="2030-04-30"
                keyboardType="numbers-and-punctuation"
                maxLength={10}
                style={[styles.input, { color: colors.textPrimary, borderColor: colors.border }]}
              />
              <ActionButton {...ui} label="Save card details" busy={busy === 'save'} onPress={() => void saveDetails()} />
              <ActionButton
                {...ui}
                label={v.card.hasDocument ? 'Replace the photo or PDF of my card' : 'Add a photo or PDF of my card'}
                busy={busy === 'document'}
                onPress={() => void pickDocument()}
              />
              {hint ? <Text style={{ color: colors.textPrimary }}>{hint}</Text> : null}
              <ActionButton
                {...ui}
                label="Send my application"
                tone="primary"
                busy={busy === 'submit'}
                disabled={!v.canSubmit}
                onPress={() => void send()}
              />
            </>
          ) : null}
        </Card>
      ) : null}

      {v.consent.given || v.status !== 'NOT_SUBMITTED' ? (
        <Card {...ui} title="Who can see this">
          <Text style={{ color: colors.textPrimary }}>{driverSharingLine(v)}</Text>
        </Card>
      ) : null}

      {v.history.length > 0 ? (
        <Card {...ui} title="History">
          {v.history.map((h) => (
            <Text key={`${h.at}-${h.toStatus}`} style={{ color: colors.textPrimary }}>
              {`${formatWhen(h.at, { style: 'date' })}: ${h.text}`}
            </Text>
          ))}
        </Card>
      ) : null}

      {error ? (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error}
        </Text>
      ) : null}

      {v.canWithdraw ? (
        <Card {...ui} title="Stop and erase my details">
          <Text style={{ color: colors.textPrimary }}>
            This withdraws your consent, ends any benefit, and erases your card details and document. You can apply again later.
          </Text>
          {confirmWithdraw ? (
            <>
              <Text accessibilityRole="alert" style={{ color: colors.textPrimary, fontWeight: '700' }}>
                Are you sure? This cannot be undone.
              </Text>
              <ActionButton
                {...ui}
                label="Yes, withdraw my consent and erase my details"
                tone="danger"
                busy={busy === 'withdraw'}
                onPress={() => void run('withdraw', (t) => disabilityApi.withdraw(t), () => setConfirmWithdraw(false))}
              />
              <ActionButton {...ui} label="No, keep my application" onPress={() => setConfirmWithdraw(false)} />
            </>
          ) : (
            <ActionButton {...ui} label="Withdraw my consent and erase my details" tone="danger" onPress={() => setConfirmWithdraw(true)} />
          )}
        </Card>
      ) : null}

      <ActionButton {...ui} label="Back" onPress={props.onExit} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 14 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, minHeight: 48 },
});
