'use client';

import {
  ADMIN_PERMISSIONS,
  ADMIN_PERMISSION_LABELS,
  type AdminAccountRow,
  type AdminPermission,
} from '@yatri/types';
import { useActionState, useId, useState } from 'react';

import { styles } from '../drivers/styles';
import { useWhenDone } from '../ui/useWhenDone';
import { setPermissionsAction } from './actions';

/**
 * One administrator's permissions as a group of labelled checkboxes (each says what it allows).
 * Saving needs a reason and an in-page confirmation. You can only grant what you hold yourself
 * (the API refuses otherwise); permissions you lack are shown but cannot be switched on.
 */
export function PermissionsForm({
  admin,
  mine,
}: {
  admin: AdminAccountRow;
  mine: AdminPermission[];
}) {
  const [state, action, pending] = useActionState(setPermissionsAction, {});
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const reasonId = useId();
  useWhenDone(
    state,
    (s) => !!s.done,
    () => {
      setOpen(false);
      setConfirming(false);
      setReason('');
    },
  );

  const held = admin.permissions;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <p style={{ margin: 0 }}>
        {held.length === 0
          ? 'No permissions: can sign in and nothing else.'
          : held.map((p) => ADMIN_PERMISSION_LABELS[p].label).join(', ')}
      </p>
      {!admin.isYou && !open ? (
        <div style={styles.buttonRow}>
          <button type="button" onClick={() => setOpen(true)} style={styles.buttonSecondary}>
            Change permissions of {admin.fullName ?? admin.email ?? 'this administrator'}…
          </button>
        </div>
      ) : null}
      {admin.isYou ? (
        <p style={{ margin: 0, fontSize: 13 }}>You cannot change your own permissions.</p>
      ) : null}
      {open ? (
        <form action={action} style={{ display: 'grid', gap: 8 }}>
          <input type="hidden" name="adminId" value={admin.id} />
          <fieldset
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              display: 'grid',
              gap: 8,
            }}
          >
            <legend style={styles.label}>Permissions</legend>
            {ADMIN_PERMISSIONS.map((p) => {
              const can = mine.includes(p) || held.includes(p);
              return (
                <label
                  key={p}
                  style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 14 }}
                >
                  <input
                    type="checkbox"
                    name="permissions"
                    value={p}
                    defaultChecked={held.includes(p)}
                    disabled={!can}
                  />
                  <span>
                    <strong>{ADMIN_PERMISSION_LABELS[p].label}.</strong>{' '}
                    {ADMIN_PERMISSION_LABELS[p].help}
                    {!can ? ' You do not hold this, so you cannot grant it.' : ''}
                  </span>
                </label>
              );
            })}
          </fieldset>
          <label htmlFor={reasonId} style={styles.label}>
            Reason (kept in the audit log)
          </label>
          <textarea
            id={reasonId}
            name="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={3}
            maxLength={300}
            style={styles.textarea}
          />
          {confirming ? (
            <div
              role="group"
              aria-label="Confirm these permissions"
              style={{ display: 'grid', gap: 8 }}
            >
              <p style={{ margin: 0 }}>
                <strong>Are you sure?</strong> The change applies to their next request.
              </p>
              <div style={styles.buttonRow}>
                <button type="submit" disabled={pending} style={styles.buttonDanger}>
                  {pending ? 'Saving…' : 'Yes, save these permissions'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  style={styles.buttonSecondary}
                >
                  Go back and edit
                </button>
              </div>
            </div>
          ) : (
            <div style={styles.buttonRow}>
              <button
                type="button"
                disabled={reason.trim().length < 3}
                onClick={() => setConfirming(true)}
                style={styles.buttonPrimary}
              >
                Review and save
              </button>
              <button type="button" onClick={() => setOpen(false)} style={styles.buttonSecondary}>
                Cancel
              </button>
            </div>
          )}
        </form>
      ) : null}
      <div role="status" aria-live="polite">
        {state.error ? <p style={styles.errorText}>{state.error}</p> : null}
        {state.done ? <p style={{ margin: 0, fontSize: 14 }}>{state.done}</p> : null}
      </div>
    </div>
  );
}
