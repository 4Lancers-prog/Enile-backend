import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { AppError } from '../../lib/errors';
import { objectId } from '../../lib/schemas';
import { authorize } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AuditLog } from '../../models/AuditLog';
import { Job, Notification, RenewalJob } from '../../models/Jobs';
import { audit } from '../../services/audit.service';

export const adminRouter = Router();

/** Dead-letter / failed work across all queues (manual 6, 12). */
adminRouter.get(
  '/jobs/failed',
  authorize('jobs.view'),
  asyncHandler(async (_req, res) => {
    const failed = { $in: ['failed', 'dead'] };
    const [jobs, notifications, renewals] = await Promise.all([
      Job.find({ status: failed }).sort({ updatedAt: -1 }).limit(50).select('type status attempts lastError payload updatedAt').lean(),
      Notification.find({ status: failed }).sort({ createdAt: -1 }).limit(50).select('channel templateKey title status attempts lastError createdAt').lean(),
      RenewalJob.find({ status: failed }).sort({ scheduledAt: -1 }).limit(50).select('ownerLabel reminderType dueDate status attempts lastError').lean(),
    ]);
    res.json({ jobs, notifications, renewals });
  }),
);

adminRouter.post(
  '/jobs/:kind/:id/retry',
  authorize('jobs.view'),
  validate({ params: z.object({ kind: z.enum(['job', 'notification', 'renewal']), id: objectId }) }),
  asyncHandler(async (req, res) => {
    const { kind, id } = req.params as { kind: 'job' | 'notification' | 'renewal'; id: string };
    const reset = { $set: { status: 'queued', attempts: 0, lastError: null, leaseUntil: null, nextAttemptAt: new Date(), scheduledAt: new Date() } };
    const filter = { _id: new Types.ObjectId(id), status: { $in: ['failed', 'dead'] } };
    const r =
      kind === 'job' ? await Job.updateOne(filter, reset) : kind === 'notification' ? await Notification.updateOne(filter, reset) : await RenewalJob.updateOne(filter, reset);
    if (!r.modifiedCount) throw AppError.notFound('Failed job');
    await audit(req, { action: 'jobs.retry', entityType: kind, entityId: id });
    res.status(202).json({ status: 'queued' });
  }),
);

const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().optional(), // keyset cursor: `${isoTimestamp}_${id}`
  entityType: z.string().max(40).optional(),
  entityId: z.string().max(40).optional(),
  actorId: objectId.optional(),
  action: z.string().max(60).optional(),
});

/**
 * Audit log with keyset (cursor) pagination: stays fast however large the
 * collection grows, unlike skip/limit.
 */
adminRouter.get(
  '/audit',
  authorize('audit.view'),
  validate({ query: auditQuery }),
  asyncHandler(async (req, res) => {
    const { limit, before, entityType, entityId, actorId, action } = req.query as unknown as z.infer<typeof auditQuery>;
    const filter: Record<string, unknown> = {};
    if (entityType) filter.entityType = entityType;
    if (entityId) filter.entityId = entityId;
    if (actorId) filter.actorId = actorId;
    if (action) filter.action = action;
    if (before) {
      const [ts, id] = before.split('_');
      const date = new Date(ts);
      if (Number.isNaN(date.getTime()) || !Types.ObjectId.isValid(id)) throw AppError.badRequest('Invalid cursor.');
      filter.$or = [{ timestamp: { $lt: date } }, { timestamp: date, _id: { $lt: new Types.ObjectId(id) } }];
    }
    const items = await AuditLog.find(filter).sort({ timestamp: -1, _id: -1 }).limit(limit + 1).lean();
    const hasMore = items.length > limit;
    const page = items.slice(0, limit);
    const last = page[page.length - 1];
    res.json({ items: page, nextCursor: hasMore && last ? `${last.timestamp.toISOString()}_${last._id}` : null });
  }),
);
