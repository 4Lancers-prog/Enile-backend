import { Router } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';
import { ADVANCE_PAYMENT_TYPES, PAYMENT_PREFIX } from '../../config/constants';
import { asyncHandler } from '../../lib/asyncHandler';
import { loadForUpdate, withVersion } from '../../lib/crud';
import { AppError, ErrorCodes } from '../../lib/errors';
import { withLocks } from '../../lib/locks';
import { paginate } from '../../lib/pagination';
import { idParams } from '../../lib/schemas';
import { addDaysYmd, financialYear, startOfDayInTz, todayYmd } from '../../lib/time';
import { authorize } from '../../middleware/auth';
import { exportLimiter, uploadLimiter } from '../../middleware/rateLimiters';
import { validate } from '../../middleware/validate';
import { nextSequence } from '../../models/Counter';
import { Driver } from '../../models/Driver';
import { DriverPayment, type IDriverPayment } from '../../models/DriverPayment';
import { TripExpense } from '../../models/TripExpense';
import { audit, diffFields } from '../../services/audit.service';
import { discardFile, fileLink, publicFile, storeReceipt } from '../../services/files.service';
import { getSettings } from '../../services/settings.service';
import { uploadSingle } from '../documents/documents.service';
import { PAYMENT_HEADERS, paymentRow, renderTable } from './payroll.export';
import { createPaymentBody, driverParams, exportPaymentsQuery, listPaymentsQuery, monthQuery, payDetailsBody, previewQuery, voidBody } from './payroll.schema';
import { advanceBalances, computeSalaries, currentMonth, monthBounds, unreimbursedExpenses } from './payroll.service';

export const payrollRouter = Router();

const PAYROLL_DRIVER_FIELDS = 'name phone status employeeCode joiningDate monthlySalaryPaise tripAllowancePaise salaryDay advanceRecoveryPaise bank upiId pan';
const MAX_DOWNLOAD_ROWS = 50_000;

type Lean = IDriverPayment & { __v?: number };
const out = (p: Lean) => ({ ...withVersion(p), slip: publicFile(p.slip) });

async function paymentFilter(q: Omit<z.infer<typeof listPaymentsQuery>, 'page' | 'limit'>) {
  const { timezone } = await getSettings();
  const filter: Record<string, unknown> = {};
  if (q.driverId) filter.driverId = q.driverId;
  if (q.type) filter.type = q.type;
  if (q.paymentMode) filter.paymentMode = q.paymentMode;
  if (q.status) filter.status = q.status;
  if (q.salaryMonth) filter.salaryMonth = q.salaryMonth;
  if (q.from || q.to) filter.paymentDate = { ...(q.from ? { $gte: startOfDayInTz(q.from, timezone) } : {}), ...(q.to ? { $lt: startOfDayInTz(addDaysYmd(q.to, 1), timezone) } : {}) };
  return filter;
}

/* ------------------------------- Payments ------------------------------- */

payrollRouter.get(
  '/payments',
  authorize('payroll.view'),
  validate({ query: listPaymentsQuery }),
  asyncHandler(async (req, res) => {
    const { page, limit, ...q } = req.query as unknown as z.infer<typeof listPaymentsQuery>;
    const filter = await paymentFilter(q);
    const [result, totals] = await Promise.all([
      paginate(DriverPayment, { filter, page, limit, sort: { paymentDate: -1, _id: -1 }, populate: [{ path: 'driverId', select: 'employeeCode' }] }),
      DriverPayment.aggregate<{ _id: string; amount: number; n: number }>([
        { $match: { ...filter, driverId: filter.driverId ? new Types.ObjectId(String(filter.driverId)) : { $exists: true }, status: filter.status ?? 'paid' } },
        { $group: { _id: '$type', amount: { $sum: '$amountPaise' }, n: { $sum: 1 } } },
      ]),
    ]);
    res.json({ ...result, items: (result.items as Lean[]).map(out), totals: { byType: Object.fromEntries(totals.map((t) => [t._id, t.amount])), amountPaise: totals.reduce((s, t) => s + t.amount, 0), count: totals.reduce((s, t) => s + t.n, 0) } });
  }),
);

/** Instant CSV / Excel download of payment details with the same filters as the list. */
payrollRouter.get(
  '/payments/export',
  authorize('payroll.view'),
  exportLimiter,
  validate({ query: exportPaymentsQuery }),
  asyncHandler(async (req, res) => {
    const { format, ...q } = req.query as unknown as z.infer<typeof exportPaymentsQuery>;
    const { timezone } = await getSettings();
    const filter = await paymentFilter(q);
    const total = await DriverPayment.countDocuments(filter);
    if (total > MAX_DOWNLOAD_ROWS) throw AppError.unprocessable(ErrorCodes.REPORT_RANGE_TOO_LARGE, `That is ${total} payments. Narrow the dates (up to ${MAX_DOWNLOAD_ROWS}) or use Reports › Export.`);
    const rows = await DriverPayment.find(filter).sort({ paymentDate: 1, _id: 1 }).populate('driverId', 'employeeCode').lean();
    const buffer = await renderTable(PAYMENT_HEADERS, rows.map((p) => paymentRow(p, timezone)), format, 'Driver payments');
    const name = `driver-payments-${q.salaryMonth ?? q.from ?? 'all'}${q.to ? `-to-${q.to}` : ''}.${format}`;
    await audit(req, { action: 'payroll.export', entityType: 'driver_payment', meta: { ...q, format, rows: rows.length } });
    res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buffer);
  }),
);

payrollRouter.get(
  '/payments/:id',
  authorize('payroll.view'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const p = await DriverPayment.findById(req.params.id).populate('driverId', 'employeeCode name').lean();
    if (!p) throw AppError.notFound('Payment');
    const expenses = p.expenseIds.length ? await TripExpense.find({ _id: { $in: p.expenseIds } }).select('tripNumber category amountPaise expenseDate billNumber').lean() : [];
    res.json({ ...out(p), expenses });
  }),
);

/**
 * Records a payment. Salary amounts are recalculated on the server from the
 * driver's pay, delivered trips and earlier payments; the request can only
 * choose leave days, deductions and how much advance to recover, and can never
 * pay more than is due. Locked per driver so two clerks cannot pay the same
 * balance twice.
 */
payrollRouter.post(
  '/payments',
  authorize('payroll.manage'),
  validate({ body: createPaymentBody }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createPaymentBody>;
    const { timezone } = await getSettings();
    if (body.paymentDate > todayYmd(timezone)) throw AppError.badRequest('The payment date cannot be in the future.', [{ field: 'paymentDate', code: 'FUTURE' }]);
    const payment = await withLocks([`payroll:${body.driverId}`], async () => {
      const driver = await Driver.findById(body.driverId).select(PAYROLL_DRIVER_FIELDS).lean();
      if (!driver) throw AppError.badRequest('Driver not found.', [{ field: 'driverId', code: 'NOT_FOUND' }]);
      if (body.paymentMode === 'bank_transfer' && !driver.bank?.accountNumber) {
        throw AppError.badRequest(`Add ${driver.name}'s bank account before paying by bank transfer.`, [{ field: 'paymentMode', code: 'NO_BANK_ACCOUNT' }]);
      }
      if (ADVANCE_PAYMENT_TYPES.includes(body.type) && driver.status === 'inactive') {
        throw AppError.badRequest(`${driver.name} is inactive. Advances can only go to current drivers.`, [{ field: 'type', code: 'DRIVER_INACTIVE' }]);
      }
      if (body.type === 'joining_advance' && (await DriverPayment.exists({ driverId: driver._id, type: 'joining_advance', status: 'paid' }))) {
        throw AppError.badRequest(`${driver.name} already has a joining advance. Record further money as an advance.`, [{ field: 'type', code: 'ALREADY_GIVEN' }]);
      }

      const fields: Partial<IDriverPayment> = { amountPaise: body.amountPaise, advanceRecoveryPaise: 0, salaryMonth: null, salary: null, expenseIds: [] };
      if (body.type === 'salary') {
        const month = body.salaryMonth!;
        if (month > currentMonth(timezone)) throw AppError.badRequest('Salary cannot be paid for a future month.', [{ field: 'salaryMonth', code: 'FUTURE' }]);
        if (!driver.monthlySalaryPaise) throw AppError.badRequest(`Set ${driver.name}'s monthly salary first.`, [{ field: 'salaryMonth', code: 'NO_SALARY' }]);
        const [base] = await computeSalaries([driver], month, timezone, { leaveDays: body.leaveDays, otherDeductionsPaise: body.otherDeductionsPaise, advanceRecoveryPaise: 0 });
        if (base.status === 'not_joined') throw AppError.badRequest(`${driver.name} had not joined by ${month}.`, [{ field: 'salaryMonth', code: 'NOT_JOINED' }]);
        const recovery = body.advanceRecoveryPaise ?? 0;
        if (recovery > base.maxRecoveryPaise) {
          throw AppError.unprocessable(ErrorCodes.ADVANCE_RECOVERY_TOO_HIGH, `At most ${(base.maxRecoveryPaise / 100).toFixed(2)} can be recovered (outstanding advance ${(base.advanceOutstandingPaise / 100).toFixed(2)}).`, [{ field: 'advanceRecoveryPaise', code: 'TOO_HIGH' }]);
        }
        const [calc] = await computeSalaries([driver], month, timezone, { leaveDays: body.leaveDays, otherDeductionsPaise: body.otherDeductionsPaise, advanceRecoveryPaise: recovery });
        if (body.amountPaise > calc.balanceDuePaise) {
          throw AppError.unprocessable(ErrorCodes.PAYMENT_EXCEEDS_DUE, `Only ${(calc.balanceDuePaise / 100).toFixed(2)} is due for ${month}.`, [{ field: 'amountPaise', code: 'EXCEEDS_DUE' }], { balanceDuePaise: calc.balanceDuePaise });
        }
        if (body.amountPaise === 0 && recovery === 0) throw AppError.badRequest('Enter an amount above zero.', [{ field: 'amountPaise', code: 'ZERO' }]);
        const { driverId: _d, allowancePaidPaise: _a, salaryPaidPaise: _s, recoveredThisMonthPaise: _r, balanceDuePaise: _b, advanceOutstandingPaise: _o, maxRecoveryPaise: _m, dueDate: _due, status: _st, payments: _n, ...breakdown } = calc;
        Object.assign(fields, { salaryMonth: month, salary: breakdown, advanceRecoveryPaise: recovery });
      }

      if (body.type === 'reimbursement') {
        const owed = await unreimbursedExpenses(driver._id);
        const chosen = body.expenseIds?.length ? owed.filter((e) => body.expenseIds!.includes(String(e._id))) : owed;
        if (!chosen.length) throw AppError.badRequest(`Nothing is owed to ${driver.name} for approved trip expenses.`, [{ field: 'expenseIds', code: 'NONE' }]);
        if (body.expenseIds?.length && chosen.length !== body.expenseIds.length) throw AppError.conflict(ErrorCodes.DEPENDENT_RECORDS, 'Some selected expenses are no longer waiting for reimbursement. Refresh and try again.');
        const sum = chosen.reduce((s, e) => s + e.amountPaise, 0);
        if (body.amountPaise !== sum) throw AppError.badRequest(`The selected expenses add up to ${(sum / 100).toFixed(2)}.`, [{ field: 'amountPaise', code: 'MISMATCH' }]);
        fields.expenseIds = chosen.map((e) => e._id);
      }

      const date = startOfDayInTz(body.paymentDate, timezone);
      const fy = financialYear(date, timezone);
      const p = await DriverPayment.create({
        ...fields,
        paymentNumber: `${PAYMENT_PREFIX}/${fy}/${String(await nextSequence(`payment:${fy}`)).padStart(5, '0')}`,
        driverId: driver._id,
        driverName: driver.name,
        type: body.type,
        paymentDate: date,
        paymentMode: body.paymentMode,
        reference: body.reference,
        paidById: req.user!.id,
        paidByName: body.paidByName ?? req.user!.name,
        notes: body.notes,
      });
      if (fields.expenseIds?.length) {
        const r = await TripExpense.updateMany({ _id: { $in: fields.expenseIds }, reimbursedPaymentId: null }, { $set: { reimbursedPaymentId: p._id } });
        if (r.modifiedCount !== fields.expenseIds.length) {
          await TripExpense.updateMany({ reimbursedPaymentId: p._id }, { $set: { reimbursedPaymentId: null } });
          await p.deleteOne();
          throw AppError.conflict(ErrorCodes.DEPENDENT_RECORDS, 'Some expenses were reimbursed by someone else just now. Refresh and try again.');
        }
      }
      return p;
    });
    await audit(req, { action: 'payroll.payment', entityType: 'driver_payment', entityId: String(payment._id), meta: { driverId: body.driverId, type: body.type, amountPaise: payment.amountPaise, salaryMonth: payment.salaryMonth } });
    res.status(201).json(out(payment.toObject()));
  }),
);

/** Attach the signed voucher, bank slip or UPI screenshot. */
payrollRouter.post(
  '/payments/:id/slip',
  authorize('payroll.manage'),
  uploadLimiter,
  validate({ params: idParams }),
  uploadSingle,
  asyncHandler(async (req, res) => {
    const p = await DriverPayment.findById(req.params.id);
    if (!p) throw AppError.notFound('Payment');
    const previous = p.slip;
    const slip = await storeReceipt(req, 'receipts/payments');
    p.slip = slip;
    try {
      await p.save();
    } catch (err) {
      await discardFile(slip);
      throw err;
    }
    await discardFile(previous);
    await audit(req, { action: 'payroll.slip_upload', entityType: 'driver_payment', entityId: String(p._id) });
    res.status(201).json(out(p.toObject()));
  }),
);

payrollRouter.get(
  '/payments/:id/slip',
  authorize('payroll.view'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const p = await DriverPayment.findById(req.params.id).select('slip').lean();
    if (!p) throw AppError.notFound('Payment');
    res.json(fileLink(req, p.slip));
  }),
);

/** Payments are never deleted. Voiding keeps the record, frees linked expenses and is refused if it would leave recoveries larger than advances. */
payrollRouter.post(
  '/payments/:id/void',
  authorize('payroll.manage'),
  validate({ params: idParams, body: voidBody }),
  asyncHandler(async (req, res) => {
    const existing = await DriverPayment.findById(req.params.id).select('driverId').lean();
    if (!existing) throw AppError.notFound('Payment');
    const p = await withLocks([`payroll:${existing.driverId}`], async () => {
      const pay = (await DriverPayment.findById(req.params.id))!;
      if (pay.status === 'void') throw AppError.unprocessable(ErrorCodes.DEPENDENT_RECORDS, 'This payment is already void.');
      if (ADVANCE_PAYMENT_TYPES.includes(pay.type)) {
        const bal = (await advanceBalances([pay.driverId])).get(String(pay.driverId));
        if (bal && bal.advancedPaise - pay.amountPaise < bal.recoveredPaise) {
          throw AppError.conflict(ErrorCodes.DEPENDENT_RECORDS, 'Salary has already recovered part of this advance. Void those salary payments first.');
        }
      }
      pay.set({ status: 'void', voidReason: req.body.reason, voidedBy: req.user!.id, voidedAt: new Date() });
      await pay.save();
      if (pay.expenseIds.length) await TripExpense.updateMany({ reimbursedPaymentId: pay._id }, { $set: { reimbursedPaymentId: null } });
      return pay;
    });
    await audit(req, { action: 'payroll.void', entityType: 'driver_payment', entityId: String(p._id), meta: { reason: req.body.reason } });
    res.json(out(p.toObject()));
  }),
);

/* -------------------------------- Salary -------------------------------- */

/** Month view: every current driver (and anyone paid that month) with gross, paid and balance due. */
payrollRouter.get(
  '/salary-sheet',
  authorize('payroll.view'),
  validate({ query: monthQuery }),
  asyncHandler(async (req, res) => {
    const { timezone } = await getSettings();
    const month = (req.query as { month?: string }).month ?? currentMonth(timezone);
    const { end } = monthBounds(month, timezone);
    const paidIds = await DriverPayment.distinct('driverId', { salaryMonth: month, status: 'paid' });
    const drivers = await Driver.find({
      $or: [{ status: { $in: ['active', 'on_leave'] }, $or: [{ joiningDate: null }, { joiningDate: { $lt: end } }] }, { _id: { $in: paidIds } }],
    })
      .select(PAYROLL_DRIVER_FIELDS)
      .sort({ normalizedName: 1 })
      .limit(1000)
      .lean();
    const rows = await computeSalaries(drivers, month, timezone);
    const byId = new Map(drivers.map((d) => [String(d._id), d]));
    const items = rows.map((r) => ({ ...r, driver: { _id: r.driverId, name: byId.get(r.driverId)!.name, employeeCode: byId.get(r.driverId)!.employeeCode, status: byId.get(r.driverId)!.status, salaryDay: byId.get(r.driverId)!.salaryDay, hasBank: !!byId.get(r.driverId)!.bank?.accountNumber, missingSalary: !byId.get(r.driverId)!.monthlySalaryPaise } }));
    const sum = (k: keyof (typeof rows)[number]) => rows.reduce((s, r) => s + (r[k] as number), 0);
    res.json({
      month,
      items,
      totals: { grossPaise: sum('grossPaise'), paidPaise: sum('salaryPaidPaise'), balanceDuePaise: sum('balanceDuePaise'), advanceOutstandingPaise: sum('advanceOutstandingPaise'), recoveryPaise: sum('advanceRecoveryPaise') + sum('recoveredThisMonthPaise') },
      counts: Object.fromEntries(['paid', 'partial', 'due', 'overdue', 'running', 'not_joined'].map((s) => [s, rows.filter((r) => r.status === s).length])),
    });
  }),
);

/** Live salary calculation for the payment form. */
payrollRouter.get(
  '/drivers/:driverId/salary-preview',
  authorize('payroll.view'),
  validate({ params: driverParams, query: previewQuery }),
  asyncHandler(async (req, res) => {
    const { month, ...overrides } = req.query as unknown as z.infer<typeof previewQuery>;
    const { timezone } = await getSettings();
    const driver = await Driver.findById(req.params.driverId).select(PAYROLL_DRIVER_FIELDS).lean();
    if (!driver) throw AppError.notFound('Driver');
    const [row] = await computeSalaries([driver], month, timezone, overrides);
    res.json(row);
  }),
);

/** Employee view: profile, balances, unpaid salary months, reimbursements owed and totals for the financial year. */
payrollRouter.get(
  '/drivers/:driverId/summary',
  authorize('payroll.view'),
  validate({ params: driverParams }),
  asyncHandler(async (req, res) => {
    const { timezone } = await getSettings();
    const driver = await Driver.findById(req.params.driverId).select(PAYROLL_DRIVER_FIELDS + ' licenceNumber').lean();
    if (!driver) throw AppError.notFound('Driver');
    const now = new Date();
    const fy = financialYear(now, timezone);
    const fyStart = startOfDayInTz(`${fy.slice(0, 4)}-04-01`, timezone);
    const thisMonth = currentMonth(timezone);
    const months: string[] = [];
    for (let i = 0; i < 6; i++) {
      const [y, m] = thisMonth.split('-').map(Number);
      const d = new Date(Date.UTC(y, m - 1 - i, 1));
      months.push(d.toISOString().slice(0, 7));
    }
    const [balances, owed, fyTotals, history, lastPayments] = await Promise.all([
      advanceBalances([driver._id]),
      unreimbursedExpenses(driver._id),
      DriverPayment.aggregate<{ _id: string; amount: number }>([
        { $match: { driverId: driver._id, status: 'paid', paymentDate: { $gte: fyStart } } },
        { $group: { _id: '$type', amount: { $sum: '$amountPaise' } } },
      ]),
      Promise.all(months.map((m) => computeSalaries([driver], m, timezone).then((r) => r[0]))),
      DriverPayment.find({ driverId: driver._id }).sort({ paymentDate: -1, _id: -1 }).limit(10).lean(),
    ]);
    res.json({
      driver,
      advance: balances.get(String(driver._id)) ?? { advancedPaise: 0, recoveredPaise: 0, outstandingPaise: 0 },
      reimbursement: { owedPaise: owed.reduce((s, e) => s + e.amountPaise, 0), expenses: owed },
      financialYear: fy,
      fyTotals: Object.fromEntries(fyTotals.map((t) => [t._id, t.amount])),
      salaryHistory: history.filter((h) => h.status !== 'not_joined'),
      recentPayments: (lastPayments as Lean[]).map(out),
    });
  }),
);

/** Payroll staff set joining date, salary, allowance, salary day, recovery and bank details. */
payrollRouter.patch(
  '/drivers/:driverId/pay',
  authorize('payroll.manage'),
  validate({ params: driverParams, body: payDetailsBody }),
  asyncHandler(async (req, res) => {
    const { version, joiningDate, ...rest } = req.body as z.infer<typeof payDetailsBody>;
    const { timezone } = await getSettings();
    const driver = await loadForUpdate(Driver, req.params.driverId, version, 'Driver');
    const fields: Record<string, unknown> = { ...rest };
    if (joiningDate !== undefined) fields.joiningDate = joiningDate ? startOfDayInTz(joiningDate, timezone) : null;
    const changed = diffFields(driver.toObject(), fields);
    driver.set({ ...fields, updatedBy: req.user!.id });
    await driver.save();
    await audit(req, { action: 'driver.pay_update', entityType: 'driver', entityId: String(driver._id), changedFields: changed });
    res.json(withVersion(driver.toObject()));
  }),
);
