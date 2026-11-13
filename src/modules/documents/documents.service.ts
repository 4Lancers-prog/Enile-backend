import type { Request } from 'express';
import multer from 'multer';
import { NON_EXPIRING_DOCUMENT_TYPES, type DocumentType } from '../../config/constants';
import { env } from '../../config/env';
import { AppError, ErrorCodes } from '../../lib/errors';
import { ALLOWED_UPLOADS, detectMime, safeFileName } from '../../lib/fileSignature';
import { newStorageKey, storage } from '../../lib/storage';
import { sha256 } from '../../lib/tokens';
import { startOfDayInTz } from '../../lib/time';
import { ComplianceDocument } from '../../models/Document';
import { Driver } from '../../models/Driver';
import { Vehicle } from '../../models/Vehicle';
import { audit } from '../../services/audit.service';
import { getSettings } from '../../services/settings.service';
import { allowedTypesFor, uploadFields } from './documents.schema';
import { zodToFieldErrors } from '../../middleware/validate';

/** Memory storage + hard size cap; the file is inspected before it touches disk. */
export const uploadSingle = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxUploadBytes, files: 1, fields: 20, fieldSize: 4096 },
}).single('file');

/** Validates the real file content and stores it privately. */
export async function storeUploadedFile(file: Express.Multer.File | undefined, prefix: string) {
  if (!file) throw AppError.badRequest('Choose a file to upload.', [{ field: 'file', code: 'REQUIRED' }]);
  const mime = detectMime(file.buffer);
  if (!mime) {
    throw AppError.unprocessable(ErrorCodes.DOCUMENT_TYPE_NOT_ALLOWED, 'Unsupported file type. Upload a PDF, JPG or PNG file.', [
      { field: 'file', code: 'TYPE_NOT_ALLOWED' },
    ]);
  }
  const key = newStorageKey(prefix, ALLOWED_UPLOADS[mime].ext);
  await storage.put(key, file.buffer);
  return { storageKey: key, mimeType: mime, sizeBytes: file.size, checksum: sha256(file.buffer), fileName: safeFileName(file.originalname) };
}

export async function uploadOwnerDocument(req: Request, ownerType: 'vehicle' | 'driver', ownerId: string) {
  const owner =
    ownerType === 'vehicle'
      ? await Vehicle.findById(ownerId).select('registrationNumber').lean()
      : await Driver.findById(ownerId).select('name').lean();
  if (!owner) throw AppError.notFound(ownerType === 'vehicle' ? 'Vehicle' : 'Driver');

  const parsed = uploadFields.safeParse(req.body ?? {});
  if (!parsed.success) throw AppError.badRequest('Please correct the highlighted fields.', zodToFieldErrors(parsed.error));
  const f = parsed.data;
  if (!allowedTypesFor(ownerType).includes(f.documentType)) {
    throw AppError.badRequest(`${f.documentType} is not a valid ${ownerType} document type.`, [{ field: 'documentType', code: 'INVALID' }]);
  }
  if (!f.expiryDate && !NON_EXPIRING_DOCUMENT_TYPES.includes(f.documentType as DocumentType)) {
    throw AppError.badRequest('Expiry date is required for this document type.', [{ field: 'expiryDate', code: 'REQUIRED' }]);
  }
  if (f.issueDate && f.expiryDate && f.issueDate > f.expiryDate) {
    throw AppError.badRequest('Issue date cannot be after the expiry date.', [{ field: 'issueDate', code: 'AFTER_EXPIRY' }]);
  }

  const checksum = req.file ? sha256(req.file.buffer) : undefined;
  if (checksum && f.confirmDuplicate !== 'true') {
    const dup = await ComplianceDocument.findOne({ ownerId, checksum }).select('documentType expiryDate status').lean();
    if (dup) {
      throw AppError.conflict(ErrorCodes.DOCUMENT_DUPLICATE, 'This exact file was already uploaded for this record. Confirm to upload it again.', {
        existing: dup,
      });
    }
  }
  const current =
    f.documentType === 'OTHER'
      ? null
      : await ComplianceDocument.findOne({ ownerType, ownerId, documentType: f.documentType, status: 'active' }).select('_id').lean();
  if (current && !f.replaceReason) {
    throw AppError.badRequest('An active document of this type exists. Give a reason for replacing it.', [{ field: 'replaceReason', code: 'REQUIRED' }]);
  }

  const { timezone } = await getSettings();
  const stored = await storeUploadedFile(req.file, `documents/${ownerType}`);
  try {
    const doc = await ComplianceDocument.create({
      ownerType,
      ownerId,
      documentType: f.documentType,
      documentNumber: f.documentNumber,
      issueDate: f.issueDate ? startOfDayInTz(f.issueDate, timezone) : null,
      expiryDate: f.expiryDate ? startOfDayInTz(f.expiryDate, timezone) : null,
      notes: f.notes,
      ...stored,
      uploadedBy: req.user!.id,
    });
    if (current) {
      await ComplianceDocument.updateOne(
        { _id: current._id },
        { $set: { status: 'superseded', replacedById: doc._id, replaceReason: f.replaceReason } },
      );
    }
    // Keep driver master data in sync so licence reminders/blocks use the latest dates.
    if (ownerType === 'driver' && doc.expiryDate) {
      if (f.documentType === 'DRIVING_LICENCE') await Driver.updateOne({ _id: ownerId }, { $set: { licenceExpiry: doc.expiryDate } });
      if (f.documentType === 'HAZCHEM_TRAINING') await Driver.updateOne({ _id: ownerId }, { $set: { hazchemTrainingExpiry: doc.expiryDate } });
    }
    await audit(req, {
      action: current ? 'document.replace' : 'document.upload',
      entityType: 'document',
      entityId: String(doc._id),
      meta: { ownerType, ownerId, documentType: f.documentType, replaced: current ? String(current._id) : undefined, reason: f.replaceReason },
    });
    const { storageKey: _omit, ...safe } = doc.toObject();
    return safe;
  } catch (err) {
    await storage.remove(stored.storageKey).catch(() => undefined);
    throw err;
  }
}
