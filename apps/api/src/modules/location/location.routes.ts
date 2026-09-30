import { Router, type Router as RouterType } from 'express';

import { env } from '../../config/env';
import { authenticate } from '../../middleware/authenticate';
import { userRateLimit, userMutationRateLimit } from '../../middleware/rateLimit';
import { validateBody } from '../../middleware/validate';
import { validateQuery } from '../../middleware/validateQuery';
import { distanceHandler, reverseGeocodeHandler, searchHandler } from './location.controller';
import { distanceBodySchema, reverseQuerySchema, searchQuerySchema } from './location.validators';

export const locationRouter: RouterType = Router();

// Every endpoint spends provider quota or CPU, so all require a signed-in
// user (any role) and are rate limited per user, not just per IP.
locationRouter.use(authenticate);
locationRouter.use(userMutationRateLimit());

locationRouter.get(
  '/search',
  userRateLimit('loc-search', env.LOCATION_SEARCH_RATE_LIMIT_PER_MINUTE, 60),
  validateQuery(searchQuerySchema),
  searchHandler,
);
locationRouter.get(
  '/reverse-geocode',
  userRateLimit('loc-reverse', env.LOCATION_SEARCH_RATE_LIMIT_PER_MINUTE, 60),
  validateQuery(reverseQuerySchema),
  reverseGeocodeHandler,
);
locationRouter.post(
  '/distance',
  userRateLimit('loc-distance', env.LOCATION_SEARCH_RATE_LIMIT_PER_MINUTE, 60),
  validateBody(distanceBodySchema),
  distanceHandler,
);
