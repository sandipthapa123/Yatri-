import { z } from 'zod';

/** What a ride request or estimate may say about offers: a code and whether to use points. Never an amount. */
export const promotionRequestSchema = z
  .object({
    promoCode: z.string().trim().min(1).max(30).optional(),
    usePoints: z.boolean().optional(),
  })
  .strict();
