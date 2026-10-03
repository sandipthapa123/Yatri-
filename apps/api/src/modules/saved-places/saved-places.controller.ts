import { isUniqueViolation } from '../../lib/db';
import type { Request, Response } from 'express';
import type { ApiResponse, SavedPlace, SavedPlaceKind } from '@yatri/types';

import { HttpError } from '../../middleware/errorHandler';
import { getLocationProvider } from '../location/providers';
import { reverseGeocode } from '../location/location.service';
import {
  countSavedPlaces,
  createSavedPlace,
  deleteSavedPlace,
  getSavedPlace,
  listSavedPlaces,
  updateSavedPlace,
  type PlaceFields,
} from './saved-places.repository';

const MAX_SAVED_PLACES = 50;

function userId(req: Request): string {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
}

function idParam(req: Request): string {
  const v = req.params.id;
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

const NOT_FOUND = () => new HttpError(404, 'NOT_FOUND', 'Saved place not found.');

/** Unique-index violations become clear 409s instead of raw Postgres errors. */
function mapConflict(err: unknown): never {
  if (isUniqueViolation(err)) {
    if (isUniqueViolation(err, 'saved_places_one_home_work')) {
      throw new HttpError(
        409,
        'SAVED_PLACE_EXISTS',
        'You already have a Home or Work place of that type. Edit it instead.',
      );
    }
    throw new HttpError(
      409,
      'SAVED_PLACE_DUPLICATE_NAME',
      'You already have a saved place with that name.',
    );
  }
  throw err;
}

/** Best-effort address resolution when the client did not supply one. */
async function resolveAddress(
  latitude: number,
  longitude: number,
): Promise<{
  address: string;
  city: string | null;
  province: string | null;
  country: string | null;
}> {
  try {
    const r = await reverseGeocode({ latitude, longitude });
    return {
      address: r.formattedAddress,
      city: r.city,
      province: r.province,
      country: r.country,
    };
  } catch {
    return {
      address: `Pinned location (${latitude.toFixed(5)}, ${longitude.toFixed(5)})`,
      city: null,
      province: null,
      country: null,
    };
  }
}

export async function listHandler(req: Request, res: Response<ApiResponse<SavedPlace[]>>) {
  res.json({ success: true, data: await listSavedPlaces(userId(req)) });
}

export async function getHandler(req: Request, res: Response<ApiResponse<SavedPlace>>) {
  const place = await getSavedPlace(userId(req), idParam(req));
  if (!place) throw NOT_FOUND();
  res.json({ success: true, data: place });
}

export async function createHandler(req: Request, res: Response<ApiResponse<SavedPlace>>) {
  const uid = userId(req);
  const b = req.body as {
    kind: SavedPlaceKind;
    name: string;
    label?: string | null;
    address?: string;
    latitude: number;
    longitude: number;
    city?: string | null;
    province?: string | null;
    country?: string | null;
  };
  if ((await countSavedPlaces(uid)) >= MAX_SAVED_PLACES) {
    throw new HttpError(409, 'SAVED_PLACE_LIMIT', `You can save up to ${MAX_SAVED_PLACES} places.`);
  }
  const resolved = b.address
    ? {
        address: b.address,
        city: b.city ?? null,
        province: b.province ?? null,
        country: b.country ?? null,
      }
    : await resolveAddress(b.latitude, b.longitude);

  try {
    const place = await createSavedPlace(uid, {
      kind: b.kind,
      name: b.name,
      label: b.label ?? null,
      provider: getLocationProvider()?.name ?? 'none',
      latitude: b.latitude,
      longitude: b.longitude,
      ...resolved,
    });
    res.status(201).json({ success: true, data: place });
  } catch (err) {
    mapConflict(err);
  }
}

export async function updateHandler(req: Request, res: Response<ApiResponse<SavedPlace>>) {
  const uid = userId(req);
  const id = idParam(req);
  const b = req.body as {
    kind?: SavedPlaceKind;
    name?: string;
    label?: string | null;
    address?: string;
    latitude?: number;
    longitude?: number;
    city?: string | null;
    province?: string | null;
    country?: string | null;
  };

  let place: PlaceFields | undefined;
  if (b.latitude !== undefined && b.longitude !== undefined) {
    // New coordinates: use the supplied address, otherwise resolve it. Never keep a stale address.
    const resolved = b.address
      ? {
          address: b.address,
          city: b.city ?? null,
          province: b.province ?? null,
          country: b.country ?? null,
        }
      : await resolveAddress(b.latitude, b.longitude);
    place = { latitude: b.latitude, longitude: b.longitude, ...resolved };
  } else if (b.address !== undefined) {
    const current = await getSavedPlace(uid, id);
    if (!current) throw NOT_FOUND();
    place = {
      latitude: current.latitude,
      longitude: current.longitude,
      address: b.address,
      city: b.city ?? current.city,
      province: b.province ?? current.province,
      country: b.country ?? current.country,
    };
  }

  try {
    const updated = await updateSavedPlace(uid, id, {
      kind: b.kind,
      name: b.name,
      label: b.label,
      place,
    });
    if (!updated) throw NOT_FOUND();
    res.json({ success: true, data: updated });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    mapConflict(err);
  }
}

export async function deleteHandler(req: Request, res: Response<ApiResponse<{ deleted: true }>>) {
  if (!(await deleteSavedPlace(userId(req), idParam(req)))) throw NOT_FOUND();
  res.json({ success: true, data: { deleted: true } });
}
