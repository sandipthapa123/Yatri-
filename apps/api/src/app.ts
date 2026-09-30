import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { ensureSettingsFresh } from './modules/settings/settings.service';
import { shareRouter } from './modules/sharing/share.routes';
import { apiRouter } from './routes';

export function createApp(): Express {
  const app = express();

  // Behind a single reverse proxy (typical prod deployment), so req.ip and
  // rate limiting see the real client address instead of the proxy's.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS }));
  app.use(express.json({ limit: '32kb' }));

  // Every request sees platform settings no older than SETTINGS_CACHE_SECONDS (one cheap read per
  // interval, however busy). A read failure never blocks a request: the last known values apply.
  app.use((_req, _res, next) => {
    ensureSettingsFresh().then(() => next(), next);
  });

  app.use('/api/v1', apiRouter);
  // The trusted contact's page: public, and the link itself is the credential.
  app.use('/share', shareRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
