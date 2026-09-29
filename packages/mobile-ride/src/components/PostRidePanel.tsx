import {
  RATING_COMMENT_MAX,
  RATING_MAX,
  RATING_MIN,
  DISPUTE_REASON_MAX,
  formatDistance,
  formatDuration,
  formatNpr,
  type TripRole,
  type TripSummary,
} from '@yatri/types';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { outcomeText, paymentText, type RideAction } from '../rideActions';
import { ActionButton, Card, Fact, type UiProps } from './RideUi';

/**
 * After the ride: what happened, what it cost (all figures come from the server), where the payment
 * stands, and the follow-ups the ride allows — confirm cash (driver), rate, report a problem.
 * Nothing is computed here; a fare is shown, never derived.
 */
export function PostRidePanel(
  props: UiProps & {
    trip: TripSummary;
    role: TripRole;
    actions: RideAction[];
    busy: boolean;
    error: string | null;
    onAction: (id: RideAction['id']) => void;
    onRate: (stars: number, comment: string) => Promise<boolean>;
    onDispute: (reason: string) => Promise<boolean>;
    /** Which follow-up form is open. */
    form: 'rate' | 'dispute' | null;
    onForm: (f: 'rate' | 'dispute' | null) => void;
  },
) {
  const { trip, role, colors, minTouchTarget, actions, busy, form } = props;
  const ui = { colors, minTouchTarget };
  const fare = trip.fare;
  const amount = fare?.finalNpr ?? fare?.estimateNpr ?? null;

  return (
    <View style={styles.container}>
      <Card {...ui} title="Ride summary">
        <Text style={{ color: colors.textPrimary, fontSize: 17 }} accessibilityRole="text">
          {outcomeText(trip, role)}
        </Text>
        <Fact {...ui} label="From" value={trip.pickup.name} />
        <Fact {...ui} label="To" value={trip.destination.name} />
        {fare ? (
          <>
            {fare.actualDistanceMeters !== null ? (
              <Fact
                {...ui}
                label="Distance travelled"
                value={formatDistance(fare.actualDistanceMeters)}
              />
            ) : (
              <Fact
                {...ui}
                label="Estimated distance"
                value={formatDistance(fare.distanceMeters)}
              />
            )}
            {fare.actualDurationSeconds !== null ? (
              <Fact {...ui} label="Ride time" value={formatDuration(fare.actualDurationSeconds)} />
            ) : null}
            <Fact {...ui} label="Estimated fare" value={formatNpr(fare.estimateNpr)} />
            {fare.waitingChargeNpr > 0 ? (
              <Fact {...ui} label="Waiting charge" value={formatNpr(fare.waitingChargeNpr)} />
            ) : null}
            {fare.finalNpr !== null ? (
              <Fact {...ui} label="Final fare" value={formatNpr(fare.finalNpr)} />
            ) : null}
          </>
        ) : null}
        {trip.status === 'COMPLETED' ? (
          <Text accessibilityRole="text" style={{ color: colors.textPrimary }}>
            {paymentText(role, trip.paymentStatus, amount)}
          </Text>
        ) : null}
      </Card>

      {props.error ? (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {props.error}
        </Text>
      ) : null}

      {form === 'rate' ? (
        <RateForm {...ui} role={role} onSubmit={props.onRate} onCancel={() => props.onForm(null)} />
      ) : form === 'dispute' ? (
        <DisputeForm {...ui} onSubmit={props.onDispute} onCancel={() => props.onForm(null)} />
      ) : (
        actions.map((a) => (
          <ActionButton
            key={a.id}
            {...ui}
            label={a.label}
            tone={a.tone}
            busy={busy && a.id === 'confirmPayment'}
            disabled={busy}
            onPress={() => props.onAction(a.id)}
          />
        ))
      )}
      {trip.rated ? (
        <Text accessibilityRole="text" style={{ color: colors.textSecondary }}>
          Thank you. Your rating was sent.
        </Text>
      ) : null}
    </View>
  );
}

function RateForm(
  props: UiProps & {
    role: TripRole;
    onSubmit: (stars: number, comment: string) => Promise<boolean>;
    onCancel: () => void;
  },
) {
  const { colors, minTouchTarget, role } = props;
  const ui = { colors, minTouchTarget };
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const who = role === 'PASSENGER' ? 'your driver' : 'the passenger';
  const values = Array.from({ length: RATING_MAX - RATING_MIN + 1 }, (_, i) => RATING_MIN + i);
  return (
    <Card {...ui} title={`Rate ${who}`}>
      <View accessibilityRole="radiogroup" style={styles.stars}>
        {values.map((v) => (
          <ActionButton
            key={v}
            {...ui}
            role="radio"
            selected={stars === v}
            label={`${v} ${v === 1 ? 'star' : 'stars'}`}
            accessibilityLabel={`${v} ${v === 1 ? 'star' : 'stars'} out of ${RATING_MAX}`}
            onPress={() => setStars(v)}
          />
        ))}
      </View>
      <TextInput
        value={comment}
        onChangeText={setComment}
        placeholder="Add a comment (optional)"
        placeholderTextColor={colors.textSecondary}
        accessibilityLabel="Comment, optional"
        maxLength={RATING_COMMENT_MAX}
        multiline
        style={[
          styles.input,
          { minHeight: minTouchTarget, color: colors.textPrimary, borderColor: colors.border },
        ]}
      />
      <ActionButton
        {...ui}
        label="Send rating"
        tone="primary"
        disabled={stars === 0}
        busy={sending}
        hint={stars === 0 ? 'Choose a number of stars first' : undefined}
        onPress={() => {
          setSending(true);
          void props.onSubmit(stars, comment).finally(() => setSending(false));
        }}
      />
      <ActionButton {...ui} label="Not now" onPress={props.onCancel} />
    </Card>
  );
}

function DisputeForm(
  props: UiProps & { onSubmit: (reason: string) => Promise<boolean>; onCancel: () => void },
) {
  const { colors, minTouchTarget } = props;
  const ui = { colors, minTouchTarget };
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const ready = reason.trim().length >= 5;
  return (
    <Card {...ui} title="Report a problem">
      <Text style={{ color: colors.textSecondary }}>
        Tell us what went wrong. Our team will look at this ride and get back to you.
      </Text>
      <TextInput
        value={reason}
        onChangeText={setReason}
        placeholder="What happened?"
        placeholderTextColor={colors.textSecondary}
        accessibilityLabel="What happened?"
        maxLength={DISPUTE_REASON_MAX}
        multiline
        style={[
          styles.input,
          { minHeight: minTouchTarget * 2, color: colors.textPrimary, borderColor: colors.border },
        ]}
      />
      <ActionButton
        {...ui}
        label="Send report"
        tone="primary"
        disabled={!ready}
        busy={sending}
        hint={!ready ? 'Write at least five characters' : undefined}
        onPress={() => {
          setSending(true);
          void props.onSubmit(reason.trim()).finally(() => setSending(false));
        }}
      />
      <ActionButton {...ui} label="Cancel" onPress={props.onCancel} />
    </Card>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  stars: { gap: 8 },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 16,
  },
});
