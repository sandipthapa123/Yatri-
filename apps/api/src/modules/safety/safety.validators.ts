import { pageParam, pageSizeParam } from '../../lib/pagination';
import {
  EMERGENCY_CONTACT_NAME_MAX,
  INCIDENT_CATEGORIES,
  INCIDENT_DESCRIPTION_MAX,
  INCIDENT_DESCRIPTION_MIN,
  INCIDENT_NOTE_MAX,
  INCIDENT_STATES,
  SOS_STATES,
} from '@yatri/types';
import { z } from 'zod';

import { phoneNumberSchema } from '../auth/auth.validators';

/** An SOS body is entirely optional and strictly limited: no id, status or user can ride along. */
export const sosBodySchema = z
  .object({
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    accuracyMeters: z.number().min(0).max(100_000).nullable().optional(),
  })
  .strict();

export const emergencyContactSchema = z
  .object({
    name: z.string().trim().min(1).max(EMERGENCY_CONTACT_NAME_MAX),
    phoneNumber: phoneNumberSchema,
  })
  .strict();

export const incidentSchema = z
  .object({
    category: z.enum(INCIDENT_CATEGORIES),
    description: z.string().trim().min(INCIDENT_DESCRIPTION_MIN).max(INCIDENT_DESCRIPTION_MAX),
  })
  .strict();

const page = {
  page: pageParam,
  pageSize: pageSizeParam(50, 20),
};

export const adminSosQuerySchema = z.object({ status: z.enum(SOS_STATES).optional(), ...page });
export const adminIncidentsQuerySchema = z.object({
  status: z.enum(INCIDENT_STATES).optional(),
  category: z.enum(INCIDENT_CATEGORIES).optional(),
  ...page,
});
export const sosAcknowledgeSchema = z
  .object({ note: z.string().trim().max(INCIDENT_NOTE_MAX).optional() })
  .strict();
export const sosResolveSchema = z
  .object({ note: z.string().trim().min(3).max(INCIDENT_NOTE_MAX) })
  .strict();
export const incidentStatusSchema = z
  .object({
    status: z.enum(INCIDENT_STATES),
    note: z.string().trim().max(INCIDENT_NOTE_MAX).optional(),
  })
  .strict();
export const incidentNoteSchema = z
  .object({
    kind: z.enum(['NOTE', 'ACTION']),
    body: z.string().trim().min(1).max(INCIDENT_NOTE_MAX),
  })
  .strict();
export const lowRatingsQuerySchema = z.object({
  maxStars: z.coerce.number().int().min(1).max(4).default(2),
  ...page,
});
