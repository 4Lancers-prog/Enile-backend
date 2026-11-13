import { Router, type Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { loadForUpdate, withVersion } from '../../lib/crud';
import { AppError, ErrorCodes } from '../../lib/errors';
import { paginate } from '../../lib/pagination';
import { idParams } from '../../lib/schemas';
import { addDaysYmd, startOfDayInTz, todayYmd, ymdInTz } from '../../lib/time';
import { authorize } from '../../middleware/auth';
import { uploadLimiter } from '../../middleware/rateLimiters';
import { validate } from '../../middleware/validate';
import { Trip } from '../../models/Trip';
import { TripExpense, type ITripExpense } from '../../models/TripExpense';
import { audit, diffFields } from '../../services/audit.service';
import { discardFile, fileLink, publicFile, storeReceipt } from '../../services/files.service';
import { getSettings } from '../../services/settings.service';
import { uploadSingle } from '../documents/documents.service';
import { approveBody, bulkApproveBody, createExpenseBody, listExpensesQuery, rejectBody, summaryQuery, updateExpenseBody } from './expenses.schema';

export const expensesRouter = Router();

type Lean = ITripExpense & { __v?: number };
const out = (e: Lean) => ({ ...withVersion(e), receipt: publicFile(e.receipt) });

/** Bills can be dated from the day before the trip starts (advance fuel) up to today. */
async function checkDate(req: Request, trip: { plannedStart: Date; tripNumber: string }, ymd: string) {
  const { timezone } = await getSettings();
  if (ymd > todayYmd(timezone)) throw AppError.badRequest('The bill date cannot be in the future.', [{ field: 'expenseDate', code: 'FUTURE' }]);
  const earliest = addDaysYmd(ymdInTz(trip.plannedStart, timezone), -1);
  if (ymd < earliest) throw AppError.badRequest(`Trip ${trip.tripNumber} starts later. Bills can be dated from ${earliest}.`, [{ field: 'expenseDate', code: 'BEFORE_TRIP' }]);
  return startOfDayInTz(ymd, timezone);
}

/** The same bill number cannot be claimed twice on one trip. */
async function checkDuplicate(tripId: unknown, category: string, billNumber?: string, exceptId?: unknown) {
  if (!billNumber) return;
  const dup = await TripExpense.findOne({ tripId, category, billNumber, status: { $ne: 'rejected' }, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).select('_id').lean();
  if (dup) throw AppError.conflict(ErrorCodes.DUPLICATE_RECORD, `Bill ${billNumber} is already recorded on this trip.`, undefined, [{ field: 'billNumber', code: 'DUPLICATE' }]);
}

const fuelRate = (amountPaise: number, litres?: number | null) => (litres ? Math.round(amountPaise / litres) : null);

expensesRouter.get(
  '/',
  authorize('expenses.view'),
  validate({ query: listExpensesQuery }),
  asyncHandler(async (req, res) => {
    const { page, limit, tripId, driverId, vehicleId, category, status, paidBy, from, to } = req.query as unknown as z.infer<typeof listExpensesQuery>;
    const { timezone } = await getSettings();
    const filter: Record<string, unknown> = {};
    if (tripId) filter.tripId = tripId;
    if (driverId) filter.driverId = driverId;
    if (vehicleId) filter.vehicleId = vehicleId;
    if (category) filter.category = category;
    if (status) filter.status = status;
    if (paidBy) filter.paidBy = paidBy;
    if (from || to) filter.expenseDate = { ...(from ? { $gte: startOfDayInTz(from, timezone) } : {}), ...(to ? { $lt: startOfDayInTz(addDaysYmd(to, 1), timezone) } : {}) };
    const result = await paginate(TripExpense, {
      filter,
      page,
      limit,
      sort: tripId ? { expenseDate: 1, _id: 1 } : { expenseDate: -1, _id: -1 },
      populate: [
        { path: 'vehicleId', select: 'registrationNumber' },
        { path: 'driverId', select: 'name' },
        { path: 'createdBy', select: 'name' },
      ],
    });
    res.json({ ...result, items: (result.items as Lean[]).map(out) });
  }),
);

/** Totals by category (for a trip, or a date range), with the pending count and driver-paid amount. */
expensesRouter.get(
  '/summary',
  authorize('expenses.view'),
  validate({ query: summaryQuery }),
  asyncHandler(async (req, res) => {
    const { tripId, from, to } = req.query as unknown as z.infer<typeof summaryQuery>;
    const { timezone } = await getSettings();
    const match: Record<string, unknown> = { status: { $ne: 'rejected' } };
    if (tripId) match.tripId = new Types.ObjectId(tripId);
    if (from || to) match.expenseDate = { ...(from ? { $gte: startOfDayInTz(from, timezone) } : {}), ...(to ? { $lt: startOfDayInTz(addDaysYmd(to, 1), timezone) } : {}) };
    const rows = await TripExpense.aggregate<{ _id: string; amountPaise: number; count: number; pending: number; driverPaid: number; litres: number }>([
      { $match: match },
      {
        $group: {
          _id: '$category',
          amountPaise: { $sum: '$amountPaise' },
          count: { $sum: 1 },
          pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
          driverPaid: { $sum: { $cond: [{ $eq: ['$paidBy', 'driver'] }, '$amountPaise', 0] } },
          litres: { $sum: { $ifNull: ['$litres', 0] } },
        },
      },
      { $sort: { amountPaise: -1 } },
    ]);
    const total = rows.reduce((s, r) => s + r.amountPaise, 0);
    let freightPaise: number | null = null;
    // Freight and margin are customer money: Admin only.
    if (tripId && req.user!.permissions.includes('customers.finance')) freightPaise = (await Trip.findById(tripId).select('freightPaise').lean())?.freightPaise ?? null;
    res.json({
      byCategory: rows.map((r) => ({ category: r._id, amountPaise: r.amountPaise, count: r.count })),
      totalPaise: total,
      pending: rows.reduce((s, r) => s + r.pending, 0),
      driverPaidPaise: rows.reduce((s, r) => s + r.driverPaid, 0),
      fuelLitres: rows.find((r) => r._id === 'fuel')?.litres ?? 0,
      freightPaise,
      marginPaise: freightPaise !== null ? freightPaise - total : null,
    });
  }),
);

expensesRouter.post(
  '/',
  authorize('expenses.manage'),
  validate({ body: createExpenseBody }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createExpenseBody>;
    const trip = await Trip.findById(body.tripId).select('tripNumber status vehicleId driverId plannedStart').lean();
    if (!trip) throw AppError.badRequest('Trip not found.', [{ field: 'tripId', code: 'NOT_FOUND' }]);
    if (trip.status === 'cancelled') throw AppError.unprocessable(ErrorCodes.EXPENSE_NOT_EDITABLE, `Trip ${trip.tripNumber} is cancelled. Expenses cannot be added to it.`, [{ field: 'tripId', code: 'CANCELLED' }]);
    const expenseDate = await checkDate(req, trip, body.expenseDate);
    await checkDuplicate(trip._id, body.category, body.billNumber);
    const { tripId: _t, ...rest } = body;
    const e = await TripExpense.create({
      ...rest,
      expenseDate,
      tripId: trip._id,
      tripNumber: trip.tripNumber,
      vehicleId: trip.vehicleId,
      driverId: trip.driverId,
      ratePaise: body.category === 'fuel' ? fuelRate(body.amountPaise, body.litres) : null,
      createdBy: req.user!.id,
    });
    await audit(req, { action: 'expense.create', entityType: 'trip_expense', entityId: String(e._id), meta: { tripId: String(trip._id), amountPaise: body.amountPaise } });
    res.status(201).json(out(e.toObject()));
  }),
);

expensesRouter.patch(
  '/:id',
  authorize('expenses.manage'),
  validate({ params: idParams, body: updateExpenseBody }),
  asyncHandler(async (req, res) => {
    const { version, ...patch } = req.body as z.infer<typeof updateExpenseBody>;
    const e = await loadForUpdate(TripExpense, req.params.id, version, 'Expense');
    if (e.status !== 'pending') throw AppError.unprocessable(ErrorCodes.EXPENSE_NOT_EDITABLE, `This expense is already ${e.status}. Only pending expenses can change.`);
    const trip = (await Trip.findById(e.tripId).select('tripNumber plannedStart').lean())!;
    const fields: Partial<ITripExpense> = { ...(patch as Partial<ITripExpense>) };
    if (patch.expenseDate) fields.expenseDate = await checkDate(req, trip, patch.expenseDate);
    const category = patch.category ?? e.category;
    const litres = patch.litres !== undefined ? patch.litres : e.litres;
    if (category === 'fuel' && !litres) throw AppError.badRequest('Enter the litres filled for a fuel bill.', [{ field: 'litres', code: 'REQUIRED' }]);
    await checkDuplicate(e.tripId, category, patch.billNumber ?? e.billNumber, e._id);
    fields.ratePaise = category === 'fuel' ? fuelRate(patch.amountPaise ?? e.amountPaise, litres) : null;
    const changed = diffFields(e.toObject(), fields);
    e.set({ ...fields, updatedBy: req.user!.id });
    await e.save();
    await audit(req, { action: 'expense.update', entityType: 'trip_expense', entityId: String(e._id), changedFields: changed });
    res.json(out(e.toObject()));
  }),
);

/** Attach or replace the bill photo / PDF. Allowed until the expense is decided. */
expensesRouter.post(
  '/:id/receipt',
  authorize('expenses.manage'),
  uploadLimiter,
  validate({ params: idParams }),
  uploadSingle,
  asyncHandler(async (req, res) => {
    const e = await TripExpense.findById(req.params.id);
    if (!e) throw AppError.notFound('Expense');
    if (e.status !== 'pending') throw AppError.unprocessable(ErrorCodes.EXPENSE_NOT_EDITABLE, `This expense is already ${e.status}. The receipt can no longer change.`);
    const previous = e.receipt;
    const receipt = await storeReceipt(req, 'receipts/expenses');
    e.receipt = receipt;
    try {
      await e.save();
    } catch (err) {
      await discardFile(receipt);
      throw err;
    }
    await discardFile(previous);
    await audit(req, { action: previous ? 'expense.receipt_replace' : 'expense.receipt_upload', entityType: 'trip_expense', entityId: String(e._id) });
    res.status(201).json(out(e.toObject()));
  }),
);

expensesRouter.get(
  '/:id/receipt',
  authorize('expenses.view'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const e = await TripExpense.findById(req.params.id).select('receipt').lean();
    if (!e) throw AppError.notFound('Expense');
    res.json(fileLink(req, e.receipt));
  }),
);

async function decide(req: Request, id: string, version: number | undefined, status: 'approved' | 'rejected', reason?: string) {
  const e = await loadForUpdate(TripExpense, id, version, 'Expense');
  if (e.status !== 'pending') throw AppError.unprocessable(ErrorCodes.EXPENSE_NOT_EDITABLE, `This expense is already ${e.status}.`);
  if (String(e.createdBy) === req.user!.id && !req.user!.permissions.includes('settings.manage')) {
    throw AppError.forbidden('Someone other than the person who entered this expense must approve or reject it.');
  }
  e.set({ status, decidedBy: req.user!.id, decidedAt: new Date(), rejectReason: reason, updatedBy: req.user!.id });
  await e.save();
  await audit(req, { action: `expense.${status === 'approved' ? 'approve' : 'reject'}`, entityType: 'trip_expense', entityId: String(e._id), meta: reason ? { reason } : undefined });
  return e;
}

expensesRouter.post(
  '/:id/approve',
  authorize('expenses.approve'),
  validate({ params: idParams, body: approveBody }),
  asyncHandler(async (req, res) => res.json(out((await decide(req, req.params.id, req.body.version, 'approved')).toObject()))),
);

expensesRouter.post(
  '/:id/reject',
  authorize('expenses.approve'),
  validate({ params: idParams, body: rejectBody }),
  asyncHandler(async (req, res) => res.json(out((await decide(req, req.params.id, req.body.version, 'rejected', req.body.reason)).toObject()))),
);

/** Approve several pending expenses at once; ones that cannot be approved are reported, not silently skipped. */
expensesRouter.post(
  '/approve-many',
  authorize('expenses.approve'),
  validate({ body: bulkApproveBody }),
  asyncHandler(async (req, res) => {
    const approved: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of req.body.ids as string[]) {
      try {
        await decide(req, id, undefined, 'approved');
        approved.push(id);
      } catch (err) {
        skipped.push({ id, reason: (err as Error).message });
      }
    }
    res.json({ approved, skipped });
  }),
);

expensesRouter.delete(
  '/:id',
  authorize('expenses.manage'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const e = await TripExpense.findById(req.params.id);
    if (!e) throw AppError.notFound('Expense');
    if (e.status !== 'pending') throw AppError.unprocessable(ErrorCodes.EXPENSE_NOT_EDITABLE, `This expense is already ${e.status}. Reject it instead of deleting.`);
    await e.deleteOne();
    await discardFile(e.receipt);
    await audit(req, { action: 'expense.delete', entityType: 'trip_expense', entityId: String(e._id), meta: { tripNumber: e.tripNumber, amountPaise: e.amountPaise } });
    res.status(204).end();
  }),
);
