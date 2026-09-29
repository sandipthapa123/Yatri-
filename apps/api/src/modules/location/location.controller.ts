import type { Request, Response } from 'express';
import type { ApiResponse, DistanceResult, PlaceSummary, ReverseGeocodeResult } from '@yatri/types';

import { calculateDistance, reverseGeocode, searchPlaces } from './location.service';
import type { Coordinate } from './coordinates';

export async function searchHandler(req: Request, res: Response<ApiResponse<PlaceSummary[]>>) {
  const q = req.validatedQuery as {
    q: string;
    limit: number;
    nearLatitude?: number;
    nearLongitude?: number;
  };
  const near =
    q.nearLatitude !== undefined && q.nearLongitude !== undefined
      ? { latitude: q.nearLatitude, longitude: q.nearLongitude }
      : undefined;
  const results = await searchPlaces(q.q, { limit: q.limit, near });
  res.json({ success: true, data: results });
}

export async function reverseGeocodeHandler(
  req: Request,
  res: Response<ApiResponse<ReverseGeocodeResult>>,
) {
  const result = await reverseGeocode(req.validatedQuery as Coordinate);
  res.json({ success: true, data: result });
}

export async function distanceHandler(req: Request, res: Response<ApiResponse<DistanceResult>>) {
  const body = req.body as {
    origin: Coordinate;
    destination: Coordinate;
    method: 'straight_line' | 'route';
  };
  res.json({
    success: true,
    data: await calculateDistance(body.origin, body.destination, body.method),
  });
}
