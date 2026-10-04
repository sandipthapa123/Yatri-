/**
 * Inclusive and accessible rides: the ONE definition of what a passenger can say they need, what a vehicle can
 * offer, how the two meet, and the words for it. The API validates and decides against this; the apps render from
 * it. Nothing here is ever inferred: a person's needs are only what they chose to state, and a vehicle's features
 * are only what its driver declared (and, where verification is required, an administrator approved).
 *
 * Privacy: needs and pickup instructions are sensitive. They are visible to their owner, to the driver of the
 * ride they were given for (from the moment the driver is assigned), and to support staff handling that ride (each
 * read audited). They are never public, never in a notification or a shared trip link, and are deleted with the ride's
 * retention period. Drivers are shown only what they need to serve the person.
 */

// ---------------------------------------------------------------- what a passenger can say they need

export const PASSENGER_NEED_CODES = [
  'WHEELCHAIR',
  'ASSISTANCE',
  'EXTRA_BOARDING_TIME',
  'VISUAL',
  'HEARING',
  'SERVICE_ANIMAL',
  'OTHER',
] as const;
export type PassengerNeedCode = (typeof PASSENGER_NEED_CODES)[number];

export interface PassengerNeedDef {
  code: PassengerNeedCode;
  /** The words the passenger sees. */
  label: string;
  /** What it means for the ride, in a sentence. */
  help: string;
  /** What the driver is told (never the person's diagnosis, only what helps them serve the ride). */
  driverText: string;
  /**
   * The vehicle feature this need requires. The matching engine offers the ride only to drivers whose vehicle holds
   * it (approved). Null: nothing the vehicle must have, only something the driver should know.
   */
  vehicleAttribute: string | null;
}

export const PASSENGER_NEEDS: readonly PassengerNeedDef[] = [
  {
    code: 'WHEELCHAIR',
    label: 'I use a wheelchair and need an accessible vehicle',
    help: 'Only drivers whose vehicle is approved as wheelchair accessible are offered your ride.',
    driverText: 'Needs a wheelchair-accessible vehicle.',
    vehicleAttribute: 'WHEELCHAIR_ACCESSIBLE',
  },
  {
    code: 'ASSISTANCE',
    label: 'I need help getting in and out of the vehicle',
    help: 'Your driver is told you may need a hand at pickup and drop-off.',
    driverText: 'May need help getting in and out of the vehicle.',
    vehicleAttribute: null,
  },
  {
    code: 'EXTRA_BOARDING_TIME',
    label: 'I need extra time to get in and out of the vehicle',
    help: 'Your driver waits longer before any waiting charge starts and before they can cancel because you have not come. Nothing extra is charged for the extra time.',
    driverText:
      'Needs extra time to get in and out of the vehicle. Please be patient: the waiting time is longer for this ride.',
    vehicleAttribute: null,
  },
  {
    code: 'VISUAL',
    label: 'I am blind or have low vision',
    help: 'Your driver is asked to say who they are, describe where they are and walk you to the vehicle if you ask.',
    driverText:
      'Is blind or has low vision. Please say who you are and where the vehicle is, and offer to guide them to it.',
    vehicleAttribute: null,
  },
  {
    code: 'HEARING',
    label: 'I am deaf or hard of hearing',
    help: 'Your driver is told to use messages and clear gestures rather than only speaking.',
    driverText:
      'Is deaf or hard of hearing. Please use messages or clear gestures, and face them when speaking.',
    vehicleAttribute: null,
  },
  {
    code: 'SERVICE_ANIMAL',
    label: 'I travel with a service animal',
    help: 'Only drivers who have said they welcome service animals are offered your ride.',
    driverText: 'Travels with a service animal, which must be allowed in the vehicle.',
    vehicleAttribute: 'SERVICE_ANIMAL_FRIENDLY',
  },
  {
    code: 'OTHER',
    label: 'Something else (you can describe it)',
    help: 'Your note is shown to your driver once they are assigned.',
    driverText: 'Has another accessibility need (see the note).',
    vehicleAttribute: null,
  },
];
export const PASSENGER_NEED_BY_CODE: Record<PassengerNeedCode, PassengerNeedDef> =
  Object.fromEntries(PASSENGER_NEEDS.map((n) => [n.code, n])) as Record<
    PassengerNeedCode,
    PassengerNeedDef
  >;

/** The feature that makes a vehicle "accessible" in the counts staff see (the one a wheelchair need requires). */
export const ACCESSIBLE_VEHICLE_ATTRIBUTE = PASSENGER_NEED_BY_CODE.WHEELCHAIR
  .vehicleAttribute as string;

/** The vehicle features a set of needs requires, once each, in a stable order. */
export function requiredVehicleAttributes(needs: readonly PassengerNeedCode[]): string[] {
  const out = new Set<string>();
  for (const code of needs) {
    const attr = PASSENGER_NEED_BY_CODE[code]?.vehicleAttribute;
    if (attr) out.add(attr);
  }
  return [...out].sort();
}

// ---------------------------------------------------------------- how the person prefers to be reached

export const COMMUNICATION_PREFERENCES = ['ANY', 'TEXT_PREFERRED', 'TEXT_ONLY'] as const;
export type CommunicationPreference = (typeof COMMUNICATION_PREFERENCES)[number];
export const COMMUNICATION_LABELS: Record<
  CommunicationPreference,
  { label: string; help: string; driverText: string }
> = {
  ANY: {
    label: 'Calls or messages',
    help: 'Your driver may call you or write to you.',
    driverText: 'May be called or messaged.',
  },
  TEXT_PREFERRED: {
    label: 'Messages first',
    help: 'Your driver is asked to write to you before calling.',
    driverText: 'Prefers messages. Write first, and call only if needed.',
  },
  TEXT_ONLY: {
    label: 'Messages only',
    help: 'Your driver cannot call you on this ride; they can still write to you. You can still call them.',
    driverText: 'Messages only. Calls to this passenger are switched off for this ride.',
  },
};

// ---------------------------------------------------------------- structured pickup instructions

export const PICKUP_INSTRUCTION_CODES = [
  'MEET_AT_ACCESSIBLE_ENTRANCE',
  'CALL_ON_ARRIVAL',
  'NEED_HELP_LOCATING_VEHICLE',
  'CANNOT_USE_STAIRS',
  'OTHER',
] as const;
export type PickupInstructionCode = (typeof PICKUP_INSTRUCTION_CODES)[number];
export const PICKUP_INSTRUCTION_LABELS: Record<
  PickupInstructionCode,
  { label: string; driverText: string }
> = {
  MEET_AT_ACCESSIBLE_ENTRANCE: {
    label: 'Meet me at the accessible entrance',
    driverText: 'Meet at the accessible entrance.',
  },
  CALL_ON_ARRIVAL: {
    label: 'Call me when you arrive',
    driverText: 'Call on arrival (unless messages only is set).',
  },
  NEED_HELP_LOCATING_VEHICLE: {
    label: 'I need help finding the vehicle',
    driverText: 'Needs help locating the vehicle: describe it and where you are.',
  },
  CANNOT_USE_STAIRS: {
    label: 'I cannot use stairs',
    driverText: 'Cannot use stairs: pick up at ground level or by a ramp or lift.',
  },
  OTHER: { label: 'Something else (add a note)', driverText: 'See the pickup note.' },
};

export const ACCESSIBILITY_NOTE_MAX = 200;

/** What the driver reads when a companion travels with the passenger. Never anything about why. */
export const COMPANION_DRIVER_TEXT =
  'Someone travels with the passenger. Please allow room for them.';
export const COMMUNICATION_ALLOWED_TO_CALL: Record<CommunicationPreference, boolean> = {
  ANY: true,
  TEXT_PREFERRED: true,
  TEXT_ONLY: false,
};

// ---------------------------------------------------------------- the passenger's saved profile and a ride's snapshot

/** What the passenger saved once, used as the starting point of each ride they request. Explicit only. */
export interface AccessibilityProfile {
  needs: PassengerNeedCode[];
  communication: CommunicationPreference;
  pickupInstructions: PickupInstructionCode[];
  pickupNote: string | null;
  otherNote: string | null;
  /** Someone (a helper, a relative) usually travels with the passenger. They need no account and say nothing about themselves. */
  companion: boolean;
  /** Raised on every save; a save must name the version it saw so two devices cannot overwrite each other. */
  version: number;
  updatedAt: string | null;
}

export type AccessibilityProfileBody = Omit<AccessibilityProfile, 'version' | 'updatedAt'> & {
  version?: number;
};

/** What one ride carries: a copy taken at the request, so changing the profile later never changes a ride under way. */
export interface TripAccessibility {
  needs: PassengerNeedCode[];
  communication: CommunicationPreference;
  pickupInstructions: PickupInstructionCode[];
  pickupNote: string | null;
  otherNote: string | null;
  /** A companion rides with the passenger. The driver is told that, and nothing about why. */
  companion: boolean;
  /** The vehicle features the matching engine required for this ride. */
  requiredVehicleAttributes: string[];
}

/** What a ride request may carry: any part can be left out (the saved profile fills it). */
export type TripAccessibilityRequest = Partial<
  Omit<TripAccessibility, 'requiredVehicleAttributes'>
>;

/** The change a passenger can make while the ride is under way (before the pickup). */
export type TripAccessibilityUpdateBody = Pick<
  TripAccessibility,
  'communication' | 'pickupInstructions' | 'pickupNote'
>;

export const hasAccessibilityContent = (a: TripAccessibility | null | undefined): boolean =>
  !!a &&
  (a.needs.length > 0 ||
    a.companion ||
    a.communication !== 'ANY' ||
    a.pickupInstructions.length > 0 ||
    !!a.pickupNote ||
    !!a.otherNote);

/**
 * The sentences a driver reads (and a screen reader speaks) about a ride's needs. One function, one wording; the offer
 * card, the ride screen and the update announcement all use it. A need with a vehicle requirement is stated plainly.
 */
export function describeAccessibilityForDriver(a: TripAccessibility): string[] {
  const lines: string[] = [];
  for (const code of a.needs) lines.push(PASSENGER_NEED_BY_CODE[code].driverText);
  if (a.companion) lines.push(COMPANION_DRIVER_TEXT);
  if (a.otherNote) lines.push(`Note about their needs: ${a.otherNote}`);
  if (a.communication !== 'ANY') lines.push(COMMUNICATION_LABELS[a.communication].driverText);
  for (const code of a.pickupInstructions) lines.push(PICKUP_INSTRUCTION_LABELS[code].driverText);
  if (a.pickupNote) lines.push(`Pickup note: ${a.pickupNote}`);
  return lines;
}

/** A short line for a ride offer (before the ride is accepted): only what decides whether the driver can take it. */
export function describeVehicleNeeds(
  requiredAttributes: readonly string[],
  labels: Record<string, string>,
): string[] {
  return requiredAttributes.map((code) => `Needs: ${labels[code] ?? code}`);
}

// ---------------------------------------------------------------- what a vehicle offers

/** The features the apps and the matching engine know by name (the catalogue may hold more, added by an administrator). */
export const CORE_VEHICLE_ATTRIBUTES = [
  'WHEELCHAIR_ACCESSIBLE',
  'RAMP_OR_LIFT',
  'EXTRA_SPACE',
  'ACCESSIBLE_SEATING',
  'SERVICE_ANIMAL_FRIENDLY',
] as const;
export type CoreVehicleAttribute = (typeof CORE_VEHICLE_ATTRIBUTES)[number];

/** A feature in the catalogue. Which need each core one serves is `PASSENGER_NEEDS[].vehicleAttribute`. */
export interface VehicleAttributeInfo {
  code: string;
  label: string;
  help: string;
  /** True: a driver's declaration only counts once an administrator has approved it (the vehicle was checked). */
  requiresApproval: boolean;
  active: boolean;
  /** Core features cannot be removed or deactivated: the passenger needs map to them. */
  core: boolean;
  version: number;
}

export const VEHICLE_ATTRIBUTE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,39}$/;

export const VEHICLE_CAPABILITY_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type VehicleCapabilityStatus = (typeof VEHICLE_CAPABILITY_STATUSES)[number];
export const VEHICLE_CAPABILITY_LABELS: Record<VehicleCapabilityStatus, string> = {
  PENDING: 'Waiting for approval',
  APPROVED: 'Approved',
  REJECTED: 'Not approved',
};

/** One feature of one vehicle, as its driver and the reviewers see it. */
export interface VehicleCapability {
  code: string;
  label: string;
  help: string;
  requiresApproval: boolean;
  /** Null: not declared. */
  status: VehicleCapabilityStatus | null;
  decisionReason: string | null;
}

export interface VehicleCapabilitiesResponse {
  vehicleId: string;
  capabilities: VehicleCapability[];
}

export interface VehicleCapabilitiesBody {
  /** The features the driver says the vehicle has. Features not listed are removed. */
  declared: string[];
}

/** The status a declaration starts with: a feature that needs checking waits; the others count at once. */
export function initialCapabilityStatus(requiresApproval: boolean): VehicleCapabilityStatus {
  return requiresApproval ? 'PENDING' : 'APPROVED';
}

// ---------------------------------------------------------------- administration

export interface AdminCapabilityReview {
  vehicleId: string;
  attributeCode: string;
  attributeLabel: string;
  driverName: string | null;
  vehicle: string;
  declaredAt: string;
}

export interface AdminCapabilityDecisionBody {
  decision: 'APPROVED' | 'REJECTED';
  reason: string;
}

export interface AdminAttributeBody {
  code?: string;
  label: string;
  help: string;
  requiresApproval: boolean;
  active: boolean;
  version?: number;
  reason: string;
}

/** Counts only: nobody's needs are listed. */
export interface AccessibilityStats {
  rangeLabel: string;
  ridesRequestedWithNeeds: number;
  ridesNeedingAccessibleVehicle: number;
  ridesNeedingAccessibleVehicleMatched: number;
  ridesNeedingAccessibleVehicleUnmatched: number;
  accessibleVehiclesApproved: number;
  accessibleVehiclesOnlineNow: number;
  pendingReviews: number;
  byAttribute: Array<{ code: string; label: string; approvedVehicles: number; onlineNow: number }>;
}

/** What staff handling a ride may read (audited), including the protected details. */
export interface AdminTripAccessibility {
  tripId: string;
  accessibility: TripAccessibility | null;
}

export const ACCESSIBILITY_NOTIFICATION_TYPES = {
  CAPABILITY_APPROVED: 'VEHICLE_CAPABILITY_APPROVED',
  CAPABILITY_REJECTED: 'VEHICLE_CAPABILITY_REJECTED',
} as const;
