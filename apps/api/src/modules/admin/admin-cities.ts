import type {
  AdminCityBody,
  AdminCityCategoriesBody,
  AdminCityDocumentsBody,
  AdminCityHoursBody,
  AdminCityPaymentsBody,
  AdminCityRow,
  AdminCitySettingsBody,
  AdminCityStatusBody,
  AdminCityZonesBody,
  ApiResponse,
  CityAnalytics,
  CityDetail,
} from '@yatri/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { requireParam } from '../../lib/params';
import {
  cityAnalytics,
  cityDetail,
  createCity,
  listCities,
  setCityCategories,
  setCityDocuments,
  setCityHours,
  setCityPayments,
  setCitySettings,
  setCityStatus,
  setCityZones,
  updateCity,
} from '../cities/cities-admin.service';
import { HttpError } from '../../middleware/errorHandler';
import { rangeFields, resolveRange } from './admin-range';

/** Handlers for the cities workspace. Thin calls into the cities service; permissions are named on the routes. */
const adminId = (req: Request) => {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
};
const id = (req: Request) => requireParam(req, 'id');
type Res<T> = Response<ApiResponse<T>>;

export const cityAnalyticsQuerySchema = z.object(rangeFields);

export async function listCitiesHandler(_req: Request, res: Res<AdminCityRow[]>) {
  res.json({ success: true, data: await listCities() });
}
export async function cityDetailHandler(req: Request, res: Res<CityDetail>) {
  res.json({ success: true, data: await cityDetail(id(req)) });
}
export async function createCityHandler(req: Request, res: Res<CityDetail>) {
  res
    .status(201)
    .json({ success: true, data: await createCity(req.body as AdminCityBody, adminId(req)) });
}
export async function updateCityHandler(req: Request, res: Res<CityDetail>) {
  res.json({
    success: true,
    data: await updateCity(id(req), req.body as AdminCityBody, adminId(req)),
  });
}
export async function cityStatusHandler(req: Request, res: Res<CityDetail>) {
  res.json({
    success: true,
    data: await setCityStatus(id(req), req.body as AdminCityStatusBody, adminId(req)),
  });
}
export async function cityHoursHandler(req: Request, res: Res<CityDetail>) {
  res.json({
    success: true,
    data: await setCityHours(id(req), req.body as AdminCityHoursBody, adminId(req)),
  });
}
export async function cityCategoriesHandler(req: Request, res: Res<CityDetail>) {
  res.json({
    success: true,
    data: await setCityCategories(id(req), req.body as AdminCityCategoriesBody, adminId(req)),
  });
}
export async function cityPaymentsHandler(req: Request, res: Res<CityDetail>) {
  res.json({
    success: true,
    data: await setCityPayments(id(req), req.body as AdminCityPaymentsBody, adminId(req)),
  });
}
export async function citySettingsHandler(req: Request, res: Res<CityDetail>) {
  res.json({
    success: true,
    data: await setCitySettings(id(req), req.body as AdminCitySettingsBody, adminId(req)),
  });
}
export async function cityDocumentsHandler(req: Request, res: Res<CityDetail>) {
  res.json({
    success: true,
    data: await setCityDocuments(id(req), req.body as AdminCityDocumentsBody, adminId(req)),
  });
}
export async function cityZonesHandler(req: Request, res: Res<CityDetail>) {
  res.json({
    success: true,
    data: await setCityZones(id(req), req.body as AdminCityZonesBody, adminId(req)),
  });
}
export async function cityAnalyticsHandler(req: Request, res: Res<CityAnalytics>) {
  const q = req.validatedQuery as z.infer<typeof cityAnalyticsQuerySchema>;
  res.json({ success: true, data: await cityAnalytics(id(req), await resolveRange(q, '30d')) });
}
