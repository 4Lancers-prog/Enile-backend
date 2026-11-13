import { Router } from 'express';
import type { z } from 'zod';
import type { Permission } from '../../config/permissions';
import { asyncHandler } from '../../lib/asyncHandler';
import { AppError } from '../../lib/errors';
import { idParams } from '../../lib/schemas';
import { signFileLink } from '../../lib/tokens';
import { authorize } from '../../middleware/auth';
import { exportLimiter } from '../../middleware/rateLimiters';
import { validate } from '../../middleware/validate';
import { Job } from '../../models/Jobs';
import { audit } from '../../services/audit.service';
import { enqueueJob } from '../../services/jobs.service';
import { exportBody, rangeQuery } from './reports.schema';
import { conversionReport, dailyReport } from './reports.service';

export const reportsRouter = Router();

/** Exports of sensitive modules also need that module's view permission. */
const EXPORT_PERMISSION: Partial<Record<z.infer<typeof exportBody>['type'], Permission>> = {
  companies: 'companies.view',
  quotations: 'quotations.view',
  driver_payments: 'payroll.view',
  trip_expenses: 'expenses.view',
  stock_movements: 'inventory.view',
  purchase_orders: 'purchases.view',
};
export const exportsRouter = Router();

function stripQuotations<T>(report: T): T {
  const drop = (r: unknown) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return r;
    const { issued: _i, issuedValuePaise: _v, ...rest } = r as Record<string, unknown>;
    return rest;
  };
  const walk = (v: unknown): unknown => (Array.isArray(v) ? v.map((x) => drop(x)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Array.isArray(x) ? x.map(drop) : k === 'totals' ? drop(x) : x])) : v);
  return walk(report) as T;
}

reportsRouter.get(
  '/daily',
  authorize('reports.view'),
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query as unknown as z.infer<typeof rangeQuery>;
    const report = await dailyReport(from, to);
    // Quotation counts and values are customer details: Admin only.
    if (req.user!.permissions.includes('quotations.view')) return res.json(report);
    return res.json(stripQuotations(report));
  }),
);

reportsRouter.get(
  '/conversion',
  authorize('reports.view', 'quotations.view'),
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query as unknown as z.infer<typeof rangeQuery>;
    res.json(await conversionReport(from, to));
  }),
);

/** Exports always run in the background worker; the UI polls the job status. */
exportsRouter.post(
  '/',
  authorize('reports.export'),
  exportLimiter,
  validate({ body: exportBody }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof exportBody>;
    const needs = EXPORT_PERMISSION[body.type];
    if (needs && !req.user!.permissions.includes(needs)) throw AppError.forbidden('You cannot export this data.');
    const job = await enqueueJob('export', { ...body, userId: req.user!.id }, { createdBy: req.user!.id, requestId: String(req.id), maxAttempts: 3 });
    await audit(req, { action: 'report.export', entityType: 'export', entityId: String(job._id), meta: body });
    res.status(202).json({ id: job._id, status: job.status });
  }),
);

exportsRouter.get(
  '/',
  authorize('reports.export'),
  asyncHandler(async (req, res) => {
    const items = await Job.find({ type: 'export', createdBy: req.user!.id })
      .sort({ createdAt: -1 })
      .limit(20)
      .select('status payload.type payload.format payload.from payload.to result.fileName result.rows lastError createdAt updatedAt')
      .lean();
    res.json({ items });
  }),
);

exportsRouter.get(
  '/:id/download',
  authorize('reports.export'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const job = await Job.findOne({ _id: req.params.id, type: 'export', createdBy: req.user!.id }).lean();
    if (!job) throw AppError.notFound('Export');
    if (job.status !== 'done' || !job.result?.storageKey) return res.status(202).json({ status: job.status });
    const url = `/api/v1/files/${signFileLink({ k: job.result.storageKey, u: req.user!.id, n: job.result.fileName ?? 'export', m: job.result.mimeType ?? 'text/csv' })}`;
    return res.json({ status: 'done', url });
  }),
);
