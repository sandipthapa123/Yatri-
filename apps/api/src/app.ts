import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
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

  app.use('/api/v1', apiRouter);
  // The trusted contact's page: public, and the link itself is the credential.
  app.use('/share', shareRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
