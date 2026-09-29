import { Router, type Router as RouterType } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/requireRole';
import { validateBody } from '../../middleware/validate';
import { uploadSingleFile } from '../../middleware/upload';
import { validateUuidParam } from '../../middleware/validateUuidParam';
import {
  deleteDocumentHandler,
  getMyDocumentDownloadUrlHandler,
  listDocumentTypesHandler,
  listMyDocumentsHandler,
  uploadDocumentHandler,
} from './documents.controller';
import { uploadDocumentSchema } from './documents.validators';

export const documentsRouter: RouterType = Router();

documentsRouter.use(authenticate);

documentsRouter.get('/types', listDocumentTypesHandler);

documentsRouter.post(
  '/',
  requireRole('DRIVER'),
  uploadSingleFile,
  validateBody(uploadDocumentSchema),
  uploadDocumentHandler,
);
documentsRouter.get('/', requireRole('DRIVER'), listMyDocumentsHandler);
documentsRouter.delete(
  '/:id',
  requireRole('DRIVER'),
  validateUuidParam('id'),
  deleteDocumentHandler,
);
documentsRouter.get(
  '/:id/download-url',
  requireRole('DRIVER'),
  validateUuidParam('id'),
  getMyDocumentDownloadUrlHandler,
);
