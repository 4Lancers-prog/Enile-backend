import { Router } from 'express';
import type { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { withVersion } from '../../lib/crud';
import { AppError, ErrorCodes } from '../../lib/errors';
import { escapeRegex } from '../../lib/normalize';
import { paginate } from '../../lib/pagination';
import { idParams, objectId, version as versionSchema } from '../../lib/schemas';
import { startOfDayInTz, addDaysYmd } from '../../lib/time';
import { signFileLink } from '../../lib/tokens';
import { authorize } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { Company } from '../../models/Company';
import { Quotation } from '../../models/Quotation';
import { Trip } from '../../models/Trip';
import { audit } from '../../services/audit.service';
import { enqueueJob } from '../../services/jobs.service';
import { getSettings } from '../../services/settings.service';
import { createQuotationBody, decideBody, listQuotationsQuery, updateQuotationBody } from './quotations.schema';
import * as svc from './quotations.service';
import { z as zod } from 'zod';

export const quotationsRouter = Router();

quotationsRouter.get(
  '/',
  authorize('quotations.view'),
  validate({ query: listQuotationsQuery }),
  asyncHandler(async (req, res) => {
    const { page, limit, q, status, companyId, from, to } = req.query as unknown as z.infer<typeof listQuotationsQuery>;
    const { timezone } = await getSettings();
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (companyId) filter.companyId = companyId;
    if (q) filter.quotationNumber = new RegExp('^' + escapeRegex(q.toUpperCase()));
    if (from || to) {
      filter.issueDate = {
        ...(from ? { $gte: startOfDayInTz(from, timezone) } : {}),
        ...(to ? { $lt: startOfDayInTz(addDaysYmd(to, 1), timezone) } : {}),
      };
    }
    const result = await paginate(Quotation, {
      filter,
      page,
      limit,
      sort: from || to ? { issueDate: -1 } : { createdAt: -1 },
      projection: 'quotationNumber revision companyId subject issueDate validUntil totalPaise status pdf.status createdAt __v',
      populate: [{ path: 'companyId', select: 'companyCode legalName' }],
    });
    res.json({ ...result, items: (result.items as { __v?: number }[]).map(withVersion) });
  }),
);

/**
 * What a new quotation can start from for this customer: its GST state (so the
 * form shows CGST+SGST or IGST before saving) and the lines and rate of its
 * latest issued quotation, ready to copy.
 */
quotationsRouter.get(
  '/prefill',
  authorize('quotations.manage'),
  validate({ query: zod.object({ companyId: objectId }).strict() }),
  asyncHandler(async (req, res) => {
    const companyId = String(req.query.companyId);
    const [company, last, settings] = await Promise.all([
      Company.findById(companyId).select('legalName status gstin billingAddress contacts').lean(),
      Quotation.findOne({ companyId, status: { $in: ['issued', 'accepted', 'expired', 'rejected'] } })
        .sort({ issueDate: -1 })
        .select('quotationNumber status issueDate subject lineItems taxRateBps')
        .lean(),
      getSettings(),
    ]);
    if (!company) throw AppError.notFound('Company');
    const stateCode = company.billingAddress?.stateCode;
    const primary = company.contacts?.find((c) => c.isPrimary) ?? company.contacts?.[0];
    res.json({
      company: { legalName: company.legalName, status: company.status, gstin: company.gstin, stateCode, intraState: !stateCode || stateCode === settings.business.homeStateCode, contactName: primary?.name, city: company.billingAddress?.city },
      lastQuotation: last
        ? { _id: last._id, quotationNumber: last.quotationNumber, status: last.status, issueDate: last.issueDate, subject: last.subject, taxRateBps: last.taxRateBps, lineItems: last.lineItems }
        : null,
      defaults: { validityDays: settings.quotation.validityDays, taxRateBps: settings.tax.defaultRateBps },
    });
  }),
);

/** Quotation + company + revision chain + linked trips, in one response. */
quotationsRouter.get(
  '/:id',
  authorize('quotations.view'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const q = await Quotation.findById(req.params.id).populate('companyId', 'companyCode legalName gstin billingAddress status').lean();
    if (!q) throw AppError.notFound('Quotation');
    const [revisions, trips] = await Promise.all([
      Quotation.find({ rootId: q.rootId ?? q._id }).sort({ revision: 1 }).select('quotationNumber revision status totalPaise issueDate').lean(),
      Trip.find({ quotationId: q._id }).select('tripNumber status plannedQuantityLitres plannedStart').sort({ plannedStart: -1 }).limit(20).lean(),
    ]);
    res.json({ ...withVersion(q), revisions, trips });
  }),
);

quotationsRouter.post(
  '/',
  authorize('quotations.manage'),
  validate({ body: createQuotationBody }),
  asyncHandler(async (req, res) => {
    const q = await svc.createDraft(req, req.body);
    res.status(201).json(withVersion(q.toObject()));
  }),
);

quotationsRouter.patch(
  '/:id',
  authorize('quotations.manage'),
  validate({ params: idParams, body: updateQuotationBody }),
  asyncHandler(async (req, res) => {
    const { version, leadId: _leadId, validityDays: _validity, ...patch } = req.body as z.infer<typeof updateQuotationBody>;
    const q = await Quotation.findById(req.params.id);
    if (!q) throw AppError.notFound('Quotation');
    if (q.__v !== version) throw AppError.stale();
    const saved = await svc.updateDraft(req, q, patch);
    res.json(withVersion(saved.toObject()));
  }),
);

quotationsRouter.post(
  '/:id/issue',
  authorize('quotations.issue'),
  validate({ params: idParams, body: zod.object({ version: versionSchema, validityDays: zod.number().int().min(1).max(90).optional() }).strict() }),
  asyncHandler(async (req, res) => {
    const q = await svc.issue(req, req.params.id, req.body.version, req.body.validityDays);
    res.json({ ...withVersion(q), message: 'Quotation issued. The PDF is being generated.' });
  }),
);

quotationsRouter.post(
  '/:id/status',
  authorize('quotations.decide'),
  validate({ params: idParams, body: decideBody }),
  asyncHandler(async (req, res) => {
    const q = await svc.decide(req, req.params.id, req.body.version, req.body.status, req.body.reason);
    res.json(withVersion(q));
  }),
);

quotationsRouter.post(
  '/:id/revise',
  authorize('quotations.manage'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const draft = await svc.revise(req, req.params.id);
    res.status(201).json(withVersion(draft.toObject()));
  }),
);

quotationsRouter.get(
  '/:id/pdf',
  authorize('quotations.view'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const q = await Quotation.findById(req.params.id).select('+pdf.storageKey').lean();
    if (!q) throw AppError.notFound('Quotation');
    if (q.pdf?.status === 'ready' && q.pdf.storageKey) {
      const name = `${(q.quotationNumber ?? 'quotation').replace(/[^\w-]/g, '_')}.pdf`;
      return res.json({ status: 'ready', url: `/api/v1/files/${signFileLink({ k: q.pdf.storageKey, u: req.user!.id, n: name, m: 'application/pdf' })}` });
    }
    if (q.pdf?.status === 'failed') {
      throw AppError.conflict(ErrorCodes.QUOTATION_PDF_FAILED, 'Quotation saved but PDF generation failed. Use Retry PDF.', { error: q.pdf.error });
    }
    return res.status(202).json({ status: q.pdf?.status ?? 'none', message: 'Quotation saved; PDF is being generated.' });
  }),
);

quotationsRouter.post(
  '/:id/pdf/retry',
  authorize('quotations.issue'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const q = await Quotation.findOneAndUpdate(
      { _id: req.params.id, status: { $ne: 'draft' }, 'pdf.status': { $in: ['failed', 'none'] } },
      { $set: { 'pdf.status': 'pending', 'pdf.error': null } },
      { new: true },
    ).lean();
    if (!q) throw AppError.conflict(ErrorCodes.QUOTATION_PDF_PENDING, 'PDF is already ready or being generated.');
    await enqueueJob('quotation_pdf', { quotationId: req.params.id }, { createdBy: req.user!.id, requestId: String(req.id) });
    await audit(req, { action: 'quotation.pdf_retry', entityType: 'quotation', entityId: req.params.id });
    res.status(202).json({ status: 'pending' });
  }),
);
