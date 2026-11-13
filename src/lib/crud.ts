import type { HydratedDocument, Model } from 'mongoose';
import { AppError } from './errors';

/**
 * Loads a document for an edit and enforces optimistic concurrency (manual 5.1):
 * the client sends back the `version` it read; a mismatch means someone else
 * saved first, so we return 409 instead of silently overwriting their change.
 */
export async function loadForUpdate<T>(model: Model<T>, id: string, version: number | undefined, entity: string): Promise<HydratedDocument<T>> {
  const doc = await model.findById(id);
  if (!doc) throw AppError.notFound(entity);
  if (version !== undefined && (doc as unknown as { __v: number }).__v !== version) throw AppError.stale();
  return doc as HydratedDocument<T>;
}

/** Adds a `version` alias for `__v` to lean results so the UI can echo it back. */
export function withVersion<T extends { __v?: number }>(doc: T): T & { version: number } {
  return { ...doc, version: doc.__v ?? 0 };
}
