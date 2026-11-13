import { Types } from 'mongoose';
import { ADVANCE_PAYMENT_TYPES } from '../../config/constants';
import { startOfDayInTz, todayYmd, ymdInTz } from '../../lib/time';
import { DriverPayment, type SalaryBreakdown } from '../../models/DriverPayment';
import type { IDriver } from '../../models/Driver';
import { Trip } from '../../models/Trip';
import { TripExpense } from '../../models/TripExpense';

/**
 * Salary maths, in integer paise.
 *
 *   basic        = monthly salary × payable days ÷ days in month
 *                  (payable days start at the joining date and exclude unpaid leave)
 *   allowance    = delivered trips in the month × the driver's per-trip allowance
 *   gross        = basic + allowance
 *   net          = gross − trip allowance already paid during the month
 *                        − other deductions − advance recovery
 *   balance due  = net − salary already paid for the month
 *
 * Advance recovery defaults to the driver's monthly instalment (or the whole
 * outstanding advance when none is set), never more than is outstanding and
 * never more than leaves the net at zero.
 */

export const monthBounds = (month: string, tz: string) => {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { start: startOfDayInTz(`${month}-01`, tz), end: startOfDayInTz(`${next}-01`, tz), daysInMonth: new Date(Date.UTC(y, m, 0)).getUTCDate(), next };
};

export const currentMonth = (tz: string) => todayYmd(tz).slice(0, 7);

export type SalaryStatus = 'paid' | 'partial' | 'due' | 'overdue' | 'running' | 'not_joined';

export interface SalaryRow extends SalaryBreakdown {
  driverId: string;
  allowancePaidPaise: number;
  salaryPaidPaise: number;
  recoveredThisMonthPaise: number;
  balanceDuePaise: number;
  advanceOutstandingPaise: number;
  maxRecoveryPaise: number;
  dueDate: string;
  status: SalaryStatus;
  payments: number;
}

type DriverLite = Pick<IDriver, '_id' | 'joiningDate' | 'monthlySalaryPaise' | 'tripAllowancePaise' | 'salaryDay' | 'advanceRecoveryPaise'>;

/** Advance given minus advance recovered, per driver. */
export async function advanceBalances(driverIds: Types.ObjectId[]) {
  const rows = await DriverPayment.aggregate<{ _id: Types.ObjectId; advanced: number; recovered: number }>([
    { $match: { driverId: { $in: driverIds }, status: 'paid' } },
    {
      $group: {
        _id: '$driverId',
        advanced: { $sum: { $cond: [{ $in: ['$type', ADVANCE_PAYMENT_TYPES] }, '$amountPaise', 0] } },
        recovered: { $sum: '$advanceRecoveryPaise' },
      },
    },
  ]);
  return new Map(rows.map((r) => [String(r._id), { advancedPaise: r.advanced, recoveredPaise: r.recovered, outstandingPaise: Math.max(0, r.advanced - r.recovered) }]));
}

/** Approved trip expenses the driver paid personally and has not been paid back for. */
export function unreimbursedExpenses(driverId: Types.ObjectId | string) {
  return TripExpense.find({ driverId, paidBy: 'driver', status: 'approved', reimbursedPaymentId: null }).sort({ expenseDate: 1 }).select('tripNumber category amountPaise expenseDate billNumber').lean();
}

/**
 * Salary for many drivers in one month with a fixed number of grouped queries
 * (not one per driver). `overrides` lets the payment form try leave days,
 * deductions and a recovery amount for a single driver.
 */
export async function computeSalaries(
  drivers: DriverLite[],
  month: string,
  tz: string,
  overrides: { leaveDays?: number; otherDeductionsPaise?: number; advanceRecoveryPaise?: number } = {},
): Promise<SalaryRow[]> {
  const { start, end, daysInMonth, next } = monthBounds(month, tz);
  const ids = drivers.map((d) => d._id);
  const [trips, paid, allowances, advances] = await Promise.all([
    Trip.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { driverId: { $in: ids }, status: 'delivered', 'delivery.deliveredAt': { $gte: start, $lt: end } } },
      { $group: { _id: '$driverId', n: { $sum: 1 } } },
    ]),
    DriverPayment.aggregate<{ _id: Types.ObjectId; amount: number; recovered: number; n: number; leaveDays: number; deductions: number }>([
      { $match: { driverId: { $in: ids }, status: 'paid', type: 'salary', salaryMonth: month } },
      { $sort: { paymentDate: -1 } },
      {
        $group: {
          _id: '$driverId',
          amount: { $sum: '$amountPaise' },
          recovered: { $sum: '$advanceRecoveryPaise' },
          n: { $sum: 1 },
          leaveDays: { $first: '$salary.leaveDays' },
          deductions: { $first: '$salary.otherDeductionsPaise' },
        },
      },
    ]),
    DriverPayment.aggregate<{ _id: Types.ObjectId; amount: number }>([
      { $match: { driverId: { $in: ids }, status: 'paid', type: 'trip_allowance', paymentDate: { $gte: start, $lt: end } } },
      { $group: { _id: '$driverId', amount: { $sum: '$amountPaise' } } },
    ]),
    advanceBalances(ids),
  ]);
  const tripsBy = new Map(trips.map((t) => [String(t._id), t.n]));
  const paidBy = new Map(paid.map((p) => [String(p._id), p]));
  const allowBy = new Map(allowances.map((a) => [String(a._id), a.amount]));
  const today = todayYmd(tz);

  return drivers.map((d) => {
    const id = String(d._id);
    const p = paidBy.get(id);
    const monthly = d.monthlySalaryPaise ?? 0;
    const joinYmd = d.joiningDate ? ymdInTz(d.joiningDate, tz) : null;
    const firstDay = joinYmd && joinYmd.slice(0, 7) === month ? Number(joinYmd.slice(8)) : 1;
    const notJoined = !!joinYmd && joinYmd >= `${next}-01`;
    // Once a salary payment is made, its leave days and deductions stand unless the form overrides them.
    const leaveDays = Math.min(overrides.leaveDays ?? p?.leaveDays ?? 0, daysInMonth);
    const payableDays = notJoined ? 0 : Math.max(0, daysInMonth - firstDay + 1 - leaveDays);
    const basic = Math.round((monthly * payableDays) / daysInMonth);
    const deliveredTrips = tripsBy.get(id) ?? 0;
    const allowance = deliveredTrips * (d.tripAllowancePaise ?? 0);
    const gross = basic + allowance;
    const allowancePaid = allowBy.get(id) ?? 0;
    const otherDeductions = overrides.otherDeductionsPaise ?? p?.deductions ?? 0;
    const salaryPaid = p?.amount ?? 0;
    const recoveredThisMonth = p?.recovered ?? 0;
    const outstanding = advances.get(id)?.outstandingPaise ?? 0;

    const room = Math.max(0, gross - allowancePaid - otherDeductions - recoveredThisMonth - salaryPaid);
    const maxRecovery = Math.min(outstanding, room);
    const instalment = d.advanceRecoveryPaise ? Math.max(0, d.advanceRecoveryPaise - recoveredThisMonth) : outstanding;
    const recovery = Math.min(overrides.advanceRecoveryPaise ?? instalment, maxRecovery);
    const totalRecovery = recoveredThisMonth + recovery;
    const net = Math.max(0, gross - allowancePaid - otherDeductions - totalRecovery);
    const balance = Math.max(0, net - salaryPaid);

    const dueDate = `${next}-${String(d.salaryDay ?? 7).padStart(2, '0')}`;
    let status: SalaryStatus;
    if (notJoined) status = 'not_joined';
    else if (salaryPaid > 0 && balance === 0) status = 'paid';
    else if (salaryPaid > 0) status = 'partial';
    else if (today < `${next}-01`) status = 'running';
    else status = today > dueDate ? 'overdue' : 'due';

    return {
      driverId: id,
      month,
      daysInMonth,
      payableDays,
      leaveDays,
      monthlySalaryPaise: monthly,
      basicPaise: basic,
      tripAllowancePaise: allowance,
      deliveredTrips,
      grossPaise: gross,
      advanceRecoveryPaise: recovery,
      otherDeductionsPaise: otherDeductions,
      netPaise: net,
      allowancePaidPaise: allowancePaid,
      salaryPaidPaise: salaryPaid,
      recoveredThisMonthPaise: recoveredThisMonth,
      balanceDuePaise: balance,
      advanceOutstandingPaise: outstanding,
      maxRecoveryPaise: maxRecovery,
      dueDate,
      status,
      payments: p?.n ?? 0,
    };
  });
}

