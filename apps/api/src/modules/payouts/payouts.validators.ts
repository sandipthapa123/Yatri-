import { PAYOUT_ACCOUNT_KINDS } from '@yatri/types';
import { z } from 'zod';

/** Shapes only; whether an account is acceptable is the one rule in @yatri/types (payoutAccountProblem), applied by the service. */
export const payoutAccountSchema = z
  .object({
    kind: z.enum(PAYOUT_ACCOUNT_KINDS),
    holderName: z.string().trim().min(2).max(80),
    accountNumber: z.string().trim().min(1).max(60),
  })
  .strict();
