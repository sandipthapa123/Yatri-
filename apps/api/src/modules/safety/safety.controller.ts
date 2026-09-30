import type {
  ApiResponse,
  EmergencyContact,
  EmergencyContactsResponse,
  IncidentBody,
  IncidentInfo,
  RatingSummary,
  SosInfo,
  SosRequestBody,
} from '@yatri/types';
import type { Request, Response } from 'express';

import { HttpError } from '../../middleware/errorHandler';
import { ratingSummary } from '../trips/ratings.service';
import { addContact, listContacts, removeContact } from './emergency-contacts.service';
import { createIncident, myIncidents } from './incidents.service';
import { cancelMySos, getMySos, triggerSos } from './sos.service';

/** The safety endpoints a passenger or driver uses on their own account and rides. */
function who(req: Request): { id: string; role: 'PASSENGER' | 'DRIVER' } {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const role = req.auth.role;
  if (role !== 'PASSENGER' && role !== 'DRIVER') {
    throw new HttpError(403, 'FORBIDDEN', 'This is for passengers and drivers.');
  }
  return { id: req.auth.userId, role };
}
const param = (req: Request, name: string) => {
  const v = req.params[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
};

// ---- emergency contacts
export async function listContactsHandler(
  req: Request,
  res: Response<ApiResponse<EmergencyContactsResponse>>,
) {
  res.json({ success: true, data: await listContacts(who(req).id) });
}
export async function addContactHandler(
  req: Request,
  res: Response<ApiResponse<EmergencyContact>>,
) {
  const u = who(req);
  res.status(201).json({
    success: true,
    data: await addContact(u.id, u.role, req.body as { name: string; phoneNumber: string }),
  });
}
export async function removeContactHandler(
  req: Request,
  res: Response<ApiResponse<{ removed: true }>>,
) {
  const u = who(req);
  await removeContact(u.id, u.role, param(req, 'contactId'));
  res.json({ success: true, data: { removed: true } });
}

// ---- SOS
export async function triggerSosHandler(req: Request, res: Response<ApiResponse<SosInfo>>) {
  const { sos, created } = await triggerSos(
    param(req, 'id'),
    who(req).id,
    req.body as SosRequestBody,
  );
  res.status(created ? 201 : 200).json({ success: true, data: sos });
}
export async function mySosHandler(req: Request, res: Response<ApiResponse<SosInfo | null>>) {
  res.json({ success: true, data: await getMySos(param(req, 'id'), who(req).id) });
}
export async function cancelSosHandler(req: Request, res: Response<ApiResponse<SosInfo>>) {
  res.json({ success: true, data: await cancelMySos(param(req, 'id'), who(req).id) });
}

// ---- incidents
export async function createIncidentHandler(
  req: Request,
  res: Response<ApiResponse<IncidentInfo>>,
) {
  res.status(201).json({
    success: true,
    data: await createIncident(param(req, 'id'), who(req).id, req.body as IncidentBody),
  });
}
export async function myIncidentsHandler(req: Request, res: Response<ApiResponse<IncidentInfo[]>>) {
  res.json({ success: true, data: await myIncidents(param(req, 'id'), who(req).id) });
}

// ---- ratings
export async function myRatingHandler(req: Request, res: Response<ApiResponse<RatingSummary>>) {
  res.json({ success: true, data: await ratingSummary(who(req).id) });
}
