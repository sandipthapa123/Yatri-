'use client';

import {
  DAY_NAMES,
  INCENTIVE_KINDS,
  INCENTIVE_KIND_LABELS,
  INCENTIVE_PERIODS,
  ZONE_KINDS,
  ZONE_KIND_LABELS,
  polygonToText,
  type IncentiveRuleInfo,
  type PricingRuleInfo,
  type TimeWindow,
  type ZoneDef,
} from '@yatri/types';
import { useActionState, useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { styles } from '../drivers/styles';
import { useWhenDone } from '../ui/useWhenDone';
import { incentiveAction, pricingRuleAction, zoneAction, type OpsActionState } from './actions';

const column = { display: 'flex', flexDirection: 'column', gap: 8 } as const;

function Feedback({ state }: { state: OpsActionState }) {
  return (
    <div role="status" aria-live="polite">
      {state.error ? <p style={styles.errorText}>Problem: {state.error}</p> : null}
      {state.done ? <p style={{ margin: 0, fontSize: 14 }}>{state.done}</p> : null}
    </div>
  );
}

export interface Options {
  zones: Array<{ id: string; name: string; isActive: boolean }>;
  categories: Array<{ id: string; label: string }>;
}

const pad = (n: number) => String(n).padStart(2, '0');
const timeValue = (m: number | null) =>
  m === null ? '' : `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
/** An ISO instant as the value of a datetime-local input, in the viewer's own time. */
const localValue = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * The time a rule applies: days, hours of the day, and optionally the exact dates of a special event. The
 * event dates are typed in the administrator's own time and sent as exact instants (hidden fields).
 */
function WindowFields({ window: w }: { window: TimeWindow }) {
  const id = useId();
  const [from, setFrom] = useState(localValue(w.startsAt));
  const [until, setUntil] = useState(localValue(w.endsAt));
  const iso = (v: string) => (v ? new Date(v).toISOString() : '');
  return (
    <>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={styles.label}>Days (none ticked means every day)</legend>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {DAY_NAMES.map((name, i) => (
            <label key={name}>
              <input
                type="checkbox"
                name={`day_${i + 1}`}
                defaultChecked={(w.daysOfWeek ?? []).includes(i + 1)}
              />{' '}
              {name}
            </label>
          ))}
        </div>
      </fieldset>
      <label htmlFor={`${id}-s`} style={styles.label}>
        From time of day (empty means all day)
      </label>
      <input
        id={`${id}-s`}
        name="startTime"
        type="time"
        defaultValue={timeValue(w.startMinute)}
        style={styles.input}
      />
      <label htmlFor={`${id}-e`} style={styles.label}>
        Until time of day (earlier than the start means it runs past midnight)
      </label>
      <input
        id={`${id}-e`}
        name="endTime"
        type={w.endMinute === 1440 ? 'text' : 'time'}
        defaultValue={w.endMinute === 1440 ? '24:00' : timeValue(w.endMinute)}
        style={styles.input}
      />
      <label htmlFor={`${id}-a`} style={styles.label}>
        Special event starts (your time; empty for no limit)
      </label>
      <input
        id={`${id}-a`}
        type="datetime-local"
        value={from}
        onChange={(e) => setFrom(e.target.value)}
        style={styles.input}
      />
      <input type="hidden" name="startsAt" value={iso(from)} />
      <label htmlFor={`${id}-b`} style={styles.label}>
        Special event ends (your time; empty for no limit)
      </label>
      <input
        id={`${id}-b`}
        type="datetime-local"
        value={until}
        onChange={(e) => setUntil(e.target.value)}
        style={styles.input}
      />
      <input type="hidden" name="endsAt" value={iso(until)} />
    </>
  );
}

/**
 * A change that affects real riders or drivers is confirmed in the page first: the sentence says what it
 * will do, focus moves to it, and Escape goes back. The reason is kept in the audit log.
 */
function Confirmed({
  pending,
  consequence,
  label,
  children,
}: {
  pending: boolean;
  consequence: string;
  label: string;
  children?: ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const reasonId = useId();
  useEffect(() => {
    if (confirming) heading.current?.focus();
  }, [confirming]);
  return (
    <>
      {children}
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
      {confirming ? (
        <div
          role="group"
          aria-label="Confirm this change"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setConfirming(false);
          }}
          style={column}
        >
          <h4 ref={heading} tabIndex={-1} style={{ margin: 0, fontSize: 16 }}>
            Are you sure? {consequence}
          </h4>
          <div style={styles.buttonRow}>
            <button type="submit" disabled={pending} style={styles.buttonDanger}>
              {pending ? 'Saving…' : 'Yes, save it'}
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
          <button type="button" onClick={() => setConfirming(true)} style={styles.buttonPrimary}>
            {label}…
          </button>
        </div>
      )}
    </>
  );
}

function Checkbox({ name, label, checked }: { name: string; label: string; checked: boolean }) {
  return (
    <label>
      <input type="checkbox" name={name} defaultChecked={checked} /> {label}
    </label>
  );
}

function Select({
  name,
  label,
  value,
  blank,
  items,
}: {
  name: string;
  label: string;
  value: string | null;
  blank: string;
  items: Array<{ id: string; label: string }>;
}) {
  const id = useId();
  return (
    <>
      <label htmlFor={id} style={styles.label}>
        {label}
      </label>
      <select id={id} name={name} defaultValue={value ?? ''} style={styles.select}>
        <option value="">{blank}</option>
        {items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.label}
          </option>
        ))}
      </select>
    </>
  );
}

function Field({
  name,
  label,
  defaultValue,
  type = 'text',
  required = false,
  hint,
}: {
  name: string;
  label: string;
  defaultValue?: string | number | null;
  type?: string;
  required?: boolean;
  hint?: string;
}) {
  const id = useId();
  return (
    <>
      <label htmlFor={id} style={styles.label}>
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue ?? ''}
        aria-describedby={hint ? `${id}-h` : undefined}
        style={styles.input}
      />
      {hint ? (
        <p id={`${id}-h`} style={{ margin: 0, fontSize: 13, color: 'var(--color-text-secondary)' }}>
          {hint}
        </p>
      ) : null}
    </>
  );
}

/** Create or edit a zone. Its boundary is typed as one "latitude, longitude" corner per line. */
export function ZoneForm({ zone }: { zone?: ZoneDef }) {
  const [state, action, pending] = useActionState(zoneAction, {});
  const [open, setOpen] = useState(!zone);
  const areaId = useId();
  const kindId = useId();
  const noteId = useId();
  useWhenDone(
    state,
    (s) => !!s.done,
    () => zone && setOpen(false),
  );
  if (!open) {
    return (
      <div style={styles.buttonRow}>
        <button type="button" onClick={() => setOpen(true)} style={styles.buttonSecondary}>
          Edit {zone?.name}…
        </button>
        <Feedback state={state} />
      </div>
    );
  }
  return (
    <form action={action} style={column}>
      {zone ? <input type="hidden" name="id" value={zone.id} /> : null}
      <Field
        name="code"
        label="Code (capital letters, digits, underscores)"
        defaultValue={zone?.code}
        required
      />
      <Field name="name" label="Name" defaultValue={zone?.name} required />
      <label htmlFor={kindId} style={styles.label}>
        Kind
      </label>
      <select
        id={kindId}
        name="kind"
        defaultValue={zone?.kind ?? 'SERVICE_AREA'}
        style={styles.select}
      >
        {ZONE_KINDS.map((k) => (
          <option key={k} value={k}>
            {ZONE_KIND_LABELS[k]}
          </option>
        ))}
      </select>
      <label htmlFor={areaId} style={styles.label}>
        Boundary: one corner per line as latitude, longitude (at least three)
      </label>
      <textarea
        id={areaId}
        name="polygon"
        required
        rows={6}
        defaultValue={zone ? polygonToText(zone.polygon) : ''}
        style={styles.textarea}
      />
      <Checkbox
        name="pickupAllowed"
        label="Rides may start here"
        checked={zone?.pickupAllowed ?? true}
      />
      <Checkbox
        name="dropoffAllowed"
        label="Rides may end here"
        checked={zone?.dropoffAllowed ?? true}
      />
      <label htmlFor={noteId} style={styles.label}>
        Note shown to riders (optional, for example where the pickup point is)
      </label>
      <input
        id={noteId}
        name="note"
        maxLength={200}
        defaultValue={zone?.note ?? ''}
        style={styles.input}
      />
      <Field
        name="priority"
        label="Priority (higher wins where zones overlap)"
        defaultValue={zone?.priority ?? 0}
        type="number"
      />
      <Checkbox name="isActive" label="In use" checked={zone?.isActive ?? true} />
      <Confirmed
        pending={pending}
        label={zone ? 'Save this zone' : 'Create this zone'}
        consequence="Rides that start or end here are allowed or refused by this zone from the next request."
      />
      <Feedback state={state} />
    </form>
  );
}

export function PricingRuleForm({ rule, options }: { rule?: PricingRuleInfo; options: Options }) {
  const [state, action, pending] = useActionState(pricingRuleAction, {});
  const [open, setOpen] = useState(!rule);
  useWhenDone(
    state,
    (s) => !!s.done,
    () => rule && setOpen(false),
  );
  if (!open) {
    return (
      <div style={styles.buttonRow}>
        <button type="button" onClick={() => setOpen(true)} style={styles.buttonSecondary}>
          Edit {rule?.name}…
        </button>
        <Feedback state={state} />
      </div>
    );
  }
  return (
    <form action={action} style={column}>
      {rule ? <input type="hidden" name="id" value={rule.id} /> : null}
      <Field name="name" label="Name (for administrators)" defaultValue={rule?.name} required />
      <Field
        name="label"
        label="Words shown to riders beside the price (for example Airport rush)"
        defaultValue={rule?.label}
        required
      />
      <Field
        name="multiplier"
        label="Multiplier (1.5 means fares are one and a half times normal)"
        defaultValue={rule?.multiplier ?? 1.25}
        type="number"
        required
        hint="Between 1.05 and 10. The platform limit in Settings caps it further."
      />
      <Select
        name="zoneId"
        label="Only in this zone"
        value={rule?.zoneId ?? null}
        blank="Everywhere"
        items={options.zones.map((z) => ({
          id: z.id,
          label: z.isActive ? z.name : `${z.name} (not in use)`,
        }))}
      />
      <Select
        name="vehicleCategoryId"
        label="Only for this vehicle type"
        value={rule?.vehicleCategoryId ?? null}
        blank="Every vehicle type"
        items={options.categories}
      />
      <Field
        name="minDemandRatio"
        label="Only while requests per available driver are at least (empty: whatever the demand)"
        defaultValue={rule?.minDemandRatio}
        type="number"
      />
      <WindowFields
        window={
          rule?.window ?? {
            daysOfWeek: null,
            startMinute: null,
            endMinute: null,
            startsAt: null,
            endsAt: null,
          }
        }
      />
      <Checkbox name="isActive" label="In use" checked={rule?.isActive ?? true} />
      <Confirmed
        pending={pending}
        label={rule ? 'Save this rule' : 'Create this rule'}
        consequence="This changes what riders are charged for new requests, straight away. Rides already requested keep the price they were shown."
      />
      <Feedback state={state} />
    </form>
  );
}

export function IncentiveForm({ rule, options }: { rule?: IncentiveRuleInfo; options: Options }) {
  const [state, action, pending] = useActionState(incentiveAction, {});
  const [open, setOpen] = useState(!rule);
  const [kind, setKind] = useState<string>(rule?.kind ?? 'RIDE_TARGET');
  const kindId = useId();
  const periodId = useId();
  useWhenDone(
    state,
    (s) => !!s.done,
    () => rule && setOpen(false),
  );
  if (!open) {
    return (
      <div style={styles.buttonRow}>
        <button type="button" onClick={() => setOpen(true)} style={styles.buttonSecondary}>
          Edit {rule?.name}…
        </button>
        <Feedback state={state} />
      </div>
    );
  }
  return (
    <form action={action} style={column}>
      {rule ? <input type="hidden" name="id" value={rule.id} /> : null}
      <Field name="name" label="Name (drivers see it)" defaultValue={rule?.name} required />
      <label htmlFor={kindId} style={styles.label}>
        Kind of bonus
      </label>
      <select
        id={kindId}
        name="kind"
        value={kind}
        onChange={(e) => setKind(e.target.value)}
        style={styles.select}
      >
        {INCENTIVE_KINDS.map((k) => (
          <option key={k} value={k}>
            {INCENTIVE_KIND_LABELS[k]}
          </option>
        ))}
      </select>
      <Field
        name="bonusNpr"
        label="Bonus in rupees"
        defaultValue={rule?.bonusNpr ?? 100}
        type="number"
        required
      />
      {kind === 'RIDE_TARGET' ? (
        <>
          <label htmlFor={periodId} style={styles.label}>
            Target resets
          </label>
          <select
            id={periodId}
            name="period"
            defaultValue={rule?.period ?? 'DAILY'}
            style={styles.select}
          >
            {INCENTIVE_PERIODS.map((p) => (
              <option key={p} value={p}>
                {p === 'DAILY' ? 'Every day' : 'Every week (from Monday)'}
              </option>
            ))}
          </select>
          <Field
            name="targetRides"
            label="Completed rides needed"
            defaultValue={rule?.targetRides ?? 5}
            type="number"
            required
          />
        </>
      ) : null}
      <Select
        name="zoneId"
        label={kind === 'ZONE_BONUS' ? 'Zone (required)' : 'Only rides picked up in this zone'}
        value={rule?.zoneId ?? null}
        blank={kind === 'ZONE_BONUS' ? 'Choose a zone' : 'Anywhere'}
        items={options.zones.map((z) => ({ id: z.id, label: z.name }))}
      />
      <Select
        name="vehicleCategoryId"
        label="Only for this vehicle type"
        value={rule?.vehicleCategoryId ?? null}
        blank="Every vehicle type"
        items={options.categories}
      />
      <WindowFields
        window={
          rule?.window ?? {
            daysOfWeek: null,
            startMinute: null,
            endMinute: null,
            startsAt: null,
            endsAt: null,
          }
        }
      />
      <Checkbox name="isActive" label="In use" checked={rule?.isActive ?? true} />
      <Confirmed
        pending={pending}
        label={rule ? 'Save this bonus' : 'Create this bonus'}
        consequence="Drivers who complete qualifying rides from now on earn this bonus. Bonuses already earned are kept."
      />
      <Feedback state={state} />
    </form>
  );
}
