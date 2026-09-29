import type { TripStatus } from '@yatri/types';

/**
 * The trip status machine (pure). ONE table decides every legal move; the service turns a
 * request into a guarded UPDATE (`WHERE status = ANY(from)`), so races cannot skip it.
 *
 *   SEARCHING ─► DRIVER_EN_ROUTE ─► DRIVER_ARRIVED ─► IN_PROGRESS ─► COMPLETED
 *       │             │  ▲               │
 *       │             └──┼── re-match ───┘ (driver cancels / is lost before pickup)
 *       │                └── back to SEARCHING
 *       ├─► NO_DRIVERS (search deadline)
 *       └─► CANCELLED  (passenger, driver after pickup, or system)  — from any active state
 */
const TRANSITIONS: Record<TripStatus, readonly TripStatus[]> = {
  SEARCHING: ['DRIVER_EN_ROUTE', 'NO_DRIVERS', 'CANCELLED'],
  DRIVER_EN_ROUTE: ['DRIVER_ARRIVED', 'SEARCHING', 'CANCELLED'],
  DRIVER_ARRIVED: ['IN_PROGRESS', 'SEARCHING', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_DRIVERS: [],
};

export function canTripTransition(from: TripStatus, to: TripStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Every status from which `to` is reachable — used to build the guarded UPDATE. */
export function statusesLeadingTo(to: TripStatus): TripStatus[] {
  return (Object.keys(TRANSITIONS) as TripStatus[]).filter((from) => canTripTransition(from, to));
}
