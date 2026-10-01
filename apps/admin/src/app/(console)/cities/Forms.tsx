'use client';

import {
  CITY_STATUS_LABELS,
  PROVINCES,
  describeCityHours,
  type CityDetail,
  type CityStatus,
} from '@yatri/types';
import { useRouter } from 'next/navigation';
import { useActionState, useId } from 'react';

import { styles } from '../drivers/styles';
import { Confirmed, Feedback, Field } from '../ui/FormParts';
import { useWhenDone } from '../ui/useWhenDone';
import {
  categoriesAction,
  createCityAction,
  documentsAction,
  hoursAction,
  paymentsAction,
  profileAction,
  settingsAction,
  cityStatusAction,
  zonesAction,
  type CityActionState,
} from './actions';

const column = { display: 'flex', flexDirection: 'column', gap: 8 } as const;

function Hidden({ city }: { city: Pick<CityDetail, 'id' | 'version'> }) {
  return (
    <>
      <input type="hidden" name="cityId" value={city.id} />
      <input type="hidden" name="expectedVersion" value={city.version} />
    </>
  );
}

function ProvinceSelect({ value }: { value?: string }) {
  const id = useId();
  return (
    <>
      <label htmlFor={id} style={styles.label}>
        Province
      </label>
      <select id={id} name="provinceCode" defaultValue={value ?? ''} required style={styles.select}>
        <option value="">Choose a province</option>
        {PROVINCES.map((p) => (
          <option key={p.code} value={p.code}>
            {p.name}
          </option>
        ))}
      </select>
    </>
  );
}

function ProfileFields({ city }: { city?: CityDetail }) {
  return (
    <>
      <Field name="name" label="City name" defaultValue={city?.name} required />
      <Field
        name="code"
        label="Short code (capital letters, digits, underscores)"
        defaultValue={city?.code}
        required
        hint="Used in reports and zone names; for example POKHARA."
      />
      <ProvinceSelect {...(city ? { value: city.provinceCode } : {})} />
      <Field
        name="centerLatitude"
        label="Map centre: latitude"
        defaultValue={city?.centerLatitude}
        required
        hint="Where a map starts for this city. It is not the boundary: the boundary is the service areas below."
      />
      <Field
        name="centerLongitude"
        label="Map centre: longitude"
        defaultValue={city?.centerLongitude}
        required
      />
      <Field
        name="timeZone"
        label="Time zone"
        defaultValue={city?.timeZone ?? 'Asia/Kathmandu'}
        required
        hint="Opening hours are read in this time zone."
      />
    </>
  );
}

/** Add a city. It starts as "coming soon" and opens only once it has a service area. */
export function CreateCityForm() {
  const router = useRouter();
  const [state, action, pending] = useActionState<CityActionState, FormData>(createCityAction, {});
  useWhenDone(
    state,
    (s) => !!s.createdId,
    () => state.createdId && router.push(`/cities/${state.createdId}`),
  );
  return (
    <form action={action} style={column}>
      <ProfileFields />
      <Confirmed
        pending={pending}
        label="Add this city"
        consequence="The city is created as coming soon. Nobody can ride there until you give it a service area and open it."
      />
      <Feedback state={state} />
    </form>
  );
}

export function ProfileForm({ city }: { city: CityDetail }) {
  const [state, action, pending] = useActionState<CityActionState, FormData>(profileAction, {});
  return (
    <form action={action} style={column}>
      <Hidden city={city} />
      <ProfileFields city={city} />
      <Confirmed
        pending={pending}
        label="Save the details"
        consequence="The name, code, province, map centre and time zone change for everyone. Opening hours follow the time zone."
      />
      <Feedback state={state} />
    </form>
  );
}

/** Open, pause or reopen. The moves offered are the server's answer (`allowedNext`). */
export function CityStatusForm({ city }: { city: CityDetail }) {
  const [state, action, pending] = useActionState<CityActionState, FormData>(cityStatusAction, {});
  const id = useId();
  if (city.allowedNext.length === 0) return null;
  return (
    <form action={action} style={column}>
      <Hidden city={city} />
      <label htmlFor={id} style={styles.label}>
        Change the status
      </label>
      <select id={id} name="to" defaultValue={city.allowedNext[0]} style={styles.select}>
        {city.allowedNext.map((s: CityStatus) => (
          <option key={s} value={s}>
            {CITY_STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      <Confirmed
        pending={pending}
        label="Change the status"
        consequence="Opening lets riders request rides here and drivers go online here. Pausing stops new rides and new drivers going online at once; rides under way finish."
      />
      <Feedback state={state} />
    </form>
  );
}

const DAYS = [
  [1, 'Monday'],
  [2, 'Tuesday'],
  [3, 'Wednesday'],
  [4, 'Thursday'],
  [5, 'Friday'],
  [6, 'Saturday'],
  [7, 'Sunday'],
] as const;
const timeOf = (m: number | null) =>
  m === null
    ? ''
    : `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Opening hours: up to three windows. No window at all means open all day, every day. */
export function HoursForm({ city }: { city: CityDetail }) {
  const [state, action, pending] = useActionState<CityActionState, FormData>(hoursAction, {});
  return (
    <form action={action} style={column}>
      <Hidden city={city} />
      <p style={{ margin: 0 }}>Now: {describeCityHours(city.hours)}.</p>
      {[0, 1, 2].map((i) => {
        const w = city.hours[i];
        return (
          <fieldset
            key={i}
            style={{
              ...column,
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              padding: 12,
            }}
          >
            <legend>Opening window {i + 1}</legend>
            <div
              role="group"
              aria-label={`Days for window ${i + 1}, none ticked means every day`}
              style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}
            >
              {DAYS.map(([d, name]) => (
                <label key={d}>
                  <input
                    type="checkbox"
                    name={`days${i}`}
                    value={d}
                    defaultChecked={!!w?.daysOfWeek?.includes(d)}
                  />{' '}
                  {name}
                </label>
              ))}
            </div>
            <Field
              name={`start${i}`}
              label={`Opens (window ${i + 1})`}
              type="time"
              defaultValue={timeOf(w?.startMinute ?? null)}
            />
            <Field
              name={`end${i}`}
              label={`Closes (window ${i + 1})`}
              type="time"
              defaultValue={timeOf(w?.endMinute ?? null)}
              hint="A closing time earlier than the opening time runs past midnight. Leave a window empty to ignore it."
            />
          </fieldset>
        );
      })}
      <Confirmed
        pending={pending}
        label="Save opening hours"
        consequence="Outside these hours riders cannot request rides here and drivers cannot go online. With no window the city is open all day."
      />
      <Feedback state={state} />
    </form>
  );
}

/** A list of checkboxes that the server reads as "these were shown, these are on". */
function CheckList({
  items,
  name = 'on',
}: {
  items: Array<{ id: string; label: string; on: boolean; note?: string }>;
  name?: string;
}) {
  return (
    <div style={column}>
      {items.map((i) => (
        <label key={i.id}>
          <input type="hidden" name="shown" value={i.id} />
          <input type="checkbox" name={name} value={i.id} defaultChecked={i.on} /> {i.label}
          {i.note ? ` (${i.note})` : ''}
        </label>
      ))}
    </div>
  );
}

export function CategoriesForm({ city }: { city: CityDetail }) {
  const [state, action, pending] = useActionState<CityActionState, FormData>(categoriesAction, {});
  return (
    <form action={action} style={column}>
      <Hidden city={city} />
      <fieldset style={{ border: 0, padding: 0 }}>
        <legend>Vehicle types offered in this city</legend>
        <CheckList
          items={city.categories.map((c) => ({ id: c.categoryId, label: c.label, on: c.enabled }))}
        />
      </fieldset>
      <Confirmed
        pending={pending}
        label="Save vehicle types"
        consequence="A switched-off type is not shown to riders here and cannot be requested here. A city must offer at least one."
      />
      <Feedback state={state} />
    </form>
  );
}

export function PaymentsForm({ city }: { city: CityDetail }) {
  const [state, action, pending] = useActionState<CityActionState, FormData>(paymentsAction, {});
  return (
    <form action={action} style={column}>
      <Hidden city={city} />
      <fieldset style={{ border: 0, padding: 0 }}>
        <legend>Ways to pay offered in this city</legend>
        <CheckList
          items={city.paymentMethods.map((m) => ({
            id: m.method,
            label: m.method === 'CASH' ? 'Cash to the driver' : m.method,
            on: m.enabled,
          }))}
        />
      </fieldset>
      <p style={{ margin: 0 }}>
        A business account pays by its own policy, whatever is chosen here.
      </p>
      <Confirmed
        pending={pending}
        label="Save payment options"
        consequence="A city must offer at least one way to pay."
      />
      <Feedback state={state} />
    </form>
  );
}

export function ZonesForm({ city }: { city: CityDetail }) {
  const [state, action, pending] = useActionState<CityActionState, FormData>(zonesAction, {});
  return (
    <form action={action} style={column}>
      <Hidden city={city} />
      <p style={{ margin: 0 }}>
        A city&apos;s boundary is the service areas and city boundaries ticked here. Draw or edit
        their shape in <a href="/operations/zones">Service zones</a>.
      </p>
      <fieldset style={{ border: 0, padding: 0 }}>
        <legend>Service areas that belong to {city.name}</legend>
        <CheckList
          items={city.zones.map((z) => ({
            id: z.id,
            label: `${z.name} (${z.code})`,
            on: z.inThisCity,
            note: [
              z.isActive ? null : 'not in use',
              z.otherCityName ? `now in ${z.otherCityName}; ticking moves it here` : null,
            ]
              .filter(Boolean)
              .join(', '),
          }))}
        />
      </fieldset>
      <Confirmed
        pending={pending}
        label="Save the boundary"
        consequence="A place is in this city if it is inside one of these areas. An open city must keep at least one active area."
      />
      <Feedback state={state} />
    </form>
  );
}

export function DocumentsForm({ city }: { city: CityDetail }) {
  const [state, action, pending] = useActionState<CityActionState, FormData>(documentsAction, {});
  return (
    <form action={action} style={column}>
      <Hidden city={city} />
      <fieldset style={{ border: 0, padding: 0 }}>
        <legend>Extra documents drivers need to go online in {city.name}</legend>
        <div style={column}>
          {city.documents.map((d) => (
            <label key={d.documentTypeId}>
              <input
                type="checkbox"
                name="on"
                value={d.documentTypeId}
                defaultChecked={d.required}
              />{' '}
              {d.label} ({d.ownerType === 'DRIVER' ? 'the driver' : 'the vehicle'})
            </label>
          ))}
        </div>
      </fieldset>
      <Confirmed
        pending={pending}
        label="Save driver requirements"
        consequence="A driver who does not hold an approved, unexpired copy of each ticked document cannot go online here, and is told which one."
      />
      <Feedback state={state} />
    </form>
  );
}

/** The city's own fare, waiting and cancellation values. Blank uses the platform value. */
export function SettingsForm({ city }: { city: CityDetail }) {
  const [state, action, pending] = useActionState<CityActionState, FormData>(settingsAction, {});
  return (
    <form action={action} style={column}>
      <Hidden city={city} />
      {city.settings.map((s) => (
        <Field
          key={s.key}
          name={s.key}
          label={`${s.label}${s.unit ? ` (${s.unit})` : ''}`}
          type="number"
          defaultValue={s.cityValue}
          hint={`Platform value: ${s.platformValue}. Leave empty to use it.`}
        />
      ))}
      <p style={{ margin: 0 }}>
        A vehicle type&apos;s own rates, where it has them, still apply on top of these.
      </p>
      <Confirmed
        pending={pending}
        label="Save these values"
        consequence="New estimates and rides in this city use these values from now on. Other cities are not affected."
      />
      <Feedback state={state} />
    </form>
  );
}
