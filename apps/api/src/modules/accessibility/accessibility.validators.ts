import {
  ACCESSIBILITY_NOTE_MAX,
  COMMUNICATION_PREFERENCES,
  PASSENGER_NEED_CODES,
  PICKUP_INSTRUCTION_CODES,
} from '@yatri/types';
import { z } from 'zod';

/** Shapes only; whether a value is allowed is the one definition in @yatri/types, checked by the service. */
const note = z.string().trim().max(ACCESSIBILITY_NOTE_MAX).nullable();
const needs = z.array(z.enum(PASSENGER_NEED_CODES)).max(PASSENGER_NEED_CODES.length);
const pickup = z.array(z.enum(PICKUP_INSTRUCTION_CODES)).max(PICKUP_INSTRUCTION_CODES.length);
const communication = z.enum(COMMUNICATION_PREFERENCES);

/** A ride request or estimate may carry any part of this; what is left out comes from the saved profile. */
export const accessibilityRequestSchema = z
  .object({
    companion: z.boolean().optional(),
    needs: needs.optional(),
    communication: communication.optional(),
    pickupInstructions: pickup.optional(),
    pickupNote: note.optional(),
    otherNote: note.optional(),
  })
  .strict();

export const profileBodySchema = z
  .object({
    needs,
    companion: z.boolean().optional(),
    communication,
    pickupInstructions: pickup,
    pickupNote: note,
    otherNote: note,
    version: z.number().int().min(0).optional(),
    /** Present when an app sends back what it received; ignored. */
    updatedAt: z.string().nullable().optional(),
  })
  .strict();

export const pickupUpdateSchema = z
  .object({ communication, pickupInstructions: pickup, pickupNote: note })
  .strict();

export const declareSchema = z
  .object({ declared: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{2,39}$/)).max(40) })
  .strict();

const reason = z.string().trim().min(3).max(300);
export const attributeBodySchema = z
  .object({
    code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,39}$/)
      .optional(),
    label: z.string().trim().min(3).max(80),
    help: z.string().trim().min(3).max(300),
    requiresApproval: z.boolean(),
    active: z.boolean(),
    version: z.number().int().min(1).optional(),
    reason,
  })
  .strict();

export const featureDecisionSchema = z
  .object({ decision: z.enum(['APPROVED', 'REJECTED']), reason })
  .strict();
