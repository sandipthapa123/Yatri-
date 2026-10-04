import type { ApiResponse, ProvidersOverview } from '@yatri/types';
import type { Request, Response } from 'express';

import { providersOverview } from '../providers/health';

/**
 * The providers screen: which outside service fills each need and whether it is working. Status only: a vendor's name, a
 * state, counts, the kind of the last failure. No key, address, account or vendor message is in the answer.
 */
export async function providersHandler(
  _req: Request,
  res: Response<ApiResponse<ProvidersOverview>>,
) {
  res.json({ success: true, data: await providersOverview() });
}
