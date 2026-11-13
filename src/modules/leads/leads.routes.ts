import { Router } from 'express';
import type { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { loadForUpdate, withVersion } from '../../lib/crud';
import { AppError, ErrorCodes } from '../../lib/errors';
import { escapeRegex, normalizeName, normalizePhone } from '../../lib/normalize';
import { paginate } from '../../lib/pagination';
import { idParams } from '../../lib/schemas';
import { authorize } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { Company } from '../../models/Company';
import { Lead } from '../../models/Lead';
import { audit, diffFields } from '../../services/audit.service';
import { createCompany } from '../companies/companies.service';
import { convertLeadBody, createLeadBody, listLeadsQuery, updateLeadBody } from './leads.schema';

export const leadsRouter = Router();

leadsRouter.get(
  '/',
  authorize('leads.view'),
  validate({ query: listLeadsQuery }),
  asyncHandler(async (req, res) => {
    const { page, limit, q, status, mine } = req.query as unknown as z.infer<typeof listLeadsQuery>;
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (mine === 'true') filter.assignedTo = req.user!.id;
    if (q) {
      const digits = q.replace(/\D/g, '');
      filter.$or =
        digits.length >= 6 ? [{ normalizedPhone: normalizePhone(digits) }] : [{ normalizedName: new RegExp('^' + escapeRegex(normalizeName(q))) }];
    }
    const result = await paginate(Lead, {
      filter,
      page,
      limit,
      sort: { createdAt: -1 },
      projection: '-normalizedName -normalizedPhone',
      populate: [
        { path: 'assignedTo', select: 'name' },
        { path: 'convertedCompanyId', select: 'companyCode legalName' },
      ],
    });
    res.json({ ...result, items: (result.items as { __v?: number }[]).map(withVersion) });
  }),
);

leadsRouter.post(
  '/',
  authorize('leads.manage'),
  validate({ body: createLeadBody }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createLeadBody>;
    const lead = await Lead.create({
      ...body,
      normalizedName: normalizeName(body.name),
      normalizedPhone: body.phone ? normalizePhone(body.phone) : undefined,
      assignedTo: body.assignedTo ?? req.user!.id,
      createdBy: req.user!.id,
    });
    await audit(req, { action: 'lead.create', entityType: 'lead', entityId: String(lead._id) });
    res.status(201).json(withVersion(lead.toObject()));
  }),
);

leadsRouter.patch(
  '/:id',
  authorize('leads.manage'),
  validate({ params: idParams, body: updateLeadBody }),
  asyncHandler(async (req, res) => {
    const { version, ...patch } = req.body as z.infer<typeof updateLeadBody>;
    const lead = await loadForUpdate(Lead, req.params.id, version, 'Lead');
    if (lead.status === 'converted') throw AppError.conflict(ErrorCodes.LEAD_ALREADY_CONVERTED, 'This lead is already converted. Edit the company instead.');
    const extra: Record<string, unknown> = {};
    if (typeof patch.name === 'string') extra.normalizedName = normalizeName(patch.name);
    if (typeof patch.phone === 'string') extra.normalizedPhone = normalizePhone(patch.phone);
    const changed = diffFields(lead.toObject(), patch);
    lead.set({ ...patch, ...extra, updatedBy: req.user!.id });
    await lead.save();
    await audit(req, { action: 'lead.update', entityType: 'lead', entityId: String(lead._id), changedFields: changed });
    res.json(withVersion(lead.toObject()));
  }),
);

/** Converts a referral lead into a customer company (or links an existing one). */
leadsRouter.post(
  '/:id/convert',
  authorize('leads.manage', 'companies.manage'),
  validate({ params: idParams, body: convertLeadBody }),
  asyncHandler(async (req, res) => {
    const lead = await Lead.findById(req.params.id);
    if (!lead) throw AppError.notFound('Lead');
    if (lead.status === 'converted') throw AppError.conflict(ErrorCodes.LEAD_ALREADY_CONVERTED, 'This lead is already converted.');
    if (lead.status === 'lost') throw AppError.badRequest('This lead is marked lost. Reopen it (set it to contacted or qualified) before converting.', [{ field: 'status', code: 'LOST' }]);
    const body = req.body as z.infer<typeof convertLeadBody>;
    let companyId: string;
    if ('existingCompanyId' in body) {
      const existing = await Company.findById(body.existingCompanyId).select('_id status').lean();
      if (!existing) throw AppError.notFound('Company');
      if (existing.status !== 'active') throw AppError.unprocessable(ErrorCodes.COMPANY_INACTIVE, 'That customer is inactive. Reactivate it or pick another.', [{ field: 'existingCompanyId', code: 'INACTIVE' }]);
      companyId = String(existing._id);
    } else {
      const company = await createCompany(req, body.company, String(lead._id));
      companyId = String(company._id);
    }
    // Conditional update: two users converting at once cannot both succeed.
    const updated = await Lead.findOneAndUpdate(
      { _id: lead._id, status: { $ne: 'converted' } },
      { $set: { status: 'converted', convertedCompanyId: companyId, convertedAt: new Date(), updatedBy: req.user!.id }, $inc: { __v: 1 } },
      { new: true },
    ).lean();
    if (!updated) throw AppError.conflict(ErrorCodes.LEAD_ALREADY_CONVERTED, 'This lead was converted by someone else.');
    await audit(req, { action: 'lead.convert', entityType: 'lead', entityId: String(lead._id), meta: { companyId } });
    res.json({ lead: withVersion(updated), companyId });
  }),
);
