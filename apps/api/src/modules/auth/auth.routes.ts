import { Router, type Router as RouterType } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { ipRateLimit } from '../../middleware/rateLimit';
import { validateBody } from '../../middleware/validate';
import {
  adminLoginHandler,
  logoutHandler,
  refreshHandler,
  requestOtpHandler,
  verifyOtpHandler,
} from './auth.controller';
import {
  adminLoginSchema,
  logoutSchema,
  refreshSchema,
  requestOtpSchema,
  verifyOtpSchema,
} from './auth.validators';

export const authRouter: RouterType = Router();

// Coarse per-IP flood guard on every auth route, on top of the
// phone/email-keyed limits inside the handlers themselves.
authRouter.use(ipRateLimit('auth:flood', 60, 60));

authRouter.post('/request-otp', validateBody(requestOtpSchema), requestOtpHandler);
authRouter.post('/verify-otp', validateBody(verifyOtpSchema), verifyOtpHandler);
authRouter.post('/refresh', validateBody(refreshSchema), refreshHandler);
authRouter.post('/logout', authenticate, validateBody(logoutSchema), logoutHandler);
authRouter.post('/admin/login', validateBody(adminLoginSchema), adminLoginHandler);
