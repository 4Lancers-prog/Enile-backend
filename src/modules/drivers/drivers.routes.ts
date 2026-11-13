import { Router, type Request } from 'express';
import type { z } from 'zod';
import { TRIP_ACTIVE_STATUS } from '../../config/constants';
import { asyncHandler } from '../../lib/asyncHandler';
import { loadForUpdate, withVersion } from '../../lib/crud';
import { AppError, ErrorCodes } from '../../lib/errors';
import { escapeRegex, normalizeLicence, normalizeName, normalizePhone } from '../../lib/normalize';
import { paginate } from '../../lib/pagination';
import { idParams } from '../../lib/schemas';
import { startOfDayInTz } from '../../lib/time';
import { authorize } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { ComplianceDocument } from '../../models/Document';
import { nextSequence } from '../../models/Counter';
import { Driver, type IDriver } from '../../models/Driver';
import { Trip } from '../../models/Trip';
import { Vehicle } from '../../models/Vehicle';
import { audit, diffFields } from '../../services/audit.service';
import { driverComplianceIssues, expiryState } from '../../services/compliance.service';
import { getSettings } from '../../services/settings.service';
import { createDriverBody, listDriversQuery, updateDriverBody } from './drivers.schema';

export const driversRouter = Router();

/** Pay and bank details are only for people who handle payroll. */
const PAYROLL_FIELDS = ['monthlySalaryPaise', 'tripAllowancePaise', 'advanceRecoveryPaise', 'bank', 'upiId', 'pan'] as const;
function forViewer<T extends object>(req: Request, d: T): T {
  if (req.user!.permissions.includes('payroll.view')) return d;
  const out = { ...d } as Record<string, unknown>;
  for (const k of PAYROLL_FIELDS) delete out[k];
  return out as T;
}

function assertPayrollEdit(req: Request) {
  const body = req.body as Record<string, unknown>;
  if (PAYROLL_FIELDS.some((k) => body[k] !== undefined) && !req.user!.permissions.includes('payroll.manage')) {
    throw AppError.forbidden('Only payroll staff can change salary or bank details.');
  }
}

async function toDriverFields(input: Partial<z.infer<typeof createDriverBody>>) {
  const { timezone } = await getSettings();
  const out: Partial<IDriver> & Record<string, unknown> = { ...input } as Record<string, unknown>;
  if (input.name) out.normalizedName = normalizeName(input.name);
  if (input.phone) out.normalizedPhone = normalizePhone(input.phone);
  if (input.licenceNumber) {
    out.licenceNumber = input.licenceNumber.toUpperCase();
    out.normalizedLicence = normalizeLicence(input.licenceNumber);
  }
  if (input.licenceExpiry) out.licenceExpiry = startOfDayInTz(input.licenceExpiry, timezone);
  if (input.joiningDate !== undefined) out.joiningDate = input.joiningDate ? startOfDayInTz(input.joiningDate, timezone) : null;
  if (input.hazchemTrainingExpiry !== undefined) {
    out.hazchemTrainingExpiry = input.hazchemTrainingExpiry ? startOfDayInTz(input.hazchemTrainingExpiry, timezone) : null;
  }
  return out;
}

driversRouter.get(
  '/',
  authorize('drivers.view'),
  validate({ query: listDriversQuery }),
  asyncHandler(async (req, res) => {
    const { page, limit, q, status } = req.query as unknown as z.infer<typeof listDriversQuery>;
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (q) {
      const digits = q.replace(/\D/g, '');
      filter.$or =
        digits.length >= 6 && digits.length === q.replace(/[\s+-]/g, '').length
          ? [{ normalizedPhone: normalizePhone(digits) }]
          : [{ normalizedName: new RegExp('^' + escapeRegex(normalizeName(q))) }, { normalizedLicence: new RegExp('^' + escapeRegex(normalizeLicence(q))) }];
    }
    const settings = await getSettings();
    const result = await paginate(Driver, { filter, page, limit, sort: { normalizedName: 1 }, projection: '-normalizedName -normalizedPhone -normalizedLicence' });
    res.json({
      ...result,
      items: (result.items as (IDriver & { __v?: number })[]).map((d) => ({
        ...forViewer(req, withVersion(d)),
        licence: expiryState(d.licenceExpiry, settings.timezone),
        hazchem: expiryState(d.hazchemTrainingExpiry, settings.timezone),
      })),
    });
  }),
);

driversRouter.get(
  '/lookup',
  authorize('drivers.view'),
  asyncHandler(async (_req, res) => {
    const items = await Driver.find({ status: 'active' }).select('name phone licenceExpiry hazardousEndorsement').sort({ normalizedName: 1 }).limit(1000).lean();
    res.set('Cache-Control', 'private, max-age=30').json({ items });
  }),
);

driversRouter.get(
  '/:id',
  authorize('drivers.view'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const driver = await Driver.findById(req.params.id).select('-normalizedName -normalizedPhone -normalizedLicence').lean();
    if (!driver) throw AppError.notFound('Driver');
    const settings = await getSettings();
    const [documents, recentTrips] = await Promise.all([
      ComplianceDocument.find({ ownerType: 'driver', ownerId: driver._id }).sort({ status: 1, documentType: 1 }).limit(50).lean(),
      Trip.find({ driverId: driver._id }).sort({ plannedStart: -1 }).limit(10).select('tripNumber status product plannedStart plannedEnd').lean(),
    ]);
    res.json({
      ...forViewer(req, withVersion(driver)),
      documents: documents.map((d) => ({ ...d, expiry: expiryState(d.expiryDate, settings.timezone) })),
      recentTrips,
      complianceIssues: driverComplianceIssues(driver, new Date(), settings),
    });
  }),
);

driversRouter.post(
  '/',
  authorize('drivers.manage'),
  validate({ body: createDriverBody }),
  asyncHandler(async (req, res) => {
    assertPayrollEdit(req);
    const employeeCode = `EMP-${String(await nextSequence('driver-employee')).padStart(4, '0')}`;
    const driver = await Driver.create({ ...(await toDriverFields(req.body)), employeeCode, createdBy: req.user!.id });
    await audit(req, { action: 'driver.create', entityType: 'driver', entityId: String(driver._id) });
    res.status(201).json(withVersion(driver.toObject()));
  }),
);

driversRouter.patch(
  '/:id',
  authorize('drivers.manage'),
  validate({ params: idParams, body: updateDriverBody }),
  asyncHandler(async (req, res) => {
    assertPayrollEdit(req);
    const { version, status, ...patch } = req.body as z.infer<typeof updateDriverBody>;
    const driver = await loadForUpdate(Driver, req.params.id, version, 'Driver');
    if (status && status !== 'active' && driver.status === 'active') {
      const busy = await Trip.findOne({ driverId: driver._id, status: { $in: TRIP_ACTIVE_STATUS } }).select('tripNumber').lean();
      if (busy) throw AppError.conflict(ErrorCodes.DEPENDENT_RECORDS, `Trip ${busy.tripNumber} is still open for this driver. Reassign or close it first.`);
    }
    const fields = await toDriverFields(patch);
    const changed = diffFields(driver.toObject(), { ...fields, ...(status ? { status } : {}) });
    driver.set({ ...fields, ...(status ? { status } : {}), updatedBy: req.user!.id });
    await driver.save();
    // A driver who leaves or goes on leave no longer holds a tanker.
    if (status && status !== 'active') await Vehicle.updateMany({ assignedDriverId: driver._id }, { $set: { assignedDriverId: null }, $inc: { __v: 1 } });
    await audit(req, { action: 'driver.update', entityType: 'driver', entityId: String(driver._id), changedFields: changed });
    res.json(withVersion(driver.toObject()));
  }),
);
