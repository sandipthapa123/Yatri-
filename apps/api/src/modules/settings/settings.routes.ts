import { Router, type Router as RouterType } from 'express';

import { publicCities, serviceAtPlace } from '../cities/cities.service';
import { publicPlatformConfig } from './settings.service';

/**
 * What the apps are allowed to know about the platform's rules (public: no personal data, and the
 * "requests paused" notice has to be readable before someone signs in). The values come from the
 * same store an admin edits; an app displays them and never decides with them.
 */
export const configRouter: RouterType = Router();

/**
 * What applies at a place: which city it is in, whether Yatri is open there now and why not if it is not (the apps use
 * this to tell a rider or driver before they try). Public, like the rest of this router: it says nothing personal.
 */
configRouter.get('/service-at', async (req, res) => {
  const latitude = Number(req.query.latitude);
  const longitude = Number(req.query.longitude);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Give a latitude and a longitude.' },
    });
    return;
  }
  res.json({ success: true, data: await serviceAtPlace({ latitude, longitude }) });
});

configRouter.get('/platform', async (_req, res) => {
  res.json({ success: true, data: { ...publicPlatformConfig(), cities: await publicCities() } });
});
