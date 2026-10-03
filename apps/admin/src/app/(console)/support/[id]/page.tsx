import Link from 'next/link';
import { notFound } from 'next/navigation';
import { REFUND_STATUS_LABELS, TICKET_STATUS_LABELS, formatNpr, formatWhen } from '@yatri/types';

import {
  ApiError,
  getAdminTicket,
  getSupportConfig,
  listTicketAssignees,
} from '../../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../../lib/session';
import { styles } from '../../drivers/styles';
import { AuditTrail } from '../../safety/AuditTrail';
import { openAttachmentAction } from '../actions';
import {
  AssignForm,
  NoteForm,
  PriorityForm,
  RaiseRefundForm,
  RefundCard,
  ReplyForm,
  StatusForm,
} from '../Forms';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ fileError?: string }>;
}

const at = (iso: string) => formatWhen(iso);
const WHO = { REQUESTER: 'The person', ADMIN: 'Support', SYSTEM: 'System' } as const;
const KIND = {
  MESSAGE: 'Message',
  NOTE: 'Internal note (not shown to the person)',
  STATUS: 'Update',
  RESOLUTION: 'Decision',
} as const;

/**
 * One ticket as a workspace: who and what it is about, the ride and payment it refers to (read from the
 * ride, never copied), the conversation with internal notes marked as such, refunds and the moves this
 * administrator may make, the person's earlier tickets, and the audit trail. The API decides what each
 * control may do; this shows what it was told.
 */
export default async function TicketPage({ params, searchParams }: PageProps) {
  const token = await requireAdminAccessToken();
  const { id } = await params;
  const sp = await searchParams;
  let t;
  try {
    t = await getAdminTicket(token, id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const [people, config] = await Promise.all([
    listTicketAssignees(token).catch(() => []),
    getSupportConfig(token).catch(() => ({ categories: [], priorities: [] })),
  ]);
  const assignable = people.filter((p) => t.isDispute || p.canHandleGeneral);

  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>
          #{t.number} {t.subject}
        </h1>
        <Link href="/support" style={styles.backLink}>
          ← Support
        </Link>
      </div>

      {sp.fileError ? (
        <p role="alert" style={styles.errorText}>
          Problem: that file could not be opened.
        </p>
      ) : null}

      <section aria-labelledby="sum-h" style={styles.section}>
        <h2 id="sum-h" style={styles.sectionTitle}>
          Summary
        </h2>
        <p style={{ margin: 0 }}>
          <strong>{TICKET_STATUS_LABELS[t.status]}.</strong>{' '}
          {t.isDispute ? 'Ride problem' : 'Request'}: {t.categoryLabel}. Priority {t.priorityLabel}
          {t.escalationLevel > 0
            ? `, escalated ${t.escalationLevel} time${t.escalationLevel === 1 ? '' : 's'}`
            : ''}
          . Raised by {t.requesterName ?? 'an unnamed person'} ({t.requesterRole.toLowerCase()}) on{' '}
          {at(t.createdAt)}. Assigned to {t.assignedToName ?? 'nobody'}.
          {t.responseDueAt
            ? t.overdue
              ? ` The answer is late: it was due ${at(t.responseDueAt)}.`
              : ` An answer is due by ${at(t.responseDueAt)}.`
            : ''}
        </p>
        {t.resolution ? (
          <p style={{ margin: 0 }}>
            <strong>
              Decision{t.outcome ? ` (${t.outcome === 'UPHELD' ? 'upheld' : 'not upheld'})` : ''}:
            </strong>{' '}
            {t.resolution}
          </p>
        ) : null}
      </section>

      {t.ride ? (
        <section aria-labelledby="ride-h" style={styles.section}>
          <h2 id="ride-h" style={styles.sectionTitle}>
            The ride
          </h2>
          <p style={{ margin: 0 }}>
            {t.ride.status.toLowerCase().replace(/_/g, ' ')}, requested {at(t.ride.requestedAt)}.
            From {t.ride.pickup} to {t.ride.destination}. Passenger{' '}
            {t.ride.passengerName ?? 'unnamed'}, driver {t.ride.driverName ?? 'none'}.
          </p>
          <p style={{ margin: 0 }}>
            Estimate {t.ride.fareEstimateNpr === null ? 'none' : formatNpr(t.ride.fareEstimateNpr)};
            final fare {t.ride.fareFinalNpr === null ? 'not set' : formatNpr(t.ride.fareFinalNpr)};
            waiting charge {formatNpr(t.ride.waitingChargeNpr)}; cancellation fee{' '}
            {formatNpr(t.ride.cancellationFeeNpr)}
            {t.ride.cancelledBy ? `; cancelled by ${t.ride.cancelledBy.toLowerCase()}` : ''}.
          </p>
          <Link href={`/rides/${t.ride.tripId}`}>Open the full ride record</Link>
        </section>
      ) : null}

      {t.payment ? (
        <section aria-labelledby="pay-h" style={styles.section}>
          <h2 id="pay-h" style={styles.sectionTitle}>
            Payment
          </h2>
          <p style={{ margin: 0 }}>
            {formatNpr(t.payment.amountNpr)} by {t.payment.method.toLowerCase()}:{' '}
            {t.payment.status.toLowerCase()}
            {t.payment.paidAt ? ` on ${at(t.payment.paidAt)}` : ''}. Already refunded{' '}
            {formatNpr(t.payment.refundedNpr)}
            {t.payment.quote
              ? `; ${formatNpr(t.payment.quote.remainingNpr)} can still be refunded`
              : ''}
            .
          </p>
        </section>
      ) : null}

      <section aria-labelledby="conv-h" style={styles.section}>
        <h2 id="conv-h" style={styles.sectionTitle}>
          Conversation
        </h2>
        <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 10 }}>
          {t.messages.map((m) => (
            <li key={m.id}>
              <strong>
                {WHO[m.from]}
                {m.authorName && m.from === 'ADMIN' ? ` (${m.authorName})` : ''}
              </strong>{' '}
              · {KIND[m.kind]} · {at(m.createdAt)}
              <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
              {m.attachments.map((a) => (
                <form action={openAttachmentAction} key={a.id} style={{ marginTop: 4 }}>
                  <input type="hidden" name="attachmentId" value={a.id} />
                  <input type="hidden" name="ticketId" value={t.id} />
                  <button type="submit" style={styles.buttonSecondary}>
                    Open file: {a.filename} ({Math.max(1, Math.round(a.sizeBytes / 1024))} KB)
                  </button>
                </form>
              ))}
            </li>
          ))}
        </ol>
      </section>

      {t.status !== 'CLOSED' ? (
        <section aria-labelledby="reply-h" style={styles.section}>
          <h2 id="reply-h" style={styles.sectionTitle}>
            Reply
          </h2>
          <ReplyForm ticketId={t.id} allowedNext={t.allowedNext} />
        </section>
      ) : null}

      <section aria-labelledby="note-h" style={styles.section}>
        <h2 id="note-h" style={styles.sectionTitle}>
          Internal notes
        </h2>
        <NoteForm ticketId={t.id} />
      </section>

      <section aria-labelledby="st-h" style={styles.section}>
        <h2 id="st-h" style={styles.sectionTitle}>
          Status
        </h2>
        <StatusForm ticketId={t.id} allowedNext={t.allowedNext} isDispute={t.isDispute} />
      </section>

      <section aria-labelledby="as-h" style={styles.section}>
        <h2 id="as-h" style={styles.sectionTitle}>
          Assignment and priority
        </h2>
        <AssignForm ticketId={t.id} current={t.assignedToId} people={assignable} />
        <PriorityForm ticketId={t.id} current={t.priorityCode} priorities={config.priorities} />
      </section>

      {t.isDispute && t.payment ? (
        <section aria-labelledby="ref-h" style={styles.section}>
          <h2 id="ref-h" style={styles.sectionTitle}>
            Refunds
          </h2>
          {t.refunds.length === 0 ? <p style={{ margin: 0 }}>No refund has been raised.</p> : null}
          {t.refunds.map((r) => (
            <RefundCard key={r.id} ticketId={t.id} refund={r} />
          ))}
          {!t.canDecideRefunds && t.refunds.length > 0 ? (
            <p style={{ margin: 0 }}>
              You can see these refunds but not decide them: that needs the refund permission.
            </p>
          ) : null}
          {t.payment.quote &&
          t.status !== 'CLOSED' &&
          !t.refunds.some((r) => !['COMPLETED', 'REJECTED'].includes(r.status)) ? (
            <RaiseRefundForm ticketId={t.id} quote={t.payment.quote} />
          ) : t.refunds.some((r) => !['COMPLETED', 'REJECTED'].includes(r.status)) ? (
            <p style={{ margin: 0 }}>
              A refund is being handled ({REFUND_STATUS_LABELS[t.refunds[0]?.status ?? 'REQUESTED']}
              ); another can be raised once it is finished or declined.
            </p>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="hist-h" style={styles.section}>
        <h2 id="hist-h" style={styles.sectionTitle}>
          This person&apos;s earlier tickets
        </h2>
        {t.history.length === 0 ? (
          <p style={{ margin: 0 }}>None.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {t.history.map((h) => (
              <li key={h.id}>
                <Link href={`/support/${h.id}`}>
                  #{h.number} {h.subject}
                </Link>{' '}
                · {TICKET_STATUS_LABELS[h.status]} · {at(h.createdAt)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <AuditTrail entries={t.audit} />
    </div>
  );
}
