import { Router, type Request, type Response, type Router as RouterType } from 'express';
import type { ApiResponse, CallInfo, IceServersResponse } from '@yatri/types';

import { HttpError } from '../../middleware/errorHandler';
import { activeCallFor, iceServersFor } from './calls.service';

/** Mounted at /trips/:id/calls. Call control itself happens over the realtime socket. */
export const callsRouter: RouterType = Router({ mergeParams: true });

const uid = (req: Request): string => {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
};
const tripId = (req: Request) => {
  const v = req.params.id;
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
};

/** Lets an app that reconnected mid-call learn the call's state. */
callsRouter.get('/active', async (req: Request, res: Response<ApiResponse<CallInfo | null>>) => {
  res.json({ success: true, data: await activeCallFor(tripId(req), uid(req)) });
});

callsRouter.get('/ice', async (req: Request, res: Response<ApiResponse<IceServersResponse>>) => {
  res.json({ success: true, data: await iceServersFor(tripId(req), uid(req)) });
});
