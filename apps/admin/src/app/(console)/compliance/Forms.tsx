'use client';

import {
  DATA_REQUEST_STATUS_LABELS,
  type AdminDataRequestRow,
  type PolicyInfo,
  type RetentionPolicyInfo,
} from '@yatri/types';
import { useActionState, useId, useState } from 'react';

import { styles } from '../drivers/styles';
import {
  dataRequestAction,
  publishPolicyAction,
  retentionAction,
  type ComplianceActionState,
} from './actions';

const column = { display: 'flex', flexDirection: 'column', gap: 8 } as const;

function Feedback({ state }: { state: ComplianceActionState }) {
  return (
    <div role="status" aria-live="polite">
      {state.error ? <p style={styles.errorText}>Problem: {state.error}</p> : null}
      {state.done ? <p style={{ margin: 0, fontSize: 14 }}>{state.done}</p> : null}
    </div>
  );
}

/** Publish the next version of a policy. The words live at the address; only the version is recorded. */
export function PublishPolicyForm({ policy }: { policy: PolicyInfo }) {
  const [state, action, pending] = useActionState(publishPolicyAction, {});
  const [open, setOpen] = useState(false);
  const versionId = useId();
  const urlId = useId();
  const reasonId = useId();
  if (!open) {
    return (
      <div style={styles.buttonRow}>
        <button type="button" onClick={() => setOpen(true)} style={styles.buttonSecondary}>
          Publish a new version of {policy.title}…
        </button>
        <Feedback state={state} />
      </div>
    );
  }
  return (
    <form action={action} style={column}>
      <input type="hidden" name="key" value={policy.key} />
      <label htmlFor={versionId} style={styles.label}>
        New version (now {policy.version})
      </label>
      <input id={versionId} name="version" required maxLength={40} style={styles.input} />
      <label htmlFor={urlId} style={styles.label}>
        Where the new text is (web address; leave empty to keep the current one)
      </label>
      <input id={urlId} name="contentUrl" type="url" maxLength={500} style={styles.input} />
      <label htmlFor={reasonId} style={styles.label}>
        What changed (kept in the audit log)
      </label>
      <textarea
        id={reasonId}
        name="reason"
        required
        minLength={3}
        maxLength={300}
        style={styles.textarea}
      />
      <p style={{ margin: 0, fontSize: 13 }}>
        Everyone who accepted an earlier version will be asked to accept this one. Their earlier
        acceptances are kept.
      </p>
      <div style={styles.buttonRow}>
        <button type="submit" disabled={pending} style={styles.buttonPrimary}>
          {pending ? 'Publishing…' : 'Publish this version'}
        </button>
        <button type="button" onClick={() => setOpen(false)} style={styles.buttonSecondary}>
          Cancel
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

/** Move a request along; completing a deletion request is confirmed first and does the deletion. */
export function DataRequestForm({ request }: { request: AdminDataRequestRow }) {
  const [state, action, pending] = useActionState(dataRequestAction, {});
  const [to, setTo] = useState<string>(request.allowedNext[0] ?? '');
  const [confirming, setConfirming] = useState(false);
  const toId = useId();
  const noteId = useId();
  if (request.allowedNext.length === 0) return null;
  const destructive = request.kind === 'ACCOUNT_DELETION' && to === 'COMPLETED';
  return (
    <form action={action} style={column}>
      <input type="hidden" name="requestId" value={request.id} />
      <label htmlFor={toId} style={styles.label}>
        Move to
      </label>
      <select
        id={toId}
        name="to"
        value={to}
        onChange={(e) => {
          setTo(e.target.value);
          setConfirming(false);
        }}
        style={styles.select}
      >
        {request.allowedNext.map((s) => (
          <option key={s} value={s}>
            {DATA_REQUEST_STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      <label htmlFor={noteId} style={styles.label}>
        {to === 'REJECTED'
          ? 'Why it cannot be done (the person sees this)'
          : 'Note to the person (optional)'}
      </label>
      <input
        id={noteId}
        name="note"
        required={to === 'REJECTED'}
        maxLength={500}
        style={styles.input}
      />
      {destructive && !confirming ? (
        <div style={styles.buttonRow}>
          <button type="button" onClick={() => setConfirming(true)} style={styles.buttonDanger}>
            Delete this account…
          </button>
        </div>
      ) : null}
      {destructive && confirming ? (
        <div role="group" aria-label="Confirm deleting this account" style={column}>
          <p style={{ margin: 0 }}>
            This removes the person&apos;s name, phone number, saved places, emergency contacts and
            identity documents, and ends their sessions. Rides, payments, refunds, tickets, safety
            records and this audit trail are kept without their name. It cannot be undone, and it is
            refused while a ride is under way or a payment is unsettled.
          </p>
          <div style={styles.buttonRow}>
            <button type="submit" disabled={pending} style={styles.buttonDanger}>
              {pending ? 'Deleting…' : 'Yes, delete this account'}
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
      {!destructive ? (
        <div style={styles.buttonRow}>
          <button
            type="submit"
            disabled={pending}
            style={to === 'REJECTED' ? styles.buttonDanger : styles.buttonPrimary}
          >
            {pending ? 'Saving…' : 'Update request'}
          </button>
        </div>
      ) : null}
      <Feedback state={state} />
    </form>
  );
}

/** Change a retention period (only for records that are deleted on age; never below the stated minimum). */
export function RetentionForm({ rule }: { rule: RetentionPolicyInfo }) {
  const [state, action, pending] = useActionState(retentionAction, {});
  const daysId = useId();
  const reasonId = useId();
  if (rule.action === 'KEEP' || rule.retainDays === null) return null;
  return (
    <form action={action} style={column}>
      <input type="hidden" name="recordType" value={rule.recordType} />
      <label htmlFor={daysId} style={styles.label}>
        Days to keep (at least {rule.minRetainDays ?? 1})
      </label>
      <input
        id={daysId}
        name="retainDays"
        inputMode="numeric"
        pattern="[0-9]+"
        defaultValue={rule.retainDays}
        required
        style={styles.input}
      />
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
          {pending ? 'Saving…' : 'Change period'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}
