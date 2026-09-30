import type { ApiResponse, ShareCreated, ShareInfo } from '@yatri/types';
import type { Request, Response } from 'express';

import { HttpError } from '../../middleware/errorHandler';
import { createShare, listShares, stopShare } from './sharing.service';

function uid(req: Request): string {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
}
const param = (req: Request, name: string) => {
  const v = req.params[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
};

export async function createShareHandler(req: Request, res: Response<ApiResponse<ShareCreated>>) {
  res.status(201).json({ success: true, data: await createShare(param(req, 'id'), uid(req)) });
}

export async function listSharesHandler(req: Request, res: Response<ApiResponse<ShareInfo[]>>) {
  res.json({ success: true, data: await listShares(param(req, 'id'), uid(req)) });
}

export async function stopShareHandler(
  req: Request,
  res: Response<ApiResponse<{ stopped: true }>>,
) {
  await stopShare(param(req, 'id'), param(req, 'shareId'), uid(req));
  res.json({ success: true, data: { stopped: true } });
}
