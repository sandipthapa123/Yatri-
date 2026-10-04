import type { Request, Response } from 'express';
import type {
  ApiResponse,
  FareEstimateResponse,
  LiveTripSnapshot,
  NavigationRouteResponse,
  DigitalPaymentInfo,
  PaymentInfo,
  TripEventRecord,
  TripHistoryPage,
  TripOfferInfo,
  TripEstimateBody,
  TripRequestBody,
  TripAccessibilityUpdateBody,
  TripSummary,
} from '@yatri/types';

import { HttpError } from '../../middleware/errorHandler';
import { updatePickup } from '../accessibility/accessibility.service';
import {
  currentOfferFor,
  offerNext,
  requestAndOffer,
  respondOffer,
} from '../dispatch/dispatch.service';
import { readRoute } from '../navigation/navigation.service';
import { buildSnapshot, isActive, loadMeta } from '../tracking/tracking.service';
import { startDigitalPayment, verifyDigitalPayment } from './digital-payments.service';
import { getPaymentFor, settlePayment } from './payments.service';
import { rateTrip } from './ratings.service';
import { listTripEvents } from './trip-events.service';
import { getActiveTripFor, getTrip } from './trips.repository';
import {
  buildTripSummary,
  completeTrip,
  driverArrived,
  driverDropsOut,
  driverNoShow,
  estimateForRequest,
  listHistory,
  metaFromRow,
  participantTrip,
  passengerCancel,
  startTrip,
} from './trips.service';

function uid(req: Request): string {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
}
const param = (req: Request, name: string) => {
  const v = req.params[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
};
const idParam = (req: Request) => param(req, 'id');

async function summaryFor(req: Request, tripId: string): Promise<TripSummary> {
  const trip = await getTrip(tripId);
  if (!trip) throw new HttpError(404, 'NOT_FOUND', 'Trip not found.');
  return buildTripSummary(trip, uid(req));
}

// ---- passenger: estimate & request -------------------------------------------------------

export async function estimateHandler(
  req: Request,
  res: Response<ApiResponse<FareEstimateResponse>>,
) {
  const body = req.body as TripEstimateBody;
  const {
    fare,
    category,
    options,
    notices,
    pricing: cfg,
  } = await estimateForRequest(uid(req), body);
  res.json({
    success: true,
    data: {
      fare,
      vehicleCategory: { code: category.code, label: category.label },
      categories: options,
      pickup: {
        name: body.pickup.name ?? body.pickup.address,
        address: body.pickup.address,
        latitude: body.pickup.latitude,
        longitude: body.pickup.longitude,
      },
      destination: {
        name: body.destination.name ?? body.destination.address,
        address: body.destination.address,
        latitude: body.destination.latitude,
        longitude: body.destination.longitude,
      },
      waitingRule: { freeSeconds: cfg.waitingFreeSeconds, perMinuteNpr: cfg.waitingPerMinuteNpr },
      notices,
    },
  });
}

export async function requestHandler(req: Request, res: Response<ApiResponse<TripSummary>>) {
  const trip = await requestAndOffer(uid(req), req.body as TripRequestBody);
  res.status(201).json({ success: true, data: await summaryFor(req, trip.id) });
}

// ---- driver: offers -----------------------------------------------------------------------

export async function currentOfferHandler(
  req: Request,
  res: Response<ApiResponse<TripOfferInfo | null>>,
) {
  res.json({ success: true, data: await currentOfferFor(uid(req)) });
}

export function offerResponseHandler(accept: boolean) {
  return async (
    req: Request,
    res: Response<ApiResponse<{ accepted: boolean; trip: TripSummary | null }>>,
  ) => {
    const r = await respondOffer(uid(req), param(req, 'offerId'), accept);
    res.json({
      success: true,
      data: { accepted: r.accepted, trip: r.accepted ? await summaryFor(req, r.tripId) : null },
    });
  };
}

// ---- reading -------------------------------------------------------------------------------

export async function activeTripHandler(
  req: Request,
  res: Response<ApiResponse<TripSummary | null>>,
) {
  const trip = await getActiveTripFor(uid(req));
  res.json({ success: true, data: trip ? await buildTripSummary(trip, uid(req)) : null });
}

export async function historyHandler(req: Request, res: Response<ApiResponse<TripHistoryPage>>) {
  const q = req.validatedQuery as { page: number; pageSize: number };
  res.json({ success: true, data: await listHistory(uid(req), q.page, q.pageSize) });
}

export async function getTripHandler(req: Request, res: Response<ApiResponse<TripSummary>>) {
  const trip = await participantTrip(idParam(req), uid(req));
  res.json({ success: true, data: await buildTripSummary(trip, uid(req)) });
}

/** REST snapshot: the initial paint and the fallback when the socket is down. Not a history endpoint. */
export async function liveSnapshotHandler(
  req: Request,
  res: Response<ApiResponse<LiveTripSnapshot>>,
) {
  const trip = await participantTrip(idParam(req), uid(req));
  if (!isActive(trip.status)) {
    throw new HttpError(
      409,
      'TRIP_NOT_ACTIVE',
      'Live location is only available during an active trip.',
    );
  }
  const meta = (await loadMeta(trip.id)) ?? metaFromRow(trip);
  const viewer = trip.passenger_id === uid(req) ? 'PASSENGER' : 'DRIVER';
  res.json({ success: true, data: await buildSnapshot(meta, viewer) });
}

/**
 * The driver's route for the current target (pickup, then destination): turn-by-turn steps and the line. Only the
 * ASSIGNED driver of an ACTIVE ride may ask; a passenger (or anyone else) never receives the route, because it starts
 * at the driver's position. The passenger's view of progress is the snapshot's text figures.
 */
export async function navigationRouteHandler(
  req: Request,
  res: Response<ApiResponse<NavigationRouteResponse>>,
) {
  const trip = await participantTrip(idParam(req), uid(req));
  if (trip.driver_id !== uid(req)) {
    throw new HttpError(403, 'FORBIDDEN', 'Only the driver of this ride has its route.');
  }
  if (!isActive(trip.status)) {
    throw new HttpError(
      409,
      'TRIP_NOT_ACTIVE',
      'Directions are only available during an active ride.',
    );
  }
  const q = req.validatedQuery as { version?: number };
  res.json({ success: true, data: await readRoute(trip.id, q.version ?? null) });
}

/** Missed something while offline? Ask for everything after the last event number you applied. */
export async function eventsHandler(req: Request, res: Response<ApiResponse<TripEventRecord[]>>) {
  const trip = await participantTrip(idParam(req), uid(req));
  const q = req.validatedQuery as { after: number };
  res.json({ success: true, data: await listTripEvents(trip.id, { afterSeq: q.after }) });
}

// ---- lifecycle actions ---------------------------------------------------------------------

export function driverAction(action: 'arrived' | 'start' | 'complete' | 'no-show') {
  return async (req: Request, res: Response<ApiResponse<TripSummary>>) => {
    const id = idParam(req);
    const me = uid(req);
    if (action === 'arrived') await driverArrived(id, me);
    else if (action === 'start') await startTrip(id, me);
    else if (action === 'complete') await completeTrip(id, me);
    else await driverNoShow(id, me);
    res.json({ success: true, data: await summaryFor(req, id) });
  };
}

/** Cancel: a passenger cancels the ride; a driver dropping out sends it back to be re-matched. */
export async function cancelHandler(req: Request, res: Response<ApiResponse<TripSummary>>) {
  const id = idParam(req);
  const me = uid(req);
  const trip = await participantTrip(id, me);
  const { reason } = req.body as { reason?: string };
  if (trip.passenger_id === me) {
    await passengerCancel(id, me, reason);
  } else {
    const out = await driverDropsOut(id, me, 'DRIVER_CANCELLED');
    if (out.rematching) await offerNext(id);
  }
  res.json({ success: true, data: await summaryFor(req, id) });
}

// ---- payment, rating -----------------------------------------------------------

export async function getPaymentHandler(req: Request, res: Response<ApiResponse<PaymentInfo>>) {
  res.json({ success: true, data: await getPaymentFor(idParam(req), uid(req)) });
}

export async function confirmPaymentHandler(req: Request, res: Response<ApiResponse<PaymentInfo>>) {
  res.json({ success: true, data: await settlePayment(idParam(req), uid(req)) });
}

export async function startDigitalPaymentHandler(
  req: Request,
  res: Response<ApiResponse<DigitalPaymentInfo>>,
) {
  res.json({ success: true, data: await startDigitalPayment(idParam(req), uid(req)) });
}

export async function verifyDigitalPaymentHandler(
  req: Request,
  res: Response<ApiResponse<DigitalPaymentInfo>>,
) {
  res.json({ success: true, data: await verifyDigitalPayment(idParam(req), uid(req)) });
}

export async function rateHandler(
  req: Request,
  res: Response<ApiResponse<{ id: string; tripId: string; stars: number }>>,
) {
  res
    .status(201)
    .json({ success: true, data: await rateTrip(idParam(req), uid(req), req.body as never) });
}

/** The passenger changes how to be reached and where to meet, until the ride has started. */
export async function updateAccessibilityHandler(
  req: Request,
  res: Response<ApiResponse<TripSummary>>,
) {
  await updatePickup(idParam(req), uid(req), req.body as TripAccessibilityUpdateBody);
  res.json({ success: true, data: await summaryFor(req, idParam(req)) });
}
