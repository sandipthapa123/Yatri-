import type { Request, Response } from 'express';
import type { ApiResponse, Vehicle, VehicleCategory } from '@yatri/types';

import { HttpError } from '../../middleware/errorHandler';
import { requireParam } from '../../lib/params';
import {
  createVehicle,
  findVehicleById,
  findVehiclesByDriver,
  listActiveVehicleCategories,
  updateVehicle,
  type CreateVehicleInput,
  type UpdateVehicleInput,
} from './vehicles.repository';
import { toPublicVehicle, toPublicVehicleCategory } from './vehicles.types';

export async function listVehicleCategoriesHandler(
  _req: Request,
  res: Response<ApiResponse<VehicleCategory[]>>,
) {
  const rows = await listActiveVehicleCategories();
  res.json({ success: true, data: rows.map(toPublicVehicleCategory) });
}

export async function createVehicleHandler(req: Request, res: Response<ApiResponse<Vehicle>>) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const input = req.body as CreateVehicleInput;

  const category = await listActiveVehicleCategories();
  if (!category.some((c) => c.id === input.categoryId)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Unknown vehicle category.').withDetails({
      categoryId: ['Unknown vehicle category'],
    });
  }

  const vehicle = await createVehicle(req.auth.userId, input);
  res.status(201).json({ success: true, data: toPublicVehicle(vehicle) });
}

export async function listMyVehiclesHandler(req: Request, res: Response<ApiResponse<Vehicle[]>>) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const rows = await findVehiclesByDriver(req.auth.userId);
  res.json({ success: true, data: rows.map(toPublicVehicle) });
}

export async function updateVehicleHandler(req: Request, res: Response<ApiResponse<Vehicle>>) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const existing = await findVehicleById(requireParam(req, 'id'));
  if (!existing || existing.driver_user_id !== req.auth.userId) {
    // 404, not 403 — a driver should not be able to tell "not mine" from
    // "doesn't exist" for another driver's vehicle id.
    throw new HttpError(404, 'NOT_FOUND', 'Vehicle not found.');
  }

  const update = req.body as UpdateVehicleInput;
  const updated = await updateVehicle(existing.id, update);
  if (!updated) throw new HttpError(404, 'NOT_FOUND', 'Vehicle not found.');
  res.json({ success: true, data: toPublicVehicle(updated) });
}
