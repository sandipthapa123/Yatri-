import type { TripRole } from './trip';

/**
 * Safety: SOS, emergency contacts, incident reports and ratings summaries — the definitions, once.
 * The state machines below are the only place a legal move is decided; the services apply them with
 * a guarded update, and the apps only show the states.
 */

// ---------------------------------------------------------------- SOS

export const SOS_STATES = ['ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'CANCELLED'] as const;
export type SosStatus = (typeof SOS_STATES)[number];

/**
 * ACTIVE: raised, nobody has looked yet. ACKNOWLEDGED: the safety team has seen it and is acting.
 * RESOLVED: closed by the safety team. CANCELLED: the person said they are safe.
 * Every open state can end either way; the ended states are final.
 */
export const SOS_TRANSITIONS: Record<SosStatus, readonly SosStatus[]> = {
  ACTIVE: ['ACKNOWLEDGED', 'RESOLVED', 'CANCELLED'],
  ACKNOWLEDGED: ['RESOLVED', 'CANCELLED'],
  RESOLVED: [],
  CANCELLED: [],
};
export const OPEN_SOS_STATES: readonly SosStatus[] = ['ACTIVE', 'ACKNOWLEDGED'];
export const canSosTransition = (from: SosStatus, to: SosStatus) =>
  SOS_TRANSITIONS[from].includes(to);
export const sosStatesLeadingTo = (to: SosStatus): SosStatus[] =>
  SOS_STATES.filter((from) => canSosTransition(from, to));

/** An alert's state as the safety team reads it (the person's own wording is `describeSosStatus`). */
export const SOS_STATUS_LABELS: Record<SosStatus, string> = {
  ACTIVE: 'Active: needs attention',
  ACKNOWLEDGED: 'Acknowledged',
  RESOLVED: 'Resolved',
  CANCELLED: 'Cancelled by the person',
};

export type SosLocationSource = 'DEVICE' | 'DRIVER_FEED' | 'NONE';

/** What a person may send with an SOS. Everything is optional: an emergency must never be refused. */
export interface SosRequestBody {
  latitude?: number;
  longitude?: number;
  accuracyMeters?: number | null;
}

/** The person's own view of their alert. */
export interface SosInfo {
  id: string;
  tripId: string;
  status: SosStatus;
  createdAt: string;
  /** Whether a position was recorded (the coordinates themselves stay with the safety team). */
  locationRecorded: boolean;
  contactsNotified: number;
  /** The local emergency services number, so the screen can offer to call it. */
  emergencyNumber: string;
}

/** The words for an alert's state, for the person who raised it. One function, used everywhere. */
export function describeSosStatus(s: Pick<SosInfo, 'status' | 'contactsNotified'>): string {
  switch (s.status) {
    case 'ACTIVE': {
      const contacts =
        s.contactsNotified > 0
          ? ` ${s.contactsNotified} emergency ${s.contactsNotified === 1 ? 'contact has' : 'contacts have'} been sent a link to follow your trip.`
          : '';
      return `Emergency alert sent. The Yatri safety team has been notified.${contacts}`;
    }
    case 'ACKNOWLEDGED':
      return 'The Yatri safety team has seen your alert and is responding.';
    case 'RESOLVED':
      return 'The Yatri safety team has closed your emergency alert.';
    case 'CANCELLED':
      return 'You cancelled the emergency alert.';
  }
}

// ---------------------------------------------------------------- emergency contacts

export interface EmergencyContact {
  id: string;
  name: string;
  phoneNumber: string;
}

export interface EmergencyContactsResponse {
  contacts: EmergencyContact[];
  /** How many a person may keep. */
  limit: number;
  emergencyNumber: string;
}

export const EMERGENCY_CONTACT_NAME_MAX = 60;

// ---------------------------------------------------------------- incident reports

export const INCIDENT_CATEGORIES = [
  'SAFETY_ISSUE',
  'HARASSMENT',
  'ACCIDENT',
  'FRAUD',
  'VEHICLE_ISSUE',
  'OTHER',
] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];

export const INCIDENT_CATEGORY_LABELS: Record<IncidentCategory, string> = {
  SAFETY_ISSUE: 'Safety issue',
  HARASSMENT: 'Harassment',
  ACCIDENT: 'Accident',
  FRAUD: 'Fraud',
  VEHICLE_ISSUE: 'Vehicle issue',
  OTHER: 'Something else',
};

export const INCIDENT_STATES = [
  'OPEN',
  'UNDER_REVIEW',
  'ACTION_TAKEN',
  'RESOLVED',
  'DISMISSED',
] as const;
export type IncidentStatus = (typeof INCIDENT_STATES)[number];

/** The one table of legal incident moves. RESOLVED and DISMISSED are final. */
export const INCIDENT_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  OPEN: ['UNDER_REVIEW', 'DISMISSED'],
  UNDER_REVIEW: ['ACTION_TAKEN', 'RESOLVED', 'DISMISSED'],
  ACTION_TAKEN: ['UNDER_REVIEW', 'RESOLVED'],
  RESOLVED: [],
  DISMISSED: [],
};
export const canIncidentTransition = (from: IncidentStatus, to: IncidentStatus) =>
  INCIDENT_TRANSITIONS[from].includes(to);
/** Reports still being handled: every state that can still move (derived, so it follows the table). */
export const OPEN_INCIDENT_STATES: readonly IncidentStatus[] = INCIDENT_STATES.filter(
  (s) => INCIDENT_TRANSITIONS[s].length > 0,
);
export const incidentStatesLeadingTo = (to: IncidentStatus): IncidentStatus[] =>
  INCIDENT_STATES.filter((from) => canIncidentTransition(from, to));

export const INCIDENT_DESCRIPTION_MIN = 10;
export const INCIDENT_DESCRIPTION_MAX = 2000;
export const INCIDENT_NOTE_MAX = 2000;

export interface IncidentBody {
  category: IncidentCategory;
  description: string;
}

/** The reporter's view: what they said and where it stands. Internal notes never appear here. */
export interface IncidentInfo {
  id: string;
  tripId: string;
  category: IncidentCategory;
  description: string;
  status: IncidentStatus;
  createdAt: string;
  updatedAt: string;
}

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  OPEN: 'Received',
  UNDER_REVIEW: 'Under review',
  ACTION_TAKEN: 'Action taken',
  RESOLVED: 'Resolved',
  DISMISSED: 'Closed without action',
};

/** What the reporter is told when their report moves. */
export function describeIncidentStatus(category: IncidentCategory, status: IncidentStatus): string {
  const what = INCIDENT_CATEGORY_LABELS[category].toLowerCase();
  switch (status) {
    case 'OPEN':
      return `We received your ${what} report.`;
    case 'UNDER_REVIEW':
      return `Your ${what} report is being reviewed.`;
    case 'ACTION_TAKEN':
      return `We have taken action on your ${what} report.`;
    case 'RESOLVED':
      return `Your ${what} report has been resolved.`;
    case 'DISMISSED':
      return `Your ${what} report was closed without action.`;
  }
}

export type IncidentNoteKind = 'NOTE' | 'ACTION' | 'STATUS';

export interface IncidentNote {
  id: string;
  kind: IncidentNoteKind;
  body: string;
  fromStatus: IncidentStatus | null;
  toStatus: IncidentStatus | null;
  adminName: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------- ratings

export interface RatingSummary {
  /** One decimal, 1 to 5; null until there is at least one rating. */
  average: number | null;
  count: number;
}

export function describeRatingSummary(s: RatingSummary): string {
  return s.average === null
    ? 'No ratings yet'
    : `Rating ${s.average.toFixed(1)} out of 5, from ${s.count} ${s.count === 1 ? 'rating' : 'ratings'}`;
}

// ---------------------------------------------------------------- admin views

export interface AdminSosRow {
  id: string;
  tripId: string;
  status: SosStatus;
  role: TripRole;
  userName: string | null;
  createdAt: string;
  locationRecorded: boolean;
  contactsNotified: number;
}

export interface AdminSosDetail extends AdminSosRow {
  /** Only for admins holding SAFETY_REVIEW; each read is audited. */
  location: {
    latitude: number;
    longitude: number;
    accuracyMeters: number | null;
    source: SosLocationSource;
    recordedAt: string | null;
  } | null;
  /** Every action and every look at this alert, from the one audit log. */
  audit: AuditEntry[];
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  cancelledAt: string | null;
  /** The ride, so the team can see who is involved without a second lookup. */
  trip: {
    status: string;
    passengerName: string | null;
    driverName: string | null;
    vehicle: string | null;
    registration: string | null;
    pickup: string;
    destination: string;
  };
}

export interface AdminIncidentRow {
  id: string;
  tripId: string;
  category: IncidentCategory;
  status: IncidentStatus;
  reporterRole: TripRole;
  reporterName: string | null;
  createdAt: string;
}

export interface AdminIncidentDetail extends AdminIncidentRow {
  description: string;
  updatedAt: string;
  notes: IncidentNote[];
  audit: AuditEntry[];
}

export interface AuditEntry {
  id: string;
  action: string;
  actorName: string | null;
  actorRole: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface AdminLowRating {
  tripId: string;
  raterRole: TripRole;
  stars: number;
  comment: string | null;
  createdAt: string;
}
