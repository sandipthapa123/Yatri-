import { z } from 'zod';

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD)')
  .refine((val) => !Number.isNaN(Date.parse(val)), 'Invalid date');

const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'Phone number must be in E.164 format, e.g. +9779800000000');

function pastDate(label: string) {
  return isoDateSchema.refine((val) => new Date(val) < new Date(), `${label} must be in the past`);
}

function futureDate(label: string) {
  return isoDateSchema.refine(
    (val) => new Date(val) > new Date(),
    `${label} must be in the future`,
  );
}

export const updateOnboardingSchema = z
  .object({
    fullLegalName: z.string().trim().min(1).max(150).optional(),
    dateOfBirth: pastDate('Date of birth').optional(),
    licenseNumber: z.string().trim().min(1).max(50).optional(),
    licenseExpiryDate: futureDate('Licence expiry date').optional(),
    addressLine1: z.string().trim().min(1).max(150).optional(),
    addressLine2: z.union([z.string().trim().max(150), z.null()]).optional(),
    city: z.string().trim().min(1).max(100).optional(),
    emergencyContactName: z.union([z.string().trim().max(150), z.null()]).optional(),
    emergencyContactPhone: z.union([phoneSchema, z.null()]).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field is required.' });
