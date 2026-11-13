import { Router } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';
import { TRIP_ACTIVE_STATUS } from '../../config/constants';
import { asyncHandler } from '../../lib/asyncHandler';
import { loadForUpdate, withVersion } from '../../lib/crud';
import { AppError, ErrorCodes } from '../../lib/errors';
import { escapeRegex, normalizeRegistration } from '../../lib/normalize';
import { paginate } from '../../lib/pagination';
import { idParams } from '../../lib/schemas';
import { authorize } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { ComplianceDocument } from '../../models/Document';
import { Driver } from '../../models/Driver';
import { Trip } from '../../models/Trip';
import { Vehicle } from '../../models/Vehicle';
import { audit, diffFields } from '../../services/audit.service';
import { expiryState, vehicleComplianceIssues } from '../../services/compliance.service';
import { getSettings } from '../../services/settings.service';
import { createVehicleBody, listVehiclesQuery, updateVehicleBody } from './vehicles.schema';

export const vehiclesRouter = Router();

/** One tanker per driver: the driver must be active and not already assigned to another vehicle. */
async function assertDriverAssignable(driverId: string | Types.ObjectId, vehicleId?: Types.ObjectId) {
  const driver = await Driver.findById(driverId).select('name status').lean();
  if (!driver) throw AppError.notFound('Driver');
  if (driver.status !== 'active') throw AppError.badRequest(`${driver.name} is not active.`, [{ field: 'assignedDriverId', code: 'INACTIVE' }]);
  const other = await Vehicle.findOne({ assignedDriverId: driver._id, status: { $ne: 'retired' }, ...(vehicleId ? { _id: { $ne: vehicleId } } : {}) }).select('registrationNumber').lean();
  if (other) {
    throw AppError.conflict(ErrorCodes.DEPENDENT_RECORDS, `${driver.name} is already assigned to ${other.registrationNumber}. Unassign them there first.`, undefined, [
      { field: 'assignedDriverId', code: 'ASSIGNED_ELSEWHERE' },
    ]);
  }
}

/** Per-page compliance summary computed with ONE aggregate for all rows (no N+1). */
async function complianceSummary(vehicleIds: Types.ObjectId[]) {
  if (!vehicleIds.length) return new Map<string, { expired: number; expiring: number; nextExpiry: Date | null }>();
  const settings = await getSettings();
  const docs = await ComplianceDocument.find({ ownerType: 'vehicle', ownerId: { $in: vehicleIds }, status: 'active', expiryDate: { $ne: null } })
    .select('ownerId expiryDate')
    .lean();
  const map = new Map<string, { expired: number; expiring: number; nextExpiry: Date | null }>();
  for (const d of docs) {
    const key = String(d.ownerId);
    const entry = map.get(key) ?? { expired: 0, expiring: 0, nextExpiry: null };
    const { state } = expiryState(d.expiryDate, settings.timezone);
    if (state === 'expired') entry.expired++;
    if (state === 'expiring') entry.expiring++;
    if (state !== 'expired' && d.expiryDate && (!entry.nextExpiry || d.expiryDate < entry.nextExpiry)) entry.nextExpiry = d.expiryDate;
    map.set(key, entry);
  }
  return map;
}

vehiclesRouter.get(
  '/',
  authorize('vehicles.view'),
  validate({ query: listVehiclesQuery }),
  asyncHandler(async (req, res) => {
    const { page, limit, q, status, vehicleType } = req.query as unknown as z.infer<typeof listVehiclesQuery>;
    const filter: Record<string, unknown> = {};
    if (q) filter.normalizedRegistration = new RegExp('^' + escapeRegex(normalizeRegistration(q)));
    if (status) filter.status = status;
    if (vehicleType) filter.vehicleType = vehicleType;
    const result = await paginate(Vehicle, {
      filter,
      page,
      limit,
      sort: { normalizedRegistration: 1 },
      projection: '-normalizedRegistration -notes',
      populate: [{ path: 'assignedDriverId', select: 'name phone' }],
    });
    const items = result.items as { _id: Types.ObjectId; __v?: number }[];
    const summary = await complianceSummary(items.map((i) => i._id));
    res.json({
      ...result,
      items: items.map((i) => ({ ...withVersion(i), compliance: summary.get(String(i._id)) ?? { expired: 0, expiring: 0, nextExpiry: null } })),
    });
  }),
);

/** Lightweight list of assignable vehicles for pickers; the fleet is bounded (~120). */
vehiclesRouter.get(
  '/lookup',
  authorize('vehicles.view'),
  asyncHandler(async (_req, res) => {
    const items = await Vehicle.find({ status: 'active' })
      .select('registrationNumber capacityLitres compartments status assignedDriverId')
      .sort({ normalizedRegistration: 1 })
      .limit(1000)
      .lean();
    res.set('Cache-Control', 'private, max-age=30').json({ items });
  }),
);

vehiclesRouter.get(
  '/:id',
  authorize('vehicles.view'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const vehicle = await Vehicle.findById(req.params.id).populate('assignedDriverId', 'name phone licenceExpiry').lean();
    if (!vehicle) throw AppError.notFound('Vehicle');
    const settings = await getSettings();
    const [documents, recentTrips, complianceIssues] = await Promise.all([
      ComplianceDocument.find({ ownerType: 'vehicle', ownerId: vehicle._id }).sort({ status: 1, documentType: 1, expiryDate: -1 }).limit(100).lean(),
      Trip.find({ vehicleId: vehicle._id }).sort({ plannedStart: -1 }).limit(10).select('tripNumber status product plannedQuantityLitres plannedStart plannedEnd').lean(),
      vehicleComplianceIssues(vehicle._id, new Date(), settings),
    ]);
    res.json({
      ...withVersion(vehicle),
      documents: documents.map((d) => ({ ...d, expiry: expiryState(d.expiryDate, settings.timezone) })),
      recentTrips,
      complianceIssues,
    });
  }),
);

vehiclesRouter.post(
  '/',
  authorize('vehicles.manage'),
  validate({ body: createVehicleBody }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createVehicleBody>;
    if (body.assignedDriverId) await assertDriverAssignable(body.assignedDriverId);
    const vehicle = await Vehicle.create({
      ...body,
      registrationNumber: body.registrationNumber.toUpperCase(),
      normalizedRegistration: normalizeRegistration(body.registrationNumber),
      createdBy: req.user!.id,
    });
    await audit(req, { action: 'vehicle.create', entityType: 'vehicle', entityId: String(vehicle._id), meta: { registration: vehicle.registrationNumber } });
    res.status(201).json(withVersion(vehicle.toObject()));
  }),
);

vehiclesRouter.patch(
  '/:id',
  authorize('vehicles.manage'),
  validate({ params: idParams, body: updateVehicleBody }),
  asyncHandler(async (req, res) => {
    const { version, ...patch } = req.body as z.infer<typeof updateVehicleBody>;
    const vehicle = await loadForUpdate(Vehicle, req.params.id, version, 'Vehicle');
    if (patch.status && patch.status !== vehicle.status) {
      if (!req.user!.permissions.includes('vehicles.changeStatus')) throw AppError.forbidden();
      if (patch.status !== 'active') {
        const busy = await Trip.findOne({ vehicleId: vehicle._id, status: { $in: TRIP_ACTIVE_STATUS } }).select('tripNumber').lean();
        if (busy) throw AppError.conflict(ErrorCodes.DEPENDENT_RECORDS, `Trip ${busy.tripNumber} is still open on this vehicle. Reassign or close it first.`);
      }
      // A retired tanker no longer holds a driver, so the driver is free for another vehicle.
      if (patch.status === 'retired') patch.assignedDriverId = null;
    }
    if (patch.assignedDriverId && String(patch.assignedDriverId) !== String(vehicle.assignedDriverId ?? '')) await assertDriverAssignable(patch.assignedDriverId, vehicle._id);
    const newCapacity = patch.capacityLitres;
    if (newCapacity !== undefined && newCapacity < vehicle.capacityLitres) {
      const over = await Trip.findOne({ vehicleId: vehicle._id, status: 'planned', plannedQuantityLitres: { $gt: newCapacity } }).select('tripNumber plannedQuantityLitres').lean();
      if (over) throw AppError.conflict(ErrorCodes.DEPENDENT_RECORDS, `Planned trip ${over.tripNumber} carries ${over.plannedQuantityLitres} L, more than the new capacity.`, undefined, [{ field: 'capacityLitres', code: 'BELOW_PLANNED' }]);
      if (!patch.compartments && vehicle.compartments?.length) {
        throw AppError.badRequest('Update the compartment capacities together with the total capacity.', [{ field: 'compartments', code: 'MISMATCH' }]);
      }
    }
    if (patch.compartments && patch.capacityLitres === undefined) {
      const sum = patch.compartments.reduce((s, c) => s + c.capacityLitres, 0);
      if (patch.compartments.length && sum !== vehicle.capacityLitres) {
        throw AppError.badRequest('Compartment capacities must add up to the total capacity.', [{ field: 'compartments', code: 'MISMATCH' }]);
      }
    }
    const extra: Record<string, unknown> = {};
    if (patch.registrationNumber) {
      extra.registrationNumber = patch.registrationNumber.toUpperCase();
      extra.normalizedRegistration = normalizeRegistration(patch.registrationNumber);
    }
    const changed = diffFields(vehicle.toObject(), patch);
    vehicle.set({ ...patch, ...extra, updatedBy: req.user!.id });
    await vehicle.save();
    await audit(req, {
      action: changed.includes('status') ? 'vehicle.status_change' : 'vehicle.update',
      entityType: 'vehicle',
      entityId: String(vehicle._id),
      changedFields: changed,
      meta: changed.includes('status') ? { status: vehicle.status } : undefined,
    });
    res.json(withVersion(vehicle.toObject()));
  }),
);
