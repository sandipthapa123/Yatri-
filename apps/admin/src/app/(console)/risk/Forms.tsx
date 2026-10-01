'use client';

import { RISK_NOTE_MAX, type RiskEventStatus, type RiskRuleInfo } from '@yatri/types';
import { useActionState, useId } from 'react';

import { styles } from '../drivers/styles';
import { Checkbox, Confirmed, Feedback, Field } from '../ui/FormParts';
import {
  liftAction,
  riskNoteAction,
  restrictAction,
  reviewAction,
  ruleAction,
  sweepAction,
} from './actions';

const column = { display: 'flex', flexDirection: 'column', gap: 8 } as const;

/** Confirm or dismiss one signal. A dismissed signal stops counting; the reason stays in the audit log. */
export function ReviewForm({
  eventId,
  allowed,
}: {
  eventId: string;
  allowed: readonly RiskEventStatus[];
}) {
  const [state, action, pending] = useActionState(reviewAction, {});
  const statusId = useId();
  if (allowed.length === 0) return null;
  return (
    <form action={action} style={column}>
      <input type="hidden" name="eventId" value={eventId} />
      <label htmlFor={statusId} style={styles.label}>
        Decision
      </label>
      <select id={statusId} name="status" style={styles.select} defaultValue={allowed[0]}>
        {allowed.map((s) => (
          <option key={s} value={s}>
            {s === 'DISMISSED' ? 'Dismiss as a false alarm' : 'Confirm as real'}
          </option>
        ))}
      </select>
      <Confirmed
        pending={pending}
        label="Save the decision"
        consequence="A dismissed signal stops counting towards the person's score; a confirmed one counts."
      />
      <Feedback state={state} />
    </form>
  );
}

/** Temporarily restrict an account. The longest allowed time is the server's rule, which answers if it is exceeded. */
export function RestrictForm({ userId, maxDays }: { userId: string; maxDays: number }) {
  const [state, action, pending] = useActionState(restrictAction, {});
  return (
    <form action={action} style={column}>
      <input type="hidden" name="userId" value={userId} />
      <Field
        name="days"
        label="Days"
        type="number"
        defaultValue={3}
        required
        hint={`Restrictions are temporary: at most ${maxDays} days. For longer, suspend the account instead.`}
      />
      <Confirmed
        pending={pending}
        label="Restrict this account"
        consequence="A passenger will not be able to request rides and a driver will not be offered rides until it ends or you lift it. The person is told, without a reason."
      />
      <Feedback state={state} />
    </form>
  );
}

export function LiftForm({ userId }: { userId: string }) {
  const [state, action, pending] = useActionState(liftAction, {});
  return (
    <form action={action} style={column}>
      <input type="hidden" name="userId" value={userId} />
      <Confirmed
        pending={pending}
        label="Lift the restriction"
        consequence="The person can use the service again straight away."
      />
      <Feedback state={state} />
    </form>
  );
}

/** An internal note on a person, a ride or an event. Staff only; never shown to the person. */
export function RiskNoteForm({
  userId,
  tripId,
  eventId,
}: {
  userId?: string | null;
  tripId?: string | null;
  eventId?: string | null;
}) {
  const [state, action, pending] = useActionState(riskNoteAction, {});
  const noteId = useId();
  return (
    <form action={action} style={column}>
      {userId ? <input type="hidden" name="userId" value={userId} /> : null}
      {tripId ? <input type="hidden" name="tripId" value={tripId} /> : null}
      {eventId ? <input type="hidden" name="eventId" value={eventId} /> : null}
      <label htmlFor={noteId} style={styles.label}>
        Internal note (staff only)
      </label>
      <textarea
        id={noteId}
        name="note"
        required
        maxLength={RISK_NOTE_MAX}
        style={styles.textarea}
      />
      <div style={styles.buttonRow}>
        <button type="submit" disabled={pending} style={styles.buttonPrimary}>
          {pending ? 'Adding…' : 'Add note'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

/** Change one rule's switch, points, threshold and window. Putting the defaults back removes the override. */
export function RuleForm({ rule }: { rule: RiskRuleInfo }) {
  const [state, action, pending] = useActionState(ruleAction, {});
  return (
    <form action={action} style={column}>
      <input type="hidden" name="code" value={rule.code} />
      <Checkbox name="enabled" label="This rule is on" checked={rule.enabled} />
      <Field
        name="points"
        label="Points when it fires"
        type="number"
        defaultValue={rule.points}
        required
      />
      <Field
        name="threshold"
        label={`Fires at (${rule.unit})`}
        type="number"
        defaultValue={rule.threshold}
        required
      />
      <Field
        name="windowHours"
        label="Looking back (hours)"
        type="number"
        defaultValue={rule.windowHours}
        required
      />
      <Confirmed
        pending={pending}
        label="Save this rule"
        consequence="From the next check, signals use these numbers. Signals already raised are not changed."
      />
      <Feedback state={state} />
    </form>
  );
}

export function SweepButton() {
  const [state, action, pending] = useActionState(sweepAction, {});
  return (
    <form action={action} style={column}>
      <div style={styles.buttonRow}>
        <button type="submit" disabled={pending} style={styles.buttonSecondary}>
          {pending ? 'Checking…' : 'Check now'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}
