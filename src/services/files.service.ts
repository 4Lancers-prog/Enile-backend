import type { Request } from 'express';
import { AppError } from '../lib/errors';
import { storage } from '../lib/storage';
import { signFileLink } from '../lib/tokens';
import type { FileRef } from '../models/shared';
import { storeUploadedFile } from '../modules/documents/documents.service';

/** Stores a receipt/slip upload (PDF, JPG or PNG, checked by magic bytes) and returns its reference. */
export async function storeReceipt(req: Request, prefix: string): Promise<FileRef> {
  const stored = await storeUploadedFile(req.file, prefix);
  return { ...stored, uploadedAt: new Date() };
}

/** Removes a stored file, ignoring errors (used when replacing or after a failed save). */
export const discardFile = (ref?: FileRef | null) => (ref?.storageKey ? storage.remove(ref.storageKey).catch(() => undefined) : Promise.resolve());

/** Short-lived, user-bound download link; storage keys never leave the server. */
export function fileLink(req: Request, ref: FileRef | null | undefined) {
  if (!ref?.storageKey) throw AppError.notFound('File');
  return { url: `/api/v1/files/${signFileLink({ k: ref.storageKey, u: req.user!.id, n: ref.fileName ?? 'file', m: ref.mimeType ?? 'application/octet-stream' })}`, expiresInSeconds: 300 };
}

/** The file metadata that is safe to send to the browser. */
export const publicFile = (ref?: FileRef | null) => (ref ? { fileName: ref.fileName, mimeType: ref.mimeType, sizeBytes: ref.sizeBytes, uploadedAt: ref.uploadedAt } : null);
