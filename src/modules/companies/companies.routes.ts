import { Router } from 'express';
import type { z } from 'zod';
import { TRIP_ACTIVE_STATUS } from '../../config/constants';
import { asyncHandler } from '../../lib/asyncHandler';
import { loadForUpdate, withVersion } from '../../lib/crud';
import { AppError, ErrorCodes } from '../../lib/errors';
import { normalizeGstin } from '../../lib/gstin';
import { escapeRegex, normalizeName, normalizePhone } from '../../lib/normalize';
import { paginate } from '../../lib/pagination';
import { idParams } from '../../lib/schemas';
import { authorize } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { Company } from '../../models/Company';
import { Quotation } from '../../models/Quotation';
import { Trip } from '../../models/Trip';
import { audit, diffFields } from '../../services/audit.service';
import { createCompanyBody, duplicatesQuery, listCompaniesQuery, lookupQuery, updateCompanyBody } from './companies.schema';
import { buildCompanyFields, companySearchFilter, createCompany, findDuplicates } from './companies.service';

export const companiesRouter = Router();

const LIST_FIELDS = 'companyCode legalName tradeName customerType gstin billingAddress.city billingAddress.state contacts status createdAt __v';

companiesRouter.get(
  '/',
  authorize('companies.view'),
  validate({ query: listCompaniesQuery }),
  asyncHandler(async (req, res) => {
    const { page, limit, q, status, customerType, lite } = req.query as unknown as z.infer<typeof listCompaniesQuery>;
    const filter: Record<string, unknown> = companySearchFilter(q);
    if (status) filter.status = status;
    if (customerType) filter.customerType = customerType;
    const result = await paginate(Company, {
      filter,
      page,
      limit,
      sort: q ? { normalizedName: 1 } : { createdAt: -1 },
      projection: lite === 'true' ? 'companyCode legalName gstin status' : LIST_FIELDS,
    });
    res.json(result);
  }),
);

/** Name-only customer lookup for trip planning: code and name, nothing else. */
companiesRouter.get(
  '/lookup',
  authorize('companies.lookup'),
  validate({ query: lookupQuery }),
  asyncHandler(async (req, res) => {
    const { q, id } = req.query as unknown as z.infer<typeof lookupQuery>;
    // Searches by name or customer code only, so GSTIN or phone cannot be used to probe.
    const nameOrCode = q ? (/^CMP-/i.test(q) ? { companyCode: new RegExp('^' + escapeRegex(q.toUpperCase())) } : { normalizedName: new RegExp('^' + escapeRegex(normalizeName(q))) }) : {};
    const filter: Record<string, unknown> = id ? { _id: id } : { ...nameOrCode, status: 'active' };
    const items = await Company.find(filter).sort({ normalizedName: 1 }).limit(10).select('companyCode legalName status').lean();
    res.json({ items: items.map((c) => ({ _id: c._id, companyCode: c.companyCode, legalName: c.legalName, status: c.status })) });
  }),
);

companiesRouter.get(
  '/duplicates',
  authorize('companies.view'),
  validate({ query: duplicatesQuery }),
  asyncHandler(async (req, res) => {
    const { name, gstin, phone, excludeId } = req.query as unknown as z.infer<typeof duplicatesQuery>;
    const matches = await findDuplicates({
      gstin: gstin ? normalizeGstin(gstin) : undefined,
      normalizedName: name ? normalizeName(name) : undefined,
      phones: phone ? [normalizePhone(phone)] : undefined,
      excludeId,
    });
    res.json({ matches });
  }),
);

/** Detail + related summary in one response (avoids extra round trips from the UI). */
companiesRouter.get(
  '/:id',
  authorize('companies.view'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const company = await Company.findById(req.params.id).select('-normalizedName -phones').lean();
    if (!company) throw AppError.notFound('Company');
    const [quotationStats, recentTrips, tripCount] = await Promise.all([
      Quotation.aggregate([{ $match: { companyId: company._id } }, { $group: { _id: '$status', count: { $sum: 1 }, totalPaise: { $sum: '$totalPaise' } } }]),
      Trip.find({ companyId: company._id }).sort({ createdAt: -1 }).limit(5).select('tripNumber status product plannedQuantityLitres plannedStart').lean(),
      Trip.countDocuments({ companyId: company._id }),
    ]);
    res.json({ ...withVersion(company), stats: { quotations: quotationStats, tripCount }, recentTrips });
  }),
);

companiesRouter.post(
  '/',
  authorize('companies.manage'),
  validate({ body: createCompanyBody }),
  asyncHandler(async (req, res) => {
    const company = await createCompany(req, req.body);
    res.status(201).json(withVersion(company.toObject()));
  }),
);

companiesRouter.patch(
  '/:id',
  authorize('companies.manage'),
  validate({ params: idParams, body: updateCompanyBody }),
  asyncHandler(async (req, res) => {
    const { version, status, ...patch } = req.body as z.infer<typeof updateCompanyBody>;
    if (status && !req.user!.permissions.includes('companies.deactivate')) throw AppError.forbidden();
    const company = await loadForUpdate(Company, req.params.id, version, 'Company');
    if (status === 'inactive' && company.status === 'active') {
      const [trip, quote] = await Promise.all([
        Trip.findOne({ companyId: company._id, status: { $in: TRIP_ACTIVE_STATUS } }).select('tripNumber').lean(),
        Quotation.findOne({ companyId: company._id, status: 'issued' }).select('quotationNumber').lean(),
      ]);
      if (trip) throw AppError.conflict(ErrorCodes.DEPENDENT_RECORDS, `Trip ${trip.tripNumber} is still open for this customer. Deliver or cancel it before deactivating.`);
      if (quote) throw AppError.conflict(ErrorCodes.DEPENDENT_RECORDS, `Quotation ${quote.quotationNumber} is still open. Mark it accepted, rejected or cancelled before deactivating.`);
    }
    const fields = buildCompanyFields(patch);
    if (fields.gstin) {
      const dups = await findDuplicates({ gstin: fields.gstin, excludeId: req.params.id });
      if (dups.length) throw AppError.conflict(ErrorCodes.COMPANY_DUPLICATE, 'A company with this GSTIN already exists.', { matches: dups }, [{ field: 'gstin', code: 'DUPLICATE' }]);
    }
    const changed = diffFields(company.toObject(), { ...fields, ...(status ? { status } : {}) });
    company.set({ ...fields, ...(status ? { status } : {}), updatedBy: req.user!.id });
    await company.save();
    await audit(req, {
      action: status === 'inactive' ? 'company.deactivate' : status === 'active' ? 'company.activate' : 'company.update',
      entityType: 'company',
      entityId: String(company._id),
      changedFields: changed,
    });
    res.json(withVersion(company.toObject()));
  }),
);

/** Hard delete only when nothing references the company; otherwise deactivate (manual 4.2). */
companiesRouter.delete(
  '/:id',
  authorize('companies.deactivate'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const [q, t] = await Promise.all([Quotation.exists({ companyId: req.params.id }), Trip.exists({ companyId: req.params.id })]);
    if (q || t) throw AppError.conflict(ErrorCodes.COMPANY_IN_USE, 'This company has quotations or trips. Deactivate it instead of deleting.');
    const deleted = await Company.findByIdAndDelete(req.params.id).lean();
    if (!deleted) throw AppError.notFound('Company');
    await audit(req, { action: 'company.delete', entityType: 'company', entityId: req.params.id, meta: { companyCode: deleted.companyCode } });
    res.status(204).end();
  }),
);
