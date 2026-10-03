import { pageParam, pageSizeParam } from '../../lib/pagination';
import { z } from 'zod';

export const listDriversQuerySchema = z.object({
  search: z.string().trim().min(1).max(100).optional(),
  status: z
    .enum([
      'NOT_STARTED',
      'IN_PROGRESS',
      'SUBMITTED',
      'UNDER_REVIEW',
      'VERIFIED',
      'REJECTED',
      'SUSPENDED',
    ])
    .optional(),
  page: pageParam,
  pageSize: pageSizeParam(100, 20),
});

export const rejectDriverSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, 'A rejection reason of at least 5 characters is required.')
    .max(1000),
});

export const suspendDriverSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, 'A suspension reason of at least 5 characters is required.')
    .max(1000),
});

export const reviewDocumentRejectSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, 'A rejection reason of at least 5 characters is required.')
    .max(1000),
});
