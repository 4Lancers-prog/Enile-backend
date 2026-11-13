import type { Request } from 'express';
import { AuditLog } from '../models/AuditLog';
import { logger } from '../lib/logger';

interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  changedFields?: string[];
  meta?: Record<string, unknown>;
  outcome?: 'success' | 'failure';
  actorId?: string | null;
  actorName?: string;
}

/**
 * Writes an audit event. Failures are logged but never break the user's request:
 * the business write already committed and must not be reported as failed.
 */
export async function audit(req: Request | null, input: AuditInput): Promise<void> {
  try {
    await AuditLog.create({
      actorId: input.actorId ?? req?.user?.id ?? null,
      actorName: input.actorName ?? req?.user?.name,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      requestId: req ? String(req.id) : undefined,
      ip: req?.ip,
      changedFields: input.changedFields,
      meta: input.meta,
      outcome: input.outcome ?? 'success',
    });
  } catch (err) {
    logger.error({ err, requestId: req ? String(req.id) : undefined, action: input.action }, 'audit write failed');
  }
}

/** Names of fields whose values differ between two plain objects (shallow). */
export function diffFields(before: object, patch: object): string[] {
  const b = before as Record<string, unknown>;
  const p = patch as Record<string, unknown>;
  return Object.keys(p).filter((k) => p[k] !== undefined && JSON.stringify(b[k]) !== JSON.stringify(p[k]));
}
