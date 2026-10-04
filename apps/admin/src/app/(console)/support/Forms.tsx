'use client';

import { Feedback } from '../ui/FormParts';

import {
  REFUND_METHODS,
  REFUND_METHOD_LABELS,
  REFUND_REASONS,
  REFUND_REASON_LABELS,
  REFUND_STATUS_LABELS,
  SUPPORT_RESOLUTION_MAX,
  TICKET_BODY_MAX,
  TICKET_NOTE_MAX,
  TICKET_STATUS_LABELS,
  type AdminRefundInfo,
  type RefundQuote,
  type RefundStatus,
  type SupportPriority,
  type TicketStatus,
  formatWhen,
  formatNpr,
} from '@yatri/types';
import { useActionState, useId, useState } from 'react';

import { styles } from '../drivers/styles';
import {
  assignAction,
  noteAction,
  priorityAction,
  raiseRefundAction,
  refundAction,
  replyAction,
  statusAction,
} from './actions';

const column = { display: 'flex', flexDirection: 'column', gap: 8 } as const;

/** A reply to the person, optionally with a file, optionally moving the ticket to a working state. */
export function ReplyForm({
  ticketId,
  allowedNext,
}: {
  ticketId: string;
  allowedNext: TicketStatus[];
}) {
  const [state, action, pending] = useActionState(replyAction, {});
  const bodyId = useId();
  const statusId = useId();
  const fileId = useId();
  // Resolving and closing need their own form (a decision is written down there).
  const moves = allowedNext.filter((s) => s !== 'RESOLVED' && s !== 'CLOSED');
  return (
    <form action={action} style={column}>
      <input type="hidden" name="ticketId" value={ticketId} />
      <label htmlFor={bodyId} style={styles.label}>
        Reply (the person is told and reads it in the app)
      </label>
      <textarea id={bodyId} name="body" maxLength={TICKET_BODY_MAX} style={styles.textarea} />
      <label htmlFor={statusId} style={styles.label}>
        After replying
      </label>
      <select id={statusId} name="status" defaultValue="" style={styles.select}>
        <option value="">Usual move (hand it to the person)</option>
        {moves.map((s) => (
          <option key={s} value={s}>
            Set to: {TICKET_STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      <label htmlFor={fileId} style={styles.label}>
        Attach a photo, screenshot or PDF (the message above travels with it)
      </label>
      <input id={fileId} name="file" type="file" accept="image/jpeg,image/png,application/pdf" />
      <div style={styles.buttonRow}>
        <button type="submit" disabled={pending} style={styles.buttonPrimary}>
          {pending ? 'Sending…' : 'Send reply'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function NoteForm({ ticketId }: { ticketId: string }) {
  const [state, action, pending] = useActionState(noteAction, {});
  const id = useId();
  return (
    <form action={action} style={column}>
      <input type="hidden" name="ticketId" value={ticketId} />
      <label htmlFor={id} style={styles.label}>
        Internal note (never shown to the person, sends no notification)
      </label>
      <textarea id={id} name="body" required maxLength={TICKET_NOTE_MAX} style={styles.textarea} />
      <div style={styles.buttonRow}>
        <button type="submit" disabled={pending} style={styles.buttonSecondary}>
          {pending ? 'Saving…' : 'Add note'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

/**
 * Move the ticket along the table's legal moves. Resolving asks what was decided (and, for a ride problem,
 * whether it was upheld); resolving and closing are confirmed in the page first.
 */
export function StatusForm({
  ticketId,
  allowedNext,
  isDispute,
}: {
  ticketId: string;
  allowedNext: TicketStatus[];
  isDispute: boolean;
}) {
  const [state, action, pending] = useActionState(statusAction, {});
  const [to, setTo] = useState<TicketStatus | ''>(allowedNext[0] ?? '');
  const [confirming, setConfirming] = useState(false);
  const toId = useId();
  const textId = useId();
  const outcomeId = useId();
  if (allowedNext.length === 0) {
    return <p style={{ margin: 0 }}>This ticket is closed and cannot change.</p>;
  }
  const final = to === 'RESOLVED' || to === 'CLOSED';
  return (
    <form action={action} style={column}>
      <input type="hidden" name="ticketId" value={ticketId} />
      <label htmlFor={toId} style={styles.label}>
        Move to
      </label>
      <select
        id={toId}
        name="status"
        value={to}
        onChange={(e) => {
          setTo(e.target.value as TicketStatus);
          setConfirming(false);
        }}
        style={styles.select}
      >
        {allowedNext.map((s) => (
          <option key={s} value={s}>
            {TICKET_STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      {to === 'RESOLVED' ? (
        <>
          {isDispute ? (
            <>
              <label htmlFor={outcomeId} style={styles.label}>
                Outcome of the ride problem
              </label>
              <select id={outcomeId} name="outcome" defaultValue="UPHELD" style={styles.select}>
                <option value="UPHELD">Upheld (in the reporter&apos;s favour)</option>
                <option value="REJECTED">Not upheld</option>
              </select>
            </>
          ) : null}
          <label htmlFor={textId} style={styles.label}>
            What was decided (shown to the person)
          </label>
          <textarea
            id={textId}
            name="resolution"
            required
            minLength={3}
            maxLength={SUPPORT_RESOLUTION_MAX}
            style={styles.textarea}
          />
        </>
      ) : null}
      {final && !confirming ? (
        <div style={styles.buttonRow}>
          <button type="button" onClick={() => setConfirming(true)} style={styles.buttonPrimary}>
            {to === 'RESOLVED' ? 'Resolve this ticket…' : 'Close this ticket…'}
          </button>
        </div>
      ) : null}
      {final && confirming ? (
        <div role="group" aria-label="Confirm" style={column}>
          <p style={{ margin: 0 }}>
            {to === 'RESOLVED'
              ? 'Resolving tells the person the ticket is done. They can still reopen it by replying.'
              : 'Closing is final. The person cannot reply any more.'}
          </p>
          <div style={styles.buttonRow}>
            <button type="submit" disabled={pending} style={styles.buttonDanger}>
              {pending ? 'Saving…' : to === 'RESOLVED' ? 'Yes, resolve it' : 'Yes, close it'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              style={styles.buttonSecondary}
            >
              Go back
            </button>
          </div>
        </div>
      ) : null}
      {!final ? (
        <div style={styles.buttonRow}>
          <button type="submit" disabled={pending} style={styles.buttonPrimary}>
            {pending ? 'Saving…' : 'Update status'}
          </button>
        </div>
      ) : null}
      <Feedback state={state} />
    </form>
  );
}

export function AssignForm({
  ticketId,
  current,
  people,
}: {
  ticketId: string;
  current: string | null;
  people: Array<{ id: string; name: string | null }>;
}) {
  const [state, action, pending] = useActionState(assignAction, {});
  const id = useId();
  return (
    <form action={action} style={column}>
      <input type="hidden" name="ticketId" value={ticketId} />
      <label htmlFor={id} style={styles.label}>
        Assigned to
      </label>
      <select id={id} name="adminId" defaultValue={current ?? ''} style={styles.select}>
        <option value="">Nobody</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name ?? 'Unnamed administrator'}
          </option>
        ))}
      </select>
      <div style={styles.buttonRow}>
        <button type="submit" disabled={pending} style={styles.buttonSecondary}>
          {pending ? 'Saving…' : 'Save assignment'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function PriorityForm({
  ticketId,
  current,
  priorities,
}: {
  ticketId: string;
  current: string;
  priorities: SupportPriority[];
}) {
  const [state, action, pending] = useActionState(priorityAction, {});
  const selectId = useId();
  const reasonId = useId();
  return (
    <form action={action} style={column}>
      <input type="hidden" name="ticketId" value={ticketId} />
      <label htmlFor={selectId} style={styles.label}>
        Priority
      </label>
      <select id={selectId} name="priorityCode" defaultValue={current} style={styles.select}>
        {priorities.map((p) => (
          <option key={p.code} value={p.code}>
            {p.label} (first answer within {p.firstResponseHours} h)
          </option>
        ))}
      </select>
      <label htmlFor={reasonId} style={styles.label}>
        Reason (kept in the audit log)
      </label>
      <input
        id={reasonId}
        name="reason"
        required
        minLength={3}
        maxLength={300}
        style={styles.input}
      />
      <div style={styles.buttonRow}>
        <button type="submit" disabled={pending} style={styles.buttonSecondary}>
          {pending ? 'Saving…' : 'Change priority'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

/** Raise a refund from this ticket. The figures shown are the server's own: it checks the request again. */
export function RaiseRefundForm({ ticketId, quote }: { ticketId: string; quote: RefundQuote }) {
  const [state, action, pending] = useActionState(raiseRefundAction, {});
  const [reason, setReason] = useState<string>('FULL_FARE');
  const reasonId = useId();
  const amountId = useId();
  const noteId = useId();
  const reasons = REFUND_REASONS.filter((r) => quote.amounts[r] !== null);
  if (reasons.length === 0) {
    return <p style={{ margin: 0 }}>Everything paid for this ride has already been refunded.</p>;
  }
  return (
    <form action={action} style={column}>
      <input type="hidden" name="ticketId" value={ticketId} />
      <p style={{ margin: 0 }}>
        Paid NPR {quote.paidNpr}. Already refunded NPR {quote.refundedNpr}. Up to NPR{' '}
        {quote.remainingNpr} can still be refunded.
      </p>
      <label htmlFor={reasonId} style={styles.label}>
        What the refund is for
      </label>
      <select
        id={reasonId}
        name="reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        style={styles.select}
      >
        {reasons.map((r) => (
          <option key={r} value={r}>
            {REFUND_REASON_LABELS[r]}
            {r !== 'PARTIAL' && quote.amounts[r] !== null
              ? ` (${formatNpr(quote.amounts[r])})`
              : ''}
          </option>
        ))}
      </select>
      {reason === 'PARTIAL' ? (
        <>
          <label htmlFor={amountId} style={styles.label}>
            Amount in whole rupees (at most {quote.remainingNpr})
          </label>
          <input
            id={amountId}
            name="amountNpr"
            inputMode="numeric"
            pattern="[0-9]+"
            required
            style={styles.input}
          />
        </>
      ) : null}
      <label htmlFor={noteId} style={styles.label}>
        Note for the approver (optional)
      </label>
      <input id={noteId} name="note" maxLength={500} style={styles.input} />
      <div style={styles.buttonRow}>
        <button type="submit" disabled={pending} style={styles.buttonPrimary}>
          {pending ? 'Raising…' : 'Raise this refund'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

const MONEY_MOVES: RefundStatus[] = ['APPROVED', 'PROCESSING', 'COMPLETED'];

/**
 * One refund and the moves this administrator may make on it (the list comes from the server, which
 * applies the same rules again). Approving, paying back and completing involve money, so each asks for
 * a second, in-page confirmation that says what it means.
 */
export function RefundCard({ ticketId, refund }: { ticketId: string; refund: AdminRefundInfo }) {
  const [state, action, pending] = useActionState(refundAction, {});
  const [to, setTo] = useState<RefundStatus | ''>(refund.allowedNext[0] ?? '');
  const [confirming, setConfirming] = useState(false);
  const toId = useId();
  const noteId = useId();
  const methodId = useId();
  const refId = useId();
  const failId = useId();
  return (
    <div style={{ ...column, borderTop: '1px solid var(--color-border)', paddingTop: 8 }}>
      <p style={{ margin: 0 }}>
        <strong>
          NPR {refund.amountNpr}: {REFUND_STATUS_LABELS[refund.status]}.
        </strong>{' '}
        {REFUND_REASON_LABELS[refund.reason]}. Raised by {refund.requestedByName ?? 'someone'} (
        {refund.requestedByRole.toLowerCase()}) on {formatWhen(refund.createdAt)}.
        {refund.method ? ` Paid back by: ${REFUND_METHOD_LABELS[refund.method]}.` : ''}
        {refund.reference ? ` Reference: ${refund.reference}.` : ''}
        {refund.decisionNote ? ` Note: ${refund.decisionNote}.` : ''}
        {refund.failedReason ? ` Last problem: ${refund.failedReason}.` : ''}
      </p>
      {refund.allowedNext.length === 0 ? null : (
        <form action={action} style={column}>
          <input type="hidden" name="ticketId" value={ticketId} />
          <input type="hidden" name="refundId" value={refund.id} />
          <label htmlFor={toId} style={styles.label}>
            Move this refund to
          </label>
          <select
            id={toId}
            name="to"
            value={to}
            onChange={(e) => {
              setTo(e.target.value as RefundStatus);
              setConfirming(false);
            }}
            style={styles.select}
          >
            {refund.allowedNext.map((s) => (
              <option key={s} value={s}>
                {REFUND_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
          {to === 'PROCESSING' ? (
            <>
              <label htmlFor={methodId} style={styles.label}>
                How the money goes back (Yatri holds none; this records who pays it)
              </label>
              <select
                id={methodId}
                name="method"
                defaultValue={refund.method ?? 'DRIVER_CASH'}
                style={styles.select}
              >
                {REFUND_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {REFUND_METHOD_LABELS[m]}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          {to === 'COMPLETED' ? (
            <>
              <label htmlFor={refId} style={styles.label}>
                Reference (how it was paid back, optional)
              </label>
              <input id={refId} name="reference" maxLength={120} style={styles.input} />
            </>
          ) : null}
          {to === 'FAILED' ? (
            <>
              <label htmlFor={failId} style={styles.label}>
                What went wrong
              </label>
              <input
                id={failId}
                name="failedReason"
                required
                maxLength={300}
                style={styles.input}
              />
            </>
          ) : null}
          <label htmlFor={noteId} style={styles.label}>
            {to === 'REJECTED' ? 'Why it is not approved (shown in the record)' : 'Note (optional)'}
          </label>
          <input
            id={noteId}
            name="note"
            required={to === 'REJECTED'}
            maxLength={500}
            style={styles.input}
          />
          {to && MONEY_MOVES.includes(to) && !confirming ? (
            <div style={styles.buttonRow}>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                style={styles.buttonPrimary}
              >
                {REFUND_STATUS_LABELS[to]}…
              </button>
            </div>
          ) : null}
          {to && MONEY_MOVES.includes(to) && confirming ? (
            <div role="group" aria-label="Confirm this refund step" style={column}>
              <p style={{ margin: 0 }}>
                {to === 'APPROVED'
                  ? `Approving agrees that ${formatNpr(refund.amountNpr)} is owed back to the passenger. Someone else must have raised it.`
                  : to === 'PROCESSING'
                    ? `This records that ${formatNpr(refund.amountNpr)} is now being paid back. Nothing is sent by this system.`
                    : `This records that ${formatNpr(refund.amountNpr)} reached the passenger and counts it as refunded for this ride. It cannot be undone.`}
              </p>
              <div style={styles.buttonRow}>
                <button type="submit" disabled={pending} style={styles.buttonDanger}>
                  {pending ? 'Saving…' : 'Yes, confirm'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  style={styles.buttonSecondary}
                >
                  Go back
                </button>
              </div>
            </div>
          ) : null}
          {to && !MONEY_MOVES.includes(to) ? (
            <div style={styles.buttonRow}>
              <button
                type="submit"
                disabled={pending}
                style={to === 'REJECTED' ? styles.buttonDanger : styles.buttonPrimary}
              >
                {pending ? 'Saving…' : REFUND_STATUS_LABELS[to]}
              </button>
            </div>
          ) : null}
        </form>
      )}
      <Feedback state={state} />
    </div>
  );
}
