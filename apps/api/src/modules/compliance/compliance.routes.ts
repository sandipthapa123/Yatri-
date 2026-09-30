import {
  DATA_REQUEST_KINDS,
  type ApiResponse,
  type ComplianceRecordInfo,
  type DataRequestInfo,
  type MyPolicyStatus,
  type TripRole,
} from '@yatri/types';
import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/authenticate';
import { HttpError } from '../../middleware/errorHandler';
import { userMutationRateLimit, userRateLimit } from '../../middleware/rateLimit';
import { requireRole } from '../../middleware/requireRole';
import { validateBody } from '../../middleware/validate';
import { validateUuidParam } from '../../middleware/validateUuidParam';
import { requireParam } from '../../lib/params';
import { acceptPolicy, myComplianceRecords, myPolicyStatus } from './compliance.service';
import {
  buildPersonalDataExport,
  cancelMyDataRequest,
  createDataRequest,
  listMyDataRequests,
} from './data-requests.service';

/**
 * A person's own compliance and privacy: which policies they have accepted (and which are waiting),
 * accepting the current version, and asking for a copy of their data or for their account to be deleted.
 * (Deactivating an account is the existing POST /users/me/deactivate; nothing here repeats it.)
 */
export const complianceRouter: RouterType = Router();
complianceRouter.use(authenticate, requireRole('PASSENGER', 'DRIVER'));
complianceRouter.use(userMutationRateLimit());

const acceptSchema = z
  .object({ key: z.string().trim().min(1).max(40), version: z.string().trim().min(1).max(40) })
  .strict();
const requestSchema = z
  .object({ kind: z.enum(DATA_REQUEST_KINDS), note: z.string().trim().max(500).optional() })
  .strict();

const who = (req: Request) => {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return { userId: req.auth.userId, role: req.auth.role as TripRole };
};

complianceRouter.get('/policies', async (req, res: Response<ApiResponse<MyPolicyStatus[]>>) => {
  const { userId, role } = who(req);
  res.json({ success: true, data: await myPolicyStatus(userId, role) });
});

complianceRouter.post(
  '/accept',
  validateBody(acceptSchema),
  async (req, res: Response<ApiResponse<ComplianceRecordInfo>>) => {
    const { userId, role } = who(req);
    const b = req.body as z.infer<typeof acceptSchema>;
    res
      .status(201)
      .json({ success: true, data: await acceptPolicy(userId, role, b.key, b.version) });
  },
);

complianceRouter.get(
  '/records',
  async (req, res: Response<ApiResponse<ComplianceRecordInfo[]>>) => {
    res.json({ success: true, data: await myComplianceRecords(who(req).userId) });
  },
);

complianceRouter.get(
  '/data-requests',
  async (req, res: Response<ApiResponse<DataRequestInfo[]>>) => {
    res.json({ success: true, data: await listMyDataRequests(who(req).userId) });
  },
);

complianceRouter.post(
  '/data-requests',
  userRateLimit('privacy:request', 5, 3600),
  validateBody(requestSchema),
  async (req, res: Response<ApiResponse<DataRequestInfo>>) => {
    const { userId, role } = who(req);
    res.status(201).json({
      success: true,
      data: await createDataRequest(userId, role, req.body as z.infer<typeof requestSchema>),
    });
  },
);

complianceRouter.post(
  '/data-requests/:id/cancel',
  validateUuidParam('id'),
  async (req, res: Response<ApiResponse<DataRequestInfo>>) => {
    res.json({
      success: true,
      data: await cancelMyDataRequest(who(req).userId, requireParam(req, 'id')),
    });
  },
);

complianceRouter.get(
  '/data-requests/:id/export',
  userRateLimit('privacy:export', 5, 3600),
  validateUuidParam('id'),
  async (req, res) => {
    const { userId, role } = who(req);
    const data = await buildPersonalDataExport(userId, role, requireParam(req, 'id'));
    // A personal file: never cached by the browser or an intermediary.
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data });
  },
);
