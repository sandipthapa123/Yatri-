import { z } from 'zod';

const currentYear = new Date().getUTCFullYear();

// Nepal-style registration plates vary by province but are always short
// alphanumeric strings — this is intentionally permissive (validated at
// review time by an admin who can see the actual document), not a strict
// format check that would reject legitimate real-world plates.
const registrationNumberSchema = z
  .string()
  .trim()
  .min(3)
  .max(20)
  .regex(/^[A-Za-z0-9 -]+$/, 'Registration number contains invalid characters');

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD)')
  .refine((val) => !Number.isNaN(Date.parse(val)), 'Invalid date');

export const createVehicleSchema = z.object({
  categoryId: z.uuid(),
  make: z.string().trim().min(1).max(50),
  model: z.string().trim().min(1).max(50),
  year: z.coerce
    .number()
    .int()
    .min(1970)
    .max(currentYear + 1),
  color: z.string().trim().min(1).max(30),
  registrationNumber: registrationNumberSchema,
  vin: z.string().trim().min(5).max(50).optional(),
  registrationExpiryDate: isoDateSchema.optional(),
  insuranceProvider: z.string().trim().min(1).max(100).optional(),
  insurancePolicyNumber: z.string().trim().min(1).max(50).optional(),
  insuranceExpiryDate: isoDateSchema.optional(),
});

export const updateVehicleSchema = z
  .object({
    make: z.string().trim().min(1).max(50).optional(),
    model: z.string().trim().min(1).max(50).optional(),
    year: z.coerce
      .number()
      .int()
      .min(1970)
      .max(currentYear + 1)
      .optional(),
    color: z.string().trim().min(1).max(30).optional(),
    registrationNumber: registrationNumberSchema.optional(),
    vin: z.union([z.string().trim().min(5).max(50), z.null()]).optional(),
    registrationExpiryDate: z.union([isoDateSchema, z.null()]).optional(),
    insuranceProvider: z.union([z.string().trim().min(1).max(100), z.null()]).optional(),
    insurancePolicyNumber: z.union([z.string().trim().min(1).max(50), z.null()]).optional(),
    insuranceExpiryDate: z.union([isoDateSchema, z.null()]).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field is required.' });
