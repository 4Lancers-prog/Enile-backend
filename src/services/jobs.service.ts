import type { Types } from 'mongoose';
import { Job, type IJob } from '../models/Jobs';

export async function enqueueJob(type: IJob['type'], payload: Record<string, unknown>, opts: { createdBy?: string | Types.ObjectId; requestId?: string; maxAttempts?: number } = {}) {
  return Job.create({ type, payload, createdBy: opts.createdBy, requestId: opts.requestId, maxAttempts: opts.maxAttempts ?? 5 });
}

/** Exponential backoff with full jitter, capped at 30 minutes. */
export function backoffMs(attempt: number, baseMs = 30_000, capMs = 30 * 60_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}
