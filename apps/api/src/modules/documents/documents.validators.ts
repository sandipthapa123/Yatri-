import { z } from 'zod';

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD)')
  .refine((val) => !Number.isNaN(Date.parse(val)), 'Invalid date');

// multer populates req.body with string values from multipart text fields —
// this validates those, run after uploadSingleFile and before the controller.
export const uploadDocumentSchema = z.object({
  documentTypeCode: z.string().trim().min(1, 'documentTypeCode is required'),
  vehicleId: z.uuid().optional(),
  expiryDate: isoDateSchema.optional(),
});
