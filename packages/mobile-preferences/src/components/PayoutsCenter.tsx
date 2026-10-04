import { ApiError, useAuth } from '@yatri/mobile-auth';
import { ActionButton, Announcer, Card, type UiProps } from '@yatri/mobile-ride';
import { useNews, usePolled } from '@yatri/mobile-support';
import {
  PAYOUT_ACCOUNT_KINDS,
  PAYOUT_ACCOUNT_LABELS,
  maskedAccount,
  type PayoutAccountKind,
  formatWhen,
} from '@yatri/types';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { payoutsApi } from '../payoutsApi';

const problem = (e: unknown) =>
  e instanceof ApiError
    ? e.message
    : 'That did not work. Please check your connection and try again.';

/**
 * What a driver is owed for rides paid online, the payouts made, and where payouts go. Every sentence and figure comes from the
 * server; each part is a heading with plain sentences (nothing depends on colour), a saved account is announced, a problem is
 * read as "Problem: …", and the account number is typed once, sent, and cleared. Cash rides are said to be the driver's own.
 */
export function PayoutsCenter(props: UiProps & { onExit: () => void }) {
  const { colors, minTouchTarget } = props;
  const ui = { colors, minTouchTarget };
  const { getAccessToken } = useAuth();
  const [news, say] = useNews();
  const state = usePolled(async () => payoutsApi.summary(await getAccessToken()), 60_000);
  const [kind, setKind] = useState<PayoutAccountKind>('BANK');
  const [holder, setHolder] = useState('');
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await payoutsApi.saveAccount(await getAccessToken(), {
        kind,
        holderName: holder.trim(),
        accountNumber: number.trim(),
      });
      setNumber('');
      say('Saved. Payouts will go to this account.');
      void state.reload();
    } catch (e) {
      setError(problem(e));
      say(problem(e));
    } finally {
      setBusy(false);
    }
  }, [getAccessToken, holder, kind, number, say, state]);

  const s = state.data;
  if (state.error && !s) {
    return (
      <Text
        accessibilityRole="alert"
        style={{ color: colors.error }}
      >{`Problem: ${state.error}`}</Text>
    );
  }
  if (!s) return <Text style={{ color: colors.textSecondary }}>Loading…</Text>;

  return (
    <View style={styles.container}>
      <Announcer {...ui} polite={news} />

      <Card {...ui} title="Online earnings">
        {s.sentences.map((line) => (
          <Text key={line} accessibilityRole="text" style={{ color: colors.textPrimary }}>
            {line}
          </Text>
        ))}
      </Card>

      <Card {...ui} title="Where payouts go">
        {s.account ? (
          <Text accessibilityRole="text" style={{ color: colors.textPrimary }}>
            {`${PAYOUT_ACCOUNT_LABELS[s.account.kind].label}, ${s.account.holderName}, ${maskedAccount(s.account.last4)}.`}
          </Text>
        ) : (
          <Text style={{ color: colors.textPrimary }}>No account saved yet.</Text>
        )}
        <Text style={{ color: colors.textPrimary, fontWeight: '600' }}>
          Where should payouts go?
        </Text>
        {PAYOUT_ACCOUNT_KINDS.map((k) => (
          <ActionButton
            key={k}
            {...ui}
            label={`${kind === k ? 'Selected: ' : ''}${PAYOUT_ACCOUNT_LABELS[k].label}`}
            tone={kind === k ? 'primary' : 'neutral'}
            onPress={() => setKind(k)}
          />
        ))}
        <Text style={{ color: colors.textPrimary, fontWeight: '600' }}>Name on the account</Text>
        <TextInput
          accessibilityLabel="Name on the account"
          value={holder}
          onChangeText={setHolder}
          maxLength={80}
          style={[styles.input, { color: colors.textPrimary, borderColor: colors.border }]}
        />
        <Text style={{ color: colors.textPrimary, fontWeight: '600' }}>
          {PAYOUT_ACCOUNT_LABELS[kind].numberLabel}
        </Text>
        <TextInput
          accessibilityLabel={PAYOUT_ACCOUNT_LABELS[kind].numberLabel}
          value={number}
          onChangeText={setNumber}
          keyboardType="number-pad"
          autoCorrect={false}
          maxLength={40}
          style={[styles.input, { color: colors.textPrimary, borderColor: colors.border }]}
        />
        <ActionButton
          {...ui}
          label="Save this account"
          busy={busy}
          tone="primary"
          disabled={!holder.trim() || !number.trim()}
          onPress={() => void save()}
        />
        {error ? (
          <Text accessibilityRole="alert" style={{ color: colors.error }}>
            {`Problem: ${error}`}
          </Text>
        ) : null}
      </Card>

      <Card {...ui} title="Payouts">
        {s.payouts.length === 0 ? (
          <Text style={{ color: colors.textPrimary }}>No payouts yet.</Text>
        ) : (
          s.payouts.map((p) => (
            <Text key={p.id} accessibilityRole="text" style={{ color: colors.textPrimary }}>
              {`${formatWhen(p.createdAt, { style: 'date' })}: ${p.statusText}${p.reference ? ` Reference ${p.reference}.` : ''}`}
            </Text>
          ))
        )}
      </Card>

      <ActionButton {...ui} label="Back" onPress={props.onExit} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 14 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    minHeight: 48,
  },
});
