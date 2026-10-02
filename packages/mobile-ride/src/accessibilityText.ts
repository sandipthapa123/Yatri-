import {
  COMMUNICATION_LABELS,
  PASSENGER_NEED_BY_CODE,
  PICKUP_INSTRUCTION_LABELS,
  VEHICLE_CAPABILITY_LABELS,
  bearingDegrees,
  compassWord,
  formatDistance,
  formatDuration,
  hasAccessibilityContent,
  haversineMeters,
  type AccessibilityProfile,
  type LiveTripSnapshot,
  type TripAccessibility,
  type TripCounterpart,
  type VehicleCapability,
} from '@yatri/types';

/**
 * The words of the accessible-ride screens, with no framework in them so they are tested. Definitions and wording of
 * the needs themselves are in @yatri/types (accessibility.ts); this only assembles sentences from them.
 */

/** A sentence about what a passenger has stated, for their own settings screen and the request screen. */
export function profileSummary(
  p: Pick<
    AccessibilityProfile,
    'needs' | 'companion' | 'communication' | 'pickupInstructions' | 'pickupNote' | 'otherNote'
  >,
): string {
  const a: TripAccessibility = { ...p, requiredVehicleAttributes: [] };
  if (!hasAccessibilityContent(a))
    return 'No accessibility needs are set. Your rides are requested as usual.';
  const parts: string[] = [];
  if (p.needs.length > 0)
    parts.push(p.needs.map((n) => PASSENGER_NEED_BY_CODE[n].label).join('; '));
  if (p.companion) parts.push('Someone travels with me');
  if (p.communication !== 'ANY')
    parts.push(`Reach me by: ${COMMUNICATION_LABELS[p.communication].label}`);
  if (p.pickupInstructions.length > 0) {
    parts.push(p.pickupInstructions.map((i) => PICKUP_INSTRUCTION_LABELS[i].label).join('; '));
  }
  if (p.pickupNote) parts.push(`Pickup note: ${p.pickupNote}`);
  return `${parts.join('. ')}.`;
}

/** What the request screen says about this ride: from the saved profile, with how the matching will treat it. */
export function requestAccessibilityLine(p: AccessibilityProfile | null): string | null {
  if (!p || !hasAccessibilityContent({ ...p, requiredVehicleAttributes: [] })) return null;
  const vehicle = p.needs.filter((n) => PASSENGER_NEED_BY_CODE[n].vehicleAttribute);
  const matching =
    vehicle.length > 0
      ? ' Only drivers whose vehicle is approved for this will be offered your ride.'
      : '';
  return `This ride uses your accessibility settings. ${profileSummary(p)}${matching} You can change them in Settings.`;
}

/** The sentence when nobody suitable is nearby, so the person is told why instead of waiting without knowing. */
export const NO_ACCESSIBLE_VEHICLE_TEXT =
  'No accessible vehicle is available near you right now. You can still request the ride and we will keep looking, or try again in a few minutes.';

export function capabilityWords(c: VehicleCapability): string {
  if (c.status === null) return 'Not declared';
  const base = VEHICLE_CAPABILITY_LABELS[c.status];
  return c.status === 'REJECTED' && c.decisionReason ? `${base}: ${c.decisionReason}` : base;
}

/** The sentence announced after a driver changes the features they declare. */
export function capabilitySavedNews(c: VehicleCapability[]): string {
  const waiting = c.filter((x) => x.status === 'PENDING').length;
  return waiting > 0
    ? `Saved. ${waiting} feature${waiting === 1 ? ' is' : 's are'} waiting for approval before you can be offered rides that need ${waiting === 1 ? 'it' : 'them'}.`
    : 'Saved.';
}

/** What the passenger is told after changing pickup instructions. */
export const PICKUP_SAVED_NEWS = 'Saved. Your driver has been told to read your new instructions.';

/**
 * The text-based picture of the pickup, for anyone who does not use the map: where it is (address and landmark), which
 * way the driver is from it, how far and how long, and what vehicle to look for. Every figure comes from the server's
 * snapshot; the direction is worked out from the two positions it contains.
 */
export interface GuideRow {
  label: string;
  value: string;
}
export function pickupGuide(s: LiveTripSnapshot, vehicle: TripCounterpart['vehicle']): GuideRow[] {
  const rows: GuideRow[] = [];
  rows.push({ label: 'Pickup address', value: s.pickup.address || s.pickup.name });
  if (s.pickup.address && s.pickup.name && s.pickup.name !== s.pickup.address) {
    rows.push({ label: 'Landmark', value: s.pickup.name });
  }
  if (s.driver && s.status === 'DRIVER_EN_ROUTE') {
    const meters = s.driverArrival?.distanceMeters ?? haversineMeters(s.driver, s.pickup);
    const dir = compassWord(bearingDegrees(s.pickup, s.driver));
    rows.push({
      label: 'Where your driver is',
      value:
        meters < 25
          ? 'At the pickup'
          : `${formatDistance(meters)} to the ${dir} of the pickup${s.driver.placeName ? `, near ${s.driver.placeName}` : ''}`,
    });
    if (s.driverArrival) {
      rows.push({
        label: 'Arriving in',
        value:
          s.driverArrival.etaSeconds === null
            ? 'Not available'
            : `${formatDuration(s.driverArrival.etaSeconds)}${s.driverArrival.basis === 'estimate' ? ' (estimate)' : ''}`,
      });
    }
  }
  if (s.status === 'DRIVER_ARRIVED') {
    rows.push({ label: 'Where your driver is', value: 'At the pickup, waiting for you' });
  }
  if (vehicle) {
    rows.push({
      label: 'Look for',
      value: `${vehicle.description}, number plate ${vehicle.registrationNumber}`,
    });
  }
  return rows;
}
