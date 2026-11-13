import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { authorize } from '../../middleware/auth';
import { getDashboard } from './dashboard.service';

export const dashboardRouter = Router();

dashboardRouter.get(
  '/',
  authorize('dashboard.view'),
  asyncHandler(async (req, res) => {
    const data = (await getDashboard()) as { metrics: Record<string, unknown> } & Record<string, unknown>;
    // Quotation values and the deal pipeline are customer money: Admin only.
    const body = req.user!.permissions.includes('quotations.view')
      ? data
      : { ...data, metrics: { ...data.metrics, openQuotationValuePaise: null, wonValuePaise: null, openQuotations: null }, pipeline: null };
    res.set('Cache-Control', 'private, max-age=15').json(body);
  }),
);
