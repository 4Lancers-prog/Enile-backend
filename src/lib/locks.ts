import crypto from 'crypto';
import { AppError, ErrorCodes, isDuplicateKeyError } from './errors';
import { Lock } from '../models/Lock';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Acquire several named locks (sorted to avoid deadlocks), run `fn`, release.
 * Works on standalone MongoDB as well as replica sets. A crashed holder's lock
 * expires after `ttlMs` (and is removed by the TTL index).
 */
export async function withLocks<T>(keys: string[], fn: () => Promise<T>, ttlMs = 15_000): Promise<T> {
  const owner = crypto.randomUUID();
  const sorted = [...new Set(keys)].sort();
  const held: string[] = [];
  try {
    for (const key of sorted) {
      let acquired = false;
      for (let attempt = 0; attempt < 20 && !acquired; attempt++) {
        try {
          await Lock.create({ _id: key, owner, expiresAt: new Date(Date.now() + ttlMs) });
          acquired = true;
        } catch (err) {
          if (!isDuplicateKeyError(err)) throw err;
          // Steal only an expired lock.
          const stolen = await Lock.findOneAndUpdate(
            { _id: key, expiresAt: { $lt: new Date() } },
            { owner, expiresAt: new Date(Date.now() + ttlMs) },
          ).lean();
          if (stolen) acquired = true;
          else await sleep(50 + Math.random() * 100);
        }
      }
      if (!acquired) throw AppError.conflict(ErrorCodes.RESOURCE_BUSY, 'This vehicle or driver is being updated by someone else. Please retry.');
      held.push(key);
    }
    return await fn();
  } finally {
    if (held.length) await Lock.deleteMany({ _id: { $in: held }, owner }).catch(() => undefined);
  }
}
