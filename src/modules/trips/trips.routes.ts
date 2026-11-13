import { Router } from 'express';
import type { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { withVersion } from '../../lib/crud';
import { AppError } from '../../lib/errors';
import { escapeRegex } from '../../lib/normalize';
import { paginate } from '../../lib/pagination';
import { idParams } from '../../lib/schemas';
import { addDaysYmd, startOfDayInTz } from '../../lib/time';
import { signFileLink } from '../../lib/tokens';
import { authorize } from '../../middleware/auth';
import { idempotent } from '../../middleware/idempotency';
import { uploadLimiter } from '../../middleware/rateLimiters';
import { validate } from '../../middleware/validate';
import { Trip } from '../../models/Trip';
import { getSettings } from '../../services/settings.service';
import { storage } from '../../lib/storage';
import { storeUploadedFile, uploadSingle } from '../documents/documents.service';
import { cancelBody, correctBody, createTripBody, deliverBody, dispatchBody, listTripsQuery, planningOptionsQuery, prefillQuery, updateTripBody } from './trips.schema';
import * as svc from './trips.service';
import { lastOdometer, planningOptions, tripPrefill } from './trips.assist';

export const tripsRouter = Router();

type Req = { user?: { permissions: string[] } };
const has = (req: Req, p: string) => !!req.user?.permissions.includes(p);

/** Customer money (freight, quotation value) is Admin only; other roles get the trip without it. */
function forViewer<T extends object>(req: Req, trip: T): T {
  if (has(req, 'customers.finance')) return trip;
  const out = { ...trip } as Record<string, unknown>;
  delete out.freightPaise;
  const q = out.quotationId;
  if (q && typeof q === 'object' && 'totalPaise' in q) {
    const { totalPaise: _t, ...qRest } = q as Record<string, unknown>;
    out.quotationId = qRest;
  }
  return out as T;
}

/**
 * Non-admins cannot set freight or change the linked quotation (both carry customer rates).
 * The fields are dropped, so an edit by Operations keeps whatever Admin set.
 */
function guardCustomerFields(req: Req & { body: Record<string, unknown> }) {
  if (!has(req, 'customers.finance')) delete req.body.freightPaise;
  if (!has(req, 'quotations.view')) delete req.body.quotationId;
}

const POPULATE = [
  { path: 'companyId', select: 'companyCode legalName' },
  { path: 'vehicleId', select: 'registrationNumber capacityLitres compartments' },
  { path: 'driverId', select: 'name phone' },
];

tripsRouter.get(
  '/',
  authorize('trips.view'),
  validate({ query: listTripsQuery }),
  asyncHandler(async (req, res) => {
    const { page, limit, q, status, vehicleId, driverId, companyId, from, to } = req.query as unknown as z.infer<typeof listTripsQuery>;
    const { timezone } = await getSettings();
    const filter: Record<string, unknown> = {};
    if (q) filter.tripNumber = new RegExp('^' + escapeRegex(q.toUpperCase()));
    if (status) filter.status = status;
    if (vehicleId) filter.vehicleId = vehicleId;
    if (driverId) filter.driverId = driverId;
    if (companyId) filter.companyId = companyId;
    if (from || to) {
      filter.plannedStart = {
        ...(from ? { $gte: startOfDayInTz(from, timezone) } : {}),
        ...(to ? { $lt: startOfDayInTz(addDaysYmd(to, 1), timezone) } : {}),
      };
    }
    const result = await paginate(Trip, {
      filter,
      page,
      limit,
      sort: { plannedStart: -1 },
      projection: 'tripNumber companyId vehicleId driverId product plannedQuantityLitres loadingPoint unloadingPoint plannedStart plannedEnd status delivery.shortageLitres delivery.withinTolerance delivery.receivedQuantityLitres __v',
      populate: POPULATE,
    });
    res.json({ ...result, items: (result.items as { __v?: number }[]).map(withVersion) });
  }),
);

/** Values the plan-trip form can fill in for the user (quotation, customer history, vehicle). */
tripsRouter.get(
  '/prefill',
  authorize('trips.manage'),
  validate({ query: prefillQuery }),
  asyncHandler(async (req, res) => {
    const params = req.query as unknown as z.infer<typeof prefillQuery>;
    if (params.quotationId && !has(req, 'quotations.view')) throw AppError.forbidden('Only Admin can open quotations.');
    res.json(await tripPrefill(params));
  }),
);

/** Active vehicles and drivers, each flagged busy or blocked for the chosen time window. */
tripsRouter.get(
  '/planning-options',
  authorize('trips.manage'),
  validate({ query: planningOptionsQuery }),
  asyncHandler(async (req, res) => {
    res.json(await planningOptions(req.query as unknown as z.infer<typeof planningOptionsQuery>));
  }),
);

tripsRouter.get(
  '/:id',
  authorize('trips.view'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const trip = await Trip.findById(req.params.id)
      .populate([...POPULATE, { path: 'quotationId', select: 'quotationNumber status totalPaise' }, { path: 'createdBy', select: 'name' }])
      .lean();
    if (!trip) throw AppError.notFound('Trip');
    // Lets the dispatch form start from the vehicle's last known odometer.
    const assist = trip.status === 'planned' || trip.status === 'in_transit' ? { lastOdometer: await lastOdometer((trip.vehicleId as unknown as { _id: string })._id, trip._id) } : undefined;
    res.json(forViewer(req, { ...withVersion(trip), assist }));
  }),
);

tripsRouter.post(
  '/',
  authorize('trips.manage'),
  validate({ body: createTripBody }),
  idempotent,
  asyncHandler(async (req, res) => {
    guardCustomerFields(req);
    const trip = await svc.createTrip(req, req.body);
    res.status(201).json(forViewer(req, withVersion(trip.toObject())));
  }),
);

tripsRouter.patch(
  '/:id',
  authorize('trips.manage'),
  validate({ params: idParams, body: updateTripBody }),
  asyncHandler(async (req, res) => {
    guardCustomerFields(req);
    const { version, ...patch } = req.body as z.infer<typeof updateTripBody>;
    const trip = await svc.updatePlannedTrip(req, req.params.id, version, patch);
    res.json(forViewer(req, withVersion(trip)));
  }),
);

tripsRouter.post(
  '/:id/dispatch',
  authorize('trips.dispatch'),
  validate({ params: idParams, body: dispatchBody }),
  idempotent,
  asyncHandler(async (req, res) => {
    res.json(forViewer(req, withVersion(await svc.dispatchTrip(req, req.params.id, req.body))));
  }),
);

tripsRouter.post(
  '/:id/deliver',
  authorize('trips.deliver'),
  uploadLimiter,
  validate({ params: idParams }),
  uploadSingle,
  validate({ body: deliverBody }),
  idempotent,
  asyncHandler(async (req, res) => {
    const proof = req.file ? await storeUploadedFile(req.file, 'proofs') : null;
    try {
      const trip = await svc.deliverTrip(req, req.params.id, req.body, proof);
      res.json(forViewer(req, withVersion(trip)));
    } catch (err) {
      if (proof) await storage.remove(proof.storageKey).catch(() => undefined);
      throw err;
    }
  }),
);

tripsRouter.post(
  '/:id/cancel',
  authorize('trips.cancel'),
  validate({ params: idParams, body: cancelBody }),
  asyncHandler(async (req, res) => {
    res.json(forViewer(req, withVersion(await svc.cancelTrip(req, req.params.id, req.body.version, req.body.reason))));
  }),
);

tripsRouter.post(
  '/:id/correct',
  authorize('trips.correct'),
  validate({ params: idParams, body: correctBody }),
  asyncHandler(async (req, res) => {
    res.json(forViewer(req, withVersion(await svc.correctTrip(req, req.params.id, req.body))));
  }),
);

tripsRouter.get(
  '/:id/proof',
  authorize('trips.view'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const trip = await Trip.findById(req.params.id).select('+delivery.proofStorageKey').lean();
    const key = trip?.delivery?.proofStorageKey;
    if (!key) throw AppError.notFound('Proof of delivery');
    const name = trip.delivery?.proofFileName ?? `${trip.tripNumber}-pod`;
    res.json({ url: `/api/v1/files/${signFileLink({ k: key, u: req.user!.id, n: name, m: 'application/octet-stream' })}`, expiresInSeconds: 300 });
  }),
);
