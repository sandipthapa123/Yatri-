import {
  REFUND_STATUS_LABELS,
  formatNpr,
  type RefundQuote,
  type RefundReason,
  type TicketDetail,
} from '@yatri/types';
import { ApiError } from '@yatri/mobile-auth';
import { ActionButton, Card, Fact, type UiProps } from '@yatri/mobile-ride';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { supportApi } from '../supportApi';
import { availableRefundReasons, checkPartialAmount, refundReasonLabel } from '../supportText';

/**
 * The refund on a ride problem, with the money stated plainly. What the person paid, what has been paid
 * back and what they can still ask for all come from the server's own figures (the same ones it checks a
 * request against); the amount of a whole-fare or waiting-charge refund is never typed, only a partial one.
 * Yatri holds no money, so the words say who pays it back and never promise a payout the server has not made.
 */
export function RefundSection(
  props: UiProps & {
    getAccessToken: () => Promise<string>;
    ticket: TicketDetail;
    onChanged: (message: string) => Promise<void>;
  },
) {
  const { colors, minTouchTarget, ticket } = props;
  const ui = { colors, minTouchTarget };
  const [open, setOpen] = useState(false);
  const [quote, setQuote] = useState<RefundQuote | null>(null);
  const [reason, setReason] = useState<RefundReason | null>(null);
  const [amount, setAmount] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setProblem(null);
    try {
      setQuote(await supportApi.refundQuote(await props.getAccessToken(), ticket.id));
      setOpen(true);
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'That did not work. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!quote || !reason) return;
    if (reason === 'PARTIAL') {
      const bad = checkPartialAmount(amount, quote);
      if (bad) {
        setProblem(bad);
        return;
      }
    }
    setBusy(true);
    setProblem(null);
    try {
      const r = await supportApi.requestRefund(await props.getAccessToken(), ticket.id, {
        reason,
        ...(reason === 'PARTIAL' ? { amountNpr: Number(amount) } : {}),
      });
      setOpen(false);
      await props.onChanged(r.statusText);
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'That did not send. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (open && quote) {
    const reasons = availableRefundReasons(quote);
    return (
      <Card {...ui} title="Ask for a refund" focusOnMount>
        <Fact {...ui} label="You paid" value={formatNpr(quote.paidNpr)} />
        <Fact {...ui} label="Already paid back" value={formatNpr(quote.refundedNpr)} />
        <Fact {...ui} label="You can ask for up to" value={formatNpr(quote.remainingNpr)} />
        <Text style={{ color: colors.textSecondary }}>
          Our team checks the ride and the payment before deciding. You will be told the decision
          here.
        </Text>
        <View accessibilityRole="radiogroup" style={styles.group}>
          {reasons.map((r) => (
            <ActionButton
              key={r}
              {...ui}
              role="radio"
              selected={reason === r}
              label={refundReasonLabel(r, quote)}
              onPress={() => setReason(r)}
            />
          ))}
        </View>
        {reason === 'PARTIAL' ? (
          <TextInput
            value={amount}
            onChangeText={setAmount}
            keyboardType="number-pad"
            placeholder="Amount in rupees"
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel="Amount to ask for, in rupees"
            style={[
              styles.input,
              { minHeight: minTouchTarget, color: colors.textPrimary, borderColor: colors.border },
            ]}
          />
        ) : null}
        {problem ? (
          <Text accessibilityRole="alert" style={{ color: colors.error, fontWeight: '600' }}>
            {`Problem: ${problem}`}
          </Text>
        ) : null}
        <ActionButton
          {...ui}
          label="Send refund request"
          tone="primary"
          busy={busy}
          disabled={!reason}
          hint={!reason ? 'Choose what you are asking for first' : undefined}
          onPress={() => void send()}
        />
        <ActionButton {...ui} label="Cancel" onPress={() => setOpen(false)} />
      </Card>
    );
  }

  return (
    <Card {...ui} title="Refund">
      {ticket.refund ? (
        <>
          <Fact {...ui} label="Amount" value={formatNpr(ticket.refund.amountNpr)} />
          <Fact {...ui} label="Status" value={REFUND_STATUS_LABELS[ticket.refund.status]} />
          <Text style={{ color: colors.textPrimary }} accessibilityRole="text">
            {ticket.refund.statusText}
          </Text>
        </>
      ) : null}
      {problem ? (
        <Text accessibilityRole="alert" style={{ color: colors.error, fontWeight: '600' }}>
          {`Problem: ${problem}`}
        </Text>
      ) : null}
      {ticket.canRequestRefund ? (
        <ActionButton {...ui} label="Ask for a refund" busy={busy} onPress={() => void start()} />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 16 },
});
