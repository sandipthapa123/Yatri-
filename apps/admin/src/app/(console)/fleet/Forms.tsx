'use client';

import {
  FLEET_STATUSES,
  FLEET_STATUS_LABELS,
  OPERATIONAL_LABELS,
  VEHICLE_LIFECYCLE_LABELS,
  type FleetDetail,
  type FleetInfo,
  type OperationalStatus,
  type ServiceRecordInfo,
  type VehicleLifecycle,
} from '@yatri/types';
import { useActionState, useId, useState } from 'react';

import { styles } from '../drivers/styles';
import { Confirmed, Feedback, Field, Select } from '../ui/FormParts';
import { useWhenDone } from '../ui/useWhenDone';
import {
  assignVehicleAction,
  checkNowAction,
  driverFleetAction,
  fleetAction,
  fleetVehicleAction,
  inspectionAction,
  lifecycleAction,
  maintenanceCompleteAction,
  maintenanceStartAction,
  operationalAction,
  serviceLogAction,
  unassignAction,
} from './actions';

const column = { display: 'flex', flexDirection: 'column', gap: 8 } as const;
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Create a fleet, or edit one (name, contact, status). A status other than active stops its vehicles and drivers taking rides. */
export function FleetForm({ fleet }: { fleet?: FleetInfo | FleetDetail }) {
  const [state, action, pending] = useActionState(fleetAction, {});
  const [open, setOpen] = useState(!fleet);
  const statusId = useId();
  useWhenDone(
    state,
    (s) => !!s.done,
    () => fleet && setOpen(false),
  );
  if (!open) {
    return (
      <div style={styles.buttonRow}>
        <button type="button" onClick={() => setOpen(true)} style={styles.buttonSecondary}>
          Edit {fleet?.name}…
        </button>
        <Feedback state={state} />
      </div>
    );
  }
  return (
    <form action={action} style={column}>
      {fleet ? <input type="hidden" name="id" value={fleet.id} /> : null}
      <Field name="name" label="Fleet name" defaultValue={fleet?.name} required />
      <Field name="contactName" label="Contact person" defaultValue={fleet?.contactName} />
      <Field
        name="contactPhone"
        label="Contact phone (international, for example +9779812345678)"
        defaultValue={fleet?.contactPhone}
        type="tel"
      />
      <Field
        name="contactEmail"
        label="Contact email"
        defaultValue={fleet?.contactEmail}
        type="email"
      />
      <label htmlFor={statusId} style={styles.label}>
        Status
      </label>
      <select
        id={statusId}
        name="status"
        defaultValue={fleet?.status ?? 'ACTIVE'}
        style={styles.select}
      >
        {FLEET_STATUSES.map((s) => (
          <option key={s} value={s}>
            {FLEET_STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      <Confirmed
        pending={pending}
        label={fleet ? 'Save this fleet' : 'Create this fleet'}
        consequence={
          fleet
            ? 'If the status is not active, its vehicles and drivers are not offered rides and online drivers are taken offline.'
            : 'The fleet is created with this status.'
        }
      />
      <Feedback state={state} />
    </form>
  );
}

export function FleetVehicleForm({
  fleetId,
  categories,
}: {
  fleetId: string;
  categories: Array<{ id: string; label: string }>;
}) {
  const [state, action, pending] = useActionState(fleetVehicleAction, {});
  return (
    <form action={action} style={column}>
      <input type="hidden" name="fleetId" value={fleetId} />
      <Field name="registrationNumber" label="Registration number" required />
      <Select
        name="categoryId"
        label="Vehicle type"
        value={null}
        blank="Choose a type"
        items={categories}
      />
      <Field name="make" label="Make" required />
      <Field name="model" label="Model" required />
      <Field name="year" label="Year" type="number" required />
      <Field name="color" label="Colour" required />
      <Field name="registrationExpiryDate" label="Registration valid until" type="date" />
      <Field name="insuranceExpiryDate" label="Insurance valid until" type="date" />
      <div style={styles.buttonRow}>
        <button type="submit" disabled={pending} style={styles.buttonPrimary}>
          {pending ? 'Adding…' : 'Add this vehicle'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

/** Move a vehicle along its lifecycle: only the moves the server says are legal from where it is. */
export function LifecycleForm({
  vehicleId,
  current,
  allowedNext,
}: {
  vehicleId: string;
  current: VehicleLifecycle;
  allowedNext: VehicleLifecycle[];
}) {
  const [state, action, pending] = useActionState(lifecycleAction, {});
  const [to, setTo] = useState<string>(allowedNext[0] ?? '');
  const toId = useId();
  if (allowedNext.length === 0) {
    return (
      <p style={{ margin: 0 }}>
        This vehicle is {VEHICLE_LIFECYCLE_LABELS[current].toLowerCase()} and cannot change.
      </p>
    );
  }
  return (
    <form action={action} style={column}>
      <input type="hidden" name="vehicleId" value={vehicleId} />
      <label htmlFor={toId} style={styles.label}>
        Change status to
      </label>
      <select
        id={toId}
        name="to"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        style={styles.select}
      >
        {allowedNext.map((s) => (
          <option key={s} value={s}>
            {VEHICLE_LIFECYCLE_LABELS[s]}
          </option>
        ))}
      </select>
      <Confirmed
        pending={pending}
        label="Change status"
        consequence={
          to === 'RETIRED'
            ? 'A retired vehicle can never be used again. The driver is told.'
            : to === 'ACTIVE'
              ? 'The vehicle can be used for rides again. The driver is told.'
              : 'The vehicle cannot be used for rides while it is in this status, and an online driver with no other usable vehicle is taken offline. The driver is told.'
        }
      />
      <Feedback state={state} />
    </form>
  );
}

export function AssignVehicleForm({
  vehicleId,
  drivers,
}: {
  vehicleId: string;
  drivers: Array<{ id: string; label: string }>;
}) {
  const [state, action, pending] = useActionState(assignVehicleAction, {});
  if (drivers.length === 0) {
    return (
      <p style={{ margin: 0 }}>
        This fleet has no drivers yet. Add a driver to the fleet from the driver&apos;s page.
      </p>
    );
  }
  return (
    <form action={action} style={column}>
      <input type="hidden" name="vehicleId" value={vehicleId} />
      <Select
        name="driverId"
        label="Assign to driver"
        value={null}
        blank="Choose a driver"
        items={drivers}
      />
      <div style={styles.buttonRow}>
        <button type="submit" disabled={pending} style={styles.buttonPrimary}>
          {pending ? 'Assigning…' : 'Assign this vehicle'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function UnassignForm({ vehicleId }: { vehicleId: string }) {
  const [state, action, pending] = useActionState(unassignAction, {});
  return (
    <form action={action} style={column}>
      <input type="hidden" name="vehicleId" value={vehicleId} />
      <Confirmed
        pending={pending}
        label="Unassign this vehicle"
        consequence="The driver can no longer use this vehicle and is told. This is refused while they are on a ride."
      />
      <Feedback state={state} />
    </form>
  );
}

/** Suspend, restrict or reinstate a driver: a status of its own, apart from account, verification and availability. */
export function OperationalForm({
  driverId,
  current,
  allowedNext,
}: {
  driverId: string;
  current: OperationalStatus;
  allowedNext: OperationalStatus[];
}) {
  const [state, action, pending] = useActionState(operationalAction, {});
  const [to, setTo] = useState<string>(allowedNext[0] ?? '');
  const [untilLocal, setUntilLocal] = useState('');
  const toId = useId();
  const untilId = useId();
  return (
    <form action={action} style={column}>
      <input type="hidden" name="driverId" value={driverId} />
      <p style={{ margin: 0 }}>
        Now: <strong>{OPERATIONAL_LABELS[current]}</strong>.
      </p>
      <label htmlFor={toId} style={styles.label}>
        Change to
      </label>
      <select
        id={toId}
        name="to"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        style={styles.select}
      >
        {allowedNext.map((s) => (
          <option key={s} value={s}>
            {s === 'ACTIVE' ? 'Active (reinstate)' : OPERATIONAL_LABELS[s]}
          </option>
        ))}
      </select>
      {to !== 'ACTIVE' ? (
        <>
          <label htmlFor={untilId} style={styles.label}>
            Lasts until (optional; it then ends by itself)
          </label>
          <input
            id={untilId}
            type="datetime-local"
            value={untilLocal}
            onChange={(e) => setUntilLocal(e.target.value)}
            style={styles.input}
          />
          <input
            type="hidden"
            name="until"
            value={untilLocal ? new Date(untilLocal).toISOString() : ''}
          />
        </>
      ) : null}
      <Confirmed
        pending={pending}
        label="Change driver status"
        consequence={
          to === 'SUSPENDED'
            ? 'The driver cannot take rides at all and is taken offline now. They are told why.'
            : to === 'RESTRICTED'
              ? 'The driver can take only a limited number of rides a day. They are told why.'
              : 'The driver can take rides again and is told.'
        }
      />
      <Feedback state={state} />
    </form>
  );
}

export function DriverFleetForm({
  driverId,
  current,
  fleets,
}: {
  driverId: string;
  current: string | null;
  fleets: Array<{ id: string; name: string }>;
}) {
  const [state, action, pending] = useActionState(driverFleetAction, {});
  return (
    <form action={action} style={column}>
      <input type="hidden" name="driverId" value={driverId} />
      <Select
        name="fleetId"
        label="Fleet"
        value={current}
        blank="No fleet (independent)"
        items={fleets.map((f) => ({ id: f.id, label: f.name }))}
      />
      <Confirmed
        pending={pending}
        label="Change fleet"
        consequence="The driver's fleet changes. A driver who drives a vehicle of another fleet cannot be moved until it is unassigned."
      />
      <Feedback state={state} />
    </form>
  );
}

export function MaintenanceStartForm({ vehicleId }: { vehicleId: string }) {
  const [state, action, pending] = useActionState(maintenanceStartAction, {});
  return (
    <form action={action} style={column}>
      <input type="hidden" name="vehicleId" value={vehicleId} />
      <Field name="notes" label="What needs doing (optional)" />
      <div style={styles.buttonRow}>
        <button type="submit" disabled={pending} style={styles.buttonSecondary}>
          {pending ? 'Starting…' : 'Take out of service for maintenance'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function MaintenanceCompleteForm({ record }: { record: ServiceRecordInfo }) {
  const [state, action, pending] = useActionState(maintenanceCompleteAction, {});
  const returnId = useId();
  return (
    <form action={action} style={column}>
      <input type="hidden" name="recordId" value={record.id} />
      <input type="hidden" name="vehicleId" value={record.vehicleId} />
      <Field
        name="performedOn"
        label="Service date"
        type="date"
        defaultValue={todayLocal()}
        required
      />
      <Field name="nextDueOn" label="Next service due (optional)" type="date" />
      <Field name="notes" label="Notes (optional)" />
      <label htmlFor={returnId} style={styles.label}>
        Then the vehicle is
      </label>
      <select id={returnId} name="returnTo" defaultValue="ACTIVE" style={styles.select}>
        <option value="ACTIVE">Active (back in service)</option>
        <option value="INACTIVE">Inactive (kept off the road)</option>
      </select>
      <div style={styles.buttonRow}>
        <button type="submit" disabled={pending} style={styles.buttonPrimary}>
          {pending ? 'Saving…' : 'Complete this maintenance'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function InspectionForm({ vehicleId }: { vehicleId: string }) {
  const [state, action, pending] = useActionState(inspectionAction, {});
  const resultId = useId();
  return (
    <form action={action} style={column}>
      <input type="hidden" name="vehicleId" value={vehicleId} />
      <Field
        name="performedOn"
        label="Inspection date"
        type="date"
        defaultValue={todayLocal()}
        required
      />
      <label htmlFor={resultId} style={styles.label}>
        Result
      </label>
      <select id={resultId} name="result" defaultValue="PASSED" style={styles.select}>
        <option value="PASSED">Passed</option>
        <option value="FAILED">Failed (the vehicle is taken out of service for repair)</option>
      </select>
      <Field name="nextDueOn" label="Next inspection due (optional)" type="date" />
      <Field name="notes" label="Notes (optional)" />
      <div style={styles.buttonRow}>
        <button type="submit" disabled={pending} style={styles.buttonSecondary}>
          {pending ? 'Saving…' : 'Record inspection'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function ServiceLogForm({ vehicleId }: { vehicleId: string }) {
  const [state, action, pending] = useActionState(serviceLogAction, {});
  return (
    <form action={action} style={column}>
      <input type="hidden" name="vehicleId" value={vehicleId} />
      <Field
        name="performedOn"
        label="Service date"
        type="date"
        defaultValue={todayLocal()}
        required
      />
      <Field name="nextDueOn" label="Next service due (optional)" type="date" />
      <Field name="notes" label="Notes (optional)" />
      <div style={styles.buttonRow}>
        <button type="submit" disabled={pending} style={styles.buttonSecondary}>
          {pending ? 'Saving…' : 'Record a service (vehicle stays in service)'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

/** Run the document, licence and service-date check now, instead of waiting for the hourly one. */
export function CheckNowButton() {
  const [state, action, pending] = useActionState(checkNowAction, {});
  return (
    <form action={action} style={column}>
      <div style={styles.buttonRow}>
        <button type="submit" disabled={pending} style={styles.buttonSecondary}>
          {pending ? 'Checking…' : 'Check documents and dates now'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}
