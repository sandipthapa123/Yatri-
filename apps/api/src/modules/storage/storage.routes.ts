import { Router, type Router as RouterType } from 'express';

import { ipRateLimit } from '../../middleware/rateLimit';
import { getSignedContentHandler } from './storage.controller';

export const storageRouter: RouterType = Router();

storageRouter.get('/content', ipRateLimit('storage:content', 60, 60), getSignedContentHandler);
