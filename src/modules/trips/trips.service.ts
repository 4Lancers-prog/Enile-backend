import type { Request } from 'express';
import { Types } from 'mongoose';
import { TRIP_ACTIVE_STATUS, TRIP_TRANSITIONS, type TripStatus } from '../../config/constants';
import { AppError, ErrorCodes } from '../../lib/errors';
import { withLocks } from '../../lib/locks';
import { financialYear } from '../../lib/time';
import { Company } from '../../models/Company';
import { nextSequence } from '../../models/Counter';
import { Driver } from '../../models/Driver';
import { Quotation } from '../../models/Quotation';
import type { AppSettings } from '../../models/SystemSetting';
import { Trip, type ITrip } from '../../models/Trip';
import { Vehicle } from '../../models/Vehicle';
import { audit } from '../../services/audit.service';
import { driverComplianceIssues, vehicleComplianceIssues } from '../../services/compliance.service';
import { getSettings } from '../../services/settings.service';
import { lastOdometer } from './trips.assist';
import type { CreateTripInput } from './trips.schema';

export function assertTripTransition(from: TripStatus, to: TripStatus) {
  if (!TRIP_TRANSITIONS[from].includes(to)) {
    throw AppError.unprocessable(
      ErrorCodes.TRIP_INVALID_STATUS_TRANSITION,
      `A ${from.replace('_', ' ')} trip cannot move to ${to.replace('_', ' ')}. Refresh the record or request a correction.`,
    );
  }
}

/** Two time ranges overlap when each starts before the other ends. */
export function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

interface AssignmentInput {
  companyId: string;
  quotationId?: string | null;
  vehicleId: string;
  driverId: string;
  plannedStart: Date;
  plannedEnd: Date;
  plannedQuantityLitres: number;
  complianceOverrideReason?: string;
}

/**
 * All the checks for assigning a vehicle + driver (manual 4.6). Must be called
 * while holding the vehicle and driver locks so the overlap result stays true
 * until the trip is written.
 */
async function validateAssignment(req: Request, input: AssignmentInput, settings: AppSettings, excludeTripId?: Types.ObjectId) {
  const hours = (input.plannedEnd.getTime() - input.plannedStart.getTime()) / 3_600_000;
  if (hours > settings.trip.maxDurationHours) {
    throw AppError.badRequest(`Trip duration cannot exceed ${settings.trip.maxDurationHours} hours.`, [{ field: 'plannedEnd', code: 'TOO_LONG' }]);
  }
  const [company, vehicle, driver, quotation] = await Promise.all([
    Company.findById(input.companyId).select('status').lean(),
    Vehicle.findById(input.vehicleId).select('registrationNumber status capacityLitres').lean(),
    Driver.findById(input.driverId).select('name status licenceExpiry hazardousEndorsement hazchemTrainingExpiry').lean(),
    input.quotationId ? Quotation.findById(input.quotationId).select('companyId status quotationNumber validUntil').lean() : Promise.resolve(null),
  ]);
  if (!company) throw AppError.notFound('Company');
  if (company.status !== 'active') throw AppError.unprocessable(ErrorCodes.COMPANY_INACTIVE, 'Select an active company.', [{ field: 'companyId', code: 'INACTIVE' }]);
  if (!vehicle) throw AppError.notFound('Vehicle');
  if (!driver) throw AppError.notFound('Driver');
  if (input.quotationId) {
    if (!quotation) throw AppError.notFound('Quotation');
    if (String(quotation.companyId) !== String(input.companyId)) {
      throw AppError.badRequest('The quotation belongs to a different company.', [{ field: 'quotationId', code: 'MISMATCH' }]);
    }
    if (!['accepted', 'issued'].includes(quotation.status)) {
      throw AppError.badRequest('Link an issued or accepted quotation.', [{ field: 'quotationId', code: 'INVALID_STATUS' }]);
    }
    // An issued (not yet accepted) offer only holds until its validity date.
    if (quotation.status === 'issued' && quotation.validUntil && quotation.validUntil < new Date()) {
      throw AppError.badRequest(`Quotation ${quotation.quotationNumber} lapsed on its validity date. Mark it accepted or issue a revision first.`, [{ field: 'quotationId', code: 'EXPIRED' }]);
    }
  }
  if (vehicle.status !== 'active') {
    throw AppError.conflict(ErrorCodes.TRIP_VEHICLE_UNAVAILABLE, `Vehicle ${vehicle.registrationNumber} is ${vehicle.status.replace('_', ' ')} and cannot be assigned.`, undefined, [
      { field: 'vehicleId', code: 'UNAVAILABLE' },
    ]);
  }
  if (input.plannedQuantityLitres > vehicle.capacityLitres) {
    throw AppError.badRequest(`Planned quantity exceeds the tanker capacity (${vehicle.capacityLitres} L).`, [{ field: 'plannedQuantityLitres', code: 'OVER_CAPACITY' }]);
  }
  if (driver.status !== 'active') {
    throw AppError.conflict(ErrorCodes.TRIP_DRIVER_UNAVAILABLE, `${driver.name} is not active and cannot be assigned.`, undefined, [{ field: 'driverId', code: 'UNAVAILABLE' }]);
  }

  const overlap = (field: 'vehicleId' | 'driverId', id: string) =>
    Trip.findOne({
      [field]: id,
      status: { $in: TRIP_ACTIVE_STATUS },
      plannedStart: { $lt: input.plannedEnd },
      plannedEnd: { $gt: input.plannedStart },
      ...(excludeTripId ? { _id: { $ne: excludeTripId } } : {}),
    })
      .select('tripNumber plannedStart plannedEnd')
      .lean();
  const [vClash, dClash] = await Promise.all([overlap('vehicleId', input.vehicleId), settings.trip.driverOverlapCheck ? overlap('driverId', input.driverId) : null]);
  if (vClash) {
    throw AppError.conflict(ErrorCodes.TRIP_VEHICLE_UNAVAILABLE, `Vehicle is already assigned to trip ${vClash.tripNumber} in this time window.`, { trip: vClash }, [
      { field: 'vehicleId', code: 'OVERLAP' },
    ]);
  }
  if (dClash) {
    throw AppError.conflict(ErrorCodes.TRIP_DRIVER_UNAVAILABLE, `Driver is already assigned to trip ${dClash.tripNumber} in this time window.`, { trip: dClash }, [
      { field: 'driverId', code: 'OVERLAP' },
    ]);
  }

  const issues = [...(await vehicleComplianceIssues(vehicle._id, input.plannedEnd, settings)), ...driverComplianceIssues(driver, input.plannedEnd, settings)];
  return resolveCompliance(req, issues, input.complianceOverrideReason, settings);
}

/** Expired/missing documents block dispatch unless an authorized user overrides with a reason. */
function resolveCompliance(req: Request, issues: string[], overrideReason: string | undefined, settings: AppSettings) {
  if (!issues.length) return null;
  const canOverride = settings.compliance.allowOverride && req.user!.permissions.includes('trips.overrideCompliance');
  if (overrideReason && canOverride) return { by: new Types.ObjectId(req.user!.id), at: new Date(), reason: overrideReason, issues };
  throw AppError.unprocessable(
    ErrorCodes.TRIP_COMPLIANCE_BLOCKED,
    canOverride ? 'Compliance documents need attention. Renew them or override with a reason.' : 'Compliance documents need attention before this trip can proceed.',
    undefined,
    { issues, canOverride },
  );
}

export async function createTrip(req: Request, input: CreateTripInput) {
  const settings = await getSettings();
  return withLocks([`vehicle:${input.vehicleId}`, `driver:${input.driverId}`], async () => {
    const override = await validateAssignment(req, input, settings);
    const fy = financialYear(input.plannedStart, settings.timezone);
    const seq = await nextSequence(`trip:${fy}`);
    const { complianceOverrideReason: _r, ...rest } = input;
    const trip = await Trip.create({
      ...rest,
      tripNumber: `${settings.trip.numberPrefix}/${fy}/${String(seq).padStart(5, '0')}`,
      status: 'planned',
      complianceOverride: override,
      createdBy: req.user!.id,
    });
    await audit(req, {
      action: 'trip.create',
      entityType: 'trip',
      entityId: String(trip._id),
      meta: { tripNumber: trip.tripNumber, complianceOverride: override ? override.issues : undefined },
    });
    return trip;
  });
}

export async function updatePlannedTrip(req: Request, id: string, version: number, patch: Partial<CreateTripInput>) {
  const settings = await getSettings();
  const current = await Trip.findById(id).lean();
  if (!current) throw AppError.notFound('Trip');
  if (current.__v !== version) throw AppError.stale();
  if (current.status !== 'planned') {
    throw AppError.unprocessable(ErrorCodes.TRIP_INVALID_STATUS_TRANSITION, 'Only planned trips can be edited.');
  }
  const merged = {
    companyId: String(patch.companyId ?? current.companyId),
    quotationId: patch.quotationId === undefined ? (current.quotationId ? String(current.quotationId) : null) : patch.quotationId,
    vehicleId: String(patch.vehicleId ?? current.vehicleId),
    driverId: String(patch.driverId ?? current.driverId),
    plannedStart: patch.plannedStart ?? current.plannedStart,
    plannedEnd: patch.plannedEnd ?? current.plannedEnd,
    plannedQuantityLitres: patch.plannedQuantityLitres ?? current.plannedQuantityLitres,
    complianceOverrideReason: patch.complianceOverrideReason,
  };
  if (merged.plannedEnd <= merged.plannedStart) throw AppError.badRequest('Planned end must be after planned start.', [{ field: 'plannedEnd', code: 'BEFORE_START' }]);
  const locks = [`vehicle:${merged.vehicleId}`, `driver:${merged.driverId}`, `vehicle:${current.vehicleId}`, `driver:${current.driverId}`];
  return withLocks(locks, async () => {
    const override = await validateAssignment(req, merged, settings, current._id);
    const { complianceOverrideReason: _r, ...rest } = patch;
    const updated = await Trip.findOneAndUpdate(
      { _id: id, __v: version, status: 'planned' },
      { $set: { ...rest, complianceOverride: override ?? current.complianceOverride ?? null, updatedBy: req.user!.id }, $inc: { __v: 1 } },
      { new: true },
    ).lean();
    if (!updated) throw AppError.stale();
    await audit(req, { action: 'trip.update', entityType: 'trip', entityId: id, changedFields: Object.keys(rest) });
    return updated;
  });
}

export async function dispatchTrip(
  req: Request,
  id: string,
  body: { version: number; invoiceNumber: string; dispatchedQuantityLitres: number; seals: { compartment: number; sealNumber: string }[]; densityKgM3?: number; temperatureC?: number; odometerStart?: number; complianceOverrideReason?: string },
) {
  const settings = await getSettings();
  const trip = await Trip.findById(id).lean();
  if (!trip) throw AppError.notFound('Trip');
  if (trip.__v !== body.version) throw AppError.stale();
  assertTripTransition(trip.status, 'in_transit');
  const [vehicle, driver] = await Promise.all([
    Vehicle.findById(trip.vehicleId).select('status capacityLitres compartments registrationNumber').lean(),
    Driver.findById(trip.driverId).select('name status licenceExpiry hazardousEndorsement hazchemTrainingExpiry').lean(),
  ]);
  if (!vehicle || vehicle.status !== 'active') throw AppError.conflict(ErrorCodes.TRIP_VEHICLE_UNAVAILABLE, 'The assigned vehicle is no longer available.');
  if (!driver || driver.status !== 'active') throw AppError.conflict(ErrorCodes.TRIP_DRIVER_UNAVAILABLE, 'The assigned driver is no longer available.');
  if (body.dispatchedQuantityLitres > vehicle.capacityLitres) {
    throw AppError.badRequest(`Dispatched quantity exceeds tanker capacity (${vehicle.capacityLitres} L).`, [{ field: 'dispatchedQuantityLitres', code: 'OVER_CAPACITY' }]);
  }
  if (settings.trip.requireSealsOnDispatch && body.seals.length === 0) {
    throw AppError.badRequest('Enter the seal numbers for the loaded compartments.', [{ field: 'seals', code: 'REQUIRED' }]);
  }
  const maxCompartment = vehicle.compartments?.length || 12;
  if (body.seals.some((s) => s.compartment > maxCompartment)) {
    throw AppError.badRequest(`This tanker has ${maxCompartment} compartments.`, [{ field: 'seals', code: 'INVALID_COMPARTMENT' }]);
  }
  if (body.odometerStart !== undefined) {
    const last = await lastOdometer(trip.vehicleId, trip._id);
    if (last !== null && body.odometerStart < last) {
      throw AppError.unprocessable(ErrorCodes.ODOMETER_BACKWARDS, `Opening odometer is below the last recorded reading for this vehicle (${last.toLocaleString('en-IN')} km).`, [
        { field: 'odometerStart', code: 'BELOW_LAST' },
      ]);
    }
  }
  // Re-check documents at dispatch time: something may have expired since planning.
  const issues = [...(await vehicleComplianceIssues(trip.vehicleId, trip.plannedEnd, settings)), ...driverComplianceIssues(driver, trip.plannedEnd, settings)];
  const override = issues.length ? trip.complianceOverride && issues.every((i) => trip.complianceOverride!.issues.includes(i)) ? trip.complianceOverride : resolveCompliance(req, issues, body.complianceOverrideReason, settings) : trip.complianceOverride;

  const updated = await Trip.findOneAndUpdate(
    { _id: id, __v: body.version, status: 'planned' },
    {
      $set: {
        status: 'in_transit',
        complianceOverride: override ?? null,
        dispatch: {
          dispatchedAt: new Date(),
          dispatchedBy: req.user!.id,
          invoiceNumber: body.invoiceNumber,
          dispatchedQuantityLitres: body.dispatchedQuantityLitres,
          seals: body.seals,
          densityKgM3: body.densityKgM3,
          temperatureC: body.temperatureC,
          odometerStart: body.odometerStart,
        },
        updatedBy: req.user!.id,
      },
      $inc: { __v: 1 },
    },
    { new: true },
  ).lean();
  if (!updated) throw AppError.stale();
  await audit(req, { action: 'trip.dispatch', entityType: 'trip', entityId: id, meta: { invoiceNumber: body.invoiceNumber, litres: body.dispatchedQuantityLitres } });
  return updated;
}

export function computeShortage(dispatched: number, received: number, tolerancePercent: number) {
  const shortageLitres = Math.round((dispatched - received) * 1000) / 1000;
  const shortagePercent = dispatched > 0 ? Math.round((shortageLitres / dispatched) * 100_000) / 1000 : 0;
  return { shortageLitres, shortagePercent, withinTolerance: shortagePercent <= tolerancePercent };
}

export async function deliverTrip(
  req: Request,
  id: string,
  body: { version: number; receivedQuantityLitres: number; receiverName?: string; sealsIntact: boolean; odometerEnd?: number; remarks?: string },
  proof: { storageKey: string; fileName: string } | null,
) {
  const settings = await getSettings();
  const trip = await Trip.findById(id).lean();
  if (!trip) throw AppError.notFound('Trip');
  if (trip.__v !== body.version) throw AppError.stale();
  assertTripTransition(trip.status, 'delivered');
  if (settings.trip.requireProofOfDelivery && !proof) {
    throw AppError.badRequest('Attach the proof of delivery (signed challan/receipt).', [{ field: 'file', code: 'REQUIRED' }]);
  }
  const dispatched = trip.dispatch?.dispatchedQuantityLitres ?? trip.plannedQuantityLitres;
  if (body.receivedQuantityLitres > dispatched * 1.02) {
    throw AppError.badRequest('Received quantity is more than 2% above the dispatched quantity. Please recheck.', [{ field: 'receivedQuantityLitres', code: 'TOO_HIGH' }]);
  }
  if (body.odometerEnd !== undefined && trip.dispatch?.odometerStart !== undefined && body.odometerEnd < trip.dispatch.odometerStart) {
    throw AppError.badRequest('Closing odometer cannot be less than the opening reading.', [{ field: 'odometerEnd', code: 'INVALID' }]);
  }
  const shortage = computeShortage(dispatched, body.receivedQuantityLitres, settings.trip.shortageTolerancePercent);
  const updated = await Trip.findOneAndUpdate(
    { _id: id, __v: body.version, status: 'in_transit' },
    {
      $set: {
        status: 'delivered',
        delivery: {
          deliveredAt: new Date(), // server time only (manual 4.6)
          deliveredBy: req.user!.id,
          receivedQuantityLitres: body.receivedQuantityLitres,
          ...shortage,
          receiverName: body.receiverName,
          sealsIntact: body.sealsIntact,
          proofStorageKey: proof?.storageKey ?? null,
          proofFileName: proof?.fileName ?? null,
          odometerEnd: body.odometerEnd,
          remarks: body.remarks,
        },
        updatedBy: req.user!.id,
      },
      $inc: { __v: 1 },
    },
    { new: true },
  ).lean();
  if (!updated) throw AppError.stale();
  await audit(req, { action: 'trip.deliver', entityType: 'trip', entityId: id, meta: { received: body.receivedQuantityLitres, ...shortage } });
  return updated;
}

export async function cancelTrip(req: Request, id: string, version: number, reason: string) {
  const trip = await Trip.findById(id).select('status __v').lean();
  if (!trip) throw AppError.notFound('Trip');
  if (trip.__v !== version) throw AppError.stale();
  assertTripTransition(trip.status, 'cancelled');
  if (trip.status === 'in_transit' && !req.user!.permissions.includes('trips.correct')) {
    throw AppError.forbidden('Only a manager can cancel a trip that is already in transit.');
  }
  const updated = await Trip.findOneAndUpdate(
    { _id: id, __v: version, status: trip.status },
    { $set: { status: 'cancelled', cancellation: { cancelledAt: new Date(), cancelledBy: req.user!.id, reason }, updatedBy: req.user!.id }, $inc: { __v: 1 } },
    { new: true },
  ).lean();
  if (!updated) throw AppError.stale();
  await audit(req, { action: 'trip.cancel', entityType: 'trip', entityId: id, meta: { from: trip.status, reason } });
  return updated;
}

/** Authorized correction flow for delivered trips: every change is kept with a reason. */
export async function correctTrip(
  req: Request,
  id: string,
  body: { version: number; reason: string; receivedQuantityLitres?: number; receiverName?: string; sealsIntact?: boolean; remarks?: string; revertToInTransit?: boolean },
) {
  const settings = await getSettings();
  const trip = await Trip.findById(id).lean();
  if (!trip) throw AppError.notFound('Trip');
  if (trip.__v !== body.version) throw AppError.stale();
  if (trip.status !== 'delivered' || !trip.delivery) {
    throw AppError.unprocessable(ErrorCodes.TRIP_INVALID_STATUS_TRANSITION, 'Only delivered trips can be corrected.');
  }
  const before: Record<string, unknown> = {};
  const set: Record<string, unknown> = { updatedBy: req.user!.id };
  if (body.revertToInTransit) {
    before.status = trip.status;
    before.delivery = trip.delivery;
    set.status = 'in_transit';
    set.delivery = null;
  } else {
    const d = trip.delivery as NonNullable<ITrip['delivery']>;
    if (body.receivedQuantityLitres !== undefined) {
      const dispatched = trip.dispatch?.dispatchedQuantityLitres ?? trip.plannedQuantityLitres;
      const s = computeShortage(dispatched, body.receivedQuantityLitres, settings.trip.shortageTolerancePercent);
      before.receivedQuantityLitres = d.receivedQuantityLitres;
      set['delivery.receivedQuantityLitres'] = body.receivedQuantityLitres;
      set['delivery.shortageLitres'] = s.shortageLitres;
      set['delivery.shortagePercent'] = s.shortagePercent;
      set['delivery.withinTolerance'] = s.withinTolerance;
    }
    for (const k of ['receiverName', 'sealsIntact', 'remarks'] as const) {
      if (body[k] !== undefined) {
        before[k] = d[k];
        set[`delivery.${k}`] = body[k];
      }
    }
  }
  const changes = { before, after: Object.fromEntries(Object.entries(set).filter(([k]) => k !== 'updatedBy')) };
  const updated = await Trip.findOneAndUpdate(
    { _id: id, __v: body.version, status: 'delivered' },
    { $set: set, $push: { corrections: { at: new Date(), by: req.user!.id, reason: body.reason, changes } }, $inc: { __v: 1 } },
    { new: true },
  ).lean();
  if (!updated) throw AppError.stale();
  await audit(req, { action: 'trip.correct', entityType: 'trip', entityId: id, meta: { reason: body.reason, changes } });
  return updated;
}
