import { Router } from 'express';
import { z } from 'zod';
import { RENEWAL_STATUS } from '../../config/constants';
import { asyncHandler } from '../../lib/asyncHandler';
import { paginate, paginationQuery } from '../../lib/pagination';
import { authorize } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { RenewalJob } from '../../models/Jobs';

export const renewalsRouter = Router();

const listQuery = z.object({ ...paginationQuery, status: z.enum(RENEWAL_STATUS).optional() });

/** Reminder history so users can see queued / dispatched / failed status (manual 4.5). */
renewalsRouter.get(
  '/reminders',
  authorize('renewals.view'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { page, limit, status } = req.query as unknown as z.infer<typeof listQuery>;
    const filter = status ? { status } : {};
    res.json(await paginate(RenewalJob, { filter, page, limit, sort: { scheduledAt: -1 }, projection: '-idempotencyKey -leaseUntil' }));
  }),
);
