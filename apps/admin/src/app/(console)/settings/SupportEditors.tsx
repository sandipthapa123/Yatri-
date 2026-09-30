'use client';

import type { SupportCategory, SupportPriority } from '@yatri/types';
import { useActionState, useId, useState } from 'react';

import { styles } from '../drivers/styles';
import { useWhenDone } from '../ui/useWhenDone';
import { updateSupportCategoryAction, updateSupportPriorityAction } from './actions';

const column = { display: 'flex', flexDirection: 'column', gap: 8 } as const;

function Status({ state }: { state: { error?: string; done?: string } }) {
  return (
    <div role="status" aria-live="polite">
      {state.error ? <p style={styles.errorText}>Problem: {state.error}</p> : null}
      {state.done ? <p style={{ margin: 0, fontSize: 14 }}>{state.done}</p> : null}
    </div>
  );
}

/** One support category as data: edit its words, who may pick it, its default priority and whether it is offered. */
export function SupportCategoryEditor({
  category,
  priorities,
  canManage,
}: {
  category: SupportCategory;
  priorities: SupportPriority[];
  canManage: boolean;
}) {
  const [state, action, pending] = useActionState(updateSupportCategoryAction, {});
  const [open, setOpen] = useState(false);
  const id = useId();
  useWhenDone(
    state,
    (s) => !!s.done,
    () => setOpen(false),
  );
  return (
    <div style={column}>
      <p style={{ margin: 0 }}>
        <strong>{category.label}</strong> ({category.code}):{' '}
        {category.kind === 'DISPUTE' ? 'ride problem' : 'general'},{' '}
        {category.isActive ? 'offered' : 'not offered'}, for{' '}
        {category.forRoles.join(' and ').toLowerCase()}s
        {category.requiresRide ? ', names a ride' : ''}, default priority {category.defaultPriority}
        , order {category.sortOrder}. {category.help}
      </p>
      {canManage && !open ? (
        <div style={styles.buttonRow}>
          <button type="button" onClick={() => setOpen(true)} style={styles.buttonSecondary}>
            Edit {category.label}…
          </button>
        </div>
      ) : null}
      {canManage && open ? (
        <form action={action} style={column}>
          <input type="hidden" name="code" value={category.code} />
          <label htmlFor={`${id}-l`} style={styles.label}>
            Name
          </label>
          <input
            id={`${id}-l`}
            name="label"
            defaultValue={category.label}
            maxLength={80}
            style={styles.input}
          />
          <label htmlFor={`${id}-h`} style={styles.label}>
            What belongs here (shown to the person)
          </label>
          <textarea
            id={`${id}-h`}
            name="help"
            defaultValue={category.help}
            maxLength={300}
            style={styles.textarea}
          />
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={styles.label}>Who can pick it</legend>
            {(['PASSENGER', 'DRIVER'] as const).map((r) => (
              <label key={r} style={{ marginRight: 16 }}>
                <input
                  type="checkbox"
                  name={`role_${r}`}
                  defaultChecked={category.forRoles.includes(r)}
                />{' '}
                {r === 'PASSENGER' ? 'Passengers' : 'Drivers'}
              </label>
            ))}
          </fieldset>
          <label htmlFor={`${id}-p`} style={styles.label}>
            Default priority
          </label>
          <select
            id={`${id}-p`}
            name="defaultPriority"
            defaultValue={category.defaultPriority}
            style={styles.select}
          >
            {priorities.map((p) => (
              <option key={p.code} value={p.code}>
                {p.label}
              </option>
            ))}
          </select>
          <label htmlFor={`${id}-a`} style={styles.label}>
            Offered to people
          </label>
          <select
            id={`${id}-a`}
            name="isActive"
            defaultValue={String(category.isActive)}
            style={styles.select}
          >
            <option value="true">Yes</option>
            <option value="false">No, hide it</option>
          </select>
          <label htmlFor={`${id}-o`} style={styles.label}>
            Order in the list
          </label>
          <input
            id={`${id}-o`}
            name="sortOrder"
            inputMode="numeric"
            defaultValue={category.sortOrder}
            style={styles.input}
          />
          <label htmlFor={`${id}-r`} style={styles.label}>
            Reason (kept in the audit log)
          </label>
          <input
            id={`${id}-r`}
            name="reason"
            required
            minLength={3}
            maxLength={300}
            style={styles.input}
          />
          <div style={styles.buttonRow}>
            <button type="submit" disabled={pending} style={styles.buttonPrimary}>
              {pending ? 'Saving…' : 'Save category'}
            </button>
            <button type="button" onClick={() => setOpen(false)} style={styles.buttonSecondary}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <Status state={state} />
    </div>
  );
}

/** One priority level: its name, how long an unanswered ticket may wait, and what it is raised to after that. */
export function SupportPriorityEditor({
  priority,
  higher,
  canManage,
}: {
  priority: SupportPriority;
  /** The levels more urgent than this one (an escalation can only go up). */
  higher: SupportPriority[];
  canManage: boolean;
}) {
  const [state, action, pending] = useActionState(updateSupportPriorityAction, {});
  const [open, setOpen] = useState(false);
  const id = useId();
  useWhenDone(
    state,
    (s) => !!s.done,
    () => setOpen(false),
  );
  const target = higher.find((p) => p.code === priority.escalatesTo);
  return (
    <div style={column}>
      <p style={{ margin: 0 }}>
        <strong>{priority.label}</strong> ({priority.code}): first answer within{' '}
        {priority.firstResponseHours} hour
        {priority.firstResponseHours === 1 ? '' : 's'}; after that{' '}
        {target ? `raised to ${target.label} and the team is told` : 'only the team is told'}.
      </p>
      {canManage && !open ? (
        <div style={styles.buttonRow}>
          <button type="button" onClick={() => setOpen(true)} style={styles.buttonSecondary}>
            Edit {priority.label}…
          </button>
        </div>
      ) : null}
      {canManage && open ? (
        <form action={action} style={column}>
          <input type="hidden" name="code" value={priority.code} />
          <label htmlFor={`${id}-l`} style={styles.label}>
            Name
          </label>
          <input
            id={`${id}-l`}
            name="label"
            defaultValue={priority.label}
            maxLength={40}
            style={styles.input}
          />
          <label htmlFor={`${id}-h`} style={styles.label}>
            Hours allowed before the first answer
          </label>
          <input
            id={`${id}-h`}
            name="firstResponseHours"
            inputMode="numeric"
            defaultValue={priority.firstResponseHours}
            style={styles.input}
          />
          <label htmlFor={`${id}-e`} style={styles.label}>
            Then raise it to
          </label>
          <select
            id={`${id}-e`}
            name="escalatesTo"
            defaultValue={priority.escalatesTo ?? ''}
            style={styles.select}
          >
            <option value="">Nothing: only tell the team</option>
            {higher.map((p) => (
              <option key={p.code} value={p.code}>
                {p.label}
              </option>
            ))}
          </select>
          <label htmlFor={`${id}-r`} style={styles.label}>
            Reason (kept in the audit log)
          </label>
          <input
            id={`${id}-r`}
            name="reason"
            required
            minLength={3}
            maxLength={300}
            style={styles.input}
          />
          <div style={styles.buttonRow}>
            <button type="submit" disabled={pending} style={styles.buttonPrimary}>
              {pending ? 'Saving…' : 'Save priority'}
            </button>
            <button type="button" onClick={() => setOpen(false)} style={styles.buttonSecondary}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <Status state={state} />
    </div>
  );
}
