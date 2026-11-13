import { Router } from 'express';
import type { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { AppError } from '../../lib/errors';
import { paginate } from '../../lib/pagination';
import { idParams } from '../../lib/schemas';
import { addDaysYmd, startOfDayInTz, todayYmd } from '../../lib/time';
import { signFileLink } from '../../lib/tokens';
import { authorize } from '../../middleware/auth';
import { uploadLimiter } from '../../middleware/rateLimiters';
import { validate } from '../../middleware/validate';
import { ComplianceDocument, type IDocument } from '../../models/Document';
import { Driver } from '../../models/Driver';
import { Vehicle } from '../../models/Vehicle';
import { audit } from '../../services/audit.service';
import { expiryState } from '../../services/compliance.service';
import { getSettings } from '../../services/settings.service';
import { listDocumentsQuery, updateDocumentBody } from './documents.schema';
import { uploadOwnerDocument, uploadSingle } from './documents.service';

export const documentsRouter = Router();

/** Upload routes mounted under /vehicles/:id/documents and /drivers/:id/documents. */
export const ownerDocumentsRouter = (ownerType: 'vehicle' | 'driver') => {
  const r = Router({ mergeParams: true });
  r.post(
    '/',
    authorize('documents.manage'),
    uploadLimiter,
    validate({ params: idParams }),
    uploadSingle,
    asyncHandler(async (req, res) => {
      const doc = await uploadOwnerDocument(req, ownerType, req.params.id);
      res.status(201).json(doc);
    }),
  );
  return r;
};

/** Renewal dashboard listing: indexed on { status, expiryDate }. */
documentsRouter.get(
  '/',
  authorize('documents.view'),
  validate({ query: listDocumentsQuery }),
  asyncHandler(async (req, res) => {
    const { page, limit, ownerType, ownerId, documentType, expiry, withinDays } = req.query as unknown as z.infer<typeof listDocumentsQuery>;
    const { timezone } = await getSettings();
    const today = startOfDayInTz(todayYmd(timezone), timezone);
    const horizon = startOfDayInTz(addDaysYmd(todayYmd(timezone), withinDays + 1), timezone);
    const filter: Record<string, unknown> = { status: 'active' };
    if (ownerType) filter.ownerType = ownerType;
    if (ownerId) filter.ownerId = ownerId;
    if (documentType) filter.documentType = documentType;
    if (expiry === 'expired') filter.expiryDate = { $lt: today };
    if (expiry === 'expiring') filter.expiryDate = { $gte: today, $lt: horizon };
    if (expiry === 'valid') filter.expiryDate = { $gte: horizon };
    const result = await paginate(ComplianceDocument, { filter, page, limit, sort: { expiryDate: 1 } });
    const items = result.items as IDocument[];

    // Resolve owner labels in two batched queries (not one per row).
    const vIds = items.filter((d) => d.ownerType === 'vehicle').map((d) => d.ownerId);
    const dIds = items.filter((d) => d.ownerType === 'driver').map((d) => d.ownerId);
    const [vehicles, drivers] = await Promise.all([
      vIds.length ? Vehicle.find({ _id: { $in: vIds } }).select('registrationNumber').lean() : [],
      dIds.length ? Driver.find({ _id: { $in: dIds } }).select('name').lean() : [],
    ]);
    const labels = new Map<string, string>([
      ...vehicles.map((v) => [String(v._id), v.registrationNumber] as [string, string]),
      ...drivers.map((d) => [String(d._id), d.name] as [string, string]),
    ]);
    res.json({
      ...result,
      items: items.map((d) => ({ ...d, ownerLabel: labels.get(String(d.ownerId)) ?? '—', expiry: expiryState(d.expiryDate, timezone) })),
    });
  }),
);

documentsRouter.patch(
  '/:id',
  authorize('documents.manage'),
  validate({ params: idParams, body: updateDocumentBody }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateDocumentBody>;
    const { timezone } = await getSettings();
    const doc = await ComplianceDocument.findById(req.params.id);
    if (!doc) throw AppError.notFound('Document');
    if (body.documentNumber !== undefined) doc.documentNumber = body.documentNumber;
    if (body.notes !== undefined) doc.notes = body.notes;
    if (body.issueDate !== undefined) doc.issueDate = body.issueDate ? startOfDayInTz(body.issueDate, timezone) : null;
    if (body.expiryDate !== undefined) doc.expiryDate = body.expiryDate ? startOfDayInTz(body.expiryDate, timezone) : null;
    if (doc.issueDate && doc.expiryDate && doc.issueDate > doc.expiryDate) {
      throw AppError.badRequest('Issue date cannot be after the expiry date.', [{ field: 'issueDate', code: 'AFTER_EXPIRY' }]);
    }
    await doc.save();
    await audit(req, { action: 'document.update', entityType: 'document', entityId: String(doc._id), changedFields: Object.keys(body) });
    res.json(doc.toObject());
  }),
);

/** Issues a 5-minute, user-bound download link after checking permission (no public URLs). */
documentsRouter.get(
  '/:id/download',
  authorize('documents.view'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const doc = await ComplianceDocument.findById(req.params.id).select('+storageKey fileName mimeType').lean();
    if (!doc?.storageKey) throw AppError.notFound('Document');
    const token = signFileLink({ k: doc.storageKey, u: req.user!.id, n: doc.fileName ?? 'document', m: doc.mimeType ?? 'application/octet-stream' });
    await audit(req, { action: 'document.download_link', entityType: 'document', entityId: String(doc._id) });
    res.json({ url: `/api/v1/files/${token}`, expiresInSeconds: 300 });
  }),
);
