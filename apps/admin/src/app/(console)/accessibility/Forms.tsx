'use client';

import type { VehicleAttributeInfo } from '@yatri/types';
import { useActionState, useId } from 'react';

import { styles } from '../drivers/styles';
import { Checkbox, Confirmed, Feedback, Field } from '../ui/FormParts';
import { decideAction, saveAttributeAction } from './actions';

const column = { display: 'flex', flexDirection: 'column', gap: 8 } as const;

/** Approve or reject one claim. The name of the feature and vehicle is in the label so a screen reader hears which. */
export function DecideForm({
  vehicleId,
  code,
  what,
}: {
  vehicleId: string;
  code: string;
  what: string;
}) {
  const [state, action, pending] = useActionState(decideAction, {});
  const id = useId();
  return (
    <form action={action} style={column} aria-label={`Decision on ${what}`}>
      <input type="hidden" name="vehicleId" value={vehicleId} />
      <input type="hidden" name="code" value={code} />
      <label htmlFor={id} style={styles.label}>
        Decision for {what}
      </label>
      <select id={id} name="decision" defaultValue="APPROVED" style={styles.select}>
        <option value="APPROVED">Approve: the vehicle has this feature</option>
        <option value="REJECTED">Do not approve</option>
      </select>
      <Confirmed
        pending={pending}
        label="Save the decision"
        consequence="The driver is told, and can only be offered rides that need this feature once it is approved."
      />
      <Feedback state={state} />
    </form>
  );
}

/** Add a feature (no `attribute`) or edit one. Core features cannot be switched off. */
export function AttributeForm({ attribute }: { attribute?: VehicleAttributeInfo }) {
  const [state, action, pending] = useActionState(saveAttributeAction, {});
  return (
    <form action={action} style={column}>
      {attribute ? (
        <>
          <input type="hidden" name="code" value={attribute.code} />
          <input type="hidden" name="version" value={attribute.version} />
        </>
      ) : null}
      <Field name="label" label="Name" defaultValue={attribute?.label} required />
      <Field
        name="help"
        label="What it means"
        defaultValue={attribute?.help}
        required
        hint="Drivers read this when they declare the feature."
      />
      <Checkbox
        name="requiresApproval"
        label="A claim only counts once an administrator approves it"
        checked={attribute?.requiresApproval ?? true}
      />
      {attribute?.core ? (
        <>
          <p style={{ margin: 0, fontSize: 14 }}>
            This feature is needed to match passengers, so it cannot be switched off.
          </p>
          <input type="hidden" name="active" value="on" />
        </>
      ) : (
        <Checkbox
          name="active"
          label="Drivers can declare this feature"
          checked={attribute?.active ?? true}
        />
      )}
      <Confirmed
        pending={pending}
        label={attribute ? 'Save the feature' : 'Add the feature'}
        consequence={
          attribute
            ? 'If approval is now required, vehicles that were counted go back to waiting for approval.'
            : 'Drivers will be able to declare it for their vehicle.'
        }
      />
      <Feedback state={state} />
    </form>
  );
}
