'use client';

import {
  describeSettingValue,
  settingDef,
  type AdminVehicleCategory,
  type PlatformSettingInfo,
  formatWhen,
} from '@yatri/types';
import { useActionState, useEffect, useId, useRef, useState } from 'react';

import { styles } from '../drivers/styles';
import { useWhenDone } from '../ui/useWhenDone';
import { updateCategoryAction, updateSettingAction } from './actions';

const toText = (v: PlatformSettingInfo['value']) => (Array.isArray(v) ? v.join(', ') : String(v));

/**
 * Edit one setting in three steps, all in the page: change the value; review it ("from A to B") with
 * the reason; confirm. Changes to fares and rules affect real rides, so nothing is saved by a single
 * press. A stale edit (someone else saved first) is refused by the server and the page reloads the
 * new value.
 */
export function SettingEditor({
  setting,
  canManage,
}: {
  setting: PlatformSettingInfo;
  canManage: boolean;
}) {
  const def = settingDef(setting.key);
  const [state, action, pending] = useActionState(updateSettingAction, {});
  const [step, setStep] = useState<'view' | 'edit' | 'review'>('view');
  const [value, setValue] = useState(toText(setting.value));
  const [reason, setReason] = useState('');
  const valueId = useId();
  const reasonId = useId();
  const opener = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLElement | null>(null);
  const was = useRef<'view' | 'edit' | 'review'>('view');

  useEffect(() => {
    if (step !== 'view') first.current?.focus();
    else if (was.current !== 'view') opener.current?.focus();
    was.current = step;
  }, [step]);
  useWhenDone(
    state,
    (s) => !!s.done,
    () => {
      setStep('view');
      setReason('');
    },
  );
  // The server's value may have changed under us (another admin, or our own save): show the new one.
  const [shownVersion, setShownVersion] = useState(setting.version);
  if (shownVersion !== setting.version) {
    setShownVersion(setting.version);
    setValue(toText(setting.value));
  }

  if (!def) return null;
  const shownNow = describeSettingValue(def, setting.value);
  const newText = def.kind === 'boolean' ? (value === 'true' ? 'on' : 'off') : value;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={{ margin: 0 }}>
        <strong>{shownNow}</strong>
        {setting.overridden ? '' : ' (default)'}
        {setting.updatedAt
          ? `. Last changed ${formatWhen(setting.updatedAt)}${
              setting.updatedByName ? ` by ${setting.updatedByName}` : ''
            }.`
          : '.'}
      </p>
      {canManage && step === 'view' ? (
        <div style={styles.buttonRow}>
          <button
            ref={opener}
            type="button"
            onClick={() => setStep('edit')}
            style={styles.buttonSecondary}
          >
            Change {setting.label.toLowerCase()}…
          </button>
        </div>
      ) : null}

      {canManage && step !== 'view' ? (
        <form
          action={action}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setStep('view');
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          <input type="hidden" name="key" value={setting.key} />
          <input type="hidden" name="expectedVersion" value={setting.version} />
          <input type="hidden" name="value" value={value} />
          <input type="hidden" name="reason" value={reason} />
          {step === 'edit' ? (
            <>
              <label htmlFor={valueId} style={styles.label}>
                {setting.label}
                {setting.unit ? ` (${setting.unit})` : ''}
              </label>
              {def.kind === 'boolean' ? (
                <select
                  id={valueId}
                  ref={(el) => {
                    first.current = el;
                  }}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  style={styles.select}
                >
                  <option value="true">On</option>
                  <option value="false">Off</option>
                </select>
              ) : (
                <input
                  id={valueId}
                  ref={(el) => {
                    first.current = el;
                  }}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  inputMode={def.kind === 'text' ? 'text' : 'decimal'}
                  style={styles.input}
                />
              )}
              <label htmlFor={reasonId} style={styles.label}>
                Reason (kept in the audit log)
              </label>
              <textarea
                id={reasonId}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={300}
                style={styles.textarea}
              />
              <div style={styles.buttonRow}>
                <button
                  type="button"
                  disabled={reason.trim().length < 3}
                  onClick={() => setStep('review')}
                  style={styles.buttonPrimary}
                >
                  Review this change
                </button>
                {setting.overridden ? (
                  <button
                    type="submit"
                    name="reset"
                    value="true"
                    disabled={pending || reason.trim().length < 3}
                    style={styles.buttonSecondary}
                  >
                    Put back the default ({describeSettingValue(def, setting.defaultValue)})
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setStep('view')}
                  style={styles.buttonSecondary}
                >
                  Cancel
                </button>
              </div>
              {reason.trim().length < 3 ? (
                <p style={{ margin: 0, fontSize: 13 }}>Write a reason to continue.</p>
              ) : null}
            </>
          ) : (
            <div role="group" aria-label="Confirm this change" style={{ display: 'grid', gap: 8 }}>
              <h4
                tabIndex={-1}
                ref={(el) => {
                  first.current = el;
                }}
                style={{ margin: 0, fontSize: 16 }}
              >
                Are you sure? This changes {setting.label.toLowerCase()} from {shownNow} to{' '}
                {newText}
                {def.unit && def.kind !== 'boolean' ? ` ${def.unit}` : ''} for everyone, straight
                away.
              </h4>
              <p style={{ margin: 0 }}>Reason: {reason}</p>
              <div style={styles.buttonRow}>
                <button type="submit" disabled={pending} style={styles.buttonDanger}>
                  {pending ? 'Saving…' : 'Yes, change it'}
                </button>
                <button
                  type="button"
                  onClick={() => setStep('edit')}
                  style={styles.buttonSecondary}
                >
                  Go back and edit
                </button>
              </div>
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

/** Edit a vehicle category: label, order, availability and how its fare differs from the default. */
export function CategoryEditor({
  category,
  canManage,
}: {
  category: AdminVehicleCategory;
  canManage: boolean;
}) {
  const [state, action, pending] = useActionState(updateCategoryAction, {});
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const reasonId = useId();
  const [reason, setReason] = useState('');
  useWhenDone(
    state,
    (s) => !!s.done,
    () => {
      setOpen(false);
      setConfirming(false);
      setReason('');
    },
  );

  const fare = (n: number | null) => (n === null ? 'platform default' : String(n));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={{ margin: 0 }}>
        <strong>{category.label}</strong> ({category.code}):{' '}
        {category.isActive ? 'can be requested' : 'switched off'}, order {category.sortOrder},{' '}
        {category.driversUsing} vehicle{category.driversUsing === 1 ? '' : 's'}. Base fare{' '}
        {fare(category.baseFareNpr)}, per km {fare(category.perKmNpr)}, per minute{' '}
        {fare(category.perMinuteNpr)}, minimum {fare(category.minimumFareNpr)}.
      </p>
      {canManage && !open ? (
        <div style={styles.buttonRow}>
          <button type="button" onClick={() => setOpen(true)} style={styles.buttonSecondary}>
            Edit {category.label}…
          </button>
        </div>
      ) : null}
      {canManage && open ? (
        <form action={action} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input type="hidden" name="categoryId" value={category.id} />
          <label style={styles.label}>
            Name
            <input name="label" defaultValue={category.label} maxLength={40} style={styles.input} />
          </label>
          <label style={styles.label}>
            Order in the list
            <input
              name="sortOrder"
              type="number"
              defaultValue={category.sortOrder}
              style={styles.input}
            />
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
            <input type="hidden" name="isActive" value="false" />
            <input
              type="checkbox"
              name="isActive"
              value="true"
              defaultChecked={category.isActive}
            />
            Can be requested by passengers
          </label>
          <p style={{ margin: 0, fontSize: 13 }}>
            Leave a fare figure blank to use the platform default from Fare parameters.
          </p>
          {(
            [
              ['baseFareNpr', 'Base fare (NPR)', category.baseFareNpr],
              ['perKmNpr', 'Price per kilometre (NPR)', category.perKmNpr],
              ['perMinuteNpr', 'Price per minute (NPR)', category.perMinuteNpr],
              ['minimumFareNpr', 'Minimum fare (NPR)', category.minimumFareNpr],
            ] as const
          ).map(([name, label, v]) => (
            <label key={name} style={styles.label}>
              {label}
              <input name={name} defaultValue={v ?? ''} inputMode="decimal" style={styles.input} />
            </label>
          ))}
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
            <div role="group" aria-label="Confirm this change" style={{ display: 'grid', gap: 8 }}>
              <p style={{ margin: 0 }}>
                <strong>Are you sure?</strong> Fare and availability changes apply to every new ride
                request in this category straight away.
              </p>
              <div style={styles.buttonRow}>
                <button type="submit" disabled={pending} style={styles.buttonDanger}>
                  {pending ? 'Saving…' : 'Yes, save these changes'}
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
