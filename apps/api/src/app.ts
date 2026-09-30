import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { ipRateLimit } from './middleware/rateLimit';
import { requestContext } from './middleware/requestContext';
import { ensureSettingsFresh } from './modules/settings/settings.service';
import { shareRouter } from './modules/sharing/share.routes';
import { apiRouter } from './routes';

export function createApp(): Express {
  const app = express();

  // How many reverse proxies sit in front (TRUST_PROXY_HOPS), so req.ip and rate limiting see the
  // real client address instead of a proxy's. Trusting too many lets a caller forge their address.
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  app.use(requestContext);
  app.use(helmet());
  app.use(
    cors({
      // Only the listed browser origins (the admin site); production forbids "*" and localhost.
      origin: env.CORS_ORIGINS,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '32kb' }));

  // A generous ceiling per client address for the whole API. Routes that matter have their own,
  // much stricter limits (OTP, login, SOS, uploads, chat); this only stops raw flooding. Health probes
  // are never limited, and if the limiter's store is down requests still pass (see LimitOptions).
  const apiCeiling = ipRateLimit('api', env.API_RATE_LIMIT_PER_MINUTE, 60, { failOpen: true });
  app.use('/api/v1', (req, res, next) =>
    req.path.startsWith('/health') ? next() : apiCeiling(req, res, next),
  );

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
