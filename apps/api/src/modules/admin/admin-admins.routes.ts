import { Router, type Router as RouterType } from 'express';

import { validateBody } from '../../middleware/validate';
import { validateUuidParam } from '../../middleware/validateUuidParam';
import { listAdminsHandler, setPermissionsHandler, setPermissionsSchema } from './admin-admins';

/** Administrator management (mounted behind ADMINS_MANAGE). */
export const adminAdminsRoutes: RouterType = Router();
adminAdminsRoutes.get('/', listAdminsHandler);
adminAdminsRoutes.put(
  '/:id/permissions',
  validateUuidParam('id'),
  validateBody(setPermissionsSchema),
  setPermissionsHandler,
);
