import Link from 'next/link';
import { notFound } from 'next/navigation';
import { RISK_LEVEL_LABELS, formatWhen } from '@yatri/types';

import { ApiError, getRiskUser } from '../../../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../../../lib/session';
import { styles } from '../../../drivers/styles';
import { AuditTrail } from '../../../safety/AuditTrail';
import { ConfirmAction } from '../../../ui/ConfirmAction';
import { userStatusAction } from '../../../users/actions';
import { LiftForm, RiskNoteForm, RestrictForm } from '../../Forms';
import { EventsTable, NotesList, RiskNav } from '../../parts';

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * One person, for an investigation: the level and why, every signal and note, the context needed to judge them,
 * and the controls the server says this administrator may use. Suspending and restoring are the existing account
 * moves (the same ones as on the users page); a restriction is the temporary, lighter measure.
 */
export default async function RiskUserPage({ params }: PageProps) {
  const token = await requireAdminAccessToken();
  const { id } = await params;
  let u;
  try {
    u = await getRiskUser(token, id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const name = u.name ?? 'Unnamed person';
  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>{name}</h1>
        <Link href="/risk" style={styles.backLink}>
          ← Overview
        </Link>
      </div>
      <RiskNav />

      <section aria-labelledby="lvl-h" style={styles.section}>
        <h2 id="lvl-h" style={styles.sectionTitle}>
          Level
        </h2>
        <p style={{ margin: 0 }}>
          <strong>{RISK_LEVEL_LABELS[u.level]}.</strong> {u.levelHelp}
        </p>
        <p style={{ margin: 0 }}>
          Score {u.score} (a review is due at {u.reviewScore}). Role: {u.role.toLowerCase()}.
          Account: {u.accountStatus.toLowerCase()}.
        </p>
        {u.restriction ? (
          <p style={{ margin: 0 }}>
            Restricted until {formatWhen(u.restriction.until)} (
            {u.restriction.source === 'AUTOMATIC' ? 'set automatically' : 'set by a person'}
            ): {u.restriction.reason}
          </p>
        ) : null}
        <p style={{ margin: 0 }}>
          Context: {u.context.completedRides} rides completed, {u.context.cancelledRides} cancelled,{' '}
          {u.context.disputes} disputes, {u.context.refundRequests} refund requests. Many signals
          with little history can mean a new account; a few with a long history often mean nothing.
        </p>
        <Link href={`/users/${u.userId}`}>Open the account page</Link>
      </section>

      <section aria-labelledby="act-h" style={styles.section}>
        <h2 id="act-h" style={styles.sectionTitle}>
          Actions
        </h2>
        {u.actions.canRestrict ? (
          <>
            <h3 style={{ margin: 0, fontSize: 16 }}>Restrict temporarily</h3>
            <RestrictForm userId={u.userId} maxDays={u.maxRestrictionDays} />
          </>
        ) : null}
        {u.actions.canLift ? (
          <>
            <h3 style={{ margin: 0, fontSize: 16 }}>Lift the restriction</h3>
            <LiftForm userId={u.userId} />
          </>
        ) : null}
        {u.actions.canSuspend ? (
          <ConfirmAction
            action={userStatusAction}
            hidden={{ userId: u.userId, to: 'suspend' }}
            label="Suspend this account"
            consequence="The person is signed out everywhere and cannot sign in until you restore the account."
            confirmLabel="Suspend"
          />
        ) : null}
        {u.actions.canRestore ? (
          <ConfirmAction
            action={userStatusAction}
            hidden={{ userId: u.userId, to: 'reactivate' }}
            label="Restore this account"
            consequence="The person can sign in and use the service again."
            confirmLabel="Restore"
            tone="primary"
          />
        ) : null}
        {!u.actions.canRestrict &&
        !u.actions.canLift &&
        !u.actions.canSuspend &&
        !u.actions.canRestore ? (
          <p style={{ margin: 0 }}>You cannot take any action on this account.</p>
        ) : null}
      </section>

      <section aria-labelledby="ev-h" style={styles.section}>
        <h2 id="ev-h" style={styles.sectionTitle}>
          Signals
        </h2>
        <EventsTable events={u.events} label={`Risk signals for ${name}`} />
      </section>

      <section aria-labelledby="notes-h" style={styles.section}>
        <h2 id="notes-h" style={styles.sectionTitle}>
          Internal notes
        </h2>
        <NotesList notes={u.notes} />
        <RiskNoteForm userId={u.userId} />
      </section>

      <AuditTrail entries={u.audit} />
    </div>
  );
}
