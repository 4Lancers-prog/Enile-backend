import type { Request } from 'express';
import { Types } from 'mongoose';
import { QUOTATION_TRANSITIONS, TRIP_ACTIVE_STATUS, type QuotationStatus } from '../../config/constants';
import { AppError, ErrorCodes } from '../../lib/errors';
import { computeQuotation, type LineInput } from '../../lib/money';
import { addDaysYmd, financialYear, startOfDayInTz, todayYmd } from '../../lib/time';
import { Company } from '../../models/Company';
import { nextSequence } from '../../models/Counter';
import { Lead } from '../../models/Lead';
import { Quotation, type IQuotation } from '../../models/Quotation';
import { Trip } from '../../models/Trip';
import type { AppSettings } from '../../models/SystemSetting';
import { audit } from '../../services/audit.service';
import { enqueueJob } from '../../services/jobs.service';
import { getSettings } from '../../services/settings.service';

export function assertTransition(from: QuotationStatus, to: QuotationStatus) {
  if (!QUOTATION_TRANSITIONS[from].includes(to)) {
    throw AppError.unprocessable(ErrorCodes.QUOTATION_INVALID_STATUS_TRANSITION, `A ${from} quotation cannot be marked ${to}. Refresh and follow the allowed workflow.`);
  }
}

async function loadActiveCompany(companyId: string | Types.ObjectId) {
  const company = await Company.findById(companyId).lean();
  if (!company) throw AppError.notFound('Company');
  if (company.status !== 'active') throw AppError.unprocessable(ErrorCodes.COMPANY_INACTIVE, 'Select an active company.', [{ field: 'companyId', code: 'INACTIVE' }]);
  return company;
}

/** Totals are ALWAYS computed here; browser totals are never trusted (manual 4.3). */
export function totalsFor(lines: LineInput[], taxRateBps: number, companyStateCode: string | undefined, settings: AppSettings) {
  if (!settings.tax.allowedRatesBps.includes(taxRateBps)) {
    throw AppError.badRequest('Select one of the configured GST rates.', [{ field: 'taxRateBps', code: 'NOT_ALLOWED' }]);
  }
  try {
    return computeQuotation(lines, {
      taxRateBps,
      intraState: !companyStateCode || companyStateCode === settings.business.homeStateCode,
      roundOffTotal: settings.tax.roundOffTotal,
    });
  } catch (err) {
    throw AppError.badRequest((err as Error).message, [{ field: 'lineItems', code: 'INVALID' }]);
  }
}

export async function createDraft(req: Request, input: { companyId: string; leadId?: string | null; subject?: string; lineItems: LineInput[]; taxRateBps: number; terms?: string }) {
  const settings = await getSettings();
  const company = await loadActiveCompany(input.companyId);
  if (input.leadId) {
    const lead = await Lead.findById(input.leadId).select('status').lean();
    if (!lead) throw AppError.notFound('Lead');
    if (lead.status === 'lost') throw AppError.badRequest('This lead is marked lost. Reopen it before quoting.', [{ field: 'leadId', code: 'LOST' }]);
  }
  const totals = totalsFor(input.lineItems, input.taxRateBps, company.billingAddress?.stateCode, settings);
  const _id = new Types.ObjectId();
  const q = await Quotation.create({
    _id,
    rootId: _id,
    revision: 0,
    companyId: company._id,
    leadId: input.leadId ?? null,
    subject: input.subject,
    terms: input.terms ?? settings.quotation.defaultTerms,
    ...totals,
    taxRateBps: input.taxRateBps,
    taxConfigVersion: settings.tax.configVersion,
    status: 'draft',
    createdBy: req.user!.id,
  });
  await audit(req, { action: 'quotation.create', entityType: 'quotation', entityId: String(q._id) });
  return q;
}

export async function updateDraft(req: Request, q: InstanceType<typeof Quotation>, patch: Partial<{ companyId: string; subject: string; lineItems: LineInput[]; taxRateBps: number; terms: string }>) {
  if (q.status !== 'draft') throw AppError.unprocessable(ErrorCodes.QUOTATION_NOT_EDITABLE, 'Issued quotations cannot be edited. Create a revision instead.');
  const settings = await getSettings();
  const company = await loadActiveCompany(patch.companyId ?? q.companyId);
  const lines = patch.lineItems ?? q.lineItems.map((l) => ({ ...l }));
  const rate = patch.taxRateBps ?? q.taxRateBps;
  const totals = totalsFor(lines, rate, company.billingAddress?.stateCode, settings);
  q.set({
    companyId: company._id,
    ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
    ...(patch.terms !== undefined ? { terms: patch.terms } : {}),
    ...totals,
    taxRateBps: rate,
    taxConfigVersion: settings.tax.configVersion,
    updatedBy: req.user!.id,
  });
  await q.save();
  await audit(req, { action: 'quotation.update', entityType: 'quotation', entityId: String(q._id), changedFields: Object.keys(patch) });
  return q;
}

/**
 * Issue: snapshot the company, recompute totals, allocate the number atomically
 * and queue the PDF. A conditional update on (status=draft, __v) guarantees a
 * double-click or two users cannot issue the same draft twice.
 */
export async function issue(req: Request, id: string, version: number, validityDays?: number) {
  const settings = await getSettings();
  const q = await Quotation.findById(id);
  if (!q) throw AppError.notFound('Quotation');
  if (q.__v !== version) throw AppError.stale();
  assertTransition(q.status, 'issued');
  const company = await loadActiveCompany(q.companyId);
  const totals = totalsFor(q.lineItems.map((l) => ({ ...l })), q.taxRateBps, company.billingAddress?.stateCode, settings);
  const tz = settings.timezone;
  const now = new Date();

  let baseNumber = q.baseNumber;
  if (!baseNumber) {
    const fy = financialYear(now, tz);
    const seq = await nextSequence(`quotation:${fy}`);
    baseNumber = `${settings.quotation.numberPrefix}/${fy}/${String(seq).padStart(4, '0')}`;
  }
  const quotationNumber = q.revision > 0 ? `${baseNumber}-R${q.revision}` : baseNumber;
  const days = validityDays ?? settings.quotation.validityDays;
  const validUntil = new Date(startOfDayInTz(addDaysYmd(todayYmd(tz), days + 1), tz).getTime() - 1);
  const primary = company.contacts?.find((c) => c.isPrimary) ?? company.contacts?.[0];

  const updated = await Quotation.findOneAndUpdate(
    { _id: q._id, status: 'draft', __v: version },
    {
      $set: {
        ...totals,
        quotationNumber,
        baseNumber,
        issueDate: now,
        validUntil,
        status: 'issued',
        taxConfigVersion: settings.tax.configVersion,
        companySnapshot: {
          companyCode: company.companyCode,
          legalName: company.legalName,
          gstin: company.gstin,
          billingAddress: company.billingAddress,
          stateCode: company.billingAddress?.stateCode,
          contactName: primary?.name,
          contactPhone: primary?.phone,
          contactEmail: primary?.email,
        },
        pdf: { status: 'pending', storageKey: null, generatedAt: null, error: null },
        updatedBy: req.user!.id,
      },
      $inc: { __v: 1 },
    },
    { new: true },
  ).lean();
  if (!updated) throw AppError.stale();

  if (q.previousId) {
    await Quotation.updateOne({ _id: q.previousId, status: { $in: ['issued', 'accepted', 'rejected', 'expired'] } }, { $set: { status: 'superseded' }, $inc: { __v: 1 } });
  }
  await enqueueJob('quotation_pdf', { quotationId: String(q._id) }, { createdBy: req.user!.id, requestId: String(req.id) });
  await audit(req, { action: 'quotation.issue', entityType: 'quotation', entityId: String(q._id), meta: { quotationNumber, totalPaise: totals.totalPaise } });
  return updated;
}

export async function decide(req: Request, id: string, version: number, status: 'accepted' | 'rejected' | 'cancelled', reason?: string) {
  const q = await Quotation.findById(id).lean();
  if (!q) throw AppError.notFound('Quotation');
  if (q.__v !== version) throw AppError.stale();
  assertTransition(q.status, status);
  if (status === 'accepted' && q.validUntil && q.validUntil < new Date()) {
    throw AppError.unprocessable(ErrorCodes.QUOTATION_INVALID_STATUS_TRANSITION, 'This quotation has expired. Create a revision with a new validity date.');
  }
  if (status !== 'accepted') {
    const active = await Trip.findOne({ quotationId: q._id, status: { $in: TRIP_ACTIVE_STATUS } }).select('tripNumber').lean();
    if (active) {
      throw AppError.conflict(ErrorCodes.DEPENDENT_RECORDS, `Trip ${active.tripNumber} is still open against this quotation. Deliver or cancel it first.`, { tripId: String(active._id) });
    }
  }
  const updated = await Quotation.findOneAndUpdate(
    { _id: id, __v: version, status: q.status },
    { $set: { status, decisionReason: reason, decidedAt: new Date(), decidedBy: req.user!.id }, $inc: { __v: 1 } },
    { new: true },
  ).lean();
  if (!updated) throw AppError.stale();
  await audit(req, { action: `quotation.${status}`, entityType: 'quotation', entityId: id, meta: { reason } });
  return updated;
}

/** Revisions are new documents in the same chain; issued data is never overwritten. */
export async function revise(req: Request, id: string) {
  const src = await Quotation.findById(id).lean();
  if (!src) throw AppError.notFound('Quotation');
  if (!['issued', 'accepted', 'rejected', 'expired'].includes(src.status)) {
    throw AppError.unprocessable(ErrorCodes.QUOTATION_INVALID_STATUS_TRANSITION, 'Only issued, accepted, rejected or expired quotations can be revised.');
  }
  const rootId = src.rootId ?? src._id;
  const openDraft = await Quotation.findOne({ rootId, status: 'draft' }).select('_id').lean();
  if (openDraft) throw AppError.conflict(ErrorCodes.QUOTATION_NOT_EDITABLE, 'A draft revision already exists for this quotation.', { draftId: String(openDraft._id) });
  const last = await Quotation.findOne({ rootId }).sort({ revision: -1 }).select('revision').lean();
  const draft = await Quotation.create({
    rootId,
    revision: (last?.revision ?? src.revision) + 1,
    previousId: src._id,
    baseNumber: src.baseNumber,
    companyId: src.companyId,
    leadId: src.leadId,
    subject: src.subject,
    lineItems: src.lineItems,
    subtotalPaise: src.subtotalPaise,
    discountPaise: src.discountPaise,
    taxablePaise: src.taxablePaise,
    taxRateBps: src.taxRateBps,
    taxBreakdown: src.taxBreakdown,
    taxTotalPaise: src.taxTotalPaise,
    roundOffPaise: src.roundOffPaise,
    totalPaise: src.totalPaise,
    taxConfigVersion: src.taxConfigVersion,
    terms: src.terms,
    status: 'draft',
    createdBy: req.user!.id,
  });
  await audit(req, { action: 'quotation.revise', entityType: 'quotation', entityId: String(draft._id), meta: { from: id, revision: draft.revision } });
  return draft;
}

export type QuotationLean = IQuotation & { __v: number };
