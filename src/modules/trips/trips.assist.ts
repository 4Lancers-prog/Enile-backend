import { Types } from 'mongoose';
import { TRIP_ACTIVE_STATUS } from '../../config/constants';
import { AppError } from '../../lib/errors';
import { Company } from '../../models/Company';
import { Driver } from '../../models/Driver';
import { Quotation } from '../../models/Quotation';
import { Trip } from '../../models/Trip';
import { Vehicle } from '../../models/Vehicle';
import { driverComplianceIssues, vehicleComplianceIssuesBulk } from '../../services/compliance.service';
import { getSettings } from '../../services/settings.service';

/**
 * Read-only helpers that let the planner fill forms from data the system
 * already has, instead of retyping it. Every value returned here is still
 * validated again when the trip is saved or dispatched.
 */

/** "Loni - Chakan", "Loni → Chakan", "Loni to Chakan" → ["Loni", "Chakan"]. */
export function splitRoute(route?: string | null): { from?: string; to?: string } {
  if (!route) return {};
  const parts = route.split(/\s*(?:→|->|–|—|\bto\b|\s-\s|\/)\s*/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return {};
  return { from: parts[0], to: parts[parts.length - 1] };
}

/** Litres implied by a quotation line, when its unit is a volume. */
export function lineLitres(line: { quantity: number; unit: string }): number | undefined {
  if (line.unit === 'KL') return Math.round(line.quantity * 1000);
  if (line.unit === 'litre') return Math.round(line.quantity);
  return undefined;
}

const DEFAULT_DURATION_HOURS = 12;

/** Everything the "Plan trip" form can fill from a quotation, the customer's history and the vehicle. */
export async function tripPrefill(params: { companyId?: string; quotationId?: string; vehicleId?: string }) {
  const settings = await getSettings();
  const out: Record<string, unknown> = {};

  if (params.quotationId) {
    const q = await Quotation.findById(params.quotationId).select('quotationNumber status validUntil companyId lineItems subject').populate('companyId', 'legalName status').lean();
    if (!q) throw AppError.notFound('Quotation');
    // The first freight line (one with a product or a route) drives the trip.
    const line = q.lineItems.find((l) => l.product || l.route) ?? q.lineItems[0];
    const route = splitRoute(line?.route);
    const company = q.companyId as unknown as { _id: Types.ObjectId; legalName: string; status: string };
    out.quotation = {
      _id: q._id,
      quotationNumber: q.quotationNumber,
      status: q.status,
      validUntil: q.validUntil,
      expired: q.status === 'issued' && !!q.validUntil && q.validUntil < new Date(),
      companyId: company?._id,
      companyName: company?.legalName,
      product: line?.product,
      plannedQuantityLitres: line ? lineLitres(line) : undefined,
      loadingPoint: route.from,
      unloadingPoint: route.to,
      rate: line ? { unit: line.unit, ratePaise: line.ratePaise } : undefined,
    };
  }

  const companyId = params.companyId ?? (out.quotation as { companyId?: Types.ObjectId } | undefined)?.companyId;
  if (companyId) {
    const [last, company] = await Promise.all([
      Trip.findOne({ companyId, status: { $ne: 'cancelled' } })
        .sort({ plannedStart: -1 })
        .select('tripNumber product plannedQuantityLitres loadingPoint unloadingPoint plannedStart plannedEnd vehicleId driverId freightPaise')
        .lean(),
      Company.findById(companyId).select('legalName billingAddress').lean(),
    ]);
    out.history = last
      ? {
          tripNumber: last.tripNumber,
          product: last.product,
          plannedQuantityLitres: last.plannedQuantityLitres,
          loadingPoint: last.loadingPoint,
          unloadingPoint: last.unloadingPoint,
          durationHours: Math.max(1, Math.round((last.plannedEnd.getTime() - last.plannedStart.getTime()) / 3_600_000)),
        }
      : null;
    out.companyName = company?.legalName;
    out.customerSite = company?.billingAddress?.city ? `${company.legalName}, ${company.billingAddress.city}` : undefined;
  }

  if (params.vehicleId) {
    const v = await Vehicle.findById(params.vehicleId).select('capacityLitres compartments assignedDriverId').populate('assignedDriverId', 'name status').lean();
    if (!v) throw AppError.notFound('Vehicle');
    const d = v.assignedDriverId as unknown as { _id: Types.ObjectId; name: string; status: string } | null;
    out.vehicle = { capacityLitres: v.capacityLitres, compartments: v.compartments?.length ?? 0, assignedDriver: d && d.status === 'active' ? { _id: d._id, name: d.name } : null };
  }

  out.defaultDurationHours = (out.history as { durationHours?: number } | null)?.durationHours ?? Math.min(DEFAULT_DURATION_HOURS, settings.trip.maxDurationHours);
  return out;
}

/**
 * Every active vehicle and driver with why it can or cannot take a trip in the
 * given window: an overlapping trip, or documents that block dispatch. Two
 * queries for the fleet and one per resource for clashes, never one per row.
 */
export async function planningOptions(params: { start: Date; end: Date; excludeTripId?: string }) {
  const settings = await getSettings();
  const exclude = params.excludeTripId ? { _id: { $ne: new Types.ObjectId(params.excludeTripId) } } : {};
  const [vehicles, drivers, clashes] = await Promise.all([
    Vehicle.find({ status: 'active' }).select('registrationNumber capacityLitres compartments assignedDriverId').sort({ normalizedRegistration: 1 }).limit(1000).lean(),
    Driver.find({ status: 'active' }).select('name phone status licenceExpiry hazardousEndorsement hazchemTrainingExpiry').sort({ normalizedName: 1 }).limit(1000).lean(),
    Trip.find({ status: { $in: TRIP_ACTIVE_STATUS }, plannedStart: { $lt: params.end }, plannedEnd: { $gt: params.start }, ...exclude })
      .select('tripNumber vehicleId driverId')
      .lean(),
  ]);
  const vehicleBusy = new Map(clashes.map((t) => [String(t.vehicleId), t.tripNumber]));
  const driverBusy = settings.trip.driverOverlapCheck ? new Map(clashes.map((t) => [String(t.driverId), t.tripNumber])) : new Map<string, string>();
  const vIssues = await vehicleComplianceIssuesBulk(vehicles.map((v) => v._id), params.end, settings);
  return {
    vehicles: vehicles.map((v) => ({
      _id: v._id,
      registrationNumber: v.registrationNumber,
      capacityLitres: v.capacityLitres,
      compartments: v.compartments?.length ?? 0,
      assignedDriverId: v.assignedDriverId,
      busyTrip: vehicleBusy.get(String(v._id)) ?? null,
      issues: vIssues.get(String(v._id)) ?? [],
    })),
    drivers: drivers.map((d) => ({
      _id: d._id,
      name: d.name,
      phone: d.phone,
      busyTrip: driverBusy.get(String(d._id)) ?? null,
      issues: driverComplianceIssues(d, params.end, settings),
    })),
  };
}

/** Highest odometer reading recorded for a vehicle, so the next trip cannot start below it. */
export async function lastOdometer(vehicleId: Types.ObjectId | string, excludeTripId?: Types.ObjectId | string): Promise<number | null> {
  const id = new Types.ObjectId(String(vehicleId));
  const [row] = await Trip.aggregate<{ km: number }>([
    { $match: { vehicleId: id, ...(excludeTripId ? { _id: { $ne: new Types.ObjectId(String(excludeTripId)) } } : {}), status: { $in: ['in_transit', 'delivered'] } } },
    { $sort: { plannedStart: -1 } },
    { $limit: 20 },
    { $project: { km: { $max: ['$dispatch.odometerStart', '$delivery.odometerEnd'] } } },
    { $group: { _id: null, km: { $max: '$km' } } },
  ]);
  return row?.km ?? null;
}
