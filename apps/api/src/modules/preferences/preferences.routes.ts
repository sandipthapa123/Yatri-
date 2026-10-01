import {
  type AccessibilityProfile,
  type AccessibilityProfileBody,
  type ApiResponse,
  type DeviceSession,
  type PreferencesResponse,
  type RecentPlacesResponse,
  type UpdatePreferencesBody,
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
import {
  clearRecentPlaces,
  listDevices,
  recentPlaces,
  signOutDevice,
  signOutOtherDevices,
} from './account.service';
import { getPreferences, updatePreferences } from './preferences.service';
import { getProfile, saveProfile } from '../accessibility/accessibility.service';
import { profileBodySchema } from '../accessibility/accessibility.validators';

/**
 * Mounted at /users/me. Everything is the caller's own: the person is the session's, never taken from the
 * request. Passengers and drivers only (administrators have no rider preferences, and no screen of theirs reads
 * anyone else's).
 */
export const preferencesRouter: RouterType = Router();
preferencesRouter.use(authenticate, requireRole('PASSENGER', 'DRIVER'), userMutationRateLimit());

type Res<T> = Response<ApiResponse<T>>;
const me = (req: Request) => {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth as { userId: string; sessionId: string; role: 'PASSENGER' | 'DRIVER' };
};

export const updatePreferencesSchema = z
  .object({
    changes: z
      .record(z.string().min(1).max(60), z.unknown())
      .refine((c) => Object.keys(c).length <= 40, 'Too many changes.'),
    expectedVersion: z.number().int().min(0).optional(),
  })
  .strict();

preferencesRouter.get('/preferences', async (req, res: Res<PreferencesResponse>) => {
  const a = me(req);
  res.json({ success: true, data: await getPreferences(a.userId, a.role) });
});
preferencesRouter.patch(
  '/preferences',
  userRateLimit('preferences', 60, 60),
  validateBody(updatePreferencesSchema),
  async (req, res: Res<PreferencesResponse>) => {
    const a = me(req);
    res.json({
      success: true,
      data: await updatePreferences(a.userId, a.role, req.body as UpdatePreferencesBody),
    });
  },
);

// What the passenger chose to say about their accessibility needs: only their own, only what they stated.
preferencesRouter.get(
  '/accessibility',
  requireRole('PASSENGER'),
  async (req, res: Res<AccessibilityProfile>) => {
    res.json({ success: true, data: await getProfile(me(req).userId) });
  },
);
preferencesRouter.put(
  '/accessibility',
  requireRole('PASSENGER'),
  userRateLimit('accessibility-profile', 30, 3600),
  validateBody(profileBodySchema),
  async (req, res: Res<AccessibilityProfile>) => {
    res.json({
      success: true,
      data: await saveProfile(me(req).userId, req.body as AccessibilityProfileBody),
    });
  },
);

preferencesRouter.get(
  '/recent-places',
  requireRole('PASSENGER'),
  async (req, res: Res<RecentPlacesResponse>) => {
    res.json({ success: true, data: await recentPlaces(me(req).userId) });
  },
);
preferencesRouter.post(
  '/recent-places/clear',
  requireRole('PASSENGER'),
  async (req, res: Res<{ cleared: true }>) => {
    await clearRecentPlaces(me(req).userId);
    res.json({ success: true, data: { cleared: true } });
  },
);

preferencesRouter.get('/devices', async (req, res: Res<DeviceSession[]>) => {
  const a = me(req);
  res.json({ success: true, data: await listDevices(a.userId, a.sessionId) });
});
preferencesRouter.post(
  '/devices/sign-out-others',
  userRateLimit('sign-out-devices', 10, 3600),
  async (req, res: Res<{ signedOut: number }>) => {
    const a = me(req);
    res.json({
      success: true,
      data: { signedOut: await signOutOtherDevices(a.userId, a.sessionId) },
    });
  },
);
preferencesRouter.delete(
  '/devices/:sessionId',
  userRateLimit('sign-out-devices', 10, 3600),
  validateUuidParam('sessionId'),
  async (req, res: Res<{ signedOut: true }>) => {
    const a = me(req);
    await signOutDevice(a.userId, requireParam(req, 'sessionId'), a.sessionId);
    res.json({ success: true, data: { signedOut: true } });
  },
);
