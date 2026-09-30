import { Router, type Router as RouterType } from 'express';

import { adminRouter } from '../modules/admin/admin.routes';
import { configRouter } from '../modules/settings/settings.routes';
import { authRouter } from '../modules/auth/auth.routes';
import { documentsRouter } from '../modules/documents/documents.routes';
import { driversRouter } from '../modules/drivers/drivers.routes';
import { healthRouter } from '../modules/health/health.routes';
import { complianceRouter } from '../modules/compliance/compliance.routes';
import { supportRouter } from '../modules/support/support.routes';
import { storageRouter } from '../modules/storage/storage.routes';
import { locationRouter } from '../modules/location/location.routes';
import { tripsRouter } from '../modules/trips/trips.routes';
import { usersRouter } from '../modules/users/users.routes';
import { vehiclesRouter } from '../modules/vehicles/vehicles.routes';

/**
 * Modular-monolith route mount point: each domain module owns its own
 * router and is mounted here. New capabilities get a new module + mount
 * line, not a new service.
 */
export const apiRouter: RouterType = Router();

apiRouter.use('/health', healthRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/location', locationRouter);
apiRouter.use('/trips', tripsRouter);
apiRouter.use('/drivers', driversRouter);
apiRouter.use('/documents', documentsRouter);
apiRouter.use('/admin', adminRouter);
apiRouter.use('/config', configRouter);
apiRouter.use('/storage', storageRouter);
apiRouter.use('/vehicles', vehiclesRouter);
apiRouter.use('/support', supportRouter);
apiRouter.use('/compliance', complianceRouter);
