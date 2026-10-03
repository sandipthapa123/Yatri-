'use client';

import { Feedback } from '../ui/FormParts';

import {
  INCIDENT_STATUS_LABELS,
  INCIDENT_TRANSITIONS,
  INCIDENT_NOTE_MAX,
  type IncidentStatus,
} from '@yatri/types';
import { useActionState, useId, useState } from 'react';

import { styles } from '../drivers/styles';
import {
  incidentNoteAction,
  incidentStatusAction,
  moveSosAction,
} from './actions';


const column = { display: 'flex', flexDirection: 'column', gap: 8 } as const;

/**
 * Acknowledge or resolve an SOS alert. Resolving closes the emergency for the person, so it takes a
 * second, in-page confirmation (never a browser dialog) and a written note.
 */
export function SosActions({ sosId, status }: { sosId: string; status: string }) {
  const [state, action, pending] = useActionState(moveSosAction, {});
  const [confirming, setConfirming] = useState(false);
  const noteId = useId();
  if (status !== 'ACTIVE' && status !== 'ACKNOWLEDGED') {
    return <p style={{ margin: 0 }}>This alert has ended, so there is nothing more to do.</p>;
  }
  return (
    <div style={column}>
      {status === 'ACTIVE' ? (
        <form action={action} style={column}>
          <input type="hidden" name="sosId" value={sosId} />
          <input type="hidden" name="to" value="ACKNOWLEDGED" />
          <button type="submit" disabled={pending} style={styles.buttonPrimary}>
            {pending ? 'Acknowledging…' : 'Acknowledge: the team is responding'}
          </button>
        </form>
      ) : null}
      <form action={action} style={column}>
        <input type="hidden" name="sosId" value={sosId} />
        <input type="hidden" name="to" value="RESOLVED" />
        <label htmlFor={noteId} style={styles.label}>
          How it was resolved (kept internally)
        </label>
        <textarea
          id={noteId}
          name="note"
          required
          minLength={3}
          maxLength={INCIDENT_NOTE_MAX}
          style={styles.textarea}
        />
        {confirming ? (
          <div role="group" aria-label="Confirm resolving this alert" style={column}>
            <p style={{ margin: 0 }}>
              Resolving tells the person their emergency alert is closed. Do this only once they are
              safe.
            </p>
            <div style={styles.buttonRow}>
              <button type="submit" disabled={pending} style={styles.buttonDanger}>
                {pending ? 'Resolving…' : 'Yes, resolve this alert'}
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
        ) : (
          <div style={styles.buttonRow}>
            <button type="button" onClick={() => setConfirming(true)} style={styles.buttonDanger}>
              Resolve this alert…
            </button>
          </div>
        )}
      </form>
      <Feedback state={state} />
    </div>
  );
}

/** Move a report to one of the states the shared table allows from where it is now. */
export function IncidentStatusForm({
  incidentId,
  status,
}: {
  incidentId: string;
  status: IncidentStatus;
}) {
  const [state, action, pending] = useActionState(incidentStatusAction, {});
  const selectId = useId();
  const noteId = useId();
  const next = INCIDENT_TRANSITIONS[status];
  if (next.length === 0) {
    return (
      <p style={{ margin: 0 }}>
        This report is {INCIDENT_STATUS_LABELS[status].toLowerCase()} and can no longer change
        status. You can still add notes.
      </p>
    );
  }
  return (
    <form action={action} style={column}>
      <input type="hidden" name="incidentId" value={incidentId} />
      <label htmlFor={selectId} style={styles.label}>
        Move to
      </label>
      <select id={selectId} name="status" defaultValue={next[0]} style={styles.select}>
        {next.map((s) => (
          <option key={s} value={s}>
            {INCIDENT_STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      <label htmlFor={noteId} style={styles.label}>
        Note (optional, kept internally)
      </label>
      <textarea id={noteId} name="note" maxLength={INCIDENT_NOTE_MAX} style={styles.textarea} />
      <div style={styles.buttonRow}>
        <button type="submit" disabled={pending} style={styles.buttonPrimary}>
          {pending ? 'Saving…' : 'Update status'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function IncidentNoteForm({ incidentId }: { incidentId: string }) {
  const [state, action, pending] = useActionState(incidentNoteAction, {});
  const kindId = useId();
  const bodyId = useId();
  return (
    <form action={action} style={column}>
      <input type="hidden" name="incidentId" value={incidentId} />
      <label htmlFor={kindId} style={styles.label}>
        Kind
      </label>
      <select id={kindId} name="kind" defaultValue="NOTE" style={styles.select}>
        <option value="NOTE">Internal note</option>
        <option value="ACTION">Action taken</option>
      </select>
      <label htmlFor={bodyId} style={styles.label}>
        What to record (never shown to the reporter)
      </label>
      <textarea
        id={bodyId}
        name="body"
        required
        maxLength={INCIDENT_NOTE_MAX}
        style={styles.textarea}
      />
      <div style={styles.buttonRow}>
        <button type="submit" disabled={pending} style={styles.buttonSecondary}>
          {pending ? 'Saving…' : 'Add to the record'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}
