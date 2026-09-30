import { Router, type Router as RouterType } from 'express';

import { publicPlatformConfig } from './settings.service';

/**
 * What the apps are allowed to know about the platform's rules (public: no personal data, and the
 * "requests paused" notice has to be readable before someone signs in). The values come from the
 * same store an admin edits; an app displays them and never decides with them.
 */
export const configRouter: RouterType = Router();

configRouter.get('/platform', (_req, res) => {
  res.json({ success: true, data: publicPlatformConfig() });
});
